// SPDX-License-Identifier: Apache-2.0
import {
  USAGE_HOUR_MS,
  UsageLifecycleEvent,
  UsageQuery,
  UsageRecorderPrincipal,
  UsageSample,
  UsageRow,
  type UsageResponse,
} from "@pgcf/contracts/usage";
import { ApiError } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { assertProjectAccess, getAuth } from "../middleware/auth.ts";
import { databaseForRequest } from "./rows.ts";
import { aggregateUsageDay, emptyUsageMetrics } from "./usage-rollup.ts";

/** Include this statement in the same atomic batch as the lifecycle state change. */
export function usageLifecycleStatement(
  db: D1Database,
  input: UsageLifecycleEvent,
): D1PreparedStatement {
  const event = UsageLifecycleEvent.parse(input);
  return db
    .prepare(
      `INSERT INTO lifecycle_events(database_id,kind,node_id,size_class_id,generation,occurred_at,resource_snapshot)
    SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM lifecycle_events WHERE database_id=? AND kind=? AND generation=?)`,
    )
    .bind(
      event.database_id,
      event.kind,
      event.node_id,
      event.size_class_id,
      event.generation,
      event.occurred_at,
      JSON.stringify(event.resources),
      event.database_id,
      event.kind,
      event.generation,
    );
}

