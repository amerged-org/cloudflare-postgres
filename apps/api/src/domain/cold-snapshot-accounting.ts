// SPDX-License-Identifier: Apache-2.0
import { ColdSnapshotStorage } from "@pgcf/contracts";

/** One correlated scalar read returns bounded accounting, never manifests or per-file data.
 * R2 payloads are immutable between acknowledged PUTs and retirement fences. Pending writes or
 * retirements therefore remain unknown; this is ledger accounting, not a fresh bucket listing. */
export function coldSnapshotStorageSql(database: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(database))
    throw new Error("invalid_database_alias");
  return `(WITH snapshots AS (
    SELECT c.snapshot_manifest_sha256 manifest_sha,c.snapshot_manifest_bytes manifest_bytes,
      c.snapshot_manifest_declared_at declared_at,c.snapshot_chunk_count chunk_count,
      c.cleanup_fenced_at cleanup,c.snapshot_payload_retired_at retired,
      MAX(c.updated_at,${database}.updated_at,
        COALESCE(c.snapshot_manifest_declared_at,c.updated_at),
        COALESCE(c.cleanup_fenced_at,c.updated_at),COALESCE(c.snapshot_payload_retired_at,c.updated_at),
        COALESCE((SELECT MAX(chunk.updated_at) FROM cold_snapshot_chunks chunk WHERE chunk.operation=c.operation),c.updated_at)) accounted_at,
      CASE WHEN c.phase='archived' AND c.snapshot_retained_until IS NOT NULL AND NOT (
        ${database}.deleted_at IS NULL AND ${database}.desired_state<>'deleted' AND ${database}.storage_residency IN('archiving','archived','restoring')
        AND (${database}.storage_operation_id=c.operation OR EXISTS(SELECT 1 FROM database_cold_storage current
          WHERE current.operation=${database}.storage_operation_id AND current.source_operation=c.operation))) THEN 1 ELSE 0 END retained,
      (SELECT COUNT(*) FROM cold_snapshot_chunks chunk WHERE chunk.operation=c.operation) chunk_rows,
      (SELECT COUNT(*) FROM cold_snapshot_chunks chunk WHERE chunk.operation=c.operation AND chunk.state='uploading') pending_chunks,
      (SELECT COUNT(*) FROM cold_snapshot_chunks chunk WHERE chunk.operation=c.operation AND chunk.state='committed'
        AND (chunk.r2_version IS NULL OR chunk.committed_at IS NULL)) bad_commits,
      COALESCE((SELECT SUM(size_bytes) FROM cold_snapshot_chunks chunk WHERE chunk.operation=c.operation
        AND chunk.state='committed' AND chunk.r2_version IS NOT NULL AND chunk.committed_at IS NOT NULL),0) committed_bytes
    FROM database_cold_storage c WHERE c.database_id=${database}.id AND c.kind='archive'
  ), facts AS (
    SELECT retained,accounted_at,
      CASE WHEN retired IS NOT NULL OR manifest_sha IS NULL THEN 0 ELSE COALESCE(manifest_bytes,0)+committed_bytes END bytes,
      CASE WHEN retired IS NULL AND cleanup IS NULL AND ((manifest_sha IS NOT NULL AND declared_at IS NULL) OR pending_chunks>0) THEN 1 ELSE 0 END upload_pending,
      CASE WHEN retired IS NULL AND cleanup IS NOT NULL THEN 1 ELSE 0 END retirement_pending,
      CASE WHEN retired IS NULL AND ((manifest_sha IS NULL AND (manifest_bytes IS NOT NULL OR declared_at IS NOT NULL OR chunk_rows>0))
        OR (manifest_sha IS NOT NULL AND manifest_bytes IS NULL) OR bad_commits>0
        OR (declared_at IS NOT NULL AND (chunk_count IS NULL OR chunk_rows<>chunk_count))) THEN 1 ELSE 0 END metadata_incomplete
    FROM snapshots
  ), totals AS (
    SELECT COALESCE(SUM(bytes),0) bytes,COALESCE(SUM(CASE WHEN retained=1 THEN bytes ELSE 0 END),0) retained_bytes,
      COALESCE(SUM(upload_pending+retirement_pending+metadata_incomplete),0) gaps,
      COALESCE(SUM(CASE WHEN retained=1 THEN upload_pending+retirement_pending+metadata_incomplete ELSE 0 END),0) retained_gaps,
      COALESCE(MAX(upload_pending),0) upload_pending,COALESCE(MAX(retirement_pending),0) retirement_pending,
      COALESCE(MAX(metadata_incomplete),0) metadata_incomplete,MAX(accounted_at) accounted_at FROM facts
  ) SELECT json_object(
    'payload_bytes',CASE WHEN gaps=0 THEN bytes ELSE NULL END,
    'retained_payload_bytes',CASE WHEN retained_gaps=0 THEN retained_bytes ELSE NULL END,
    'accounted_at',accounted_at,
    'gaps',json((SELECT json_group_array(reason) FROM (
      SELECT 'upload_pending' reason WHERE totals.upload_pending=1
      UNION ALL SELECT 'retirement_pending' WHERE totals.retirement_pending=1
      UNION ALL SELECT 'metadata_incomplete' WHERE totals.metadata_incomplete=1
    )))
  ) FROM totals)`;
}

export function coldSnapshotStorageView(
  raw: string | null | undefined,
): ColdSnapshotStorage {
  if (raw !== null && raw !== undefined) {
    try {
      const parsed = ColdSnapshotStorage.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      /* Malformed or overflowing accounting is an explicit gap, never zero. */
    }
  }
  return {
    payload_bytes: null,
    retained_payload_bytes: null,
    accounted_at: null,
    gaps: ["metadata_incomplete"],
  };
}
