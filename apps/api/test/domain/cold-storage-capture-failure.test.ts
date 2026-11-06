// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { coldStorageVerifications } from "../../src/domain/cold-storage.ts";
import { applyLifecycleObservations } from "../../src/domain/lifecycle-observations.ts";
import {
  sealColdSnapshot,
  uploadColdSnapshotChunk,
} from "../../src/domain/cold-snapshots.ts";
import { report } from "./lifecycle-fixture.ts";
import {
  activePins,
  capturing,
  cleanupColdFixture,
  declareFixtureSnapshot,
  receipt,
  residency,
  sleeping,
  status,
} from "./cold-storage-fixture.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupColdFixture();
});

async function sealedCaptureFailure(
  reason: string,
  beforeReport?: (f: Awaited<ReturnType<typeof sleeping>>) => void,
) {
  const f = await sleeping();
  const c = await capturing(f);
  const snapshot = await declareFixtureSnapshot(f, c);
  await uploadColdSnapshotChunk(
    f.configured,
    c.caller,
    c.operation,
    0,
    snapshot.payload,
  );
  await sealColdSnapshot(f.configured, c.caller, c.operation, snapshot.sha256);
  beforeReport?.(f);
  await applyLifecycleObservations(f.configured, f.node, {
    ...report([]),
    cold_snapshot_captures: [
      {
        operation: c.operation,
        database_id: f.id,
        source_generation: c.capture.source_generation,
        source_storage_generation: c.capture.source_storage_generation,
        observed_at: new Date().toISOString(),
        status: "failed",
        reason,
        cleaned_up: true,
      },
    ],
  });
  return { f, c };
}

it("keeps the local source after a post-seal control mismatch instead of accepting a sealed failed capture", async () => {
  const { f, c } = await sealedCaptureFailure("snapshot_control_mismatch");
  expect(await status(c.operation)).toMatchObject({
    phase: "failed",
    failure: "snapshot_control_mismatch",
    retirement_operation: null,
  });
  expect(await coldStorageVerifications(f.configured, f.node)).toEqual([]);
  expect(await residency(f.id)).toMatchObject({
    storage_residency: "local",
    node_id: f.node,
  });
  expect(await activePins(f.id)).toBe(0);
});

it("fences a known capture failure before cleanup can admit a concurrent verifier", async () => {
  let dispatched = 0;
  const { f, c } = await sealedCaptureFailure(
    "snapshot_source_changed",
    (fixture) => {
      const prototype = Object.getPrototypeOf(env.DB) as D1Database;
      const original = prototype.prepare;
      vi.spyOn(prototype, "prepare").mockImplementation(function (
        this: D1Database,
        sql: string,
      ) {
        const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(statement, {
            get(target, property) {
              if (property === "bind")
                return (...values: unknown[]) => wrap(target.bind(...values));
              if (
                property === "run" &&
                sql.includes("SET capture_receipt_json=")
              )
                return async () => {
                  const result = await target.run();
                  // Another desired-page/observation invocation runs after the cleanup write,
                  // before its caller resumes. It must not acquire retirement authority.
                  const tasks = await coldStorageVerifications(
                    fixture.configured,
                    fixture.node,
                  );
                  dispatched += tasks.length;
                  if (tasks[0])
                    await applyLifecycleObservations(
                      fixture.configured,
                      fixture.node,
                      {
                        ...report([]),
                        archive_verifications: [receipt(tasks[0])],
                      },
                    );
                  return result;
                };
              const value = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        return wrap(original.call(this, sql));
      });
    },
  );
  expect(dispatched).toBe(0);
  expect(await status(c.operation)).toMatchObject({
    phase: "failed",
    failure: "snapshot_source_changed",
    retirement_operation: null,
  });
  expect(await residency(f.id)).toMatchObject({
    storage_residency: "local",
    node_id: f.node,
  });
});

it("continues a sealed capture after a lost seal response, with scratch verification still required", async () => {
  const { f, c } = await sealedCaptureFailure("cold_snapshot_transfer_failed");
  expect(await status(c.operation)).toMatchObject({
    phase: "verifying",
    retirement_operation: null,
  });
  expect(await coldStorageVerifications(f.configured, f.node)).toHaveLength(1);
  expect(await residency(f.id)).toMatchObject({
    storage_residency: "archiving",
    node_id: f.node,
  });
  expect(await activePins(f.id)).toBe(1);
});
