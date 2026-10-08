// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { DesiredResponse, DesiredDatabase } from "@pgcf/contracts";
import type { BuildContext } from "../../src/agent/builders/index.ts";
import { AgentLoop } from "../../src/agent/loop.ts";
import { Reconciler } from "../../src/agent/reconcile.ts";
import { crossRegionRecoveryFixture } from "./recovery-fixture.ts";
import type { PowerCoordinator } from "../../src/agent/power.ts";
import {
  fixture,
  MemoryKubernetes,
  metrics,
  authenticate,
} from "./fixtures.ts";

test("a cross-region restore selects only its exact API source-read map before reconciliation", async (t) => {
  const { db, ctx, source } = crossRegionRecoveryFixture(),
    k8s = new MemoryKubernetes();
  k8s.backupSecret(ctx);
  const observed: unknown[] = [];
  t.mock.method(
    Reconciler.prototype,
    "reconcile",
    async (_db: DesiredDatabase, context?: BuildContext) => {
      observed.push(context);
      return null;
    },
  );
  const desired = {
    region: {
      id: "us-test",
      backup: {
        bucket: ctx.backup.bucket,
        endpoint_url: ctx.backup.endpointUrl,
        region: "auto" as const,
      },
      recovery_sources: {
        [source.region_id]: {
          bucket: source.bucket,
          endpoint_url: source.endpoint_url,
          access_key_id: "source-read-key",
          secret_access_key: "source-read-secret",
        },
      },
    },
    databases: [db],
    next: null,
  };
  const run = () =>
    new AgentLoop(
      { desired: async () => desired, observations: async () => {} },
      k8s,
      ctx.postgresImage,
      new AbortController().signal,
      () => {},
    ).cycle();
  await run();
  assert.deepEqual(
    (observed[0] as typeof ctx).recoverySource,
    ctx.recoverySource,
  );
  assert.deepEqual(
    (observed[0] as typeof ctx).backup.credentials,
    ctx.backup.credentials,
  );
  desired.region.recovery_sources[source.region_id]!.endpoint_url =
    "https://foreign.r2.cloudflarestorage.com";
  await run();
  assert.equal(observed.length, 1);
  desired.region.recovery_sources = {};
  await run();
  assert.equal(observed.length, 1);
  assert.equal(k8s.mutations, 0);
});

async function pendingCycle(
  t: TestContext,
  elapsed: number,
  options: {
    clock?: () => number;
    phaseClock?: () => number;
    ordinary?: "pending" | "ready";
  } = {},
) {
  const { db, ctx } = fixture(),
    k8s = new MemoryKubernetes(),
    abort = new AbortController();
  if (!options.ordinary)
    db.power = {
      operation: db.creation!.operation_id,
      revision: db.generation,
      mode: "running",
      reason: null,
    };
  k8s.backupSecret(ctx);
  k8s.ready = options.ordinary !== "pending";
  const desired: DesiredResponse = {
    region: {
      id: "eu-test",
      backup: {
        bucket: ctx.backup.bucket,
        endpoint_url: ctx.backup.endpointUrl,
        region: "auto",
      },
    },
    databases: [db],
    next: null,
  };
  let monotonic = 100,
    active = false,
    cycles = 0;
  const clock = () => monotonic;
  const intervals: number[] = [],
    timers: NodeJS.Timeout[] = [];
  const original = globalThis.setTimeout;
  let finished: (() => void) | undefined;
  const waited = new Promise<void>((resolve) => {
    finished = resolve;
  });
  t.mock.method(
    globalThis,
    "setTimeout",
    (callback: () => void, milliseconds: number) => {
      assert.equal(active, false);
      intervals.push(milliseconds);
      const timer = original(callback, 600000);
      timer.unref();
      timers.push(timer);
      finished?.();
      return timer;
    },
  );
  const power = {
    prepareRunning: async () => ({
      id: db.id,
      generation: db.generation,
      state: "provisioning",
      archive: { continuous: false, ready_wal_files: null },
    }),
  } as unknown as PowerCoordinator;
  const loop = new AgentLoop(
    {
      desired: async () => {
        assert.equal(active, false);
        active = true;
        cycles++;
        return desired;
      },
      observations: async () => {
        monotonic += elapsed;
        active = false;
      },
    },
    k8s,
    ctx.postgresImage,
    abort.signal,
    () => {},
    Date.now,
    metrics,
    authenticate,
    options.ordinary ? undefined : power,
    undefined,
    options.phaseClock ?? (() => 0),
    options.clock ?? clock,
  );
  const running = loop.run();
  t.after(async () => {
    abort.abort();
    for (const timer of timers) clearTimeout(timer);
    await running;
  });
  await waited;
  assert.equal(cycles, 1);
  assert.equal(active, false);
  return intervals[0];
}

test("successful pending wake work of 500ms waits only the remaining 500ms", async (t) => {
  assert.equal(await pendingCycle(t, 500), 500);
});
test("successful pending wake work exceeding one second schedules no additional delay", async (t) => {
  assert.equal(await pendingCycle(t, 1200), 0);
});

test("a nonfinite cadence measurement retains the full pending-wake interval", async (t) => {
  assert.equal(await pendingCycle(t, 500, { clock: () => NaN }), 1000);
});
test("a backward cadence measurement retains the full pending-wake interval", async (t) => {
  let reads = 0;
  assert.equal(
    await pendingCycle(t, 500, { clock: () => (reads++ === 0 ? 1000 : 900) }),
    1000,
  );
});
test("a failed cadence clock retains the full pending-wake interval without failing the cycle", async (t) => {
  assert.equal(
    await pendingCycle(t, 500, {
      clock: () => {
        throw new Error("clock_unavailable");
      },
    }),
    1000,
  );
});
test("an unsafe cadence magnitude cannot accelerate pending-wake polling", async (t) => {
  assert.equal(
    await pendingCycle(t, 500, { clock: () => Number.MAX_VALUE }),
    1000,
  );
});
test("diagnostic clock failures do not change the independent successful wake cadence", async (t) => {
  assert.equal(
    await pendingCycle(t, 500, {
      phaseClock: () => {
        throw new Error("diagnostic_clock_unavailable");
      },
    }),
    500,
  );
});
test("ordinary pending creation work retains its full five-second interval", async (t) => {
  assert.equal(await pendingCycle(t, 500, { ordinary: "pending" }), 5000);
});
test("ready database work retains its full sixty-second steady interval", async (t) => {
  assert.equal(await pendingCycle(t, 1200, { ordinary: "ready" }), 60000);
});

test("fractional cycle work rounds the remaining timer upward to preserve the minimum cadence", async (t) => {
  assert.equal(await pendingCycle(t, 500.1), 500);
});
