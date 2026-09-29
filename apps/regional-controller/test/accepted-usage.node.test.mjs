// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  statSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { UsageJournal } from "../src/usage-journal.ts";
import { UsageClient } from "../src/usage-client.ts";
import { deliverUsage } from "../src/metering.ts";

const identity = {
  regionId: "11111111-1111-4111-8111-111111111111",
  sourceId: "22222222-2222-4222-8222-222222222222",
  sourceEpoch: 1,
};
const environmentId = "33333333-3333-4333-8333-333333333333",
  organizationId = "44444444-4444-4444-8444-444444444444",
  projectId = "55555555-5555-4555-8555-555555555555";
const start = Date.parse("2026-09-29T00:00:00.000Z");
const allocation = {
  key: `${environmentId}:pod:memory`,
  environmentId,
  specHash: "a".repeat(64),
  resourceUid: "pod:postgres",
  metric: "memory_byte_ms",
  attribution: "primary",
  rate: "9007199254740993",
  continuity: { version: 1, hash: "b".repeat(64) },
  evidenceHash: "c".repeat(64),
};
const snapshot = (at) => ({
  observedAt: at,
  complete: true,
  allocations: [allocation],
  issues: [],
  volumeBindings: [],
});
const receipt = (fact, sequence = "9007199254740993") => ({
  fact: structuredClone(fact),
  regionId: identity.regionId,
  organizationId,
  projectId,
  acceptanceSequence: sequence,
  acceptedAt: "2026-09-29T00:01:00.000Z",
});
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pgcf-accepted-usage-")),
    path = join(dir, "usage.sqlite");
  let journal = new UsageJournal(path, identity, options);
  t.after(() => {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });
  journal.beginSession(start);
  journal.observe(snapshot(start));
  journal.observe(snapshot(start + 1));
  return {
    dir,
    path,
    get journal() {
      return journal;
    },
    reopen() {
      journal.close();
      journal = new UsageJournal(path, identity, options);
      return journal;
    },
  };
}

test("retains the full exact acceptance receipt across lost local acknowledgement and journal restart before removing its replayable outbox fact", (t) => {
  const f = fixture(t),
    first = f.journal.pending()[0],
    accepted = receipt(first);
  assert.equal(
    typeof f.journal.acknowledgeAccepted,
    "function",
    "missing durable acceptance receipt ledger",
  );
  f.reopen();
  assert.deepEqual(f.journal.pending()[0], first);
  assert.equal(f.journal.acknowledgeAccepted(accepted), true);
  assert.equal(f.journal.pending().length, 0);
  f.reopen();
  const page = f.journal.acceptedPage(0, 1);
  assert.equal(page.records.length, 1);
  assert.deepEqual(page.records[0].receipt, accepted);
  assert.equal(page.records[0].receipt.fact.quantity, "9007199254740993");
  assert.equal(f.journal.acknowledgeAccepted(accepted), true);
  assert.throws(
    () =>
      f.journal.acknowledgeAccepted({
        ...accepted,
        acceptanceSequence: "9007199254740994",
      }),
    /conflict/,
  );
  assert.deepEqual(f.journal.acceptedPage(0, 1).records[0].receipt, accepted);
  const legacyPath = join(f.dir, "legacy.sqlite"),
    legacyDb = new DatabaseSync(legacyPath);
  legacyDb.exec(
    "CREATE TABLE journal_meta(name TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;CREATE TABLE usage_outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,fact_id TEXT NOT NULL UNIQUE,payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL,byte_count INTEGER NOT NULL,revision INTEGER NOT NULL,evidence_hash TEXT NOT NULL) STRICT;CREATE TABLE usage_acknowledgements(sequence INTEGER PRIMARY KEY AUTOINCREMENT,fact_id TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL,evidence_hash TEXT NOT NULL) STRICT;",
  );
  legacyDb
    .prepare("INSERT INTO journal_meta VALUES(?,?)")
    .run("schema_version", "1");
  legacyDb
    .prepare("INSERT INTO journal_meta VALUES(?,?)")
    .run("identity", JSON.stringify(identity));
  const payload = JSON.stringify(first),
    payloadHash = createHash("sha256").update(payload).digest("hex");
  legacyDb
    .prepare(
      "INSERT INTO usage_outbox(fact_id,payload_json,payload_hash,byte_count,revision,evidence_hash)VALUES(?,?,?,?,?,?)",
    )
    .run(
      first.factId,
      payload,
      payloadHash,
      Buffer.byteLength(payload),
      1,
      first.evidenceHash,
    );
  legacyDb.close();
  // Existing v1 files were private before upgrade; no old receipt is invented.
  chmodSync(legacyPath, 0o600);
  const upgraded = new UsageJournal(legacyPath, identity);
  try {
    assert.deepEqual(upgraded.pending()[0], first);
    assert.deepEqual(upgraded.acceptedPage(0, 10).history, {
      legacyReceiptHistory: "unknown",
    });
  } finally {
    upgraded.close();
  }
});

