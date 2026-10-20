// SPDX-License-Identifier: Apache-2.0
//
// Placement by measured activity (ULTRA plan 4.8). A node takes new databases until its active
// RAM or its CPU load reaches 80 %, each as the highest 30-minute average of the last seven days;
// among the nodes that qualify the fullest wins, and a node is added only when none does. A node
// holding `MAX_VOLUMES_PER_NODE` volumes takes no more (plan 4.11). Cloudflare reads only what the
// node reports: its newest sample (`nodes.last_sample_json`) and its per-minute rollups
// (`node_minutes`); the node decides every start itself.
import { NODE_SAMPLE_INTERVAL_MS } from "@pgcf/contracts";

/** A node whose newest sample is older than this is offline (`regional_node_stale`). */
export const NODE_OBSERVATION_MAX_AGE_MS = 180_000;
/** A sample may be dated this far ahead of Cloudflare's clock: as far as the link takes it. */
export const CLOCK_SKEW_MS = NODE_SAMPLE_INTERVAL_MS;
/** Parts per million of active RAM and of CPU load a node reaches at most (the owner's 80 %). */
export const PLACEMENT_LIMIT_PPM = 800_000;
/** The thin pool is closed for placement from these shares of its data and metadata (plan 4.3). */
const POOL_DATA_CLOSED_PPM = 800_000;
const POOL_METADATA_CLOSED_PPM = 500_000;
/** The sold storage of a node stays within this many times its pool's data (plan 4.3). */
const LOGICAL_CAP_FACTOR = 4;
/**
 * The technical volume bound (plan 4.8, 4.11): from this many thin volumes a node is closed for
 * create, restore and move, and counts as full for the purchase signal. The LVM metadata area of
 * the default size runs out near 1,450 volumes (Stage 1); the margin absorbs the volumes created
 * between two samples. A resize adds no volume and is not stopped by it.
 */
export const MAX_VOLUMES_PER_NODE = 1000;
/** The averaging window of a load figure, and how far back its highest value counts. */
export const AVERAGE_WINDOW_SECONDS = 1800;
export const PEAK_WINDOW_MS = 7 * 86_400_000;
/** An average of fewer seconds of samples than this is not a 30-minute average (plan 4.8). */
export const AVERAGE_MINIMUM_SPAN_SECONDS = 600;

/** The memory a node keeps for the system and its page cache (plan 4.5); a start needs the rest. */
export const MEMORY_FLOOR_MIB = 600;

const MIB = 1024n ** 2n;
const GIB = 1024n ** 3n;
const PPM = 1_000_000n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** What a node reports and the databases placed on it, as `placementNodes` reads them. */
export interface PlacementNode {
  id: string;
  region_id: string;
  ready: number;
  schedulable: number;
  lost_at: string | null;
  database_placement_enabled: number;
  database_placement_closed_at: string | null;
  /** The newest sample at most 5 s ahead of the clock; null for a node that never reported. */
  sampled_at: string | null;
  memory_total_bytes: number | null;
  cpu_cores: number | null;
  /** The node's own room rule (plan 4.6) held in that sample. */
  room: number | null;
  pool_data_total_bytes: number | null;
  pool_data_used_bytes: number | null;
  pool_metadata_total_bytes: number | null;
  pool_metadata_used_bytes: number | null;
  pool_nominal_bytes: number | null;
  /** Every thin volume of the node in that sample, mounted or not. */
  volumes_total: number | null;
  /** Highest 30-minute average of active RAM and of CPU load in the last seven days. */
  ram_peak_ppm: number | null;
  cpu_peak_ppm: number | null;
  /** Active RAM in the newest sample, in parts per million: what the 30-minute average has not caught up with. */
  ram_now_ppm: number | null;
  /** Memory of the databases placed after the node's newest sample: no sample includes them yet. */
  pending_memory_mib: number;
  /** Storage of the databases whose volume the node may not have counted in `pool_nominal_bytes` yet. */
  pending_storage_gib: number;
}

/** What a new database asks of its node. */
export interface PlacementNeed {
  memory_mib: number;
  cpu_millicores: number;
  storage_gib: number;
}

/**
 * A region accepts placement while one of its nodes is ready, schedulable, not lost and open for
 * new databases. A moment without fresh samples or free capacity does not change that: the create
 * is accepted and waits for it.
 */
export function regionAcceptsPlacementSql(region = "regions"): string {
  if (!/^[a-z][a-z0-9_]*$/.test(region))
    throw new Error("invalid_region_placement_alias");
  return `EXISTS(SELECT 1 FROM nodes accepting WHERE accepting.region_id=${region}.id AND accepting.ready=1 AND accepting.schedulable=1
    AND accepting.lost_at IS NULL AND accepting.database_placement_enabled=1 AND accepting.database_placement_closed_at IS NULL)`;
}

