// SPDX-License-Identifier: Apache-2.0
// What a node's link leaves in D1 for placement and the capacity alerts: the node's newest sample
// (`nodes.last_sample_json`, `last_observed_at`) and its per-minute rollups (`node_minutes`).
import { env } from "cloudflare:workers";

export const MIB = 1024 ** 2;
export const GIB = 1024 ** 3;

/** The thin pool of one sample. */
export interface PoolSeed {
  dataTotal: number;
  dataUsed: number;
  metadataTotal: number;
  metadataUsed: number;
  nominal: number;
}
/** A pool that placement may use: 10 % of its data, 1 % of its metadata, 50 GiB sold of 100. */
export const OPEN_POOL: PoolSeed = {
  dataTotal: 100 * GIB,
  dataUsed: 10 * GIB,
  metadataTotal: GIB,
  metadataUsed: 10 * MIB,
  nominal: 50 * GIB,
};

/** One sample; whatever is left out is an idle, open node of 10 GiB and 8 cores. */
export interface SampleSeed {
  at: number;
  totalBytes?: number;
  /** Active RAM in parts per million of the total; the used bytes are rounded down. */
  ramPpm?: number;
  /** Used bytes, instead of `ramPpm`. */
  usedBytes?: number;
  cores?: number;
  /** Busy CPU in parts per million of all cores. */
  cpuPpm?: number;
  /** Null is a pool that the node could not read. */
  pool?: PoolSeed | null;
  room?: boolean;
  /** Thin volumes on the node (default 0); none of them is mounted. */
  volumes?: number;
  /** Wakes the node refused for awake capacity in this sample's minute. */
  refusals?: number;
}
export const NODE_BYTES = 10 * GIB;

const MINUTE_MS = 60_000;
const figures = (seed: SampleSeed) => {
  const total = seed.totalBytes ?? NODE_BYTES,
    used = seed.usedBytes ?? Math.floor((total * (seed.ramPpm ?? 0)) / 1e6),
    cores = seed.cores ?? 8;
  return {
    total,
    used,
    cores,
    busy: Math.floor((cores * 1000 * (seed.cpuPpm ?? 0)) / 1e6),
    pool: seed.pool === undefined ? OPEN_POOL : seed.pool,
    room: seed.room !== false,
    volumes: seed.volumes ?? 0,
  };
};

/** The sample as the link stores it in `nodes.last_sample_json`. */
function sampleJson(seed: SampleSeed): string {
  const f = figures(seed),
    observedAt = new Date(seed.at).toISOString();
  return JSON.stringify({
    observed_at: observedAt,
    memory: { total_bytes: f.total, available_bytes: f.total - f.used },
    cpu: { cores: f.cores, busy_millicores: f.busy },
    pool:
      f.pool === null
        ? null
        : {
            observed_at: observedAt,
            data_total_bytes: f.pool.dataTotal,
            data_used_bytes: f.pool.dataUsed,
            metadata_total_bytes: f.pool.metadataTotal,
            metadata_used_bytes: f.pool.metadataUsed,
            nominal_bytes: f.pool.nominal,
          },
    room: f.room,
    volumes: { total: f.volumes, mounted: 0 },
    archive: { ready_files: null, oldest_ready_seconds: null },
    awake: [],
    awake_memory_mib: 0,
    starting: 0,
    queued: 0,
    credentials_revision: null,
  });
}

/** The samples a node has been given, by instant: a seed at an instant that exists replaces it. */
const given = new Map<string, Map<number, SampleSeed>>();
/**
 * The rollup rows of the minutes `seeds` fall in, and the node's newest sample as the newest seed
 * has it. The samples of one minute fold into one row, as the NodeActor folds them.
 */
