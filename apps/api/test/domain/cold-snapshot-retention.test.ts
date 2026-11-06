// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { newOperationId } from "@pgcf/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { retireColdSnapshots } from "../../src/domain/cold-snapshot-retention.ts";
import {
  ensureArchiveCredential,
  deliverArchiveCredential,
} from "../../src/domain/archive-credentials.ts";
import { deleteUnpinnedArchiveKeys } from "../../src/domain/archive-retention-claims.ts";
import { readColdStorageMetrics } from "../../src/domain/cold-storage-metrics.ts";
import { cleanup, lifecycle, keyedEnv } from "./lifecycle-fixture.ts";
import {
  insertSnapshotArchive,
  insertSnapshotRehydrate,
} from "./cold-snapshot-fixture.ts";
import { request } from "./fixtures.ts";

const keys = new Set<string>();
afterEach(async () => {
  vi.restoreAllMocks();
  if (keys.size) await env.ARCHIVE.delete([...keys]);
  keys.clear();
  await cleanup();
});

async function snapshot(
  phase: "archived" | "cancelled" = "cancelled",
  chunks = 1,
) {
  const f = await lifecycle(),
    row = await f.row(),
    operation = newOperationId(),
    now = Date.now(),
    at = new Date(now).toISOString();
  await env.DB.prepare(
    `INSERT INTO cold_storage_operations(id,kind,status,project_id,database_id,generation,error_code,created_at,updated_at,completed_at)
    VALUES(?,'database.archive',?,?,?,1,?,?,?,?)`,
  )
    .bind(
      operation,
      phase === "archived" ? "succeeded" : "failed",
      f.project,
      f.id,
      phase === "archived" ? null : "cancelled",
      at,
      at,
      at,
    )
    .run();
  const prefix = await insertSnapshotArchive({
    operation,
    id: f.id,
    project: f.project,
    region: f.region,
    node: f.node,
    path: row.archive_path,
    at,
    phase,
    chunkCount: chunks,
    totalBytes: chunks === 1 ? 9 : 4194304 + 9,
  });
  const manifest = prefix + "manifest.json",
    chunk = (i: number) => `${prefix}chunks/${String(i).padStart(8, "0")}`;
  keys.add(manifest);
  for (let i = 0; i < chunks; i++) keys.add(chunk(i));
  if (phase === "archived")
    await env.DB.prepare(
      "UPDATE databases SET storage_residency='archived',storage_operation_id=?,node_id=NULL WHERE id=?",
    )
      .bind(operation, f.id)
      .run();
  const add = async (
    index: number,
    state: "expected" | "uploading" | "committed",
  ) => {
    const body = new Uint8Array(chunks > 1 && index === 0 ? 4194304 : 9);
    const written =
      state === "committed" ? await env.ARCHIVE.put(chunk(index), body) : null;
    await env.DB.prepare(
      `INSERT INTO cold_snapshot_chunks(operation,chunk_index,size_bytes,sha256,state,r2_version,committed_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        operation,
        index,
        body.length,
        "b".repeat(64),
        state,
        written?.version ?? null,
        written ? at : null,
        at,
        at,
      )
      .run();
    return body;
  };
  return {
    ...f,
    operation,
    now,
    at,
    prefix,
    manifest,
    chunk,
    add,
    path: row.archive_path,
  };
}

it("permanently fences unknown late chunk and manifest PUTs while preserving ordinary Barman archives", async () => {
  const f = await snapshot();
  const body = await f.add(0, "uploading"),
    normal =
      f.path.replace(`s3://${env.ARCHIVE_BUCKET_NAME}/`, "") + "/database/keep";
  keys.add(normal);
  await env.ARCHIVE.put(normal, "normal backup");
  const remove = vi.spyOn(Object.getPrototypeOf(env.ARCHIVE), "delete");
  expect(await retireColdSnapshots(env, f.now)).toEqual({
    snapshots_retired: 1,
    chunk_records_retired: 1,
  });
  expect(remove).not.toHaveBeenCalled();
  for (const key of [f.chunk(0), f.manifest]) {
    expect(await env.ARCHIVE.head(key)).toMatchObject({
      size: 0,
      customMetadata: { retired: f.operation },
    });
    // The original caller can finish late after a lost response; its create-only PUT cannot
    // recreate a retired payload because the zero-byte fence remains at the identical key.
    expect(
      await env.ARCHIVE.put(key, body, { onlyIf: { etagDoesNotMatch: "*" } }),
    ).toBeNull();
  }
  expect(await (await env.ARCHIVE.get(normal))!.text()).toBe("normal backup");
});

it("retires undispatched expected chunks without inventing an upload or removing its fence", async () => {
  const f = await snapshot();
  await f.add(0, "expected");
  await retireColdSnapshots(env, f.now);
  expect(await env.ARCHIVE.head(f.chunk(0))).toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT state FROM cold_snapshot_chunks WHERE operation=?",
    )
      .bind(f.operation)
      .first("state"),
  ).toBe("retired");
  await expect(
    env.DB.prepare(
      "UPDATE cold_snapshot_chunks SET state='uploading' WHERE operation=?",
    )
      .bind(f.operation)
      .run(),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare(
      "SELECT cleanup_fenced_at,snapshot_payload_retired_at FROM database_cold_storage WHERE operation=?",
    )
      .bind(f.operation)
      .first(),
  ).toEqual({ cleanup_fenced_at: f.at, snapshot_payload_retired_at: f.at });
});