/** The node reported in the last 180 s. */
export function nodeOnline(node: PlacementNode, now: number): boolean {
  if (node.sampled_at === null) return false;
  const at = Date.parse(node.sampled_at);
  return at >= now - NODE_OBSERVATION_MAX_AGE_MS && at <= now + CLOCK_SKEW_MS;
}
/** The node's own flags allow new databases. */
function nodeOpen(node: PlacementNode): boolean {
  return (
    node.ready === 1 &&
    node.schedulable === 1 &&
    node.lost_at === null &&
    node.database_placement_enabled === 1 &&
    node.database_placement_closed_at === null
  );
}

type PoolState =
  "unavailable" | "no_room" | "data" | "metadata" | "cap" | "volumes" | "open";
/**
 * Whether the node's thin pool is open for placement (plan 4.3): readable, with room, below 80 %
 * of its data and 50 % of its metadata, with the sold storage below the logical cap, and with
 * fewer than `MAX_VOLUMES_PER_NODE` volumes. The sold storage is what the node reported plus the
 * databases it has not counted yet, and `needGib` more must fit under the cap as well. The pool of
 * an offline node is judged by its last sample. The volume count is checked last: it closes the
 * node for new volumes only, so a state that stops a resize keeps its own name.
 */
function poolState(
  pool: Pick<
    PlacementNode,
    | "room"
    | "pool_data_total_bytes"
    | "pool_data_used_bytes"
    | "pool_metadata_total_bytes"
    | "pool_metadata_used_bytes"
    | "pool_nominal_bytes"
    | "volumes_total"
    | "pending_storage_gib"
  >,
  needGib = 0,
): PoolState {
  if (
    pool.pool_data_total_bytes === null ||
    pool.pool_data_used_bytes === null ||
    pool.pool_metadata_total_bytes === null ||
    pool.pool_metadata_used_bytes === null ||
    pool.pool_nominal_bytes === null ||
    pool.volumes_total === null
  )
    return "unavailable";
  if (pool.room !== 1) return "no_room";
  const dataTotal = BigInt(pool.pool_data_total_bytes);
  // used / total >= limit, in integers.
  if (
    BigInt(pool.pool_data_used_bytes) * PPM >=
    dataTotal * BigInt(POOL_DATA_CLOSED_PPM)
  )
    return "data";
  if (
    BigInt(pool.pool_metadata_used_bytes) * PPM >=
    BigInt(pool.pool_metadata_total_bytes) * BigInt(POOL_METADATA_CLOSED_PPM)
  )
    return "metadata";
  const cap = dataTotal * BigInt(LOGICAL_CAP_FACTOR),
    sold =
      BigInt(pool.pool_nominal_bytes) + BigInt(pool.pending_storage_gib) * GIB;
  if (sold >= cap || sold + BigInt(needGib) * GIB > cap) return "cap";
  return pool.volumes_total >= MAX_VOLUMES_PER_NODE ? "volumes" : "open";
}

/** `mib` of `total` bytes in parts per million, rounded up. */
function memoryPpm(mib: number, total: number): bigint {
  return ceilDiv(BigInt(mib) * MIB * PPM, BigInt(total));
}

/**
 * How full a node is for placement: its RAM peak plus the memory of the databases no average
 * includes yet. Null while the node cannot take a database at all; `projected` is that load with
 * `addedMib` more.
 */
function load(
  node: PlacementNode,
  addedMib: number,
): { current: bigint; projected: bigint } | null {
  if (node.ram_peak_ppm === null || node.memory_total_bytes === null)
    return null;
  // The average lags behind a burst of starts: what the newest sample shows counts as well.
  const peak = BigInt(Math.max(node.ram_peak_ppm, node.ram_now_ppm ?? 0));
  return {
    current: peak + memoryPpm(node.pending_memory_mib, node.memory_total_bytes),
    projected:
      peak +
      memoryPpm(node.pending_memory_mib + addedMib, node.memory_total_bytes),
  };
}

/**
 * The node a new database goes to: of the nodes that are online, open, with an open pool (below
 * the volume bound as well), below 80 % CPU and below 80 % active RAM after the database, the one
 * with the most load; ties go to the lower ID. Null when none qualifies and the database waits for
 * capacity.
 */
