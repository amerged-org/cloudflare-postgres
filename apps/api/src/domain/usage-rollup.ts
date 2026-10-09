// SPDX-License-Identifier: Apache-2.0
import {
  USAGE_FINAL_DELAY_MS,
  USAGE_HOUR_MS,
  USAGE_METRICS,
  UsageResourceSnapshot,
  UsageSample,
  UsageRow,
  type UsageGap,
  type UsageMetrics,
} from "@pgcf/contracts/usage";

export interface MeteredDatabase {
  id: string;
  project_id: string;
  created_at: string;
}
export interface MeteredEvent {
  id: number;
  kind: string;
  occurred_at: string;
  resource_snapshot: string | null;
}
export interface StoredSample {
  payload: string;
}
export function emptyUsageMetrics(): UsageMetrics {
  return Object.fromEntries(
    USAGE_METRICS.map((metric) => [metric, null]),
  ) as UsageMetrics;
}
const resourceMetrics = [
  "memory_mib_seconds",
  "cpu_millicore_seconds",
  "reserved_memory_mib_seconds",
  "reserved_cpu_millicore_seconds",
  "reserved_storage_byte_seconds",
] as const;
const trafficMetrics = [
  "ingress_bytes",
  "egress_bytes",
  "connections",
  "connection_seconds",
] as const;

