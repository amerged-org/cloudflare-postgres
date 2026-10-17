// SPDX-License-Identifier: Apache-2.0
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

/** One row of `node_samples`; whatever is left out is an idle, open node of 10 GiB and 8 cores. */
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
  refusals?: number;
}
export const NODE_BYTES = 10 * GIB;

export function sampleStatement(
  nodeId: string,
  seed: SampleSeed,
): D1PreparedStatement {
  const total = seed.totalBytes ?? NODE_BYTES,
    used = seed.usedBytes ?? Math.floor((total * (seed.ramPpm ?? 0)) / 1e6),
    cores = seed.cores ?? 8,
    pool = seed.pool === undefined ? OPEN_POOL : seed.pool;
  return env.DB.prepare(
    `INSERT OR REPLACE INTO node_samples(node_id,observed_at,memory_total_bytes,memory_available_bytes,cpu_cores,cpu_busy_millicores,
      pool_data_total_bytes,pool_data_used_bytes,pool_metadata_total_bytes,pool_metadata_used_bytes,pool_nominal_bytes,room,capacity_refusals)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    nodeId,
    new Date(seed.at).toISOString(),
    total,
    total - used,
    cores,
    Math.floor((cores * 1000 * (seed.cpuPpm ?? 0)) / 1e6),
    pool?.dataTotal ?? null,
    pool?.dataUsed ?? null,
    pool?.metadataTotal ?? null,
    pool?.metadataUsed ?? null,
    pool?.nominal ?? null,
    seed.room === false ? 0 : 1,
    seed.refusals ?? 0,
  );
}
export async function seedSamples(
  nodeId: string,
  seeds: readonly SampleSeed[],
): Promise<void> {
  // D1 admits 100 statements to a batch.
  for (let i = 0; i < seeds.length; i += 90)
    await env.DB.batch(
      seeds.slice(i, i + 90).map((seed) => sampleStatement(nodeId, seed)),
    );
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
 * The statement that makes a node report, now: idle, `memoryMib` of RAM, 8 cores, and a thin pool
 * of `storageGib` GiB that has nothing placed on it; no pool without storage.
 */
export function reportStatement(
  nodeId: string,
  memoryMib = 4096,
  storageGib: number | null = 30,
): D1PreparedStatement {
  return sampleStatement(nodeId, {
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
  });
}
export async function reports(
  nodeId: string,
  memoryMib?: number,
  storageGib?: number | null,
): Promise<void> {
  await reportStatement(nodeId, memoryMib, storageGib).run();
}