export function choosePlacement(
  nodes: readonly PlacementNode[],
  need: PlacementNeed,
  now = Date.now(),
): PlacementNode | null {
  const limit = BigInt(PLACEMENT_LIMIT_PPM);
  let best: { node: PlacementNode; current: bigint } | null = null;
  for (const node of nodes) {
    if (!nodeOnline(node, now) || !nodeOpen(node)) continue;
    if (
      poolState(node, need.storage_gib) !== "open" ||
      node.cpu_cores === null ||
      need.cpu_millicores > node.cpu_cores * 1000 ||
      node.cpu_peak_ppm === null ||
      BigInt(node.cpu_peak_ppm) >= limit
    )
      continue;
    const figures = load(node, need.memory_mib);
    if (figures === null || figures.projected >= limit) continue;
    if (
      best === null ||
      figures.current > best.current ||
      (figures.current === best.current && node.id < best.node.id)
    )
      best = { node, current: figures.current };
  }
  return best?.node ?? null;
}

/** What a resize adds to the node its database stays on; a shrink adds nothing. */
interface PlacementGrowth {
  memory_mib: number;
  storage_gib: number;
  cpu_millicores: number;
}
/**
 * Whether the node an existing database stays on can take its growth (plan 3.5): online, with
 * the cores the database may use, below 80 % active RAM after the extra memory, and with the
 * extra storage inside its logical cap. Growth of nothing needs only the cores. A node at the
 * volume bound can still grow its databases: a resize creates no volume.
 */
export function growthFits(
  node: PlacementNode,
  growth: PlacementGrowth,
  now = Date.now(),
): boolean {
  if (growth.memory_mib > 0 || growth.storage_gib > 0) {
    if (!nodeOnline(node, now)) return false;
    if (growth.memory_mib > 0) {
      const figures = load(node, growth.memory_mib);
      if (figures === null || figures.projected >= BigInt(PLACEMENT_LIMIT_PPM))
        return false;
    }
    if (growth.storage_gib > 0) {
      const state = poolState(node, growth.storage_gib);
      if (state === "unavailable" || state === "no_room" || state === "cap")
        return false;
    }
  }
  return (
    node.cpu_cores === null || growth.cpu_millicores <= node.cpu_cores * 1000
  );
}

/**
 * The storage in GiB of the databases on a node whose create, restore or resize has not finished,
 * or finished after `sampleAt`, the node's newest sample: the node's `pool_nominal_bytes` cannot
 * count their volumes yet. A database counts at its whole storage, which the node may have counted
 * already; the sum only shrinks when a sample taken after the operation ends it.
 */
function pendingStorageSql(node: string, sampleAt: string): string {
  return `COALESCE((SELECT SUM(r.storage_gib) FROM databases d JOIN database_resources r ON r.database_id=d.id
    WHERE d.node_id=${node}.id AND d.deleted_at IS NULL AND EXISTS(SELECT 1 FROM operations o WHERE o.database_id=d.id
      AND o.kind IN('database.create','database.restore','database.resize')
      AND (o.status IN('pending','running') OR o.completed_at>${sampleAt}))),0)`;
}

/**
 * The newest sample of every node that has reported, as columns, from the row the link keeps in
 * `nodes`. It ends in a WHERE clause: the caller adds its own conditions with AND.
 */
export const LATEST_SAMPLES_SQL = `SELECT n.id node_id,n.region_id,n.last_observed_at observed_at,
    json_extract(n.last_sample_json,'$.memory.total_bytes') memory_total_bytes,
    json_extract(n.last_sample_json,'$.memory.available_bytes') memory_available_bytes,
    json_extract(n.last_sample_json,'$.cpu.cores') cpu_cores,
    json_extract(n.last_sample_json,'$.cpu.busy_millicores') cpu_busy_millicores,
    json_extract(n.last_sample_json,'$.room') room,
    json_extract(n.last_sample_json,'$.pool.data_total_bytes') pool_data_total_bytes,
    json_extract(n.last_sample_json,'$.pool.data_used_bytes') pool_data_used_bytes,
    json_extract(n.last_sample_json,'$.pool.metadata_total_bytes') pool_metadata_total_bytes,
    json_extract(n.last_sample_json,'$.pool.metadata_used_bytes') pool_metadata_used_bytes,
    json_extract(n.last_sample_json,'$.pool.nominal_bytes') pool_nominal_bytes,
    json_extract(n.last_sample_json,'$.volumes.total') volumes_total
  FROM nodes n WHERE n.last_sample_json IS NOT NULL AND n.last_observed_at IS NOT NULL`;
const MINUTE_MS = 60_000;
/** The minute rollup a time falls in, as `node_minutes.minute` counts it. */
export const minuteOf = (ms: number) => Math.floor(ms / MINUTE_MS);

