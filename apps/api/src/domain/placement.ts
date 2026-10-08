// SPDX-License-Identifier: Apache-2.0
import {
  databaseMemoryReservationMib,
  databaseCpuReservationMillicores,
  SIDECAR,
  type SizeResources,
} from "@pgcf/contracts";
import { MEMORY_SAMPLE_MAX_AGE_MS } from "./memory-capacity.ts";
import {
  startupPhysicalFitSql,
  databaseCpuChargeSql,
} from "./startup-admission.ts";

export const NODE_OBSERVATION_MAX_AGE_MS = 180_000;
export function nodePlacementGuard(alias = "n"): string {
  if (!/^[a-z][a-z0-9_]*$/.test(alias))
    throw new Error("invalid_node_placement_alias");
  return `${alias}.lost_at IS NULL AND ${alias}.last_observed_at>=? AND ${alias}.last_observed_at<=?
    AND julianday(${alias}.last_observed_at)>=julianday('now','-180 seconds')
    AND julianday(${alias}.last_observed_at)<=julianday('now','+5 seconds')`;
}
export function nodePlacementBindings(now = Date.now()): [string, string] {
  return [
    new Date(now - NODE_OBSERVATION_MAX_AGE_MS).toISOString(),
    new Date(now + 5000).toISOString(),
  ];
}
export function nodeDatabasePlacementGuard(alias = "n"): string {
  return `${alias}.database_placement_enabled=1 AND ${alias}.database_placement_closed_at IS NULL
    AND ${nodeDatabaseCapacityGuard(alias)}`;
}
export function nodeDatabaseCapacityGuard(alias = "n"): string {
  if (!/^[a-z][a-z0-9_]*$/.test(alias))
    throw new Error("invalid_node_placement_alias");
  return `(COALESCE((SELECT placement_mode FROM node_region_policies WHERE region_id=${alias}.region_id),'reserved')='reserved'
      OR (${alias}.node_uid IS NOT NULL
        AND ${startupPhysicalFitSql(alias, "s")}
        AND s.memory_mib%256=0
        AND (SELECT maximum_database_memory_mib FROM node_region_policies WHERE region_id=${alias}.region_id)>=s.memory_mib
        AND (SELECT postgres_memory_request_mib FROM node_region_policies WHERE region_id=${alias}.region_id)<=s.memory_mib
        AND EXISTS(SELECT 1 FROM node_memory_samples m WHERE m.node_id=${alias}.id AND m.node_uid=${alias}.node_uid
          AND m.observed_at=(SELECT MAX(observed_at) FROM node_memory_samples WHERE node_id=${alias}.id AND node_uid=${alias}.node_uid)
          AND julianday(m.observed_at)>=julianday('now','-90 seconds') AND julianday(m.observed_at)<=julianday('now','+5 seconds')
          AND m.memory_pressure=0 AND m.capacity_memory_bytes>0 AND m.working_set_bytes BETWEEN 0 AND m.capacity_memory_bytes
          AND m.available_bytes BETWEEN 0 AND m.capacity_memory_bytes)))`;
}
export function nodeMemoryReservationGuard(
  expression: string,
  alias = "n",
): string {
  if (!/^[a-z][a-z0-9_]*$/.test(alias))
    throw new Error("invalid_node_placement_alias");
  return `(COALESCE((SELECT placement_mode FROM node_region_policies WHERE region_id=${alias}.region_id),'reserved')='actual_ram' OR (${expression}))`;
}
export async function databaseMemoryPolicyAllows(
  db: D1Database,
  regionId: string,
  memoryMib: number,
): Promise<boolean> {
  const policy = await db
    .prepare(
      "SELECT placement_mode,maximum_database_memory_mib,postgres_memory_request_mib FROM node_region_policies WHERE region_id=?",
    )
    .bind(regionId)
    .first<{
      placement_mode: string;
      maximum_database_memory_mib: number | null;
      postgres_memory_request_mib: number | null;
    }>();
  return (
    policy?.placement_mode !== "actual_ram" ||
    (memoryMib % 256 === 0 &&
      policy.maximum_database_memory_mib !== null &&
      memoryMib <= policy.maximum_database_memory_mib &&
      policy.postgres_memory_request_mib !== null &&
      memoryMib >= policy.postgres_memory_request_mib)
  );
}

export interface PlacementNode {
  id: string;
  region_id: string;
  ready: number | boolean;
  schedulable: number | boolean;
  allocatable_memory_mib: number;
  platform_reserved_memory_mib: number;
  allocatable_cpu_millicores: number;
  platform_reserved_cpu_millicores?: number | null;
  reserved_cpu_millicores: number;
  storage_gib_total: number | null;
  reserved_memory_mib: number;
  reserved_storage_gib: number;
  last_observed_at?: string | null;
  lost_at?: string | null;
  database_placement_enabled?: number | boolean;
  database_placement_closed_at?: string | null;
  placement_mode?: "reserved" | "actual_ram";
  node_uid?: string | null;
  memory_window_valid?: number | boolean;
  memory_window_observed_at?: string | null;
  memory_utilization_ppm?: number | null;
  maximum_database_memory_mib?: number | null;
  postgres_memory_request_mib?: number | null;
  memory_latest_observed_at?: string | null;
  memory_latest_available_bytes?: number | null;
  memory_latest_capacity_bytes?: number | null;
  memory_latest_working_set_bytes?: number | null;
  memory_latest_pressure?: boolean | number | null;
}
function physicalStartupFits(
  node: PlacementNode,
  size: SizeResources,
): boolean {
  const mib = 1024 ** 2,
    peak = (size.memory_mib + SIDECAR.limitMemoryMib) * mib,
    allocatable = node.allocatable_memory_mib * mib,
    platform = node.platform_reserved_memory_mib * mib,
    physical = node.memory_latest_capacity_bytes;
  return (
    Number.isSafeInteger(size.memory_mib) &&
    size.memory_mib > 0 &&
    Number.isSafeInteger(peak) &&
    peak > 0 &&
    Number.isSafeInteger(node.allocatable_memory_mib) &&
    node.allocatable_memory_mib > 0 &&
    Number.isSafeInteger(allocatable) &&
    Number.isSafeInteger(node.platform_reserved_memory_mib) &&
    node.platform_reserved_memory_mib >= 0 &&
    Number.isSafeInteger(platform) &&
    platform <= allocatable &&
    Number.isSafeInteger(physical) &&
    physical! > 0 &&
    Math.min(physical!, allocatable) - platform >= peak
  );
}

