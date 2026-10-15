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
import { awakeWriter, hibernated, idleIntent } from "./parked-tier-fixture.ts";
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
    | {
        state: "failed";
        error_code: string | null;
        direct?: boolean;
        payload?: Record<string, unknown>;
      }
    | { state: "idle" },
  dueDuringTurn = false,
) {
  const input = (await prepareThinStorageLease(f.local, f.node))!;
  let running: NodeBootstrap;
  const container = {
    running: true,
    start: vi.fn(),
    setInactivityTimeout: async () => {},
    getTcpPort: () => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/") return new Response(null, { status: 401 });
        if (
          request.method === "POST" &&
          outcome.state === "failed" &&
          outcome.direct
        )
          return Response.json(
            { ...outcome.payload, error_code: outcome.error_code },
            { status: 400 },
          );
        if (request.method === "POST")
          return Response.json({}, { status: 202 });
        if (dueDuringTurn) await running.thinStorageDue(f.node);
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
  const warning = vi.spyOn(console, "warn");
  let warnings: unknown[][] = [];
  const result = await runInDurableObject(stub(f), async (_instance, state) => {
    Object.defineProperty(state, "container", {
      configurable: true,
      value: container,
    });
    try {
      running = new NodeBootstrap(state, f.local);
      const error = await running.thinStorage(f.node).then(
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
  }).finally(() => {
    warnings = [...warning.mock.calls];
    warning.mockRestore();
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
    fence: {
      kind: "thin_storage",
      operation_id: input.lease.operation_id,
      revision: input.lease.revision,
    },
    warnings,
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

it("retries concurrent inventory reads and driver replacement, but blocks an uncertain dispatched action", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 });
  const action = {
    kind: "grow",
    state: "dispatched",
    nonce: `op_${"x".repeat(20)}`,
    target_data_bytes: 3 * gib,
    target_metadata_bytes: f.profile.metadata_bytes,
    expected_pool_uuid: f.authority.pool_uuid,
    driver_pod_uid: f.authority.driver_pod_uid,
    boot_id: f.qualified.bootId,
    dispatched_at: new Date(Date.now() - 1000).toISOString(),
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
  };
  await env.DB.prepare(
    "UPDATE node_thin_storage SET action_json=? WHERE node_id=?",
  )
    .bind(JSON.stringify(action), f.node)
    .run();
  const inventory = await turn(f, {
    state: "failed",
    error_code: "thin_storage_inventory_changed",
  });
  expect(inventory.error).toBeNull();
  expect(inventory.node).toEqual({
    status: "ready",
    error_code: null,
    lease_id: null,
  });
  expect(inventory.failures).toBe(1);
  const lvs = await turn(f, {
    state: "failed",
    error_code: "thin_storage_lvs_changed",
  });
  expect(lvs.node).toEqual(inventory.node);
  const preflight = await turn(f, {
    state: "failed",
    error_code: "thin_storage_action_preflight_changed",
  });
  expect(preflight.node).toEqual(inventory.node);
  const driver = await turn(f, {
    state: "failed",
    error_code: "thin_storage_driver_ambiguous",
  });
  expect(driver.node).toEqual(inventory.node);
  expect(
    await env.DB.prepare(
      "SELECT action_json FROM node_thin_storage WHERE node_id=?",
    )
      .bind(f.node)
      .first<string>("action_json"),
  ).toBe(JSON.stringify(action));
  const uncertain = await turn(f, {
    state: "failed",
    error_code: "thin_storage_action_unconfirmed",
  });
  expect(uncertain.error).toBe("thin_storage_action_unconfirmed");
  expect(uncertain.node).toMatchObject({
    status: "blocked",
    error_code: "thin_storage_action_unconfirmed",
  });
  expect(
    await env.DB.prepare(
      "SELECT action_json FROM node_thin_storage WHERE node_id=?",
    )
      .bind(f.node)
      .first<string>("action_json"),
  ).toBe(JSON.stringify(action));
});

it("blocks an unrecognized executor failure rather than retrying failed host verification", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 });
  const failed = await turn(f, {
    state: "failed",
    error_code: "patch_extension_resource_invalid",
  });
  expect(failed.error).toBe("thin_storage_executor_unconfirmed");
  expect(failed.node).toMatchObject({
    status: "blocked",
    error_code: "thin_storage_executor_unconfirmed",
  });
  expect(failed.failures).toBe(0);
  expect(failed.warnings).toEqual([
    [
      JSON.stringify({
        event: "thin_storage_executor_failed",
        node_id: f.node,
        ...failed.fence,
        error_code: "patch_extension_resource_invalid",
      }),
    ],
  ]);
});

