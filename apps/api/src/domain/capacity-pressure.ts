// SPDX-License-Identifier: Apache-2.0
// Opt-in notifications only. Placement and purchase decisions deliberately keep their own rules.
import { CapacityAlertPolicy } from "@pgcf/contracts/nodes";
import type { InfraAlert } from "@pgcf/contracts";
import {
  LATEST_SAMPLES_SQL,
  NODE_OBSERVATION_MAX_AGE_MS,
  minuteOf,
} from "./placement.ts";

export const CAPACITY_PRESSURE_KINDS = [
  "regional_node_capacity_warning",
  "regional_node_capacity_action",
] as const;
type Kind = (typeof CAPACITY_PRESSURE_KINDS)[number];
type Observation =
  | {
      state: "active";
      detail: Pick<InfraAlert, "node_ids" | "capacity">;
      subjects: string[];
    }
  | { state: "resolved" }
  | { state: "retain" };
interface Pressure {
  id: string;
  ram: number | null;
  cpu: number | null;
  data: number | null;
  metadata: number | null;
  ram_min: number | null;
  cpu_min: number | null;
  data_min: number | null;
  metadata_min: number | null;
  ram_count: number;
  cpu_count: number;
  data_count: number;
  metadata_count: number;
}
const ratio = (used: string, total: string) =>
  `CAST(1000000.0*(${used})/NULLIF((${total}),0) AS INTEGER)`;

/**
 * Warnings and clearing use the latest fresh sample, including a new node's first sample.
 * An action needs every minute's measured value above the threshold for
 * the entire persistence window. Gaps or unknown samples cannot establish sustained pressure.
 * Old three-day peaks never enter this query. Existing episodes clear only below their lower
 * threshold, and unknown measurements neither start nor clear one.
 */
export async function capacityPressureObservations(
  db: D1Database,
  regionId: string,
  raw: string | null,
  now: number,
): Promise<[Kind, Observation][]> {
  if (raw === null)
    return CAPACITY_PRESSURE_KINDS.map((kind) => [kind, { state: "resolved" }]);
  const policy = CapacityAlertPolicy.parse(JSON.parse(raw));
  const minutes = policy.persistence_seconds / 60;
  const readings = await db
    .prepare(
      `WITH latest AS (
    ${LATEST_SAMPLES_SQL} AND n.region_id=? AND n.lost_at IS NULL
      AND julianday(n.last_observed_at)>=julianday(?) AND julianday(n.last_observed_at)<=julianday(?)
  ), samples AS (
    SELECT m.node_id,m.minute,m.samples,
      ${ratio("m.memory_used_bytes_sum", "m.memory_total_bytes*m.samples")} ram,
      ${ratio("m.cpu_busy_millicores_sum", "m.cpu_cores*1000*m.samples")} cpu,
      ${ratio("m.pool_data_used_bytes", "m.pool_data_total_bytes")} data,
      ${ratio("m.pool_metadata_used_bytes", "m.pool_metadata_total_bytes")} metadata,
      CAST(strftime('%s',l.observed_at) AS INTEGER)/60 last_minute
    FROM node_minutes m JOIN latest l ON l.node_id=m.node_id
    WHERE m.samples>0 AND m.minute>=? AND m.minute<=CAST(strftime('%s',l.observed_at) AS INTEGER)/60
  ), sustained AS (
    SELECT node_id,MIN(ram) ram_min,MIN(cpu) cpu_min,MIN(data) data_min,MIN(metadata) metadata_min,
      COUNT(ram) ram_count,COUNT(cpu) cpu_count,COUNT(data) data_count,COUNT(metadata) metadata_count
    FROM samples WHERE minute>=last_minute-? GROUP BY node_id
  ) SELECT l.node_id id,
      ${ratio("l.memory_total_bytes-l.memory_available_bytes", "l.memory_total_bytes")} ram,
      ${ratio("l.cpu_busy_millicores", "l.cpu_cores*1000")} cpu,
      ${ratio("l.pool_data_used_bytes", "l.pool_data_total_bytes")} data,
      ${ratio("l.pool_metadata_used_bytes", "l.pool_metadata_total_bytes")} metadata,
      s.ram_min,s.cpu_min,s.data_min,s.metadata_min,
      COALESCE(s.ram_count,0) ram_count,COALESCE(s.cpu_count,0) cpu_count,
      COALESCE(s.data_count,0) data_count,COALESCE(s.metadata_count,0) metadata_count
    FROM latest l LEFT JOIN sustained s ON s.node_id=l.node_id ORDER BY l.node_id`,
    )
    .bind(
      regionId,
      new Date(now - NODE_OBSERVATION_MAX_AGE_MS).toISOString(),
      new Date(now + 5000).toISOString(),
      minuteOf(now) - minutes - 3,
      minutes,
    )
    .all<Pressure>();
  const current = await db
    .prepare(
      "SELECT kind,active,payload FROM infrastructure_alerts WHERE region_id=? AND kind IN('regional_node_capacity_warning','regional_node_capacity_action')",
    )
    .bind(regionId)
    .all<{ kind: Kind; active: number; payload: string }>();
  const nodes = new Map(readings.results.map((node) => [node.id, node]));
  const lost = new Set(
    (
      await db
        .prepare(
          "SELECT id FROM nodes WHERE region_id=? AND lost_at IS NOT NULL",
        )
        .bind(regionId)
        .all<{ id: string }>()
    ).results.map((node) => node.id),
  );
  return CAPACITY_PRESSURE_KINDS.map((kind) => {
    const action = kind === "regional_node_capacity_action";
    const pressure: NonNullable<InfraAlert["capacity"]> = [];
    for (const node of readings.results)
      for (const resource of ["ram", "cpu", "data", "metadata"] as const) {
        const threshold =
          resource === "metadata"
            ? action
              ? policy.metadata_action_threshold_ppm
              : policy.metadata_warning_threshold_ppm
            : action
              ? policy.action_threshold_ppm
              : policy.warning_threshold_ppm;
        const value = action ? node[`${resource}_min`] : node[resource];
        if (
          value !== null &&
          value >= threshold &&
          (!action ||
            (node[resource] !== null &&
              node[resource]! >= threshold &&
              node[`${resource}_count`] >= minutes + 1))
        )
          pressure.push({
            node_id: node.id,
            resource,
            utilization_ppm: Math.min(1_000_000, value),
            threshold_ppm: threshold,
          });
      }
    if (pressure.length) {
      pressure.sort(
        (a, b) =>
          b.utilization_ppm - a.utilization_ppm ||
          a.node_id.localeCompare(b.node_id) ||
          a.resource.localeCompare(b.resource),
      );
      const capacity = pressure.slice(0, 16),
        node_ids = [...new Set(capacity.map((value) => value.node_id))];
      return [
        kind,
        {
          state: "active",
          detail: { node_ids, capacity },
          subjects: capacity.map(
            (value) => `${value.node_id}:${value.resource}`,
          ),
        },
      ];
    }
    const previous = current.results.find(
      (row) => row.kind === kind && row.active === 1,
    );
    if (previous) {
      const event = JSON.parse(previous.payload) as InfraAlert;
      for (const held of event.capacity ?? []) {
        if (lost.has(held.node_id)) continue;
        const value = nodes.get(held.node_id)?.[held.resource];
        const clear =
          held.resource === "metadata"
            ? policy.metadata_clear_threshold_ppm
            : policy.clear_threshold_ppm;
        if (value == null || value >= clear) return [kind, { state: "retain" }];
      }
    }
    return [kind, { state: "resolved" }];
  });
}
