// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { newOperationId } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { deleteUnpinnedArchiveKeys } from "../../src/domain/archive-retention-claims.ts";
import {
  enforceBackupRetention,
  expireColdStorageArchives,
} from "../../src/domain/backup-retention.ts";
import {
  ensureArchiveCredential,
  deliverArchiveCredential,
} from "../../src/domain/archive-credentials.ts";
import { startDatabaseMove } from "../../src/domain/database-moves.ts";
import { cleanupRetainedArchives } from "../../src/domain/retained-archives.ts";
import { cleanup, keyedEnv, lifecycle } from "./lifecycle-fixture.ts";
import { request } from "./fixtures.ts";
import {
  insertSnapshotArchive,
  insertSnapshotRehydrate,
} from "./cold-snapshot-fixture.ts";

const objects = new Set<string>();
afterEach(async () => {
  if (objects.size) await env.ARCHIVE.delete([...objects]);
  objects.clear();
  await env.DB.exec(
    "DELETE FROM archive_retention_claims; DELETE FROM archive_pins; DELETE FROM cold_snapshot_chunks; DELETE FROM database_cold_storage WHERE source_operation IS NOT NULL; DELETE FROM database_cold_storage; DELETE FROM cold_storage_operations;",
  );
  await cleanup();
});
async function put(key: string) {
  objects.add(key);
  await env.ARCHIVE.put(key, "data");
}
async function fixture() {
  const f = await lifecycle(),
    row = await f.row(),
    op = newOperationId(),
    now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO cold_storage_operations(id,kind,status,project_id,database_id,generation,created_at,updated_at,completed_at) VALUES(?,'database.archive','succeeded',?,?,1,?,?,?)",
  )
    .bind(op, f.project, f.id, now, now, now)
    .run();
  const pin = () =>
    env.DB.prepare(
      "INSERT INTO archive_pins(operation,archive_path,database_id,created_at) VALUES(?,?,?,?)",
    )
      .bind(op, row.archive_path, f.id, now)
      .run();
  const prefix =
    row.archive_path.replace(`s3://${env.ARCHIVE_BUCKET_NAME}/`, "") + "/";
  return { ...f, path: row.archive_path, prefix, op, now, pin };
}

it("a pin excludes retention even when a database still has a local node", async () => {
  const f = await fixture();
  await f.pin();
  const key = f.prefix + "database/base/20261018T093000/data.tar.gz";
  await put(key);
  let selected = false;
  expect(
    await deleteUnpinnedArchiveKeys(
      env,
      env.ARCHIVE,
      f.path,
      f.prefix,
      async () => {
        selected = true;
        return { keys: [key], value: true };
      },
      Date.now(),
    ),
  ).toBeNull();
  expect(selected).toBe(false);
  expect((await enforceBackupRetention(env, Date.now())).checked).toBe(0);
  expect(await env.ARCHIVE.head(key)).not.toBeNull();
});

it("an in-flight persisted deletion excludes new pins until its exact keys are acknowledged", async () => {
  const f = await fixture(),
    key = f.prefix + "database/old-object";
  await put(key);
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bucket = Object.create(env.ARCHIVE) as R2Bucket;
  bucket.delete = async (keys) => {
    entered();
    await gate;
    await env.ARCHIVE.delete(keys);
  };
  const deleting = deleteUnpinnedArchiveKeys(
    env,
    bucket,
    f.path,
    f.prefix,
    async () => ({ keys: [key], value: "old" }),
    Date.now(),
  );
  await began;
  await expect(f.pin()).rejects.toThrow("archive_retention_in_progress");
  release();
  expect(await deleting).toMatchObject({ keys: [key], value: "old" });
  await f.pin();
  expect(await env.ARCHIVE.head(key)).toBeNull();
});

it("an interrupted deletion resumes only its persisted keys and never selects a newer batch", async () => {
  const f = await fixture(),
    old = f.prefix + "database/old",
    newer = f.prefix + "database/new";
  await put(old);
  await put(newer);
  const bucket = Object.create(env.ARCHIVE) as R2Bucket;
  bucket.delete = async (keys) => {
    await env.ARCHIVE.delete(keys);
    throw new Error("reply_lost");
  };
  await expect(
    deleteUnpinnedArchiveKeys(
      env,
      bucket,
      f.path,
      f.prefix,
      async () => ({ keys: [old], value: true }),
      Date.now(),
    ),
  ).rejects.toThrow("reply_lost");
  await expect(f.pin()).rejects.toThrow("archive_retention_in_progress");
  const resumed = await deleteUnpinnedArchiveKeys(
    env,
    env.ARCHIVE,
    f.path,
    f.prefix,
    async () => {
      throw new Error("must_not_select_new_keys");
    },
    Date.now(),
  );
  expect(resumed).toEqual({ keys: [old], value: null });
  expect(await env.ARCHIVE.head(newer)).not.toBeNull();
  await f.pin();
});