/** The nodes of a region with what they reported and the placements no average includes yet. */
export async function placementNodes(
  db: D1Database,
  regionId: string,
  now = Date.now(),
): Promise<PlacementNode[]> {
  const iso = (ms: number) => new Date(ms).toISOString();
  // A 30-minute average needs at least ten minutes of rollups in its window; a node with less
  // than 30 minutes of history altogether has one average over all of it (plan 4.8). A minute
  // holds the sums of its samples, so an average over minutes weighs every sample alike.
  const window = AVERAGE_WINDOW_SECONDS / 60,
    minimum = AVERAGE_MINIMUM_SPAN_SECONDS / 60;
  const result = await db
    .prepare(
      `WITH latest AS (
        ${LATEST_SAMPLES_SQL} AND n.region_id=? AND n.last_observed_at<=?
      ), recent AS (
        SELECT m.node_id,m.minute t,m.samples,
          m.memory_used_bytes_sum*1000000/m.memory_total_bytes ram_sum_ppm,
          m.cpu_busy_millicores_sum*1000/m.cpu_cores cpu_sum_ppm
        FROM node_minutes m JOIN latest l ON l.node_id=m.node_id AND l.observed_at>=?
        WHERE m.samples>0 AND m.minute>=? AND m.minute<=?
      ), averaged AS (
        SELECT node_id,t,SUM(ram_sum_ppm) OVER w/SUM(samples) OVER w ram_avg,SUM(cpu_sum_ppm) OVER w/SUM(samples) OVER w cpu_avg,
          t-MIN(t) OVER w span
        FROM recent WINDOW w AS (PARTITION BY node_id ORDER BY t RANGE BETWEEN ${window} PRECEDING AND CURRENT ROW)
      ), history AS (
        SELECT node_id,MAX(t)-MIN(t) span,SUM(ram_sum_ppm)/SUM(samples) ram_avg,SUM(cpu_sum_ppm)/SUM(samples) cpu_avg
        FROM recent GROUP BY node_id
      ), peaks AS (
        SELECT h.node_id,
          CASE WHEN h.span<${window} THEN h.ram_avg
            ELSE (SELECT MAX(a.ram_avg) FROM averaged a WHERE a.node_id=h.node_id AND a.t>=? AND a.span>=${minimum}) END ram_peak_ppm,
          CASE WHEN h.span<${window} THEN h.cpu_avg
            ELSE (SELECT MAX(a.cpu_avg) FROM averaged a WHERE a.node_id=h.node_id AND a.t>=? AND a.span>=${minimum}) END cpu_peak_ppm
        FROM history h
      )
      SELECT n.id,n.region_id,n.ready,n.schedulable,n.lost_at,n.database_placement_enabled,n.database_placement_closed_at,
        l.observed_at sampled_at,l.memory_total_bytes,l.cpu_cores,l.room,
        l.pool_data_total_bytes,l.pool_data_used_bytes,l.pool_metadata_total_bytes,l.pool_metadata_used_bytes,l.pool_nominal_bytes,l.volumes_total,
        p.ram_peak_ppm,p.cpu_peak_ppm,
        CASE WHEN l.memory_total_bytes>0 AND l.memory_available_bytes IS NOT NULL
          THEN (l.memory_total_bytes-l.memory_available_bytes)*1000000/l.memory_total_bytes END ram_now_ppm,
        COALESCE((SELECT SUM(r.memory_mib) FROM databases d JOIN database_resources r ON r.database_id=d.id
          WHERE d.node_id=n.id AND d.deleted_at IS NULL AND d.placed_at>COALESCE(l.observed_at,'')),0) pending_memory_mib,
        ${pendingStorageSql("n", "l.observed_at")} pending_storage_gib
      FROM nodes n LEFT JOIN latest l ON l.node_id=n.id LEFT JOIN peaks p ON p.node_id=n.id
      WHERE n.region_id=? ORDER BY n.id`,
    )
    .bind(
      regionId,
      iso(now + CLOCK_SKEW_MS),
      iso(now - NODE_OBSERVATION_MAX_AGE_MS),
      minuteOf(now - PEAK_WINDOW_MS - AVERAGE_WINDOW_SECONDS * 1000),
      minuteOf(now + CLOCK_SKEW_MS),
      minuteOf(now - PEAK_WINDOW_MS),
      minuteOf(now - PEAK_WINDOW_MS),
      regionId,
    )
    .all<PlacementNode>();
  return result.results;
}