it("keeps a snapshot referenced by an archived database or an active recovery even after a stale expiry", async () => {
  const f = await snapshot("archived");
  await f.add(0, "committed");
  await env.DB.prepare(
    "UPDATE database_cold_storage SET snapshot_retained_until=? WHERE operation=?",
  )
    .bind(new Date(f.now - 1).toISOString(), f.operation)
    .run();
  expect((await retireColdSnapshots(env, f.now)).snapshots_retired).toBe(0);
  const recovery = newOperationId(),
    target = f.path.replace(/\/g1-op_[a-z0-9]{20}$/, `/g2-${recovery}`);
  await env.DB.prepare(
    "INSERT INTO cold_storage_operations(id,kind,status,project_id,database_id,generation,created_at,updated_at) VALUES(?,'database.rehydrate','running',?,?,2,?,?)",
  )
    .bind(recovery, f.project, f.id, f.at, f.at)
    .run();
  await insertSnapshotRehydrate({
    operation: recovery,
    source: f.operation,
    node: f.other,
    target,
    at: f.at,
    phase: "restoring",
  });
  await env.DB.prepare(
    "UPDATE databases SET storage_residency='restoring',storage_operation_id=? WHERE id=?",
  )
    .bind(recovery, f.id)
    .run();
  expect((await retireColdSnapshots(env, f.now)).snapshots_retired).toBe(0);
  expect((await env.ARCHIVE.head(f.chunk(0)))!.size).toBe(9);
  await env.DB.prepare(
    "UPDATE database_cold_storage SET phase='activating',target_serving_generation=3 WHERE operation=?",
  )
    .bind(recovery)
    .run();
  await env.DB.prepare("UPDATE databases SET node_id=?,generation=3 WHERE id=?")
    .bind(f.other, f.id)
    .run();
  expect((await retireColdSnapshots(env, f.now)).snapshots_retired).toBe(0);
  const metrics = await readColdStorageMetrics(env, f.now);
  expect(metrics.databases.restoring).toBe(1);
  expect(metrics.restores_24h.succeeded).toBe(0);
  expect(metrics.oldest_pending_age_ms).toBe(0);
  const credential = await ensureArchiveCredential(
    env.DB,
    { nodeId: f.other, archivePath: target, access: "read_write" },
    f.now,
  );
  expect(
    (await deliverArchiveCredential(keyedEnv(), f.other, credential.id, f.now))
      ?.access,
  ).toBe("read_write");
  // Even an early/out-of-order local-residency publication cannot release an active reader.
  await env.DB.prepare(
    "UPDATE databases SET storage_residency='local' WHERE id=?",
  )
    .bind(f.id)
    .run();
  expect((await retireColdSnapshots(env, f.now)).snapshots_retired).toBe(0);
  let selected = false;
  expect(
    await deleteUnpinnedArchiveKeys(
      env,
      env.ARCHIVE,
      f.path,
      f.path.replace(`s3://${env.ARCHIVE_BUCKET_NAME}/`, "") + "/",
      async () => {
        selected = true;
        return { keys: [], value: true };
      },
      f.now,
    ),
  ).toBeNull();
  expect(selected).toBe(false);
});

it("replaces payloads atomically and resumes bounded retirement after an unknown acknowledgment", async () => {
  const f = await snapshot("cancelled", 2);
  await f.add(0, "committed");
  await f.add(1, "uploading");
  const put = env.ARCHIVE.put.bind(env.ARCHIVE);
  let faulted = false;
  vi.spyOn(Object.getPrototypeOf(env.ARCHIVE), "put").mockImplementation(
    async (...args: unknown[]) => {
      const [key, body, options] = args as Parameters<R2Bucket["put"]>;
      const result = await put(key, body, options);
      if (key === f.chunk(0) && !faulted) {
        faulted = true;
        throw new Error("acknowledgment_lost");
      }
      return result;
    },
  );
  await expect(retireColdSnapshots(env, f.now, 1)).rejects.toThrow(
    "acknowledgment_lost",
  );
  expect(
    await env.DB.prepare(
      "SELECT snapshot_payload_retired_at FROM database_cold_storage WHERE operation=?",
    )
      .bind(f.operation)
      .first("snapshot_payload_retired_at"),
  ).toBeNull();
  expect((await env.ARCHIVE.head(f.chunk(0)))!.size).toBe(0);
  expect(await retireColdSnapshots(env, f.now, 1)).toEqual({
    snapshots_retired: 0,
    chunk_records_retired: 1,
  });
  expect(await retireColdSnapshots(env, f.now, 1)).toEqual({
    snapshots_retired: 1,
    chunk_records_retired: 1,
  });
  expect(
    await env.DB.prepare(
      "SELECT snapshot_cleanup_cursor FROM database_cold_storage WHERE operation=?",
    )
      .bind(f.operation)
      .first("snapshot_cleanup_cursor"),
  ).toBe(3);
});

it("keeps a deleted archived database's snapshot until its durable retention deadline survives archive metadata cleanup", async () => {
  const f = await snapshot("archived");
  await f.add(0, "committed");
  expect(
    (await request(`/v1/databases/${f.id}`, f.integrator, "DELETE")).status,
  ).toBe(202);
  const deadline = await env.DB.prepare(
    "SELECT snapshot_retained_until FROM database_cold_storage WHERE operation=?",
  )
    .bind(f.operation)
    .first<string>("snapshot_retained_until");
  expect(deadline).not.toBeNull();
  expect(
    (await retireColdSnapshots(env, Date.parse(deadline!) - 1))
      .snapshots_retired,
  ).toBe(0);
  await env.DB.prepare(
    "DELETE FROM retained_archives WHERE source_database_id=?",
  )
    .bind(f.id)
    .run();
  expect(
    (await retireColdSnapshots(env, Date.parse(deadline!))).snapshots_retired,
  ).toBe(1);
});