it("records a native command timeout before retaining the hard block, lease and pending action", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 });
  const action = {
    kind: "initialize",
    state: "pending",
    nonce: `op_${"x".repeat(20)}`,
    target_data_bytes: f.profile.initial_data_bytes,
    target_metadata_bytes: f.profile.metadata_bytes,
    expected_pool_uuid: null,
    driver_pod_uid: null,
    boot_id: null,
    dispatched_at: null,
    deadline_at: null,
  };
  await env.DB.prepare(
    "UPDATE node_thin_storage SET action_json=? WHERE node_id=?",
  )
    .bind(JSON.stringify(action), f.node)
    .run();
  const failed = await turn(f, {
    state: "failed",
    error_code: "command_timeout",
  });
  expect(failed.warnings).toEqual([
    [
      JSON.stringify({
        event: "thin_storage_executor_failed",
        node_id: f.node,
        ...failed.fence,
        error_code: "command_timeout",
      }),
    ],
  ]);
  expect(failed.error).toBe("thin_storage_executor_unconfirmed");
  expect(failed.node).toEqual({
    status: "blocked",
    error_code: "thin_storage_executor_unconfirmed",
    lease_id: failed.fence.operation_id,
  });
  expect(failed.failures).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT action_json FROM node_thin_storage WHERE node_id=?",
    )
      .bind(f.node)
      .first<string>("action_json"),
  ).toBe(JSON.stringify(action));
});

it("records native cancellation without retrying the blocked turn", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 });
  const failed = await turn(f, {
    state: "failed",
    error_code: "job_cancelled",
  });
  expect(failed.warnings).toEqual([
    [
      JSON.stringify({
        event: "thin_storage_executor_failed",
        node_id: f.node,
        ...failed.fence,
        error_code: "job_cancelled",
      }),
    ],
  ]);
  expect(failed.error).toBe("thin_storage_executor_unconfirmed");
  expect(failed.node).toMatchObject({
    status: "blocked",
    lease_id: failed.fence.operation_id,
  });
  expect(failed.failures).toBe(0);
});

it("records the native invalid-request code without exposing its private input", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 });
  const failed = await turn(f, {
    state: "failed",
    error_code: "request_invalid",
    direct: true,
    payload: {
      callback: { bearer: "sensitive-test-bearer" },
      nonce: "sensitive-test-nonce",
      message: "private-test-payload",
    },
  });
  expect(failed.warnings).toEqual([
    [
      JSON.stringify({
        event: "thin_storage_executor_failed",
        node_id: f.node,
        ...failed.fence,
        error_code: "request_invalid",
      }),
    ],
  ]);
  expect(failed.error).toBe("thin_storage_executor_unconfirmed");
  expect(failed.node).toMatchObject({
    status: "blocked",
    lease_id: failed.fence.operation_id,
  });
  expect(failed.failures).toBe(0);
});

it("suppresses a sensitive error string while preserving the failed turn fence", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 });
  const failed = await turn(f, {
    state: "failed",
    error_code: "sensitive_test_bearer",
    direct: true,
    payload: { nonce: "sensitive-test-nonce", message: "private-test-payload" },
  });
  expect(failed.warnings).toEqual([
    [
      JSON.stringify({
        event: "thin_storage_executor_failed",
        node_id: f.node,
        ...failed.fence,
        error_code: null,
      }),
    ],
  ]);
  expect(failed.error).toBe("thin_storage_executor_unconfirmed");
  expect(failed.node).toMatchObject({
    status: "blocked",
    lease_id: failed.fence.operation_id,
  });
});

it("records null for a missing executor error code", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 });
  const failed = await turn(f, {
    state: "failed",
    error_code: null,
    direct: true,
  });
  expect(failed.warnings).toEqual([
    [
      JSON.stringify({
        event: "thin_storage_executor_failed",
        node_id: f.node,
        ...failed.fence,
        error_code: null,
      }),
    ],
  ]);
  expect(failed.error).toBe("thin_storage_executor_unconfirmed");
});

it("suppresses private strings even when they have a patch error prefix", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 });
  const failed = await turn(f, {
    state: "failed",
    error_code: "patch_private_test_payload",
    direct: true,
  });
  expect(failed.warnings).toEqual([
    [
      JSON.stringify({
        event: "thin_storage_executor_failed",
        node_id: f.node,
        ...failed.fence,
        error_code: null,
      }),
    ],
  ]);
  expect(failed.error).toBe("thin_storage_executor_unconfirmed");
  expect(failed.node).toMatchObject({
    status: "blocked",
    lease_id: failed.fence.operation_id,
  });
});

it("suppresses private strings even when they have a thin storage error prefix", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 });
  const failed = await turn(f, {
    state: "failed",
    error_code: "thin_storage_sensitive_test_bearer",
    direct: true,
  });
  expect(failed.warnings).toEqual([
    [
      JSON.stringify({
        event: "thin_storage_executor_failed",
        node_id: f.node,
        ...failed.fence,
        error_code: null,
      }),
    ],
  ]);
  expect(failed.error).toBe("thin_storage_sensitive_test_bearer");
  expect(failed.node).toMatchObject({
    status: "blocked",
    lease_id: failed.fence.operation_id,
  });
});

