// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { DatabaseId, NodeId, RegionId, Timestamp } from "@pgcf/contracts";
import { UsageSample } from "@pgcf/contracts/usage";
import { NODE_OBSERVATION_MAX_AGE_MS } from "./placement.ts";

export const BASE_BACKUP_MAX_AGE_MS = 36 * 60 * 60 * 1000;
export const DISK_WARNING_FRACTION = 0.9;
const HealthClock = z.strictObject({
  observed_at: Timestamp.nullable(),
  age_seconds: z.number().nonnegative().nullable(),
});
export const HeartbeatHealth = HealthClock.safeExtend({
  status: z.enum(["ok", "stale", "unknown", "lost"]),
});
export const BackupHealth = HealthClock.safeExtend({
  status: z.enum(["ok", "stale", "failing", "unknown"]),
  last_completed_at: Timestamp.nullable(),
  last_failed_at: Timestamp.nullable(),
});
export const DiskHealth = HealthClock.safeExtend({
  status: z.enum(["ok", "warning", "unknown"]),
  storage_used_bytes: z.number().int().nonnegative().nullable(),
  storage_allocated_bytes: z.number().int().positive().nullable(),
  used_fraction: z.number().nonnegative().nullable(),
});
export const BackupHealthSample = z.strictObject({
  observed_at: Timestamp,
  health: z.enum(["ok", "failing", "unknown"]),
  last_completed_at: Timestamp.nullable(),
  last_failed_at: Timestamp.nullable(),
});
export type BackupHealthSample = z.infer<typeof BackupHealthSample>;

function age(
  observedAt: string | null | undefined,
  now: number,
): number | null {
  if (observedAt == null || !Timestamp.safeParse(observedAt).success)
    return null;
  const observed = Date.parse(observedAt);
  return Number.isFinite(observed) && observed <= now + 5000
    ? Math.max(0, (now - observed) / 1000)
    : null;
}
export function heartbeatHealth(
  observedAt: string | null,
  lostAt: string | null = null,
  now = Date.now(),
): z.infer<typeof HeartbeatHealth> {
  const seconds = age(observedAt, now);
  return {
    status:
      lostAt !== null
        ? "lost"
        : seconds === null
          ? "unknown"
          : seconds * 1000 > NODE_OBSERVATION_MAX_AGE_MS
            ? "stale"
            : "ok",
    observed_at: seconds === null ? null : observedAt,
    age_seconds: seconds,
  };
}
export function backupHealth(
  sample: BackupHealthSample | null,
  now = Date.now(),
): z.infer<typeof BackupHealth> {
  const seconds = age(sample?.observed_at, now);
  const completedAge = age(sample?.last_completed_at, now);
  const failedAge = age(sample?.last_failed_at, now);
  const result = {
    status: "unknown" as z.infer<typeof BackupHealth>["status"],
    observed_at: seconds === null ? null : sample!.observed_at,
    age_seconds: seconds,
    last_completed_at: completedAge === null ? null : sample!.last_completed_at,
    last_failed_at: failedAge === null ? null : sample!.last_failed_at,
  };
  if (
    !sample ||
    seconds === null ||
    seconds * 1000 > NODE_OBSERVATION_MAX_AGE_MS ||
    sample.health === "unknown"
  )
    return result;
  if (
    sample.health === "failing" ||
    (failedAge !== null && (completedAge === null || failedAge < completedAge))
  )
    return { ...result, status: "failing" };
  if (completedAge === null) return result;
  return {
    ...result,
    status: completedAge * 1000 > BASE_BACKUP_MAX_AGE_MS ? "stale" : "ok",
  };
}
export function diskHealth(
  sample: z.infer<typeof UsageSample> | null,
  now = Date.now(),
): z.infer<typeof DiskHealth> {
  const seconds = age(sample?.observed_at, now);
  const measured =
    sample?.source === "agent" &&
    Number.isSafeInteger(sample.storage_used_bytes) &&
    Number.isSafeInteger(sample.storage_allocated_bytes) &&
    sample.storage_used_bytes! >= 0 &&
    sample.storage_allocated_bytes! > 0;
  const fraction = measured
    ? sample!.storage_used_bytes! / sample!.storage_allocated_bytes!
    : null;
  return {
    status:
      !measured ||
      seconds === null ||
      seconds * 1000 > NODE_OBSERVATION_MAX_AGE_MS
        ? "unknown"
        : fraction! >= DISK_WARNING_FRACTION
          ? "warning"
          : "ok",
    observed_at: seconds === null ? null : sample!.observed_at,
    age_seconds: seconds,
    storage_used_bytes: measured ? sample!.storage_used_bytes! : null,
    storage_allocated_bytes: measured ? sample!.storage_allocated_bytes! : null,
    used_fraction: fraction,
  };
}
export const OperationalRegionHealth = z.strictObject({
  id: RegionId,
  created_at: Timestamp,
  agent: HeartbeatHealth,
});
export const OperationalNodeHealth = z.strictObject({
  id: NodeId,
  region_id: RegionId,
  created_at: Timestamp,
  observation: HeartbeatHealth,
});
export const OperationalDatabaseHealth = z.strictObject({
  id: DatabaseId,
  region_id: RegionId,
  node_id: NodeId.nullable(),
  created_at: Timestamp,
  backup: BackupHealth,
  disk: DiskHealth,
});
export type OperationalHealthRow =
  | z.infer<typeof OperationalRegionHealth>
  | z.infer<typeof OperationalNodeHealth>
  | z.infer<typeof OperationalDatabaseHealth>;