/**
 * The nodes of a region, not lost, that the newest sample closes for placement: the thin pool's
 * data or metadata is too full, the storage sold has reached the logical cap (plan 4.3), or the
 * node holds `MAX_VOLUMES_PER_NODE` volumes. A pool without room or without a reading is another
 * alarm's.
 */
export async function closedPools(
  db: D1Database,
  regionId: string,
): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT n.id,l.room,l.pool_data_total_bytes,l.pool_data_used_bytes,l.pool_metadata_total_bytes,l.pool_metadata_used_bytes,
        l.pool_nominal_bytes,l.volumes_total,${pendingStorageSql("n", "l.observed_at")} pending_storage_gib
      FROM nodes n JOIN (${LATEST_SAMPLES_SQL}) l ON l.node_id=n.id
      WHERE n.region_id=? AND n.lost_at IS NULL ORDER BY n.id`,
    )
    .bind(regionId)
    .all<Parameters<typeof poolState>[0] & { id: string }>();
  return result.results
    .filter((node) =>
      ["data", "metadata", "cap", "volumes"].includes(poolState(node)),
    )
    .map((node) => node.id);
}

const aliasOf = (alias: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(alias))
    throw new Error("invalid_node_placement_alias");
  return alias;
};
/**
 * The write side of a decision from `placementNodes`: the node still reports, and has the same
 * memory and storage pending on it. Another placement or resize that landed meanwhile changes the
 * pending figures, so only one of two concurrent changes takes the room the node has for one.
 * `now` is the instant `placementNodes` was read at; the node's report is judged by the clock of
 * the write.
 */
export function nodeLoadGuard(
  nodeAlias: string,
  claim: { pendingMemoryMib: number; pendingStorageGib: number; now: number },
): { sql: string; bindings: (string | number)[] } {
  const node = aliasOf(nodeAlias),
    stamp = (offset: string) =>
      `strftime('%Y-%m-%dT%H:%M:%fZ','now','${offset}')`,
    newest = `(CASE WHEN ${node}.last_observed_at<=${stamp(`+${CLOCK_SKEW_MS / 1000} seconds`)} THEN ${node}.last_observed_at END)`;
  return {
    sql: `(${newest}>=${stamp(`-${NODE_OBSERVATION_MAX_AGE_MS / 1000} seconds`)}
      AND COALESCE((SELECT SUM(r.memory_mib) FROM databases d JOIN database_resources r ON r.database_id=d.id
        WHERE d.node_id=${node}.id AND d.deleted_at IS NULL AND d.placed_at>COALESCE(${node}.last_observed_at,'')),0)=?
      AND ${pendingStorageSql(node, newest)}=?)`,
    bindings: [claim.pendingMemoryMib, claim.pendingStorageGib],
  };
}
/** `nodeLoadGuard` for a node that must also be ready, open for new databases and the one named. */
export function placementGuard(
  nodeAlias: string,
  claim: {
    nodeId: string;
    pendingMemoryMib: number;
    pendingStorageGib: number;
    now: number;
  },
): { sql: string; bindings: (string | number)[] } {
  const node = aliasOf(nodeAlias),
    load = nodeLoadGuard(node, claim);
  return {
    sql: `(${node}.id=? AND ${node}.ready=1 AND ${node}.schedulable=1 AND ${node}.lost_at IS NULL
      AND ${node}.database_placement_enabled=1 AND ${node}.database_placement_closed_at IS NULL AND ${load.sql})`,
    bindings: [claim.nodeId, ...load.bindings],
  };
}

/**
 * Whether the node of `databases` can start the database now, as far as Cloudflare can tell: it
 * reported in the last 180 s, has room in its pool, and has the database's memory available above
 * its floor. The node decides every start itself (plan 4.6); this refuses a resume that it would
 * certainly refuse.
 */
export function databaseResumeFitsSql(databaseAlias = "databases"): string {
  const database = aliasOf(databaseAlias),
    sample = (path: string) =>
      `json_extract(node.last_sample_json,'$.${path}')`;
  return `EXISTS(SELECT 1 FROM nodes node WHERE node.id=${database}.node_id AND ${sample("room")}=1
    AND julianday(node.last_observed_at)>=julianday('now','-${NODE_OBSERVATION_MAX_AGE_MS / 1000} seconds')
    AND julianday(node.last_observed_at)<=julianday('now','+${CLOCK_SKEW_MS / 1000} seconds')
    AND ${sample("memory.available_bytes")}>=(SELECT memory_mib+${MEMORY_FLOOR_MIB} FROM database_resources WHERE database_id=${database}.id)*${1024 * 1024})`;
}
