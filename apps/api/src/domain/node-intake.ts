// SPDX-License-Identifier: Apache-2.0
import {
  NODE_EVENT_RETRY_SECONDS,
  NodeEventReport,
  NodeUsageReport,
  NodeVolumeReport,
  type NodeEvent,
} from "@pgcf/contracts";
import type { UsageSample } from "@pgcf/contracts/usage";
import { ApiError } from "../app.ts";
import type { ApiContext } from "../env.ts";
import type { NodeCaller } from "./node-auth.ts";
import { recordUsageSamples } from "./usage.ts";

const MINUTE_MS = 60_000;
/** A database's storage is sampled for billing and disk health once in this long. */
const STORAGE_SAMPLE_MS = 15 * MINUTE_MS;
/** The volumes written by one statement. */
const VOLUME_CHUNK = 200;

/**
 * `POST /node/v1/volumes` (plan 4.3): every thin volume of the node, orphans included, replaces
 * the node's previous report. The volumes of live databases also become the storage samples that
 * disk health and the usage rollup read, one per database and quarter hour.
 */
export async function nodeVolumes(
  c: ApiContext,
  node: NodeCaller,
  raw: unknown,
): Promise<Response> {
  const parsed = NodeVolumeReport.safeParse(raw);
  if (!parsed.success)
    throw new ApiError("invalid_request", "Invalid volume report");
  const report = parsed.data,
    db = c.env.DB;
  if (Date.parse(report.observed_at) > Date.now() + 300_000)
    throw new ApiError("invalid_request", "Observation time is in the future");
  const statements: D1PreparedStatement[] = [];
  for (let at = 0; at < report.volumes.length; at += VOLUME_CHUNK)
    statements.push(
      db
        .prepare(
          `INSERT INTO node_volumes(node_id,database_id,storage_generation,mounted,size_bytes,pool_used_bytes,
             filesystem_total_bytes,filesystem_used_bytes,inodes_total,inodes_used,observed_at)
           SELECT ?,json_extract(v.value,'$.database'),json_extract(v.value,'$.storage_generation'),
             CASE WHEN json_extract(v.value,'$.mounted') THEN 1 ELSE 0 END,json_extract(v.value,'$.size_bytes'),
             json_extract(v.value,'$.pool_used_bytes'),json_extract(v.value,'$.filesystem.total_bytes'),
             json_extract(v.value,'$.filesystem.used_bytes'),json_extract(v.value,'$.filesystem.inodes_total'),
             json_extract(v.value,'$.filesystem.inodes_used'),?
           FROM json_each(?) v WHERE true
           ON CONFLICT(node_id,database_id,storage_generation) DO UPDATE SET mounted=excluded.mounted,
             size_bytes=excluded.size_bytes,pool_used_bytes=excluded.pool_used_bytes,
             filesystem_total_bytes=excluded.filesystem_total_bytes,filesystem_used_bytes=excluded.filesystem_used_bytes,
             inodes_total=excluded.inodes_total,inodes_used=excluded.inodes_used,observed_at=excluded.observed_at
           WHERE excluded.observed_at>=node_volumes.observed_at`,
        )
        .bind(
          node.id,
          report.observed_at,
          JSON.stringify(report.volumes.slice(at, at + VOLUME_CHUNK)),
        ),
    );
  // What this report no longer names is gone from the node.
  statements.push(
    db
      .prepare("DELETE FROM node_volumes WHERE node_id=? AND observed_at<?")
      .bind(node.id, report.observed_at),
  );
  await db.batch(statements);
  await storageSamples(c, node, report);
  return c.json({ accepted: report.volumes.length });
}