it("an abandoned unprepared claim is safely selected once, and a stale selector cannot dispatch", async () => {
  const f = await fixture(),
    old = f.prefix + "database/old",
    newer = f.prefix + "database/new";
  await put(old);
  await put(newer);
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stale = deleteUnpinnedArchiveKeys(
    env,
    env.ARCHIVE,
    f.path,
    f.prefix,
    async () => {
      entered();
      await gate;
      return { keys: [newer], value: "stale" };
    },
    Date.now(),
  );
  await began;
  const resumed = await deleteUnpinnedArchiveKeys(
    env,
    env.ARCHIVE,
    f.path,
    f.prefix,
    async () => ({ keys: [old], value: "resumed" }),
    Date.now(),
  );
  expect(resumed).toMatchObject({ keys: [old] });
  await f.pin();
  release();
  expect(await stale).toBeNull();
  expect(await env.ARCHIVE.head(newer)).not.toBeNull();
});

async function archived(f: Awaited<ReturnType<typeof fixture>>) {
  await f.pin();
  await insertSnapshotArchive({
    operation: f.op,
    id: f.id,
    project: f.project,
    region: f.region,
    node: f.node,
    path: f.path,
    at: f.now,
  });
  await env.DB.prepare(
    "UPDATE databases SET node_id=NULL,storage_residency='archived',storage_operation_id=?,desired_state='suspended',suspension_reason='idle',observed_state='provisioning',observed_power='hibernated' WHERE id=?",
  )
    .bind(f.op, f.id)
    .run();
}

it("deleting an archived database completes without a node and preserves its deletion-retention archive", async () => {
  const f = await fixture(),
    key = f.prefix + "database/base/20261018T093000/data.tar.gz";
  await put(key);
  await archived(f);
  const response = await request(
    `/v1/databases/${f.id}`,
    f.integrator,
    "DELETE",
  );
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({
    operation: { kind: "database.delete", status: "succeeded" },
    database: { observed_state: "deleted" },
  });
  expect(
    await env.DB.prepare(
      "SELECT released_at FROM archive_pins WHERE operation=?",
    )
      .bind(f.op)
      .first("released_at"),
  ).not.toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT source_database_id FROM retained_archives WHERE source_database_id=?",
    )
      .bind(f.id)
      .first(),
  ).not.toBeNull();
  expect(await env.ARCHIVE.head(key)).not.toBeNull();
});

it("expires an old rehydration source only after its retention window and final pin release", async () => {
  const f = await fixture(),
    key = f.prefix + "database/retained-source";
  await put(key);
  await archived(f);
  const op = newOperationId(),
    at = new Date(Date.now() - 8 * 86_400_000).toISOString();
  const target = f.path.replace(/\/g1-op_[a-z0-9]{20}$/, `/g2-${op}`);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO cold_storage_operations(id,kind,status,project_id,database_id,generation,created_at,updated_at,completed_at) VALUES(?,'database.rehydrate','succeeded',?,?,2,?,?,?)",
    ).bind(op, f.project, f.id, at, at, at),
    env.DB.prepare(
      "UPDATE databases SET node_id=?,storage_residency='local',generation=2,storage_generation=2,archive_path=? WHERE id=?",
    ).bind(f.other, target, f.id),
  ]);
  await insertSnapshotRehydrate({
    operation: op,
    source: f.op,
    node: f.other,
    target,
    at,
    phase: "succeeded",
  });
  expect(await expireColdStorageArchives(env, Date.now())).toEqual({
    archives: 0,
    objects: 0,
  });
  await env.DB.prepare(
    "UPDATE archive_pins SET released_at=? WHERE operation=?",
  )
    .bind(f.now, f.op)
    .run();
  expect(
    await expireColdStorageArchives(env, Date.now() - 2 * 86_400_000),
  ).toEqual({ archives: 0, objects: 0 });
  expect(await expireColdStorageArchives(env, Date.now())).toEqual({
    archives: 0,
    objects: 1,
  });
  expect(await expireColdStorageArchives(env, Date.now())).toEqual({
    archives: 1,
    objects: 0,
  });
  expect(
    await env.DB.prepare(
      "SELECT source_archive_deleted_at FROM database_cold_storage WHERE operation=?",
    )
      .bind(op)
      .first("source_archive_deleted_at"),
  ).not.toBeNull();
});

