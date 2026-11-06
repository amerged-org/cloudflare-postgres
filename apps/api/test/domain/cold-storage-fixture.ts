// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import {
  ArchiveVerificationResult,
  ColdSnapshotCaptureResult,
  ColdSnapshotManifest,
  bytesToHex,
  type ArchiveVerificationRequest,
} from "@pgcf/contracts";
import {
  COLD_STORAGE_SLEEP_MS,
  coldStorageVerifications,
  coldStorageCaptures,
  startColdStorageArchive,
  type ColdStorageRow,
} from "../../src/domain/cold-storage.ts";
import { applyLifecycleObservations } from "../../src/domain/lifecycle-observations.ts";
import { qualifyExtendedNative } from "./fixtures.ts";
import {
  coldSnapshotChunkKey,
  declareColdSnapshot,
  uploadColdSnapshotChunk,
  sealColdSnapshot,
} from "../../src/domain/cold-snapshots.ts";
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
export async function capturing(f: Fixture) {
  const operation = await startColdStorageArchive(f.configured, f.id);
  expect(operation).not.toBeNull();
  const state = await status(operation!);
  expect(state).toMatchObject({
    phase: "capturing",
    source_node_id: f.node,
    verification_node_id: f.node,
  });
  expect(await coldStorageVerifications(f.configured, f.node)).toEqual([]);
  expect(await coldStorageCaptures(f.configured, f.node)).toEqual([]);
  await applyLifecycleObservations(
    f.configured,
    f.node,
    report([], [done(operation!)]),
  );
  const tasks = await coldStorageCaptures(f.configured, f.node);
  expect(tasks).toHaveLength(1);
  const capture = tasks[0]!;
  const caller = {
    id: f.node,
    uid: f.nodeUid,
    region_id: f.region,
    fenced: false,
  };
  return { operation: operation!, capture, caller };
}
export async function declareFixtureSnapshot(
  f: Fixture,
  c: Awaited<ReturnType<typeof capturing>>,
) {
  const digest = async (bytes: Uint8Array) =>
    bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  const version = new TextEncoder().encode("18\n");
  const witness = new TextEncoder().encode("snapshot-witness");
  const control = new Uint8Array(8192);
  const wal = new Uint8Array(32);
  const pieces = [version, witness, control, wal];
  const names = [
    "PG_VERSION",
    "base/5/16384",
    "global/pg_control",
    "pg_wal/000000010000000000000003",
  ];
  const payload = new Uint8Array(
    pieces.reduce((n, piece) => n + piece.byteLength, 0),
  );
  let offset = 0;
  const files = [];
  for (const [index, piece] of pieces.entries()) {
    payload.set(piece, offset);
    files.push({
      path: names[index]!,
      offset,
      size_bytes: piece.byteLength,
      sha256: await digest(piece),
    });
    offset += piece.byteLength;
  }
  const manifest = ColdSnapshotManifest.parse({
    version: 1,
    operation: c.operation,
    database_id: f.id,
    source_generation: c.capture.source_generation,
    source_storage_generation: c.capture.source_storage_generation,
    pg_major: 18,
    end: c.capture.end,
    total_bytes: payload.byteLength,
    directories: ["base", "base/5", "global", "pg_wal"],
    files,
    chunks: [
      {
        index: 0,
        size_bytes: payload.byteLength,
        sha256: await digest(payload),
      },
    ],
  });
  const encoded = new TextEncoder().encode(JSON.stringify(manifest));
  const sha256 = await digest(encoded);
  const declared = await declareColdSnapshot(
    f.configured,
    c.caller,
    c.operation,
    encoded,
  );
  expect(declared.status).toBe(200);
  const row = await status(c.operation);
  const manifestKey = `${row.snapshot_prefix}manifest.json`;
  const chunkKey = coldSnapshotChunkKey(row.snapshot_prefix, 0);
  keys.add(manifestKey);
  keys.add(chunkKey);
  return { manifest, payload, encoded, sha256, manifestKey, chunkKey };
}
export async function claimed(f: Fixture) {
  const c = await capturing(f);
  const snapshot = await declareFixtureSnapshot(f, c);
  expect(
    (
      await uploadColdSnapshotChunk(
        f.configured,
        c.caller,
        c.operation,
        0,
        snapshot.payload,
      )
    ).status,
  ).toBe(200);
  const sealed = await sealColdSnapshot(
    f.configured,
    c.caller,
    c.operation,
    snapshot.sha256,
  );
  expect(await sealed.json()).toMatchObject({ sealed: true });
  const captured = ColdSnapshotCaptureResult.parse({
    operation: c.operation,
    database_id: f.id,
    source_generation: c.capture.source_generation,
    source_storage_generation: c.capture.source_storage_generation,
    observed_at: new Date().toISOString(),
    status: "captured",
    manifest_sha256: snapshot.sha256,
    manifest_bytes: snapshot.encoded.byteLength,
    end: c.capture.end,
    cleaned_up: true,
  });
  await applyLifecycleObservations(f.configured, f.node, {
    ...report([]),
    cold_snapshot_captures: [captured],
  });
  const tasks = await coldStorageVerifications(f.configured, f.node);
  expect(tasks).toHaveLength(1);
  return { ...c, ...snapshot, task: tasks[0]! };
}
export const receipt = (task: ArchiveVerificationRequest) =>
  ArchiveVerificationResult.parse({
    operation: task.operation,
    database_id: task.database_id,
    source_generation: task.source_generation,
    source_storage_generation: task.source_storage_generation,
    manifest_sha256: task.source.manifest_sha256,
    observed_at: new Date().toISOString(),
    status: "verified",
    end: task.source.end,
    system_identifier: task.source.end.system_identifier,
    timeline: task.source.end.timeline,
    checkpoint_lsn: task.source.end.checkpoint_lsn,
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
