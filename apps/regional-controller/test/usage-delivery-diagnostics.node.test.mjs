// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageClient, UsageDeliveryError } from "../src/usage-client.ts";
import { DatabaseSync } from "node:sqlite";
import { UsageJournal } from "../src/usage-journal.ts";
import { deliverUsage } from "../src/metering.ts";
const identity = {
  regionId: "11111111-1111-4111-8111-111111111111",
  sourceId: "22222222-2222-4222-8222-222222222222",
  sourceEpoch: 1,
};
const environmentId = "33333333-3333-4333-8333-333333333333";
const fact = {
  factId: "44444444-4444-4444-8444-444444444444",
  environmentId,
  sourceId: identity.sourceId,
  sourceEpoch: 1,
  revision: 1,
  expectedPreviousRevision: 0,
  metric: "memory_byte_ms",
  attribution: "primary",
  start: "2026-09-29T00:00:00.000Z",
  end: "2026-09-29T00:00:00.001Z",
  quantity: "1024",
  status: "provisional",
  evidenceHash: "a".repeat(64),
};
const token = "cpmtr_" + "t".repeat(43);
test("reports only a bounded known server refusal code while retaining HTTP status and excluding arbitrary sensitive error data", async () => {
  let response = () =>
    Response.json({ error: { code: "not_found" } }, { status: 404 });
  const client = new UsageClient(
    "https://control.example.test",
    identity,
    async () => token,
    async () => response(),
  );
  let observed;
  try {
    await client.sendReceipt(fact);
  } catch (error) {
    observed = error;
  }
  assert(observed instanceof UsageDeliveryError);
  assert.equal(observed.status, 404);
  assert.equal(observed.code, "not_found", "missing safe server refusal code");
  assert.equal(observed.message, "usage_http_failure");
  response = () =>
    Response.json(
      { error: { code: token, detail: "private-database-password" } },
      { status: 503 },
    );
  await assert.rejects(
    client.sendReceipt(fact),
    (error) =>
      error instanceof UsageDeliveryError &&
      error.status === 503 &&
      error.code === null &&
      !JSON.stringify(error).includes(token) &&
      !error.message.includes("password"),
  );
  let cancelled = false;
  response = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(8193)));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  await assert.rejects(
    client.sendReceipt(fact),
    (error) =>
      error instanceof UsageDeliveryError &&
      error.status === 404 &&
      error.code === null,
  );
  assert(cancelled);
});

test("persists a source-bound latest delivery refusal across restart without changing pending facts and clears it only after exact durable acceptance", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pgcf-delivery-status-"));
  const path = join(dir, "usage.sqlite");
  let journal = new UsageJournal(path, identity);
  t.after(() => {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const start = Date.parse(fact.start);
  const allocation = {
    key: environmentId + ":memory",
    environmentId,
    specHash: "b".repeat(64),
    resourceUid: "pod:fixture",
    metric: "memory_byte_ms",
    attribution: "primary",
    rate: "1024",
    continuity: { version: 1, hash: "c".repeat(64) },
    evidenceHash: "d".repeat(64),
  };
  const observation = (at) => ({
    observedAt: at,
    complete: true,
    allocations: [allocation],
    issues: [],
    volumeBindings: [],
  });
  journal.beginSession(start);
  journal.observe(observation(start));
  journal.observe(observation(start + 1));
  const pending = journal.pending()[0];
  const events = [];
  const refused = new UsageClient(
    "https://control.example.test",
    identity,
    async () => token,
    async () =>
      Response.json({ error: { code: "not_found" } }, { status: 404 }),
  );
  await deliverUsage(refused, journal, new AbortController().signal, (event) =>
    events.push(event),
  );
  const diagnostic = journal.status().lastDeliveryFailure;
  assert(diagnostic, "missing durable delivery refusal status");
  assert.equal(diagnostic.kind, "http");
  assert.equal(diagnostic.httpStatus, 404);
  assert.equal(diagnostic.code, "not_found");
  assert.equal(diagnostic.factId, pending.factId);
  assert.equal(diagnostic.evidenceHash, pending.evidenceHash);
  assert.deepEqual(diagnostic.identity, identity);
  assert.equal(diagnostic.activationSupported, false);
  assert(!JSON.stringify(diagnostic).includes(token));
  assert.deepEqual(journal.pending(), [pending]);
  assert.equal(journal.acceptedPage(0, 10).records.length, 0);
  journal.close();
  journal = new UsageJournal(path, identity);
  assert.deepEqual(journal.status().lastDeliveryFailure, diagnostic);
  assert.deepEqual(journal.pending(), [pending]);
  const accepted = new UsageClient(
    "https://control.example.test",
    identity,
    async () => token,
    async () =>
      Response.json(
        {
          fact: {
            ...pending,
            regionId: identity.regionId,
            organizationId: "55555555-5555-4555-8555-555555555555",
            projectId: "66666666-6666-4666-8666-666666666666",
            acceptanceSequence: "9007199254740993",
            acceptedAt: "2026-09-29T00:01:00.000Z",
          },
        },
        { status: 201 },
      ),
  );
  await deliverUsage(accepted, journal, new AbortController().signal, (event) =>
    events.push(event),
  );
  assert.equal(journal.pending().length, 0);
  assert.equal(journal.acceptedPage(0, 10).records.length, 1);
  assert.equal(journal.status().lastDeliveryFailure, null);
  const corrupt = new DatabaseSync(path);
  corrupt
    .prepare(
      "INSERT INTO journal_meta(name,value) VALUES('last_delivery_failure',?)",
    )
    .run(
      JSON.stringify({
        ...diagnostic,
        identity: { ...identity, sourceEpoch: 2 },
      }),
    );
  corrupt.close();
  assert.throws(() => journal.status(), /delivery.*corrupt/);
  const repair = new DatabaseSync(path);
  repair
    .prepare("DELETE FROM journal_meta WHERE name='last_delivery_failure'")
    .run();
  repair.close();

  const pressure = new UsageJournal(join(dir, "pressure.sqlite"), identity, {
    maxAcceptedFacts: 1,
    maxAcceptedBytes: 8192,
  });
  try {
    pressure.beginSession(start);
    pressure.observe(observation(start));
    pressure.observe(observation(start + 1));
    const old = pressure.pending()[0];
    pressure.acknowledgeAccepted({
      fact: old,
      regionId: identity.regionId,
      organizationId: "55555555-5555-4555-8555-555555555555",
      projectId: "66666666-6666-4666-8666-666666666666",
      acceptanceSequence: "1",
      acceptedAt: "2026-09-29T00:01:00.000Z",
    });
    pressure.observe(observation(start + 2));
    const next = pressure.pending()[0];
    const capacityClient = new UsageClient(
      "https://control.example.test",
      identity,
      async () => token,
      async () =>
        Response.json(
          {
            fact: {
              ...next,
              regionId: identity.regionId,
              organizationId: "55555555-5555-4555-8555-555555555555",
              projectId: "66666666-6666-4666-8666-666666666666",
              acceptanceSequence: "2",
              acceptedAt: "2026-09-29T00:01:00.001Z",
            },
          },
          { status: 201 },
        ),
    );
    await deliverUsage(
      capacityClient,
      pressure,
      new AbortController().signal,
      () => {},
    );
    assert.deepEqual(pressure.pending(), [next]);
    assert.equal(pressure.status().lastDeliveryFailure.kind, "local_capacity");
    assert.equal(
      pressure.status().lastDeliveryFailure.code,
      "accepted_capacity_exceeded",
    );
  } finally {
    pressure.close();
  }
});