it("storage-changing requests refuse active archival or an archived database until resume", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "UPDATE databases SET storage_residency='archiving' WHERE id=?",
  )
    .bind(f.id)
    .run();
  expect(
    (await request(`/v1/databases/${f.id}`, f.integrator, "DELETE")).status,
  ).toBe(409);
  await env.DB.prepare(
    "UPDATE databases SET storage_residency='archived',node_id=NULL WHERE id=?",
  )
    .bind(f.id)
    .run();
  const resize = await request(`/v1/databases/${f.id}`, f.integrator, "PATCH", {
    size_class_id: f.size,
  });
  expect(resize.status).toBe(409);
  expect(await resize.json()).toMatchObject({
    error: { details: { reason: "storage_not_local" } },
  });
  await expect(
    startDatabaseMove(env, { databaseId: f.id, targetNodeId: f.other }),
  ).rejects.toMatchObject({ details: { reason: "storage_not_local" } });
});

async function failedTarget(f: Awaited<ReturnType<typeof fixture>>) {
  await archived(f);
  const op = newOperationId(),
    retired = newOperationId();
  const target = f.path.replace(/\/g1-op_[a-z0-9]{20}$/, `/g2-${op}`);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO cold_storage_operations(id,kind,status,project_id,database_id,generation,error_code,error_message,created_at,updated_at,completed_at) VALUES(?,'database.rehydrate','failed',?,?,2,'build_failed','Recovery failed',?,?,?)",
    ).bind(op, f.project, f.id, f.now, f.now, f.now),
    env.DB.prepare(
      "INSERT INTO archive_pins(operation,archive_path,database_id,created_at) VALUES(?,?,?,?)",
    ).bind(op, f.path, f.id, f.now),
    env.DB.prepare(
      "INSERT INTO lifecycle_orders(operation,node_id,type,database_id,storage_generation,remove_volume,created_at) VALUES(?,?,'superseded',?,2,1,?)",
    ).bind(retired, f.other, f.id, f.now),
  ]);
  await insertSnapshotRehydrate({
    operation: op,
    source: f.op,
    node: f.other,
    target,
    at: f.now,
    phase: "failed",
  });
  return retired;
}

