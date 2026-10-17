// SPDX-License-Identifier: Apache-2.0
//
// Placement by measured activity (ULTRA plan 4.8). A node takes new databases until its active
// RAM or its CPU load reaches 80 %, each as the highest 30-minute average of the last seven days;
// among the nodes that qualify the fullest wins, and a node is added only when none does. Cloudflare
// reads only what the node reports (`node_samples`); the node decides every start itself.

/** A node whose newest sample is older than this is offline (`regional_node_stale`). */
export const NODE_OBSERVATION_MAX_AGE_MS = 180_000;
/** A sample may be dated this far ahead of Cloudflare's clock. */
const CLOCK_SKEW_MS = 5000;
/** Parts per million of active RAM and of CPU load a node reaches at most (the owner's 80 %). */
export const PLACEMENT_LIMIT_PPM = 800_000;
/** The thin pool is closed for placement from these shares of its data and metadata (plan 4.3). */
export const POOL_DATA_CLOSED_PPM = 800_000;
export const POOL_METADATA_CLOSED_PPM = 500_000;
/** The sold storage of a node stays within this many times its pool's data (plan 4.3). */
export const LOGICAL_CAP_FACTOR = 4;
/** The averaging window of a load figure, and how far back its highest value counts. */
export const AVERAGE_WINDOW_SECONDS = 1800;
export const PEAK_WINDOW_MS = 7 * 86_400_000;

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
  /** Highest 30-minute average of active RAM and of CPU load in the last seven days. */
  ram_peak_ppm: number | null;
  cpu_peak_ppm: number | null;
  /** Memory of the databases placed in the last 30 minutes: no average includes them yet. */
  pending_memory_mib: number;
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
export function nodeOpen(node: PlacementNode): boolean {
  return (
    node.ready === 1 &&
    node.schedulable === 1 &&
    node.lost_at === null &&
    node.database_placement_enabled === 1 &&
    node.database_placement_closed_at === null
  );
}

export type PoolState =
  "unavailable" | "no_room" | "data" | "metadata" | "cap" | "open";
/**
 * Whether the node's thin pool is open for placement (plan 4.3): readable, with room, below 80 %
 * of its data and 50 % of its metadata, and with the sold storage below the logical cap. The pool
 * of an offline node is judged by its last sample.
 */