/** Caller authenticates the recorder; producer_id identifies one process epoch, not a reusable replica name. */
export interface BackupUsageIdentity {
  archive_path: string;
  region_id: string;
  backup_bucket: string;
  deleted_at: string | null;
}
export async function recordUsageSample(
  db: D1Database,
  principalInput: UsageRecorderPrincipal,
  input: UsageSample,
  now = Date.now(),
  backupIdentity?: BackupUsageIdentity,
): Promise<"recorded" | "duplicate"> {
  const principal = UsageRecorderPrincipal.parse(principalInput),
    parsed = UsageSample.parse(input);
  const sample: UsageSample =
    parsed.source === "gateway"
      ? {
          ...parsed,
          expected_producers: parsed.expected_producers.slice().sort(),
        }
      : parsed;
  if (
    sample.source !== principal.source ||
    Date.parse(sample.observed_at) > now + 30_000
  )
    throw new ApiError("invalid_request", "Invalid usage recorder observation");
  const start =
    sample.source === "gateway" ? sample.interval_start : sample.observed_at;
  const end =
    sample.source === "gateway" ? sample.interval_end : sample.observed_at;
  const hour = new Date(
    Math.floor(Date.parse(start) / USAGE_HOUR_MS) * USAGE_HOUR_MS,
  ).toISOString();
  const payload = JSON.stringify(sample);
  const identity = [
    sample.database_id,
    sample.source,
    sample.producer_id,
    sample.sequence,
  ] as const;
  if (
    backupIdentity &&
    (sample.source !== "backup" ||
      backupIdentity.region_id !== principal.region_id)
  )
    throw new ApiError(
      "invalid_request",
      "Backup identity is restricted to the authenticated backup recorder",
    );
  const database = await db
    .prepare(
      backupIdentity
        ? "SELECT d.region_id,d.archive_path,d.deleted_at,r.backup_bucket FROM databases d JOIN regions r ON r.id=d.region_id WHERE d.id=?"
        : "SELECT region_id FROM databases WHERE id=?",
    )
    .bind(sample.database_id)
    .first<{
      region_id: string;
      archive_path?: string;
      deleted_at?: string | null;
      backup_bucket?: string;
    }>();
  if (!database || database.region_id !== principal.region_id)
    throw new ApiError("not_found", "Metered database not found");
  if (
    backupIdentity &&
    (database.archive_path !== backupIdentity.archive_path ||
      database.deleted_at !== backupIdentity.deleted_at ||
      database.backup_bucket !== backupIdentity.backup_bucket)
  )
    throw new ApiError(
      "conflict",
      "Backup archive identity changed during measurement",
    );
  const duplicate = await db
    .prepare(
      "SELECT payload FROM usage_samples WHERE database_id=? AND source=? AND producer_id=? AND sequence=?",
    )
    .bind(...identity)
    .first<{ payload: string }>();
  if (duplicate) {
    if (duplicate.payload !== payload)
      throw new ApiError(
        "conflict",
        "Usage sample identity was reused with different measurements",
      );
    return "duplicate";
  }
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO usage_samples(database_id,source,producer_id,sequence,interval_start,interval_end,observed_at,payload)
    SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM databases WHERE id=? AND region_id=?)
    AND NOT EXISTS(SELECT 1 FROM usage_hourly WHERE database_id=? AND hour=? AND final=1)
    AND (SELECT count(*) FROM usage_samples WHERE database_id=? AND interval_start>=? AND interval_start<?)<10000
    AND (? <> 'gateway' OR NOT EXISTS(SELECT 1 FROM usage_samples WHERE database_id=? AND source='gateway' AND producer_id=? AND interval_start<? AND interval_end>?))
    AND (?=0 OR EXISTS(SELECT 1 FROM databases d JOIN regions r ON r.id=d.region_id WHERE d.id=? AND d.region_id=? AND d.archive_path=? AND d.deleted_at IS ? AND r.backup_bucket=?))`,
    )
    .bind(
      ...identity,
      start,
      end,
      sample.observed_at,
      payload,
      sample.database_id,
      principal.region_id,
      sample.database_id,
      hour,
      sample.database_id,
      hour,
      new Date(Date.parse(hour) + USAGE_HOUR_MS).toISOString(),
      sample.source,
      sample.database_id,
      sample.producer_id,
      end,
      start,
      backupIdentity ? 1 : 0,
      sample.database_id,
      backupIdentity?.region_id ?? null,
      backupIdentity?.archive_path ?? null,
      backupIdentity?.deleted_at ?? null,
      backupIdentity?.backup_bucket ?? null,
    )
    .run();
  if (result.meta.changes === 0) {
    const persisted = await db
      .prepare(
        "SELECT payload FROM usage_samples WHERE database_id=? AND source=? AND producer_id=? AND sequence=?",
      )
      .bind(...identity)
      .first<{ payload: string }>();
    if (persisted?.payload === payload) return "duplicate";
    throw new ApiError(
      "conflict",
      "Usage interval overlaps, is finalized, exceeds its input bound, or has conflicting identity",
    );
  }
  return "recorded";
}

interface QueryPeriod {
  database_id: string;
  project_id: string;
  start: string;
  hours: string;
}
interface QueryHour {
  hour: string;
  metrics: string | null;
  gaps: string | null;
  final: number | null;
}
export async function queryUsage(
  c: ApiContext,
  input: UsageQuery,
): Promise<UsageResponse> {
  const query = UsageQuery.parse(input);
  await getAuth(c);
  let scope: string, scopeId: string;
  if (query.database_id) {
    await databaseForRequest(c, query.database_id, true);
    scope = "d.id=?";
    scopeId = query.database_id;
  } else {
    scopeId = query.project_id!;
    await assertProjectAccess(c, scopeId);
    const project = await c.env.DB.prepare(
      "SELECT id FROM projects WHERE id=? AND deleted_at IS NULL",
    )
      .bind(scopeId)
      .first();
    if (!project) throw new ApiError("not_found", "Project not found");
    scope = "d.project_id=?";
  }
  const step =
    query.granularity === "hour" ? USAGE_HOUR_MS : 24 * USAGE_HOUR_MS;
  const [cursorDatabase = "", cursorPeriod = ""] =
    query.cursor?.split("|") ?? [];
  const periodCount = (Date.parse(query.to) - Date.parse(query.from)) / step;
  const databaseLimit = Math.ceil((query.limit + 1) / periodCount) + 1;
  const periods = await c.env.DB.prepare(
    `WITH RECURSIVE periods(start) AS (
    SELECT ? UNION ALL SELECT start+? FROM periods WHERE start+?<?
  ), hours(offset) AS (SELECT 0 UNION ALL SELECT offset+? FROM hours WHERE offset+?<?),
  scoped_databases AS (
    SELECT d.id,d.project_id FROM databases d JOIN projects project ON project.id=d.project_id AND project.deleted_at IS NULL
    WHERE ${scope} AND d.created_at<? AND d.id>=? ORDER BY d.id LIMIT ?
  )
  SELECT d.id database_id,d.project_id,strftime('%Y-%m-%dT%H:00:00.000Z',p.start/1000,'unixepoch') start,
    json_group_array(json_object('hour',strftime('%Y-%m-%dT%H:00:00.000Z',(p.start+h.offset)/1000,'unixepoch'),'metrics',u.metrics,'gaps',u.gaps,'final',u.final)) hours
  FROM scoped_databases d
  CROSS JOIN periods p CROSS JOIN hours h
  LEFT JOIN usage_hourly u ON u.database_id=d.id AND u.hour=strftime('%Y-%m-%dT%H:00:00.000Z',(p.start+h.offset)/1000,'unixepoch')
  WHERE (d.id>? OR (d.id=? AND strftime('%Y-%m-%dT%H:00:00.000Z',p.start/1000,'unixepoch')>?))
  GROUP BY d.id,p.start ORDER BY d.id,p.start LIMIT ?`,
  )
    .bind(
      Date.parse(query.from),
      step,
      step,
      Date.parse(query.to),
      USAGE_HOUR_MS,
      USAGE_HOUR_MS,
      step,
      scopeId,
      query.to,
      cursorDatabase,
      databaseLimit,
      cursorDatabase,
      cursorDatabase,
      cursorPeriod,
      query.limit + 1,
    )
    .all<QueryPeriod>();
  const data = periods.results.slice(0, query.limit).map((period) => {
    const hours: QueryHour[] = JSON.parse(period.hours);
    const rows = hours.map((hour) => {
      const end = new Date(Date.parse(hour.hour) + USAGE_HOUR_MS).toISOString();
      return UsageRow.parse({
        database_id: period.database_id,
        project_id: period.project_id,
        start: hour.hour,
        end,
        final: hour.final === 1,
        metrics:
          hour.metrics === null
            ? emptyUsageMetrics()
            : JSON.parse(hour.metrics),
        gaps:
          hour.gaps === null
            ? ["rollup_pending", ...Object.keys(emptyUsageMetrics())]
            : JSON.parse(hour.gaps),
      });
    });
    return query.granularity === "day" ? aggregateUsageDay(rows) : rows[0]!;
  });
  const last = data.at(-1);
  return {
    data,
    next_cursor:
      periods.results.length > query.limit && last
        ? `${last.database_id}|${last.start}`
        : null,
  };
}