it("deletion waits for an interrupted restore target's removal before releasing its source pin", async () => {
  const f = await fixture();
  const retired = await failedTarget(f);
  expect(
    (await request(`/v1/databases/${f.id}`, f.integrator, "DELETE")).status,
  ).toBe(409);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM archive_pins WHERE database_id=? AND released_at IS NULL",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(2);
  await env.DB.prepare(
    "UPDATE lifecycle_orders SET result_status='done',closed_at=? WHERE operation=?",
  )
    .bind(f.now, retired)
    .run();
  const deleted = await request(
    `/v1/databases/${f.id}`,
    f.integrator,
    "DELETE",
  );
  expect(deleted.status).toBe(202);
  expect(await deleted.json()).toMatchObject({
    operation: { status: "succeeded" },
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM archive_pins WHERE database_id=? AND released_at IS NULL",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(0);
});

it("a confirmed tunnel and provider power fence permits deletion after a restore target is permanently lost", async () => {
  const f = await fixture();
  await failedTarget(f);
  await env.DB.prepare(
    "INSERT INTO node_losses(node_id,region_id,declared_at,reason,tunnel_deleted_at,power_off_requested_at) VALUES(?,?,?,'fixture target lost',?,?)",
  )
    .bind(f.other, f.region, f.now, f.now, f.now)
    .run();
  // Declared loss and a power-off request are not proof that the old process stopped.
  expect(
    (await request(`/v1/databases/${f.id}`, f.integrator, "DELETE")).status,
  ).toBe(409);
  await env.DB.prepare(
    "UPDATE node_losses SET powered_off_at=? WHERE node_id=?",
  )
    .bind(f.now, f.other)
    .run();
  const deleted = await request(
    `/v1/databases/${f.id}`,
    f.integrator,
    "DELETE",
  );
  expect(deleted.status).toBe(202);
  expect(await deleted.json()).toMatchObject({
    operation: { status: "succeeded" },
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM archive_pins WHERE database_id=? AND released_at IS NULL",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(0);
});

it("expires a failed target's Barman archive only after positive retirement and its recovery window", async () => {
  const f = await fixture(),
    retired = await failedTarget(f);
  const target = (await env.DB.prepare(
    "SELECT operation,target_archive_path FROM database_cold_storage WHERE database_id=? AND kind='rehydrate'",
  )
    .bind(f.id)
    .first<{ operation: string; target_archive_path: string }>())!;
  const key =
    target.target_archive_path.replace(`s3://${env.ARCHIVE_BUCKET_NAME}/`, "") +
    "/database/base/failed";
  await put(key);
  const after = Date.parse(f.now) + 8 * 86_400_000;
  expect((await expireColdStorageArchives(env, after)).objects).toBe(0);
  await env.DB.prepare(
    "UPDATE lifecycle_orders SET result_status='done',closed_at=? WHERE operation=?",
  )
    .bind(f.now, retired)
    .run();
  expect(
    (await expireColdStorageArchives(env, Date.parse(f.now))).objects,
  ).toBe(0);
  expect(await expireColdStorageArchives(env, after)).toEqual({
    archives: 0,
    objects: 1,
  });
  expect(await expireColdStorageArchives(env, after)).toEqual({
    archives: 1,
    objects: 0,
  });
  expect(
    await env.DB.prepare(
      "SELECT target_archive_deleted_at FROM database_cold_storage WHERE operation=?",
    )
      .bind(target.operation)
      .first("target_archive_deleted_at"),
  ).not.toBeNull();
});

it("deleting after activation failure retains then expires the original source despite the monotonic failed-target archive path", async () => {
  const f = await fixture(),
    retired = await failedTarget(f);
  const target = (await env.DB.prepare(
    "SELECT operation,target_archive_path FROM database_cold_storage WHERE database_id=? AND kind='rehydrate'",
  )
    .bind(f.id)
    .first<{ operation: string; target_archive_path: string }>())!;
  await env.DB.prepare(
    "UPDATE lifecycle_orders SET result_status='done',closed_at=? WHERE operation=?",
  )
    .bind(f.now, retired)
    .run();
  await env.DB.prepare(
    "UPDATE database_cold_storage SET target_serving_generation=3 WHERE operation=?",
  )
    .bind(target.operation)
    .run();
  await env.DB.prepare(
    "UPDATE databases SET generation=3,storage_generation=2,archive_path=?,storage_operation_id=? WHERE id=?",
  )
    .bind(target.target_archive_path, target.operation, f.id)
    .run();
  const sourceKey = f.prefix + "database/original-source",
    targetKey =
      target.target_archive_path.replace(
        `s3://${env.ARCHIVE_BUCKET_NAME}/`,
        "",
      ) + "/database/failed-target";
  await put(sourceKey);
  await put(targetKey);
  expect(
    (await expireColdStorageArchives(env, Date.parse(f.now) + 8 * 86_400_000))
      .objects,
  ).toBe(0);
  expect(
    (await request(`/v1/databases/${f.id}`, f.integrator, "DELETE")).status,
  ).toBe(202);
  const expires = (await env.DB.prepare(
    "SELECT snapshot_retained_until FROM database_cold_storage WHERE operation=?",
  )
    .bind(f.op)
    .first<string>("snapshot_retained_until"))!;
  expect(expires).not.toBeNull();
  expect(
    (await expireColdStorageArchives(env, Date.parse(expires) - 1)).objects,
  ).toBe(0);
  expect(
    (await expireColdStorageArchives(env, Date.parse(expires))).objects,
  ).toBe(1);
  expect(await env.ARCHIVE.head(sourceKey)).toBeNull();
  expect(await env.ARCHIVE.head(targetKey)).not.toBeNull();
  await cleanupRetainedArchives(env, Date.parse(expires));
  expect(await env.ARCHIVE.head(targetKey)).toBeNull();
  await expireColdStorageArchives(env, Date.parse(expires));
  expect(
    await env.DB.prepare(
      "SELECT source_archive_deleted_at FROM database_cold_storage WHERE operation=?",
    )
      .bind(f.op)
      .first("source_archive_deleted_at"),
  ).not.toBeNull();
});

it("a node cannot renew or retrieve the former serving archive's write credential after archival", async () => {
  const f = await fixture(),
    now = Date.now();
  const scope = {
    nodeId: f.node,
    archivePath: f.path,
    access: "read_write" as const,
  };
  const credential = await ensureArchiveCredential(env.DB, scope, now);
  await env.DB.prepare(
    "UPDATE databases SET storage_residency='archived',node_id=NULL WHERE id=?",
  )
    .bind(f.id)
    .run();
  await expect(ensureArchiveCredential(env.DB, scope, now)).rejects.toThrow(
    "archive_credential_refused",
  );
  expect(
    await deliverArchiveCredential(keyedEnv(), f.node, credential.id, now),
  ).toBeNull();
  await expect(
    ensureArchiveCredential(env.DB, { ...scope, access: "read_only" }, now),
  ).resolves.toMatchObject({ id: expect.any(String) });
});
