// SPDX-License-Identifier: Apache-2.0
import { coldSnapshotPrefix } from "@pgcf/contracts";
import type { Env } from "../env.ts";
import { archiveBucket } from "./archive-bucket.ts";

interface Snapshot {
  operation: string;
  database_id: string;
  region_id: string;
  source_storage_generation: number;
  snapshot_prefix: string;
  snapshot_cleanup_cursor: number;
}
interface Chunk {
  chunk_index: number;
  state: "expected" | "uploading" | "committed" | "retired";
}

// A failed target may still have a running process. Its read is over only after an exact
// retirement acknowledgment or the existing authoritative tunnel-and-provider power fence.
const noReaders = `NOT EXISTS(SELECT 1 FROM databases d
  WHERE d.id=c.database_id AND d.deleted_at IS NULL AND d.desired_state<>'deleted'
    AND d.storage_residency IN('archiving','archived','restoring')
    AND (d.storage_operation_id=c.operation OR EXISTS(SELECT 1 FROM database_cold_storage current
      WHERE current.operation=d.storage_operation_id AND current.source_operation=c.operation)))
  AND NOT EXISTS(SELECT 1 FROM database_cold_storage reader WHERE reader.source_operation=c.operation
    AND (reader.phase IN('waiting_capacity','restoring','activating') OR (reader.phase='failed' AND reader.target_node_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM lifecycle_orders retired WHERE retired.node_id=reader.target_node_id
        AND retired.database_id=reader.database_id AND retired.storage_generation=reader.target_storage_generation
        AND retired.type='superseded' AND retired.remove_volume=1 AND (retired.result_status='done'
          OR EXISTS(SELECT 1 FROM node_losses loss WHERE loss.node_id=reader.target_node_id
            AND loss.tunnel_deleted_at IS NOT NULL AND loss.powered_off_at IS NOT NULL))))))`;
const eligible = `(c.phase IN('failed','cancelled') OR (c.phase='archived' AND c.snapshot_retained_until<=?))`;

/** Snapshot PUTs are create-only. An acknowledged zero-byte object permanently fences a late
 * unknown PUT; deleting it would reopen that race. Never DELETE a snapshot payload key. */
export async function retireSnapshotObject(
  bucket: R2Bucket,
  key: string,
  operation: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await bucket.head(key);
    if (head?.size === 0 && head.customMetadata?.retired === operation)
      return true;
    const retired = await bucket.put(key, new Uint8Array(0), {
      customMetadata: { retired: operation },
      onlyIf: head ? { etagMatches: head.etag } : { etagDoesNotMatch: "*" },
    });
    if (retired !== null) return true;
    // A payload or another cleanup won the conditional write; read its identity again.
  }
  return false;
}

/** Bounded retirement of unused complete snapshots and failed captures. The declaration and
 * chunk-intent writers share cleanup_fenced_at's D1 CAS; all possible late PUT keys are known
 * before the fence. Tiny retirement objects remain as durable fences, not recoverable data. */
export async function retireColdSnapshots(
  env: Env,
  now: number,
  chunkLimit = 64,
): Promise<{ snapshots_retired: number; chunk_records_retired: number }> {
  if (!Number.isInteger(chunkLimit) || chunkLimit < 1 || chunkLimit > 64)
    throw new Error("invalid_snapshot_retention_limit");
  const at = new Date(now).toISOString();
  const rows = (
    await env.DB.prepare(
      `SELECT c.operation,c.database_id,c.region_id,c.source_storage_generation,c.snapshot_prefix,c.snapshot_cleanup_cursor
     FROM database_cold_storage c WHERE c.kind='archive' AND c.snapshot_payload_retired_at IS NULL
       AND ${noReaders} AND (c.cleanup_fenced_at IS NOT NULL OR ${eligible})
     ORDER BY c.cleanup_fenced_at IS NULL,c.created_at,c.operation LIMIT 2`,
    )
      .bind(at)
      .all<Snapshot>()
  ).results;
  const result = { snapshots_retired: 0, chunk_records_retired: 0 };
  const bucket = archiveBucket(env).bucket;
  for (const row of rows) {
    const prefix = coldSnapshotPrefix(
      row.region_id,
      row.database_id,
      row.source_storage_generation,
      row.operation,
    );
    if (row.snapshot_prefix !== prefix)
      throw new Error("snapshot_retention_identity_mismatch");
    const fenced = await env.DB.prepare(
      `UPDATE database_cold_storage AS c SET cleanup_fenced_at=COALESCE(cleanup_fenced_at,?)
       WHERE operation=? AND kind='archive' AND snapshot_prefix=? AND snapshot_payload_retired_at IS NULL
         AND ${noReaders} AND (cleanup_fenced_at IS NOT NULL OR ${eligible})`,
    )
      .bind(at, row.operation, prefix, at)
      .run();
    if (fenced.meta.changes !== 1) continue;
    if (
      !(await retireSnapshotObject(
        bucket,
        prefix + "manifest.json",
        row.operation,
      ))
    )
      continue;
    const chunks = (
      await env.DB.prepare(
        "SELECT chunk_index,state FROM cold_snapshot_chunks WHERE operation=? AND chunk_index>=? ORDER BY chunk_index LIMIT ?",
      )
        .bind(row.operation, row.snapshot_cleanup_cursor, chunkLimit)
        .all<Chunk>()
    ).results;
    for (const chunk of chunks) {
      // expected means no PUT intent was accepted; the cleanup fence prevents accepting one now.
      if (
        chunk.state !== "expected" &&
        chunk.state !== "retired" &&
        !(await retireSnapshotObject(
          bucket,
          `${prefix}chunks/${String(chunk.chunk_index).padStart(8, "0")}`,
          row.operation,
        ))
      )
        break;
      const updates = await env.DB.batch([
        env.DB.prepare(
          `UPDATE cold_snapshot_chunks SET state='retired',updated_at=? WHERE operation=? AND chunk_index=?
          AND state<>'retired' AND EXISTS(SELECT 1 FROM database_cold_storage WHERE operation=? AND cleanup_fenced_at IS NOT NULL)`,
        ).bind(at, row.operation, chunk.chunk_index, row.operation),
        env.DB.prepare(
          `UPDATE database_cold_storage SET snapshot_cleanup_cursor=MAX(snapshot_cleanup_cursor,?)
          WHERE operation=? AND cleanup_fenced_at IS NOT NULL
          AND EXISTS(SELECT 1 FROM cold_snapshot_chunks WHERE operation=? AND chunk_index=? AND state='retired')`,
        ).bind(
          chunk.chunk_index + 1,
          row.operation,
          row.operation,
          chunk.chunk_index,
        ),
      ]);
      result.chunk_records_retired += updates[0]!.meta.changes;
    }
    const finished = await env.DB.prepare(
      `UPDATE database_cold_storage SET snapshot_payload_retired_at=?,snapshot_cleanup_cursor=MAX(snapshot_cleanup_cursor,COALESCE(snapshot_chunk_count,0)+1) WHERE operation=? AND cleanup_fenced_at IS NOT NULL
       AND snapshot_payload_retired_at IS NULL AND NOT EXISTS(SELECT 1 FROM cold_snapshot_chunks
         WHERE operation=database_cold_storage.operation AND state<>'retired')`,
    )
      .bind(at, row.operation)
      .run();
    result.snapshots_retired += finished.meta.changes;
  }
  return result;
}