export function choosePlacement(
  nodes: readonly PlacementNode[],
  regionId: string,
  size: SizeResources,
  now = Date.now(),
  existingNodeId?: string,
): PlacementNode | null {
  const needed = databaseMemoryReservationMib(size);
  return (
    nodes
      .filter(
        (n) =>
          n.region_id === regionId &&
          n.ready &&
          n.schedulable &&
          (existingNodeId === undefined
            ? n.database_placement_enabled !== 0 &&
              n.database_placement_enabled !== false &&
              n.database_placement_closed_at == null
            : n.id === existingNodeId) &&
          n.lost_at == null &&
          n.last_observed_at != null &&
          Date.parse(n.last_observed_at) >= now - NODE_OBSERVATION_MAX_AGE_MS &&
          Date.parse(n.last_observed_at) <= now + 5000 &&
          Number.isSafeInteger(n.platform_reserved_cpu_millicores) &&
          n.platform_reserved_cpu_millicores! >= 0 &&
          n.allocatable_cpu_millicores -
            n.platform_reserved_cpu_millicores! -
            n.reserved_cpu_millicores >=
            databaseCpuReservationMillicores(size) &&
          n.storage_gib_total !== null &&
          (n.placement_mode === "actual_ram"
            ? n.node_uid != null &&
              physicalStartupFits(n, size) &&
              size.memory_mib % 256 === 0 &&
              Number.isSafeInteger(n.maximum_database_memory_mib) &&
              n.maximum_database_memory_mib! >= size.memory_mib &&
              Number.isSafeInteger(n.postgres_memory_request_mib) &&
              n.postgres_memory_request_mib! <= size.memory_mib &&
              n.memory_latest_observed_at != null &&
              Date.parse(n.memory_latest_observed_at) >=
                now - MEMORY_SAMPLE_MAX_AGE_MS &&
              Date.parse(n.memory_latest_observed_at) <= now + 5000 &&
              (n.memory_latest_pressure === false ||
                n.memory_latest_pressure === 0) &&
              Number.isSafeInteger(n.memory_latest_capacity_bytes) &&
              n.memory_latest_capacity_bytes! > 0 &&
              Number.isSafeInteger(n.memory_latest_working_set_bytes) &&
              n.memory_latest_working_set_bytes! >= 0 &&
              n.memory_latest_working_set_bytes! <=
                n.memory_latest_capacity_bytes! &&
              Number.isSafeInteger(n.memory_latest_available_bytes) &&
              n.memory_latest_available_bytes! >= 0 &&
              n.memory_latest_available_bytes! <=
                n.memory_latest_capacity_bytes!
            : n.allocatable_memory_mib -
                n.platform_reserved_memory_mib -
                n.reserved_memory_mib >=
              needed) &&
          n.storage_gib_total - n.reserved_storage_gib >= size.storage_gib,
      )
      .sort(
        (a, b) =>
          (a.placement_mode === "actual_ram"
            ? (b.memory_latest_available_bytes ?? -1) -
              (a.memory_latest_available_bytes ?? -1)
            : 0) ||
          b.allocatable_memory_mib -
            b.platform_reserved_memory_mib -
            b.reserved_memory_mib -
            (a.allocatable_memory_mib -
              a.platform_reserved_memory_mib -
              a.reserved_memory_mib) ||
          a.id.localeCompare(b.id),
      )[0] ?? null
  );
}
export async function placementNodes(
  db: D1Database,
  regionId: string,
): Promise<PlacementNode[]> {
  const result = await db
    .prepare(
      `SELECT n.*,COALESCE(p.placement_mode,'reserved') placement_mode,p.maximum_database_memory_mib,p.postgres_memory_request_mib,
      m.observed_at memory_latest_observed_at,m.available_bytes memory_latest_available_bytes,m.capacity_memory_bytes memory_latest_capacity_bytes,
      m.working_set_bytes memory_latest_working_set_bytes,m.memory_pressure memory_latest_pressure,
      COALESCE(SUM(s.memory_mib + ?),0) reserved_memory_mib, COALESCE(SUM(${databaseCpuChargeSql()}),0) reserved_cpu_millicores, COALESCE(SUM(s.storage_gib),0) reserved_storage_gib
    FROM nodes n LEFT JOIN node_region_policies p ON p.region_id=n.region_id LEFT JOIN databases d ON d.node_id=n.id AND d.observed_state <> 'deleted' LEFT JOIN size_classes s ON s.id=d.size_class_id
    LEFT JOIN node_memory_samples m ON m.node_id=n.id AND m.node_uid=n.node_uid
      AND m.observed_at=(SELECT MAX(observed_at) FROM node_memory_samples WHERE node_id=n.id AND node_uid=n.node_uid)
    WHERE n.region_id=? GROUP BY n.id`,
    )
    .bind(SIDECAR.requestMemoryMib, regionId)
    .all<PlacementNode>();
  return result.results;
}