export function sampleStatements(
  nodeId: string,
  seeds: readonly SampleSeed[],
): D1PreparedStatement[] {
  if (seeds.length === 0) return [];
  const history = given.get(nodeId) ?? new Map<number, SampleSeed>();
  given.set(nodeId, history);
  for (const seed of seeds) history.set(seed.at, seed);
  const touched = new Set(seeds.map((seed) => Math.floor(seed.at / MINUTE_MS)));
  const statements: D1PreparedStatement[] = [];
  for (const minute of touched) {
    const group = [...history.values()]
        .filter((seed) => Math.floor(seed.at / MINUTE_MS) === minute)
        .sort((a, b) => a.at - b.at),
      all = group.map(figures),
      last = all.at(-1)!,
      used = all.map((f) => f.used),
      busy = all.map((f) => f.busy),
      pool = last.pool;
    statements.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO node_minutes(node_id,minute,samples,memory_total_bytes,memory_used_bytes_sum,memory_used_bytes_max,
          cpu_cores,cpu_busy_millicores_sum,cpu_busy_millicores_max,no_room_samples,
          pool_data_total_bytes,pool_data_used_bytes,pool_metadata_total_bytes,pool_metadata_used_bytes,pool_nominal_bytes,
          refused_no_headroom)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        nodeId,
        minute,
        group.length,
        last.total,
        used.reduce((a, b) => a + b, 0),
        Math.max(...used),
        last.cores,
        busy.reduce((a, b) => a + b, 0),
        Math.max(...busy),
        all.filter((f) => !f.room).length,
        pool?.dataTotal ?? null,
        pool?.dataUsed ?? null,
        pool?.metadataTotal ?? null,
        pool?.metadataUsed ?? null,
        pool?.nominal ?? null,
        group.reduce((sum, seed) => sum + (seed.refusals ?? 0), 0),
      ),
    );
  }
  const newest = [...history.values()].reduce((a, b) => (b.at >= a.at ? b : a));
  statements.push(
    env.DB.prepare(
      "UPDATE nodes SET last_observed_at=?,last_sample_json=? WHERE id=?",
    ).bind(new Date(newest.at).toISOString(), sampleJson(newest), nodeId),
  );
  return statements;
}
export async function seedSamples(
  nodeId: string,
  seeds: readonly SampleSeed[],
): Promise<void> {
  // D1 admits 100 statements to a batch.
  const statements = sampleStatements(nodeId, seeds);
  for (let i = 0; i < statements.length; i += 90)
    await env.DB.batch(statements.slice(i, i + 90));
}
/**
 * One sample a minute for `minutes` minutes, the last at `now`: what the link writes of a node that
 * stays as it is.
 */
export function steady(
  now: number,
  minutes: number,
  seed: Omit<SampleSeed, "at"> = {},
): SampleSeed[] {
  return Array.from({ length: minutes + 1 }, (_, i) => ({
    ...seed,
    at: now - (minutes - i) * 60_000,
  }));
}

/**
 * The statements that make a node report, now: idle, `memoryMib` of RAM, 8 cores, and a thin pool
 * of `storageGib` GiB that has nothing placed on it; no pool without storage.
 */
export function reportStatements(
  nodeId: string,
  memoryMib = 4096,
  storageGib: number | null = 30,
): D1PreparedStatement[] {
  return sampleStatements(nodeId, [
    {
      at: Date.now(),
      totalBytes: memoryMib * MIB,
      pool: storageGib
        ? {
            dataTotal: storageGib * GIB,
            dataUsed: 0,
            metadataTotal: GIB,
            metadataUsed: 0,
            nominal: 0,
          }
        : null,
    },
  ]);
}
export async function reports(
  nodeId: string,
  memoryMib?: number,
  storageGib?: number | null,
): Promise<void> {
  await env.DB.batch(reportStatements(nodeId, memoryMib, storageGib));
}

/**
 * Changes the node's newest sample, as a later sample of the link would, with the minute it
 * falls in when it changes the available memory.
 */
export async function patchSample(
  nodeId: string,
  patch: { observedAt?: string; availableBytes?: number; room?: boolean },
): Promise<void> {
  if (patch.availableBytes !== undefined)
    await env.DB.prepare(
      `UPDATE node_minutes SET memory_used_bytes_sum=samples*(memory_total_bytes-?1),
        memory_used_bytes_max=memory_total_bytes-?1
      WHERE node_id=?2 AND minute=(SELECT MAX(minute) FROM node_minutes WHERE node_id=?2)`,
    )
      .bind(patch.availableBytes, nodeId)
      .run();
  await env.DB.prepare(
    `UPDATE nodes SET
      last_observed_at=COALESCE(?,last_observed_at),
      last_sample_json=json_set(last_sample_json,
        '$.observed_at',COALESCE(?,json_extract(last_sample_json,'$.observed_at')),
        '$.memory.available_bytes',COALESCE(?,json_extract(last_sample_json,'$.memory.available_bytes')),
        '$.room',CASE WHEN ? IS NULL THEN json_extract(last_sample_json,'$.room') WHEN ?=1 THEN json('true') ELSE json('false') END)
    WHERE id=?`,
  )
    .bind(
      patch.observedAt ?? null,
      patch.observedAt ?? null,
      patch.availableBytes ?? null,
      patch.room === undefined ? null : Number(patch.room),
      patch.room === undefined ? null : Number(patch.room),
      nodeId,
    )
    .run();
}
/** A node that has not sampled: no sample, no rollups. */
export async function forgetSamples(nodeId: string): Promise<void> {
  given.delete(nodeId);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM node_minutes WHERE node_id=?").bind(nodeId),
    env.DB.prepare("UPDATE nodes SET last_sample_json=NULL WHERE id=?").bind(
      nodeId,
    ),
  ]);
}