test("retains pending data under accepted-ledger pressure and retires only the exact fsynced private archive batch with idempotent replay", (t) => {
  const f = fixture(t, { maxAcceptedFacts: 1, maxAcceptedBytes: 8192 }),
    first = f.journal.pending()[0];
  assert.equal(
    typeof f.journal.archiveAccepted,
    "function",
    "missing verified private acceptance archive",
  );
  assert.equal(f.journal.acknowledgeAccepted(receipt(first, "1")), true);
  f.journal.observe(snapshot(start + 2));
  const second = f.journal.pending()[0],
    next = receipt(second, "2");
  assert.throws(() => f.journal.acknowledgeAccepted(next), /accepted_capacity/);
  assert.deepEqual(f.journal.pending()[0], second);
  const path = join(f.dir, "archive.json");
  const faults = new DatabaseSync(f.path);
  faults.exec(
    "CREATE TRIGGER receipt_archive_failure BEFORE DELETE ON usage_accepted_receipts BEGIN SELECT RAISE(ABORT,'fixture_abort_after_publication'); END;",
  );
  assert.throws(() => f.journal.archiveAccepted(path, 1));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(f.journal.acceptedPage(0, 10).records.length, 1);
  faults.exec("DROP TRIGGER receipt_archive_failure");
  faults.close();
  const archived = f.journal.archiveAccepted(path, 1);
  assert.equal(archived.records, 1);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(
    createHash("sha256").update(readFileSync(path)).digest("hex"),
    archived.sha256,
  );
  assert.equal(f.journal.acceptedPage(0, 10).records.length, 0);
  assert.equal(f.journal.acknowledgeAccepted(next), true);
  assert.deepEqual(f.journal.archiveAccepted(path, 1), archived);
  assert.equal(f.journal.acceptedPage(0, 10).records.length, 1);
  writeFileSync(path, "tampered archive");
  assert.throws(() => f.journal.archiveAccepted(path, 1), /archive/);
  assert.deepEqual(f.journal.acceptedPage(0, 10).records[0].receipt, next);
});

test("the default sender persists strict server receipt metadata and rejects a mismatched owner/time before acknowledging local data", async (t) => {
  const f = fixture(t),
    fact = f.journal.pending()[0];
  let mode = "valid",
    token = `cpmtr_${"a".repeat(43)}`;
  const client = new UsageClient(
    "https://control.example.test",
    identity,
    async () => token,
    async () => {
      const value = {
        ...fact,
        regionId: identity.regionId,
        organizationId,
        projectId,
        acceptanceSequence: "9007199254740993",
        acceptedAt: "2026-09-29T00:01:00.000Z",
      };
      if (mode === "invalid-owner") value.organizationId = "not-a-uuid";
      if (mode === "invalid-time") value.acceptedAt = "not-a-time";
      return Response.json({ fact: value }, { status: 201 });
    },
  );
  assert.equal(
    typeof client.sendReceipt,
    "function",
    "missing strict acceptance receipt transport",
  );
  mode = "invalid-owner";
  await assert.rejects(client.sendReceipt(fact), /acknowledgement/);
  assert.equal(f.journal.pending().length, 1);
  mode = "invalid-time";
  await assert.rejects(client.sendReceipt(fact), /acknowledgement/);
  mode = "valid";
  token = `cpmtr_${"b".repeat(43)}`;
  await deliverUsage(client, f.journal, new AbortController().signal, () => {});
  assert.equal(f.journal.pending().length, 0);
  assert.deepEqual(
    f.journal.acceptedPage(0, 10).records[0].receipt,
    receipt(fact),
  );
  assert.equal(f.journal.status().provisionalOnly, true);
  assert.equal(
    f.journal.acceptedPage(0, 10).records[0].receipt.fact.status,
    "provisional",
  );
});