export function poolState(
  pool: Pick<
    PlacementNode,
    | "room"
    | "pool_data_total_bytes"
    | "pool_data_used_bytes"
    | "pool_metadata_total_bytes"
    | "pool_metadata_used_bytes"
    | "pool_nominal_bytes"
  >,
  extraNominalBytes = 0n,
): PoolState {
  if (
    pool.pool_data_total_bytes === null ||
    pool.pool_data_used_bytes === null ||
    pool.pool_metadata_total_bytes === null ||
    pool.pool_metadata_used_bytes === null ||
    pool.pool_nominal_bytes === null
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
    nominal = BigInt(pool.pool_nominal_bytes);
  return nominal >= cap || nominal + extraNominalBytes > cap ? "cap" : "open";
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
  const peak = BigInt(node.ram_peak_ppm);
  return {
    current: peak + memoryPpm(node.pending_memory_mib, node.memory_total_bytes),
    projected:
      peak +
      memoryPpm(node.pending_memory_mib + addedMib, node.memory_total_bytes),
  };
}

/**
 * The node a new database goes to: of the nodes that are online, open, with an open pool, below
 * 80 % CPU and below 80 % active RAM after the database, the one with the most load; ties go to
 * the lower ID. Null when none qualifies and the database waits for capacity.
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
      poolState(node, BigInt(need.storage_gib) * GIB) !== "open" ||
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
export interface PlacementGrowth {
  memory_mib: number;
  storage_gib: number;
  cpu_millicores: number;
}
/**
 * Whether the node an existing database stays on can take its growth (plan 3.5): online, with
 * the cores the database may use, below 80 % active RAM after the extra memory, and with the
 * extra storage inside its logical cap. Growth of nothing needs only the cores.
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
      const state = poolState(node, BigInt(growth.storage_gib) * GIB);
      if (state === "unavailable" || state === "no_room" || state === "cap")
        return false;
    }
  }
  return (
    node.cpu_cores === null || growth.cpu_millicores <= node.cpu_cores * 1000
  );
}

/** The nodes of a region with what they reported and the placements no average includes yet. */
export async function placementNodes(
  db: D1Database,
  regionId: string,
  now = Date.now(),
): Promise<PlacementNode[]> {
  const iso = (ms: number) => new Date(ms).toISOString();
  const result = await db
    .prepare(
      `WITH latest AS (
        SELECT s.* FROM nodes rn JOIN node_samples s ON s.node_id=rn.id
          AND s.observed_at=(SELECT MAX(observed_at) FROM node_samples WHERE node_id=rn.id AND observed_at<=?)
        WHERE rn.region_id=?
      ), recent AS (
        SELECT s.node_id,CAST(strftime('%s',s.observed_at) AS INTEGER) t,
          (s.memory_total_bytes-s.memory_available_bytes)*1000000/s.memory_total_bytes ram_ppm,
          s.cpu_busy_millicores*1000/s.cpu_cores cpu_ppm
        FROM node_samples s JOIN latest l ON l.node_id=s.node_id AND l.observed_at>=?
        WHERE s.observed_at>=? AND s.observed_at<=?
      ), averaged AS (
        SELECT node_id,t,SUM(ram_ppm) OVER w/COUNT(*) OVER w ram_avg,SUM(cpu_ppm) OVER w/COUNT(*) OVER w cpu_avg
        FROM recent WINDOW w AS (PARTITION BY node_id ORDER BY t RANGE BETWEEN ${AVERAGE_WINDOW_SECONDS} PRECEDING AND CURRENT ROW)
      ), peaks AS (
        SELECT node_id,MAX(ram_avg) ram_peak_ppm,MAX(cpu_avg) cpu_peak_ppm FROM averaged WHERE t>=? GROUP BY node_id
      )
      SELECT n.id,n.region_id,n.ready,n.schedulable,n.lost_at,n.database_placement_enabled,n.database_placement_closed_at,
        l.observed_at sampled_at,l.memory_total_bytes,l.cpu_cores,l.room,
        l.pool_data_total_bytes,l.pool_data_used_bytes,l.pool_metadata_total_bytes,l.pool_metadata_used_bytes,l.pool_nominal_bytes,
        p.ram_peak_ppm,p.cpu_peak_ppm,
        COALESCE((SELECT SUM(r.memory_mib) FROM databases d JOIN database_resources r ON r.database_id=d.id
          WHERE d.node_id=n.id AND d.deleted_at IS NULL AND d.placed_at>?),0) pending_memory_mib
      FROM nodes n LEFT JOIN latest l ON l.node_id=n.id LEFT JOIN peaks p ON p.node_id=n.id
      WHERE n.region_id=? ORDER BY n.id`,
    )
    .bind(
      iso(now + CLOCK_SKEW_MS),
      regionId,
      iso(now - NODE_OBSERVATION_MAX_AGE_MS),
      iso(now - PEAK_WINDOW_MS - AVERAGE_WINDOW_SECONDS * 1000),
      iso(now + CLOCK_SKEW_MS),
      Math.floor((now - PEAK_WINDOW_MS) / 1000),
      iso(now - AVERAGE_WINDOW_SECONDS * 1000),
      regionId,
    )
    .all<PlacementNode>();
  return result.results;
}

const aliasOf = (alias: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(alias))
    throw new Error("invalid_node_placement_alias");
  return alias;
};
/**
 * The write side of a decision from `placementNodes`: the node still reports, and has the same
 * memory pending on it. Another placement that landed meanwhile changes the pending memory, so
 * only one of two concurrent changes takes the room the node has for one. `now` is the instant
 * `placementNodes` was read at; the node's report is judged by the clock of the write.
 */
export function nodeLoadGuard(
  nodeAlias: string,
  claim: { pendingMemoryMib: number; now: number },
): { sql: string; bindings: (string | number)[] } {
  const node = aliasOf(nodeAlias),
    stamp = (offset: string) =>
      `strftime('%Y-%m-%dT%H:%M:%fZ','now','${offset}')`;
  return {
    sql: `((SELECT MAX(observed_at) FROM node_samples WHERE node_id=${node}.id AND observed_at<=${stamp(`+${CLOCK_SKEW_MS / 1000} seconds`)})>=${stamp(`-${NODE_OBSERVATION_MAX_AGE_MS / 1000} seconds`)}
      AND COALESCE((SELECT SUM(r.memory_mib) FROM databases d JOIN database_resources r ON r.database_id=d.id
        WHERE d.node_id=${node}.id AND d.deleted_at IS NULL AND d.placed_at>?),0)=?)`,
    bindings: [
      new Date(claim.now - AVERAGE_WINDOW_SECONDS * 1000).toISOString(),
      claim.pendingMemoryMib,
    ],
  };
}
/** `nodeLoadGuard` for a node that must also be ready, open for new databases and the one named. */
export function placementGuard(
  nodeAlias: string,
  claim: { nodeId: string; pendingMemoryMib: number; now: number },
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
    newest = (column: string) =>
      `(SELECT ${column} FROM node_samples WHERE node_id=${database}.node_id ORDER BY observed_at DESC LIMIT 1)`;
  return `(${newest("room")}=1
    AND julianday(${newest("observed_at")})>=julianday('now','-${NODE_OBSERVATION_MAX_AGE_MS / 1000} seconds')
    AND julianday(${newest("observed_at")})<=julianday('now','+${CLOCK_SKEW_MS / 1000} seconds')
    AND ${newest("memory_available_bytes")}>=(SELECT memory_mib+${MEMORY_FLOOR_MIB} FROM database_resources WHERE database_id=${database}.id)*${1024 * 1024})`;
}
