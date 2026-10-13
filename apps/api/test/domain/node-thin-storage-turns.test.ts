// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { NodeBootstrap } from "../../src/bootstrap-container.ts";
import { prepareThinStorageLease } from "../../src/domain/node-thin-storage-execution.ts";
import {
  cleanupFixtures,
  observation,
  observedBody,
  request,
} from "./fixtures.ts";
import { thinExecutionFixture } from "./thin-execution-fixture.ts";
import {
  type Fixture,
  gib,
  identityProof,
  turnRequested,
} from "./thin-renewal-fixture.ts";

const releases: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
const stub = (f: Fixture) =>
  env.NODE_BOOTSTRAP.get(
    env.NODE_BOOTSTRAP.idFromName(`thin-storage:${f.node}`),
  );
/** One identity turn whose container records the given outcome; returns what the DO scheduled. */
async function turn(
  f: Fixture,
  outcome:
    | { state: "succeeded" }
    | { state: "failed"; error_code: string }
    | { state: "idle" },
) {
  const input = (await prepareThinStorageLease(f.local, f.node))!;
  const container = {
    running: true,
    start: vi.fn(),
    setInactivityTimeout: async () => {},
    getTcpPort: () => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/") return new Response(null, { status: 401 });
        if (request.method === "POST")
          return Response.json({}, { status: 202 });
        return Response.json(
          outcome.state === "idle"
            ? outcome
            : {
                kind: "thin_storage",
                operation_id: input.lease.operation_id,
                revision: input.lease.revision,
                error_code: null,
                ...outcome,
              },
        );
      },
    }),
  };
  const started = Date.now();
  const result = await runInDurableObject(stub(f), async (_instance, state) => {
    Object.defineProperty(state, "container", {
      configurable: true,
      value: container,
    });
    try {
      const error = await new NodeBootstrap(state, f.local)
        .thinStorage(f.node)
        .then(
          () => null,
          (value: unknown) => value,
        );
      return {
        error: error instanceof Error ? error.message : null,
        alarm: await state.storage.getAlarm(),
        failures: (await state.storage.get<number>("thinStorageFailures")) ?? 0,
      };
    } finally {
      delete (state as { container?: unknown }).container;
    }
  });
  const node = await env.DB.prepare(
    "SELECT status,error_code,lease_id FROM node_thin_storage WHERE node_id=?",
  )
    .bind(f.node)
    .first<{
      status: string;
      error_code: string | null;
      lease_id: string | null;
    }>();
  return {
    ...result,
    started,
    issued: Date.parse(input.lease.issued_at),
    node,
  };
}

it("schedules the next identity turn one inventory interval after the last accepted one", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 });
  const done = await turn(f, { state: "succeeded" });
  expect(done.error).toBeNull();
  expect(done.alarm).toBe(done.issued + 60_000);
});

it("retries a transient failure with backoff up to the cadence and keeps the node ready", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 });
  const first = await turn(f, {
    state: "failed",
    error_code: "thin_storage_command_failed",
  });
  expect(first.error).toBeNull();
  expect(first.node).toEqual({
    status: "ready",
    error_code: null,
    lease_id: null,
  });
  expect(first.failures).toBe(1);
  expect(first.alarm).toBeGreaterThanOrEqual(first.started + 5000);
  expect(first.alarm).toBeLessThanOrEqual(Date.now() + 5000);
  // A refused callback (such as a failed relay transport issuance) and a lost turn are transient too.
  const second = await turn(f, {
    state: "failed",
    error_code: "thin_storage_authority_refused",
  });
  expect(second.failures).toBe(2);
  expect(second.alarm).toBeGreaterThanOrEqual(second.started + 10_000);
  const absent = await turn(f, { state: "idle" });
  expect(absent.node).toMatchObject({ status: "ready", lease_id: null });
  expect(absent.failures).toBe(3);
  expect(absent.alarm).toBeGreaterThanOrEqual(absent.started + 20_000);
  const done = await turn(f, { state: "succeeded" });
  expect(done.failures).toBe(0);
  expect(done.alarm).toBe(done.issued + 60_000);
});

it("blocks the node on an identity or qualification failure as before", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 });
  const failed = await turn(f, {
    state: "failed",
    error_code: "thin_storage_driver_identity_changed",
  });
  expect(failed.error).toBe("thin_storage_driver_identity_changed");
  expect(failed.node).toMatchObject({
    status: "blocked",
    error_code: "thin_storage_driver_identity_changed",
  });
});

it("asks for an identity turn at once when a thin database is ready without a receipt", async () => {
  const f = await thinExecutionFixture(releases);
  await identityProof(f, {
    physical: {
      ...f.authority.physical,
      free_bytes: 80 * gib,
      thin_pool: {
        ...f.authority.physical.thin_pool!,
        data_total_bytes: 16 * gib,
      },
    },
  });
  const created = DatabaseWithOperation.parse(
    await (await f.create()).json(),
  ).database;
  const postgres = f.qualified.spec.components.find(
    (c) => c.name === "postgres",
  )!;
  expect(await turnRequested(f)).toBe(false);
  const ready = await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(created.id, created.generation),
        postgres: {
          image: postgres.reference,
          image_id: `sha256:${postgres.sha256}`,
        },
      },
    ]),
  );
  expect(ready.status).toBe(200);
  expect(await turnRequested(f)).toBe(true);
});

it("a due identity turn moves a later alarm to now", async () => {
  const f = await thinExecutionFixture(releases);
  await runInDurableObject(stub(f), async (_instance, state) => {
    await state.storage.setAlarm(Date.now() + 60_000);
  });
  const before = Date.now();
  await stub(f).thinStorageDue(f.node);
  const alarm = await runInDurableObject(stub(f), (_instance, state) =>
    state.storage.getAlarm(),
  );
  // Either still pending at or before now, or already run.
  expect(alarm === null || alarm <= Date.now()).toBe(true);
  expect(alarm === null || alarm >= before - 1000).toBe(true);
  expect(await turnRequested(f)).toBe(true);
});
