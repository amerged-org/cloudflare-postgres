// SPDX-License-Identifier: Apache-2.0
import type { NodeMemoryObservation } from "@pgcf/contracts";
import { releaseCoveredStartupReservationsStatement } from "./startup-admission.ts";

export const MEMORY_SAMPLE_MAX_AGE_MS = 90_000;
export const MEMORY_THRESHOLD_PPM = 760_000;
const minuteMs = 60_000;
export interface MemorySample {
  node_uid: string;
  observed_at: string;
  working_set_bytes: number | null;
  capacity_memory_bytes: number | null;
  available_bytes: number | null;
  memory_pressure: boolean | number | null;
}
export function memoryCapacityWindow(
  nodeUid: string,
  samples: readonly MemorySample[],
  now = Date.now(),
): {
  complete: boolean;
  admissible: boolean;
  expand: boolean;
  utilization_ppm: number | null;
  observed_at: string | null;
} {
  const invalid = {
    complete: false,
    admissible: false,
    expand: false,
    utilization_ppm: null,
    observed_at: samples[0]?.observed_at ?? null,
  };
  const sorted = [...samples].sort(
    (a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at),
  );
  const latest = sorted[0];
  if (!latest) return invalid;
  invalid.observed_at = latest.observed_at;
  const latestAt = Date.parse(latest.observed_at);
  if (
    !Number.isFinite(latestAt) ||
    latestAt > now + 5000 ||
    latestAt < now - MEMORY_SAMPLE_MAX_AGE_MS
  )
    return invalid;
  const latestMinute = Math.floor(latestAt / minuteMs);
  const buckets = new Map<number, MemorySample>();
  for (const sample of sorted) {
    const bucket = Math.floor(Date.parse(sample.observed_at) / minuteMs);
    if (bucket < latestMinute - 9 || bucket > latestMinute) continue;
    if (buckets.has(bucket)) return invalid;
    buckets.set(bucket, sample);
  }
  if (buckets.size !== 10) return invalid;
  const capacity = latest.capacity_memory_bytes;
  if (!Number.isSafeInteger(capacity) || capacity! <= 0) return invalid;
  let sum = 0n;
  for (let bucket = latestMinute - 9; bucket <= latestMinute; bucket++) {
    const sample = buckets.get(bucket);
    if (
      !sample ||
      sample.node_uid !== nodeUid ||
      sample.capacity_memory_bytes !== capacity ||
      !Number.isSafeInteger(sample.working_set_bytes) ||
      sample.working_set_bytes! < 0 ||
      sample.working_set_bytes! > capacity!
    )
      return invalid;
    sum += BigInt(sample.working_set_bytes!);
  }
  const denominator = BigInt(capacity!) * 10n;
  const expand = sum * 100n >= denominator * 76n;
  return {
    complete: true,
    admissible:
      latest.memory_pressure === false || latest.memory_pressure === 0,
    expand,
    utilization_ppm: Number((sum * 1_000_000n) / denominator),
    observed_at: latest.observed_at,
  };
}

/** A sample belongs to the authenticated region and exact persisted physical node. */
export async function recordNodeMemoryObservation(
  db: D1Database,
  regionId: string,
  observation: NodeMemoryObservation,
  envelopeObservedAt: string,
  receivedAt = Date.now(),
): Promise<boolean> {
  const sample = observation.memory;
  const observedAt = sample?.observed_at ?? envelopeObservedAt;
  const at = Date.parse(observedAt);
  if (at > receivedAt + 5000 || at > Date.parse(envelopeObservedAt))
    throw new Error("invalid_node_memory_time");
  if (
    sample &&
    (sample.node_uid !== observation.node_uid ||
      sample.working_set_bytes > sample.capacity_memory_bytes ||
      (sample.available_bytes !== null &&
        sample.available_bytes > sample.capacity_memory_bytes))
  )
    throw new Error("invalid_node_memory_sample");
  const result = await db
    .prepare(
      `INSERT INTO node_memory_samples(node_id,node_uid,minute,observed_at,working_set_bytes,capacity_memory_bytes,available_bytes,memory_pressure)
     SELECT id,node_uid,?,?,?,?,?,? FROM nodes WHERE id=? AND region_id=? AND provider_instance_id=? AND node_uid=? AND lost_at IS NULL
     ON CONFLICT(node_id,node_uid,minute) DO UPDATE SET observed_at=excluded.observed_at,working_set_bytes=excluded.working_set_bytes,
       capacity_memory_bytes=excluded.capacity_memory_bytes,available_bytes=excluded.available_bytes,memory_pressure=excluded.memory_pressure
     WHERE excluded.observed_at>node_memory_samples.observed_at`,
    )
    .bind(
      Math.floor(at / minuteMs),
      observedAt,
      sample?.working_set_bytes ?? null,
      sample?.capacity_memory_bytes ?? null,
      sample?.available_bytes ?? null,
      sample?.memory_pressure == null ? null : Number(sample.memory_pressure),
      observation.node_id,
      regionId,
      observation.provider_instance_id,
      observation.node_uid,
    )
    .run();
  if (result.meta.changes !== 1) return false;
  const rows = await db
    .prepare(
      "SELECT * FROM node_memory_samples WHERE node_id=? AND node_uid=? AND observed_at>=? ORDER BY observed_at DESC LIMIT 12",
    )
    .bind(
      observation.node_id,
      observation.node_uid,
      new Date(receivedAt - 12 * minuteMs).toISOString(),
    )
    .all<MemorySample>();
  const window = memoryCapacityWindow(
    observation.node_uid,
    rows.results,
    receivedAt,
  );
  await db.batch([
    db
      .prepare(
        `UPDATE nodes SET memory_window_observed_at=?,memory_window_valid=?,memory_utilization_ppm=?,
      memory_expansion_triggered_at=CASE WHEN ?=1 AND database_placement_enabled=1 AND EXISTS(SELECT 1 FROM node_region_policies WHERE region_id=nodes.region_id AND placement_mode='actual_ram') THEN COALESCE(memory_expansion_triggered_at,?) ELSE memory_expansion_triggered_at END
      WHERE id=? AND region_id=? AND node_uid=? AND lost_at IS NULL
        AND (memory_window_observed_at IS NULL OR memory_window_observed_at<=?)
        AND NOT EXISTS(SELECT 1 FROM node_memory_samples WHERE node_id=nodes.id AND node_uid=nodes.node_uid AND observed_at>?)`,
      )
      .bind(
        window.observed_at,
        Number(window.complete),
        window.utilization_ppm,
        Number(window.expand),
        new Date(receivedAt).toISOString(),
        observation.node_id,
        regionId,
        observation.node_uid,
        observedAt,
        observedAt,
      ),
    releaseCoveredStartupReservationsStatement(db, {
      nodeId: observation.node_id,
      nodeUid: observation.node_uid,
    }),
    db
      .prepare(
        "DELETE FROM node_memory_samples WHERE node_id=? AND observed_at<?",
      )
      .bind(
        observation.node_id,
        new Date(receivedAt - 12 * minuteMs).toISOString(),
      ),
  ]);
  return true;
}