export function computeUsageHour(
  database: MeteredDatabase,
  hour: number,
  events: MeteredEvent[],
  stored: StoredSample[],
  now: number,
): UsageRow {
  if (
    !Number.isFinite(hour) ||
    hour % USAGE_HOUR_MS !== 0 ||
    !Number.isFinite(now)
  )
    throw new TypeError("Invalid rollup boundary");
  const end = hour + USAGE_HOUR_MS,
    measuredEnd = Math.min(end, Math.max(hour, now));
  const metrics = emptyUsageMetrics(),
    gaps = new Set<UsageGap>();
  let provisioned = false,
    awake = false,
    known = hour < Date.parse(database.created_at);
  let resources: UsageResourceSnapshot | null = null,
    cursor = hour;
  metrics.provisioned_seconds = 0;
  metrics.awake_seconds = 0;
  for (const key of resourceMetrics) metrics[key] = 0;
  const active: [number, number][] = [];
  function segment(until: number): void {
    if (until <= cursor) return;
    const seconds = (until - cursor) / 1000;
    if (!known) {
      gaps.add("lifecycle");
      metrics.provisioned_seconds = null;
      metrics.awake_seconds = null;
      for (const key of resourceMetrics) metrics[key] = null;
    } else if (provisioned) {
      active.push([cursor, until]);
      if (metrics.provisioned_seconds !== null)
        metrics.provisioned_seconds += seconds;
      if (metrics.awake_seconds !== null && awake)
        metrics.awake_seconds += seconds;
      if (!resources) {
        gaps.add("resource_snapshot");
        for (const key of resourceMetrics) metrics[key] = null;
      } else {
        const values = [
          awake ? resources.memory_mib * seconds : 0,
          awake ? resources.cpu_millicores * seconds : 0,
          resources.reserved_memory_mib * seconds,
          resources.reserved_cpu_millicores * seconds,
          resources.storage_allocated_bytes === null
            ? null
            : resources.storage_allocated_bytes * seconds,
        ];
        for (const [index, key] of resourceMetrics.entries()) {
          const value = values[index];
          if (value == null) {
            metrics[key] = null;
            gaps.add(key);
          } else if (metrics[key] !== null) metrics[key] += value;
        }
      }
    }
    cursor = until;
  }
  const sorted = [...events].sort(
    (a, b) =>
      Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.id - b.id,
  );
  for (const event of sorted) {
    const at = Date.parse(event.occurred_at);
    if (!Number.isFinite(at)) {
      gaps.add("lifecycle");
      known = false;
      continue;
    }
    if (at >= measuredEnd) break;
    if (at >= hour) segment(at);
    const parsed =
      event.resource_snapshot === null
        ? null
        : (() => {
            try {
              return UsageResourceSnapshot.safeParse(
                JSON.parse(event.resource_snapshot),
              );
            } catch {
              return null;
            }
          })();
    resources = parsed?.success ? parsed.data : null;
    switch (event.kind) {
      case "created":
        provisioned = true;
        awake = false;
        known = true;
        break;
      case "ready":
      case "woke":
        provisioned = true;
        known = true;
        awake = true;
        break;
      case "hibernated":
      case "suspended":
        provisioned = true;
        known = true;
        awake = false;
        break;
      case "deleted":
        known = true;
        provisioned = false;
        awake = false;
        break;
      case "resized":
        break;
      default:
        known = false;
        gaps.add("lifecycle");
    }
  }
  segment(measuredEnd);
  if (gaps.has("lifecycle")) {
    metrics.provisioned_seconds = null;
    metrics.awake_seconds = null;
    for (const key of resourceMetrics) metrics[key] = null;
  }
  const samples: UsageSample[] = [];
  for (const row of stored) {
    try {
      const parsed = UsageSample.safeParse(JSON.parse(row.payload));
      if (parsed.success && parsed.data.database_id === database.id)
        samples.push(parsed.data);
    } catch {
      /* Invalid persisted measurements remain missing. */
    }
  }
  for (const [source, input, output] of [
    ["agent", "storage_used_bytes", "storage_used_bytes_max"],
    ["agent", "storage_allocated_bytes", "storage_allocated_bytes"],
    ["backup", "backup_bytes", "backup_bytes_max"],
  ] as const) {
    const values = samples
      .filter(
        (s) =>
          s.source === source &&
          Date.parse(s.observed_at) >= hour &&
          (Date.parse(s.observed_at) < measuredEnd ||
            (measuredEnd < end && Date.parse(s.observed_at) === measuredEnd)),
      )
      .map((s) => (s as unknown as Record<string, unknown>)[input]);
    const measured = values.filter((v): v is number => typeof v === "number");
    metrics[output] =
      values.some((v) => v === null) || measured.length === 0
        ? null
        : Math.max(...measured);
  }
  const traffic = samples.filter(
    (s): s is Extract<UsageSample, { source: "gateway" }> =>
      s.source === "gateway" &&
      Date.parse(s.interval_start) >= hour &&
      Date.parse(s.interval_end) <= measuredEnd,
  );
  const roster = traffic[0]?.expected_producers.slice().sort();
  let covered =
    metrics.provisioned_seconds !== null &&
    (active.length === 0 || roster !== undefined);
  if (roster) {
    const rosterJson = JSON.stringify(roster);
    if (
      traffic.some(
        (s) =>
          JSON.stringify(s.expected_producers.slice().sort()) !== rosterJson,
      )
    )
      covered = false;
    for (const producer of roster) {
      const intervals = traffic
        .filter((s) => s.producer_id === producer)
        .sort(
          (a, b) => Date.parse(a.interval_start) - Date.parse(b.interval_start),
        );
      for (let index = 1; index < intervals.length; index++)
        if (
          Date.parse(intervals[index]!.interval_start) <
          Date.parse(intervals[index - 1]!.interval_end)
        )
          covered = false;
      for (const [start, finish] of active) {
        let cursor = start;
        for (const sample of intervals) {
          const sampleStart = Date.parse(sample.interval_start),
            sampleEnd = Date.parse(sample.interval_end);
          if (sampleEnd <= cursor || sampleStart >= finish) continue;
          if (sampleStart > cursor) break;
          cursor = Math.max(cursor, sampleEnd);
        }
        if (cursor < finish) covered = false;
      }
    }
  }
  if (!covered) gaps.add("traffic_coverage");
  for (const metric of trafficMetrics) {
    if (covered && active.length === 0 && traffic.length === 0)
      metrics[metric] = 0;
    else
      metrics[metric] =
        covered && traffic.every((sample) => sample[metric] !== null)
          ? traffic.reduce((sum, sample) => sum + (sample[metric] ?? 0), 0)
          : null;
  }
  for (const metric of USAGE_METRICS) {
    if (
      metrics[metric] !== null &&
      (!Number.isFinite(metrics[metric]) ||
        metrics[metric]! > Number.MAX_SAFE_INTEGER)
    )
      metrics[metric] = null;
    if (metrics[metric] === null) gaps.add(metric);
  }
  return UsageRow.parse({
    database_id: database.id,
    project_id: database.project_id,
    start: new Date(hour).toISOString(),
    end: new Date(end).toISOString(),
    final: now >= end + USAGE_FINAL_DELAY_MS,
    metrics,
    gaps: [...gaps].sort(),
  });
}

export async function rollupUsageHour(
  db: D1Database,
  databaseId: string,
  hour: number,
  now = Date.now(),
): Promise<UsageRow> {
  return rollupAttempt(db, databaseId, hour, now, 0);
}