it("rearms the cadence after a real D1 read error without destroying an executor whose write outcome is unknown", async () => {
  const f = await thinExecutionFixture(releases);
  const result = await runInDurableObject(stub(f), async (_instance, state) => {
    const container = { destroy: vi.fn(async () => {}) };
    Object.defineProperty(state, "container", {
      configurable: true,
      value: container,
    });
    await state.storage.put("thinStorageNodeId", f.node);
    await state.storage.deleteAlarm();
    await env.DB.prepare(
      "ALTER TABLE fleet_node_releases RENAME TO unavailable_fleet_node_releases",
    ).run();
    const before = Date.now();
    try {
      await new NodeBootstrap(state, f.local).alarm();
      return {
        before,
        alarm: await state.storage.getAlarm(),
        failures: await state.storage.get<number>("thinStorageFailures"),
        destroyed: container.destroy.mock.calls.length,
      };
    } finally {
      await env.DB.prepare(
        "ALTER TABLE unavailable_fleet_node_releases RENAME TO fleet_node_releases",
      ).run();
      delete (state as { container?: unknown }).container;
    }
  });
  expect(result.alarm).toBeGreaterThanOrEqual(result.before + 5000);
  expect(result.failures).toBe(1);
  expect(result.destroyed).toBe(0);
});

it("keeps transient backoff when another headroom sample requests a turn", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 });
  const failed = await turn(f, {
    state: "failed",
    error_code: "thin_storage_command_failed",
  });
  const alarm = await runInDurableObject(stub(f), async (_instance, state) => {
    await new NodeBootstrap(state, f.local).thinStorageDue(f.node);
    return state.storage.getAlarm();
  });
  expect(alarm).toBe(failed.alarm);
});

it("starts the next turn immediately for demand received during a successful identity turn", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 });
  const done = await turn(f, { state: "succeeded" }, true);
  expect(done.error).toBeNull();
  expect(done.alarm).toBeGreaterThanOrEqual(done.started);
  expect(done.alarm).toBeLessThanOrEqual(Date.now());
});

it("retains demand received during a failed turn while applying its backoff", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 });
  const failed = await turn(
    f,
    {
      state: "failed",
      error_code: "thin_storage_command_failed",
    },
    true,
  );
  expect(failed.error).toBeNull();
  expect(failed.alarm).toBeGreaterThanOrEqual(failed.started + 5000);
  const requested = await runInDurableObject(stub(f), (_instance, state) =>
    state.storage.get<boolean>("thinStorageDue"),
  );
  expect(requested).toBe(true);
});

/** Forget every turn the node's executor was asked for, as a fresh Durable Object would. */
async function forgetTurns(f: Fixture) {
  await runInDurableObject(stub(f), async (_instance, state) => {
    await state.storage.deleteAlarm();
    await state.storage.deleteAll();
  });
}

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
  // The placement asked for a turn already; a ready report without a receipt asks again.
  await forgetTurns(f);
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

it("a due identity turn without an executor reserves no lease and keeps its cadence", async () => {
  const f = await thinExecutionFixture(releases);
  const result = await runInDurableObject(stub(f), async (_instance, state) => {
    await state.storage.put("thinStorageNodeId", f.node);
    await state.storage.deleteAlarm();
    const before = Date.now();
    // The test runtime's Durable Object has no container binding: no executor can run here.
    await new NodeBootstrap(state, f.local).alarm();
    return {
      before,
      alarm: await state.storage.getAlarm(),
      failures: await state.storage.get<number>("thinStorageFailures"),
    };
  });
  expect(
    await env.DB.prepare(
      "SELECT lease_id,lease_revision FROM node_thin_storage WHERE node_id=?",
    )
      .bind(f.node)
      .first(),
  ).toEqual({ lease_id: null, lease_revision: 0 });
  expect(result.alarm).toBeGreaterThanOrEqual(result.before + 5000);
  expect(result.failures).toBe(1);
});

it("asks for the node's next identity turn at once when a thin database is placed", async () => {
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
  expect(await turnRequested(f)).toBe(false);
  // Only an identity proof reads the new volume into its receipt, which the first token needs.
  DatabaseWithOperation.parse(await (await f.create()).json());
  expect(await turnRequested(f)).toBe(true);
});

it("asks for the node's next identity turn at once when a sleeping thin database resumes", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases));
  const intent = await idleIntent(w);
  await w.evidence({ generation: intent.generation, io: [] });
  expect(await (await hibernated(w, intent)).json()).toEqual({ accepted: 1 });
  await forgetTurns(w.f);
  const resumed = await request(
    `/v1/databases/${w.id}/resume`,
    w.f.integrator,
    "POST",
    undefined,
    crypto.randomUUID(),
  );
  expect(resumed.status).toBe(202);
  expect(await turnRequested(w.f)).toBe(true);
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