async function storageSamples(
  c: ApiContext,
  node: NodeCaller,
  report: NodeVolumeReport,
): Promise<void> {
  const db = c.env.DB,
    at = Date.parse(report.observed_at),
    sequence = Math.floor(at / STORAGE_SAMPLE_MS);
  const live = await db
    .prepare(
      `SELECT id,storage_generation FROM databases WHERE node_id=? AND deleted_at IS NULL AND desired_state<>'deleted'
       AND id IN(SELECT value FROM json_each(?))`,
    )
    .bind(node.id, JSON.stringify(report.volumes.map((v) => v.database)))
    .all<{ id: string; storage_generation: number }>();
  const generations = new Map(
    live.results.map((row) => [row.id, row.storage_generation]),
  );
  const taken = await db
    .prepare(
      `SELECT database_id FROM usage_samples WHERE source='agent' AND producer_id=? AND sequence=?
       AND database_id IN(SELECT value FROM json_each(?))`,
    )
    .bind(node.uid, sequence, JSON.stringify([...generations.keys()]))
    .all<{ database_id: string }>();
  const done = new Set(taken.results.map((row) => row.database_id));
  const samples: UsageSample[] = [];
  for (const volume of report.volumes)
    if (
      generations.get(volume.database) === volume.storage_generation &&
      !done.has(volume.database)
    )
      samples.push({
        source: "agent",
        database_id: volume.database,
        producer_id: node.uid,
        sequence,
        observed_at: report.observed_at,
        // The bytes written inside the filesystem; a volume that is not mounted has only the
        // chunks the pool holds for it.
        storage_used_bytes:
          volume.filesystem?.used_bytes ?? volume.pool_used_bytes,
        storage_allocated_bytes: volume.size_bytes,
      });
  if (samples.length === 0) return;
  await recordUsageSamples(
    db,
    samples.map((sample) => ({
      principal: { region_id: node.region_id, source: "agent" as const },
      sample,
    })),
  );
}

/** The minute an event belongs to: when it happened on the node. */
const minuteOf = (event: NodeEvent) =>
  Math.floor(Date.parse(event.at) / MINUTE_MS);

/**
 * `POST /node/v1/events` (plan 9.9). An event whose id is known counts once, so a post the node
 * retried changes nothing. The decisions of the node (admissions, refusals, queue waits, early
 * sleeps) are counted in the minute they happened; a wake's timing is logged with its phases,
 * which is where every p95 is broken down.
 */
export async function nodeEvents(
  c: ApiContext,
  node: NodeCaller,
  raw: unknown,
): Promise<Response> {
  const parsed = NodeEventReport.safeParse(raw);
  if (!parsed.success)
    throw new ApiError("invalid_request", "Invalid event report");
  const events = parsed.data.events,
    db = c.env.DB,
    now = Date.now();
  if (events.some((event) => Date.parse(event.at) > now + 300_000))
    throw new ApiError("invalid_request", "Event time is in the future");
  const results = await db.batch([
    db
      .prepare("DELETE FROM node_event_ids WHERE node_id=? AND received_at<?")
      .bind(node.id, now - (NODE_EVENT_RETRY_SECONDS + 60) * 1000),
    ...events.map((event) =>
      db
        .prepare(
          "INSERT OR IGNORE INTO node_event_ids(node_id,event_id,received_at) VALUES(?,?,?)",
        )
        .bind(node.id, event.id, now),
    ),
  ]);
  const fresh = events.filter(
    (_event, index) => results[index + 1]!.meta.changes === 1,
  );
  const minutes = new Map<
    number,
    {
      admitted: number;
      noRoom: number;
      noHeadroom: number;
      early: number;
      waits: number;
      waitSum: number;
      waitMax: number;
    }
  >();
  for (const event of fresh) {
    if (event.type === "wake") {
      console.log(
        JSON.stringify({
          event: "node_wake",
          node_id: node.id,
          database_id: event.database,
          generation: event.generation,
          operation: event.operation,
          outcome: event.outcome,
          ...(event.reason ? { reason: event.reason } : {}),
          phases_ms: event.phases_ms,
          at: event.at,
        }),
      );
      continue;
    }
    const minute = minutes.get(minuteOf(event)) ?? {
      admitted: 0,
      noRoom: 0,
      noHeadroom: 0,
      early: 0,
      waits: 0,
      waitSum: 0,
      waitMax: 0,
    };
    minutes.set(minuteOf(event), minute);
    if (event.type === "early_sleep") minute.early++;
    else {
      if (event.decision === "admitted") minute.admitted++;
      else if (event.reason === "no_room") minute.noRoom++;
      else minute.noHeadroom++;
      if (event.waited_ms > 0) {
        minute.waits++;
        minute.waitSum += event.waited_ms;
        minute.waitMax = Math.max(minute.waitMax, event.waited_ms);
      }
    }
  }
  if (minutes.size)
    await db.batch(
      [...minutes].map(([minute, counts]) =>
        db
          .prepare(
            `INSERT INTO node_minutes(node_id,minute,samples,admitted,refused_no_room,refused_no_headroom,early_sleeps,
               queue_waits,queue_wait_ms_sum,queue_wait_ms_max)
             SELECT ?,?,0,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM nodes WHERE id=?)
             ON CONFLICT(node_id,minute) DO UPDATE SET admitted=admitted+excluded.admitted,
               refused_no_room=refused_no_room+excluded.refused_no_room,
               refused_no_headroom=refused_no_headroom+excluded.refused_no_headroom,
               early_sleeps=early_sleeps+excluded.early_sleeps,queue_waits=queue_waits+excluded.queue_waits,
               queue_wait_ms_sum=queue_wait_ms_sum+excluded.queue_wait_ms_sum,
               queue_wait_ms_max=MAX(queue_wait_ms_max,excluded.queue_wait_ms_max)`,
          )
          .bind(
            node.id,
            minute,
            counts.admitted,
            counts.noRoom,
            counts.noHeadroom,
            counts.early,
            counts.waits,
            counts.waitSum,
            counts.waitMax,
            node.id,
          ),
      ),
    );
  return c.json({
    accepted: fresh.length,
    duplicates: events.length - fresh.length,
  });
}

