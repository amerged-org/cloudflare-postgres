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
import { ApiError } from "../api-error.ts";
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
/** The raw samples one database keeps for one UTC hour; a producer past it is refused. */
const USAGE_HOUR_SAMPLE_LIMIT = 10_000;
export type UsageOutcome = "recorded" | "duplicate" | ApiError;
interface PreparedSample {
  principal: UsageRecorderPrincipal;
  sample: UsageSample;
  payload: string;
  start: string;
  end: string;
  hour: string;
  hourEnd: string;
}
function prepareUsageSample(
  entry: { principal: UsageRecorderPrincipal; sample: UsageSample },
  now: number,
  backupIdentity?: BackupUsageIdentity,
): PreparedSample {
  const principal = UsageRecorderPrincipal.parse(entry.principal),
    parsed = UsageSample.parse(entry.sample);
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
  const hourStart =
    Math.floor(Date.parse(start) / USAGE_HOUR_MS) * USAGE_HOUR_MS;
  if (
    backupIdentity &&
    (sample.source !== "backup" ||
      backupIdentity.region_id !== principal.region_id)
  )
    throw new ApiError(
      "invalid_request",
      "Backup identity is restricted to the authenticated backup recorder",
    );
  return {
    principal,
    sample,
    payload: JSON.stringify(sample),
    start,
    end,
    hour: new Date(hourStart).toISOString(),
    hourEnd: new Date(hourStart + USAGE_HOUR_MS).toISOString(),
  };
}
const identityOf = (p: PreparedSample) =>
  [
    p.sample.database_id,
    p.sample.source,
    p.sample.producer_id,
    p.sample.sequence,
  ] as const;
const SAMPLE_PAYLOAD_SQL =
  "SELECT payload FROM usage_samples WHERE database_id=? AND source=? AND producer_id=? AND sequence=?";
/**
 * One sample's insert. Every acceptance rule is in the statement, so it holds atomically against
 * whatever else writes: the database is in the recorder's region, its hour is not final, a gateway
 * interval does not overlap one of the same producer, and a backup sample still names the archive
 * it measured. `bounded` adds the hour's input limit; a caller that knows the limit cannot be
 * reached leaves it out and saves the count.
 */
function insertUsageSample(
  db: D1Database,
  p: PreparedSample,
  bounded: boolean,
  backupIdentity?: BackupUsageIdentity,
) {
  const { sample, principal } = p;
  return db
    .prepare(
      `INSERT OR IGNORE INTO usage_samples(database_id,source,producer_id,sequence,interval_start,interval_end,observed_at,payload)
    SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM databases WHERE id=? AND region_id=?)
    AND NOT EXISTS(SELECT 1 FROM usage_hourly WHERE database_id=? AND hour=? AND final=1)
    ${bounded ? `AND (SELECT count(*) FROM usage_samples WHERE database_id=? AND interval_start>=? AND interval_start<?)<${USAGE_HOUR_SAMPLE_LIMIT}` : ""}
    AND (? <> 'gateway' OR NOT EXISTS(SELECT 1 FROM usage_samples WHERE database_id=? AND source='gateway' AND producer_id=? AND interval_start<? AND interval_end>?))
    AND (?=0 OR EXISTS(SELECT 1 FROM databases d JOIN regions r ON r.id=d.region_id WHERE d.id=? AND d.region_id=? AND d.archive_path=? AND d.deleted_at IS ? AND r.backup_bucket=?))`,
    )
    .bind(
      ...identityOf(p),
      p.start,
      p.end,
      sample.observed_at,
      p.payload,
      sample.database_id,
      principal.region_id,
      sample.database_id,
      p.hour,
      ...(bounded ? [sample.database_id, p.hour, p.hourEnd] : []),
      sample.source,
      sample.database_id,
      sample.producer_id,
      p.end,
      p.start,
      backupIdentity ? 1 : 0,
      sample.database_id,
      backupIdentity?.region_id ?? null,
      backupIdentity?.archive_path ?? null,
      backupIdentity?.deleted_at ?? null,
      backupIdentity?.backup_bucket ?? null,
    );
}
/**
 * Records samples in the order given, with the outcome of each. Two D1 round trips: one batch
 * that reads the databases and, once per database and hour, how many samples the hour holds, and
 * one batch of the inserts; a third only for samples the insert did not take, to tell a replay
 * from a conflict. A sample whose hour cannot reach the input limit with this request alone is
 * inserted without counting; one that can keeps the count in its statement, which is exact. The
 * uncounted ones rely on the count read before them: another request writing the same hour in
 * between can take it past the limit by at most its own samples, which is slack in a ceiling that
 * only stops a runaway producer.
 *
 * `live` is the measurement route's rule: every database must be live in its recorder's region, or
 * the whole request is refused before anything is recorded. An invalid sample ends the list; the
 * ones before it are recorded and its error is raised, as recording them one at a time did.
 */