async function rollupAttempt(
  db: D1Database,
  databaseId: string,
  hour: number,
  now: number,
  attempt: number,
): Promise<UsageRow> {
  if (!Number.isFinite(hour) || hour % USAGE_HOUR_MS !== 0 || hour > now)
    throw new TypeError("Invalid rollup boundary");
  const timestamp = new Date(hour).toISOString(),
    end = new Date(hour + USAGE_HOUR_MS).toISOString();
  const database = await db
    .prepare("SELECT id,project_id,created_at FROM databases WHERE id=?")
    .bind(databaseId)
    .first<MeteredDatabase>();
  if (!database) throw new TypeError("Unknown metered database");
  const results = await db.batch([
    db
      .prepare(
        `SELECT id,kind,occurred_at,resource_snapshot FROM lifecycle_events WHERE database_id=? AND occurred_at<? AND (
          occurred_at>=? OR id=(SELECT id FROM lifecycle_events WHERE database_id=? AND occurred_at<? ORDER BY occurred_at DESC,id DESC LIMIT 1)
          OR id=(SELECT id FROM lifecycle_events WHERE database_id=? AND occurred_at<? AND kind<>'resized' ORDER BY occurred_at DESC,id DESC LIMIT 1)
        ) ORDER BY occurred_at,id LIMIT 10001`,
      )
      .bind(
        databaseId,
        end,
        timestamp,
        databaseId,
        timestamp,
        databaseId,
        timestamp,
      ),
    db
      .prepare(
        "SELECT payload FROM usage_samples WHERE database_id=? AND interval_start>=? AND interval_start<? ORDER BY interval_start,producer_id,sequence LIMIT 10001",
      )
      .bind(databaseId, timestamp, end),
    db
      .prepare(
        "SELECT COALESCE((SELECT revision FROM usage_revisions WHERE database_id=?),0) revision",
      )
      .bind(databaseId),
  ]);
  if (results.some((result) => result.results.length > 10_000))
    throw new RangeError("Usage input exceeds bounded rollup");
  const row = computeUsageHour(
    database,
    hour,
    results[0]!.results as unknown as MeteredEvent[],
    results[1]!.results as unknown as StoredSample[],
    now,
  );
  const revision = (results[2]!.results[0] as { revision: number }).revision;
  const updated = await db
    .prepare(
      `INSERT INTO usage_hourly(database_id,hour,metrics,gaps,final,computed_at)
    SELECT ?,?,?,?,?,? WHERE COALESCE((SELECT revision FROM usage_revisions WHERE database_id=?),0)=?
    ON CONFLICT(database_id,hour) DO UPDATE SET metrics=excluded.metrics,gaps=excluded.gaps,final=excluded.final,computed_at=excluded.computed_at
    WHERE usage_hourly.final=0 AND usage_hourly.computed_at<=excluded.computed_at`,
    )
    .bind(
      databaseId,
      timestamp,
      JSON.stringify(row.metrics),
      JSON.stringify(row.gaps),
      row.final ? 1 : 0,
      new Date(now).toISOString(),
      databaseId,
      revision,
    )
    .run();
  const persisted = await db
    .prepare(
      "SELECT metrics,gaps,final,computed_at FROM usage_hourly WHERE database_id=? AND hour=?",
    )
    .bind(databaseId, timestamp)
    .first<{
      metrics: string;
      gaps: string;
      final: number;
      computed_at: string;
    }>();
  if (
    updated.meta.changes === 0 &&
    (!persisted ||
      (persisted.final === 0 && Date.parse(persisted.computed_at) <= now))
  ) {
    if (attempt >= 2)
      throw new Error("Usage inputs changed during bounded rollup");
    return rollupAttempt(db, databaseId, hour, now, attempt + 1);
  }
  return UsageRow.parse({
    ...row,
    metrics: JSON.parse(persisted!.metrics),
    gaps: JSON.parse(persisted!.gaps),
    final: persisted!.final === 1,
  });
}

export function aggregateUsageDay(rows: UsageRow[]): UsageRow {
  if (rows.length !== 24)
    throw new TypeError("A UTC day requires 24 hourly rows");
  const ordered = [...rows].sort((a, b) => a.start.localeCompare(b.start)),
    first = ordered[0]!;
  const start = Date.parse(first.start);
  if (
    start % (24 * USAGE_HOUR_MS) !== 0 ||
    ordered.some(
      (row, index) =>
        row.database_id !== first.database_id ||
        row.project_id !== first.project_id ||
        Date.parse(row.start) !== start + index * USAGE_HOUR_MS ||
        Date.parse(row.end) !== start + (index + 1) * USAGE_HOUR_MS,
    )
  )
    throw new TypeError("Non-contiguous UTC day");
  const metrics = emptyUsageMetrics(),
    gaps = new Set<UsageGap>(ordered.flatMap((row) => row.gaps));
  for (const metric of USAGE_METRICS) {
    const values = ordered.map((row) => row.metrics[metric]);
    if (values.some((value) => value === null)) {
      gaps.add(metric);
      continue;
    }
    const measured = values as number[];
    const value =
      metric.endsWith("_max") || metric === "storage_allocated_bytes"
        ? Math.max(...measured)
        : measured.reduce((a, b) => a + b, 0);
    if (value <= Number.MAX_SAFE_INTEGER) metrics[metric] = value;
    else gaps.add(metric);
  }
  return UsageRow.parse({
    ...first,
    end: ordered[23]!.end,
    metrics,
    gaps: [...gaps].sort(),
    final: ordered.every((row) => row.final),
  });
}