/**
 * `POST /node/v1/usage` (plan 3.4, 5.6). A node's interval row is the counters of its gateway for
 * the database, so it is recorded as a gateway sample of that node, identified by the interval.
 * What the node could not count stays null and the rollup names it; a row of nothing known is
 * not recorded, and is acknowledged like one that is refused. The awake time of a database is not read from these rows: it is the time between
 * the lifecycle events of its observations.
 */
export async function nodeUsage(
  c: ApiContext,
  node: NodeCaller,
  raw: unknown,
): Promise<Response> {
  const parsed = NodeUsageReport.safeParse(raw);
  if (!parsed.success)
    throw new ApiError("invalid_request", "Invalid usage report");
  const rows = parsed.data.rows,
    now = Date.now();
  const known = await c.env.DB.prepare(
    "SELECT id FROM databases WHERE region_id=? AND id IN(SELECT value FROM json_each(?))",
  )
    .bind(node.region_id, JSON.stringify(rows.map((row) => row.database)))
    .all<{ id: string }>();
  const databases = new Set(known.results.map((row) => row.id));
  const entries: {
    principal: { region_id: string; source: "gateway" };
    sample: UsageSample;
  }[] = [];
  let skipped = 0;
  for (const row of rows) {
    // A row of nothing known, of a database D1 does not have or from the future cannot be
    // recorded, and waiting would only keep the node's outbox from draining.
    if (
      !databases.has(row.database) ||
      Date.parse(row.interval_end) > now + 30_000 ||
      (row.ingress_bytes === null &&
        row.egress_bytes === null &&
        row.connections === null &&
        row.connection_ms === null)
    ) {
      skipped++;
      continue;
    }
    entries.push({
      principal: { region_id: node.region_id, source: "gateway" },
      sample: {
        source: "gateway",
        database_id: row.database,
        producer_id: node.uid,
        sequence: Date.parse(row.interval_start),
        observed_at: row.interval_end,
        interval_start: row.interval_start,
        interval_end: row.interval_end,
        expected_producers: [node.uid],
        ingress_bytes: row.ingress_bytes,
        egress_bytes: row.egress_bytes,
        connections: row.connections,
        connection_seconds:
          row.connection_ms === null ? null : row.connection_ms / 1000,
      },
    });
  }
  const outcomes = await recordUsageSamples(c.env.DB, entries);
  let recorded = 0,
    duplicates = 0,
    refused = 0;
  outcomes.forEach((outcome, index) => {
    if (outcome === "recorded") recorded++;
    else if (outcome === "duplicate") duplicates++;
    else {
      // A conflict is final for this row (finalized hour, overlap, input bound, reused identity).
      // Acknowledging it lets the node's outbox drain instead of replaying it forever.
      console.warn(
        JSON.stringify({
          event: "usage_row_refused",
          database_id: entries[index]!.sample.database_id,
          reason: outcome.message,
        }),
      );
      refused++;
    }
  });
  return c.json({ recorded, duplicates, refused: refused + skipped });
}