export async function readOperationalHealth(
  db: D1Database,
  scope: "regions" | "nodes" | "databases",
  pagination: { limit: number; cursor: { sql: string; bindings: string[] } },
  now = Date.now(),
): Promise<OperationalHealthRow[]> {
  const limit = pagination.limit + 1;
  const cursor = pagination.cursor;
  if (scope === "regions") {
    const result = await db
      .prepare(
        `SELECT id,created_at,agent_last_seen_at FROM regions WHERE ${cursor.sql} ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .bind(...cursor.bindings, limit)
      .all<{
        id: string;
        created_at: string;
        agent_last_seen_at: string | null;
      }>();
    return result.results.map(({ agent_last_seen_at, ...row }) => ({
      ...row,
      agent: heartbeatHealth(agent_last_seen_at, null, now),
    }));
  }
  if (scope === "nodes") {
    const result = await db
      .prepare(
        `SELECT id,region_id,created_at,last_observed_at,lost_at FROM nodes WHERE ${cursor.sql} ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .bind(...cursor.bindings, limit)
      .all<{
        id: string;
        region_id: string;
        created_at: string;
        last_observed_at: string | null;
        lost_at: string | null;
      }>();
    return result.results.map(({ last_observed_at, lost_at, ...row }) => ({
      ...row,
      observation: heartbeatHealth(last_observed_at, lost_at, now),
    }));
  }
  const result = await db
    .prepare(
      `SELECT id,region_id,node_id,created_at,backup_observed_at,backup_health,backup_last_completed_at,backup_last_failed_at,
    (SELECT payload FROM usage_samples s WHERE s.database_id=databases.id AND s.source='agent' ORDER BY s.observed_at DESC,s.producer_id DESC,s.sequence DESC LIMIT 1) disk_sample
    FROM databases WHERE deleted_at IS NULL AND ${cursor.sql} ORDER BY created_at DESC,id DESC LIMIT ?`,
    )
    .bind(...cursor.bindings, limit)
    .all<{
      id: string;
      region_id: string;
      node_id: string | null;
      created_at: string;
      backup_observed_at: string | null;
      backup_health: BackupHealthSample["health"];
      backup_last_completed_at: string | null;
      backup_last_failed_at: string | null;
      disk_sample: string | null;
    }>();
  return result.results.map(
    ({
      backup_observed_at,
      backup_health,
      backup_last_completed_at,
      backup_last_failed_at,
      disk_sample,
      ...row
    }) => {
      const backup = BackupHealthSample.safeParse({
        observed_at: backup_observed_at,
        health: backup_health,
        last_completed_at: backup_last_completed_at,
        last_failed_at: backup_last_failed_at,
      });
      let disk: z.infer<typeof UsageSample> | null = null;
      if (disk_sample !== null) {
        try {
          const parsed = UsageSample.safeParse(JSON.parse(disk_sample));
          if (parsed.success) disk = parsed.data;
        } catch {
          /* Corrupt persisted samples remain unknown. */
        }
      }
      return {
        ...row,
        backup: backupHealth(backup.success ? backup.data : null, now),
        disk: diskHealth(disk, now),
      };
    },
  );
}