export async function recordUsageSamples(
  db: D1Database,
  entries: ReadonlyArray<{
    principal: UsageRecorderPrincipal;
    sample: UsageSample;
  }>,
  options: {
    now?: number;
    backupIdentity?: BackupUsageIdentity;
    live?: boolean;
  } = {},
): Promise<UsageOutcome[]> {
  const now = options.now ?? Date.now(),
    { backupIdentity, live } = options;
  const planned: PreparedSample[] = [];
  let invalid: unknown;
  for (const entry of entries) {
    try {
      planned.push(prepareUsageSample(entry, now, backupIdentity));
    } catch (error) {
      invalid = error;
      break;
    }
  }
  if (planned.length === 0) {
    if (invalid) throw invalid;
    return [];
  }
  const ids = [...new Set(planned.map((p) => p.sample.database_id))];
  const hours = new Map<
    string,
    { database_id: string; hour: string; hourEnd: string; samples: number }
  >();
  for (const p of planned) {
    const key = `${p.sample.database_id}|${p.hour}`,
      known = hours.get(key);
    if (known) known.samples++;
    else
      hours.set(key, {
        database_id: p.sample.database_id,
        hour: p.hour,
        hourEnd: p.hourEnd,
        samples: 1,
      });
  }
  const [found, counted] = (await db.batch([
    db
      .prepare(
        backupIdentity
          ? "SELECT d.id,d.region_id,d.archive_path,d.deleted_at,r.backup_bucket FROM databases d JOIN regions r ON r.id=d.region_id WHERE d.id IN(SELECT value FROM json_each(?))"
          : live
            ? "SELECT d.id,d.region_id FROM databases d JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL WHERE d.deleted_at IS NULL AND d.desired_state<>'deleted' AND d.id IN(SELECT value FROM json_each(?))"
            : "SELECT id,region_id FROM databases WHERE id IN(SELECT value FROM json_each(?))",
      )
      .bind(JSON.stringify(ids)),
    db
      .prepare(
        `SELECT g.database_id,g.hour,(SELECT count(*) FROM usage_samples u WHERE u.database_id=g.database_id AND u.interval_start>=g.hour AND u.interval_start<g.hour_end) n
      FROM (SELECT json_extract(value,'$[0]') database_id,json_extract(value,'$[1]') hour,json_extract(value,'$[2]') hour_end FROM json_each(?)) g`,
      )
      .bind(
        JSON.stringify(
          [...hours.values()].map((h) => [h.database_id, h.hour, h.hourEnd]),
        ),
      ),
  ])) as [
    D1Result<{
      id: string;
      region_id: string;
      archive_path?: string;
      deleted_at?: string | null;
      backup_bucket?: string;
    }>,
    D1Result<{ database_id: string; hour: string; n: number }>,
  ];
  const databases = new Map(found.results.map((row) => [row.id, row]));
  for (const p of planned) {
    const database = databases.get(p.sample.database_id);
    if (!database || database.region_id !== p.principal.region_id)
      throw new ApiError(
        "not_found",
        live ? "Measured database not found" : "Metered database not found",
      );
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
  }
  const held = new Map(
    counted.results.map((row) => [`${row.database_id}|${row.hour}`, row.n]),
  );
  const inserted = await db.batch(
    planned.map((p) => {
      const key = `${p.sample.database_id}|${p.hour}`;
      // Whether this request alone can take the hour past its limit; if not, no count is needed.
      const bounded =
        (held.get(key) ?? 0) + hours.get(key)!.samples >
        USAGE_HOUR_SAMPLE_LIMIT;
      return insertUsageSample(db, p, bounded, backupIdentity);
    }),
  );
  const outcomes: UsageOutcome[] = new Array(planned.length);
  const missed: number[] = [];
  inserted.forEach((result, index) => {
    if (result.meta.changes > 0) outcomes[index] = "recorded";
    else missed.push(index);
  });
  if (missed.length > 0) {
    const persisted = await db.batch<{ payload: string }>(
      missed.map((index) =>
        db.prepare(SAMPLE_PAYLOAD_SQL).bind(...identityOf(planned[index]!)),
      ),
    );
    missed.forEach((index, at) => {
      const stored = persisted[at]!.results[0];
      outcomes[index] =
        stored?.payload === planned[index]!.payload
          ? "duplicate"
          : new ApiError(
              "conflict",
              stored
                ? "Usage sample identity was reused with different measurements"
                : "Usage interval overlaps, is finalized, exceeds its input bound, or has conflicting identity",
            );
    });
  }
  if (invalid) throw invalid;
  return outcomes;
}

export async function recordUsageSample(
  db: D1Database,
  principalInput: UsageRecorderPrincipal,
  input: UsageSample,
  now = Date.now(),
  backupIdentity?: BackupUsageIdentity,
): Promise<"recorded" | "duplicate"> {
  const [outcome] = await recordUsageSamples(
    db,
    [{ principal: principalInput, sample: input }],
    { now, backupIdentity },
  );
  if (outcome instanceof ApiError) throw outcome;
  return outcome!;
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
