// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import {
  ArchiveVerificationResult,
  type ArchiveVerificationRequest,
} from "@pgcf/contracts";
import {
  COLD_STORAGE_SLEEP_MS,
  coldStorageVerifications,
  startColdStorageArchive,
  type ColdStorageRow,
} from "../../src/domain/cold-storage.ts";
import { applyLifecycleObservations } from "../../src/domain/lifecycle-observations.ts";
import { qualifyExtendedNative } from "./fixtures.ts";
import {
  BACKUP,
  PROOF,
  cleanup,
  done,
  lifecycle,
  observation,
  report,
} from "./lifecycle-fixture.ts";
const keys = new Set<string>();
export async function cleanupColdFixture() {
  if (keys.size) await env.ARCHIVE.delete([...keys]);
  keys.clear();
  await env.DB.prepare("DELETE FROM cold_storage_cursors").run();
  await cleanup();
}
export const status = async (operation: string) =>
  (await env.DB.prepare("SELECT * FROM database_cold_storage WHERE operation=?")
    .bind(operation)
    .first<ColdStorageRow>())!;
export const residency = (id: string) =>
  env.DB.prepare(
    "SELECT storage_residency,node_id,sleep_since,storage_operation_id,desired_state,suspension_reason,generation,storage_generation FROM databases WHERE id=?",
  )
    .bind(id)
    .first();
export const activePins = (id: string) =>
  env.DB.prepare(
    "SELECT COUNT(*) n FROM archive_pins WHERE database_id=? AND released_at IS NULL",
  )
    .bind(id)
    .first<number>("n");

/** Real local D1/R2/Actors, with controlled node reports. Native disk recovery is separate Dev acceptance. */
export async function sleeping(
  age = COLD_STORAGE_SLEEP_MS + 60_000,
  reason: "idle" | "manual" = "idle",
) {
  const f = await lifecycle();
  const qualified = await qualifyExtendedNative(f);
  const current = Date.now();
  const proof = { ...PROOF, proven_at: new Date(current - age).toISOString() };
  const backupAt = new Date(current - age - 3_600_000).toISOString();
  const backup = {
    ...BACKUP,
    backup_id: backupAt.replace(/[-:]/g, "").slice(0, 15),
    completed_at: backupAt,
  };
  const configured = {
    ...env,
    ...qualified.bindings,
    COLD_STORAGE_ARCHIVAL_ENABLED: "true",
    NATIVE_COLD_STORAGE_RELEASE_IDS: JSON.stringify([qualified.id]),
  };
  const before = await f.row();
  await env.DB.prepare(
    `UPDATE databases SET desired_state='suspended',suspension_reason=?,observed_state='provisioning',observed_power='hibernated',observed_generation=generation,runtime_json=NULL,proven_sleep_json=?,sleep_since=? WHERE id=?`,
  )
    .bind(reason, JSON.stringify(proof), proof.proven_at, f.id)
    .run();
  await applyLifecycleObservations(
    configured,
    f.node,
    report([
      observation({
        id: f.id,
        generation: before.generation,
        operation: f.operation,
        storage_generation: before.storage_generation,
        state: "asleep",
        proven_sleep: proof,
        backup,
      }),
    ]),
  );
  const prefix = `${before.archive_path.replace(`s3://${env.ARCHIVE_BUCKET_NAME}/`, "")}/database/`;
  const info = `${prefix}base/${backup.backup_id}/backup.info`;
  const data = `${prefix}base/${backup.backup_id}/data.tar.gz`;
  const first = `${prefix}wals/0000000100000000/000000010000000000000001.gz`;
  const last = `${prefix}wals/0000000100000000/000000010000000000000002.gz`;
  const put = async (key: string, value = "archive-fixture") => {
    keys.add(key);
    await env.ARCHIVE.put(key, value);
  };
  await put(
    info,
    `status=DONE\nbegin_time=${backupAt}\nend_time=${backupAt}\nbegin_wal=000000010000000000000001\nend_wal=000000010000000000000001\nxlog_segment_size=16777216\n`,
  );
  for (const key of [data, first, last]) await put(key);
  return {
    ...f,
    configured,
    proof,
    backup,
    info,
    data,
    last,
    put,
    current,
    release: qualified.id,
  };
}
export type Fixture = Awaited<ReturnType<typeof sleeping>>;
export async function claimed(f: Fixture) {
  const operation = await startColdStorageArchive(f.configured, f.id);
  expect(operation).not.toBeNull();
  const state = await status(operation!);
  expect(state).toMatchObject({
    phase: "verifying",
    source_node_id: f.node,
    verification_node_id: f.node,
  });
  expect(await coldStorageVerifications(f.configured, f.node)).toEqual([]);
  await applyLifecycleObservations(
    f.configured,
    f.node,
    report([], [done(operation!)]),
  );
  const tasks = await coldStorageVerifications(f.configured, f.node);
  expect(tasks).toHaveLength(1);
  return { operation: operation!, task: tasks[0]! };
}
export const receipt = (task: ArchiveVerificationRequest) =>
  ArchiveVerificationResult.parse({
    operation: task.operation,
    database_id: task.database_id,
    source_generation: task.source_generation,
    source_storage_generation: task.source_storage_generation,
    inventory_sha256: task.inventory_sha256,
    observed_at: new Date().toISOString(),
    status: "verified",
    backup_id: task.source.backup_id,
    end: task.source.end,
    system_identifier: task.source.end.system_identifier,
    timeline: task.source.end.timeline + 1,
    cleaned_up: true,
  });
export async function archived(f: Fixture) {
  const c = await claimed(f);
  await applyLifecycleObservations(f.configured, f.node, {
    ...report([]),
    archive_verifications: [receipt(c.task)],
  });
  const retiring = await status(c.operation);
  expect(retiring.phase).toBe("retiring");
  expect(retiring.retirement_operation).not.toBeNull();
  expect(await residency(f.id)).toMatchObject({
    storage_residency: "archiving",
    node_id: f.node,
  });
  await applyLifecycleObservations(
    f.configured,
    f.node,
    report([], [done(retiring.retirement_operation!)]),
  );
  expect(await residency(f.id)).toMatchObject({
    storage_residency: "archived",
    node_id: null,
  });
  expect(await activePins(f.id)).toBe(1);
  return c;
}
