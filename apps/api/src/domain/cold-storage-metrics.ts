// SPDX-License-Identifier: Apache-2.0
import { bytesToHex, type StorageResidency } from "@pgcf/contracts";
import type { Env } from "../env.ts";

/** Bound telemetry work independently of the number of archived databases. A partial
 * population never becomes a complete byte total. No R2 listing happens on this path. */
export const COLD_STORAGE_METRIC_SAMPLE_LIMIT = 1000;
interface ArchiveMeasurement {
  id: string;
  archive_path: string;
  region_id: string;
  sample: string | null;
}
interface OperationCounts {
  archives_removed: number;
  restores_succeeded: number;
  restores_failed: number;
  restore_duration_avg_ms: number | null;
  restore_duration_max_ms: number | null;
  oldest_pending_at: string | null;
}
export interface ColdStorageMetrics {
  event: "cold_storage_metrics";
  observed_at: string;
  databases: Record<StorageResidency, number>;
  archives_removed: number;
  restores_24h: {
    succeeded: number;
    failed: number;
    duration_avg_ms: number | null;
    duration_max_ms: number | null;
  };
  oldest_pending_age_ms: number | null;
  archived_backup_bytes: number | null;
  archived_backup_measured: number;
  archived_backup_unknown: number;
  archived_backup_oldest_observed_at: string | null;
  archived_backup_newest_observed_at: string | null;
  released_physical_bytes: null;
}

export async function readColdStorageMetrics(
  env: Pick<Env, "DB">,
  now = Date.now(),
): Promise<ColdStorageMetrics> {
  const at = new Date(now).toISOString(),
    cutoff = new Date(now - 86_400_000).toISOString();
  const [population, operations, archives] = await env.DB.batch([
    env.DB
      .prepare(`SELECT d.storage_residency,COUNT(*) n FROM databases d JOIN projects p ON p.id=d.project_id
      WHERE d.deleted_at IS NULL AND d.desired_state<>'deleted' AND p.deleted_at IS NULL GROUP BY d.storage_residency`),
    env.DB.prepare(
      `SELECT
      (SELECT COUNT(*) FROM database_cold_storage WHERE phase='archived' AND kind='archive' AND source_removed_at IS NOT NULL) archives_removed,
      COUNT(CASE WHEN status='succeeded' THEN 1 END) restores_succeeded,
      COUNT(CASE WHEN status='failed' THEN 1 END) restores_failed,
      AVG(CASE WHEN status='succeeded' AND completed_at>=created_at THEN ROUND((julianday(completed_at)-julianday(created_at))*86400000) END) restore_duration_avg_ms,
      MAX(CASE WHEN status='succeeded' AND completed_at>=created_at THEN ROUND((julianday(completed_at)-julianday(created_at))*86400000) END) restore_duration_max_ms,
      (SELECT MIN(created_at) FROM cold_storage_operations WHERE status IN('pending','running')) oldest_pending_at
      FROM cold_storage_operations WHERE kind='database.rehydrate' AND completed_at>=? AND completed_at<=?`,
    ).bind(cutoff, at),
    env.DB.prepare(
      `SELECT d.id,d.archive_path,d.region_id,
      (SELECT json_object('producer_id',s.producer_id,'observed_at',s.observed_at,'bytes',json_extract(s.payload,'$.backup_bytes'))
       FROM usage_samples s WHERE s.database_id=d.id AND s.source='backup'
       ORDER BY s.observed_at DESC,s.sequence DESC,s.producer_id DESC LIMIT 1) sample
      FROM databases d JOIN projects p ON p.id=d.project_id WHERE d.storage_residency='archived' AND d.deleted_at IS NULL
        AND d.desired_state<>'deleted' AND p.deleted_at IS NULL ORDER BY d.id LIMIT ?`,
    ).bind(COLD_STORAGE_METRIC_SAMPLE_LIMIT),
  ]);
  const databases: Record<StorageResidency, number> = {
    local: 0,
    archiving: 0,
    archived: 0,
    restoring: 0,
  };
  for (const row of population!.results as unknown as {
    storage_residency: StorageResidency;
    n: number;
  }[])
    databases[row.storage_residency] = row.n;
  const counts = operations!.results[0] as unknown as OperationCounts;
  let measured = 0,
    total = 0,
    oldest: string | null = null,
    newest: string | null = null;
  for (const row of archives!.results as unknown as ArchiveMeasurement[]) {
    if (row.sample === null) continue;
    const sample = JSON.parse(row.sample) as {
      producer_id: string;
      observed_at: string;
      bytes: number | null;
    };
    if (
      sample.bytes === null ||
      !Number.isSafeInteger(sample.bytes) ||
      sample.bytes < 0 ||
      !Number.isFinite(Date.parse(sample.observed_at)) ||
      Date.parse(sample.observed_at) > now
    )
      continue;
    // Backup producers bind their size to the measured archive identity. A last sample from an
    // older storage generation must not silently become the current archived generation's size.
    const digest = bytesToHex(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            JSON.stringify([
              row.id,
              {
                archive_path: row.archive_path,
                region_id: row.region_id,
                deleted_at: null,
              },
              sample.bytes,
            ]),
          ),
        ),
      ),
    );
    if (
      sample.producer_id !== `r2_${digest}` ||
      !Number.isSafeInteger(total + sample.bytes)
    )
      continue;
    measured++;
    total += sample.bytes;
    if (oldest === null || sample.observed_at < oldest)
      oldest = sample.observed_at;
    if (newest === null || sample.observed_at > newest)
      newest = sample.observed_at;
  }
  return {
    event: "cold_storage_metrics",
    observed_at: at,
    databases,
    archives_removed: counts.archives_removed,
    restores_24h: {
      succeeded: counts.restores_succeeded,
      failed: counts.restores_failed,
      duration_avg_ms: counts.restore_duration_avg_ms,
      duration_max_ms: counts.restore_duration_max_ms,
    },
    oldest_pending_age_ms:
      counts.oldest_pending_at === null
        ? null
        : Math.max(0, now - Date.parse(counts.oldest_pending_at)),
    archived_backup_bytes: measured === databases.archived ? total : null,
    archived_backup_measured: measured,
    archived_backup_unknown: databases.archived - measured,
    archived_backup_oldest_observed_at: oldest,
    archived_backup_newest_observed_at: newest,
    // Nominal LV sizes and a removal acknowledgment cannot establish reclaimed physical bytes.
    released_physical_bytes: null,
  };
}

export async function emitColdStorageMetrics(
  env: Pick<Env, "DB">,
  now = Date.now(),
): Promise<void> {
  console.log(JSON.stringify(await readColdStorageMetrics(env, now)));
}
