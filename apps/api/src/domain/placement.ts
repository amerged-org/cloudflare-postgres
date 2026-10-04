// SPDX-License-Identifier: Apache-2.0
import {
  databaseMemoryReservationMib,
  databaseCpuReservationMillicores,
  SIDECAR,
  type SizeResources,
} from "@pgcf/contracts";

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
}
export function choosePlacement(
  nodes: readonly PlacementNode[],
  regionId: string,
  size: SizeResources,
): PlacementNode | null {
  const needed = databaseMemoryReservationMib(size);
  return (
    nodes
      .filter(
        (n) =>
          n.region_id === regionId &&
          n.ready &&
          n.schedulable &&
          Number.isSafeInteger(n.platform_reserved_cpu_millicores) &&
          n.platform_reserved_cpu_millicores! >= 0 &&
          n.allocatable_cpu_millicores -
            n.platform_reserved_cpu_millicores! -
            n.reserved_cpu_millicores >=
            databaseCpuReservationMillicores(size) &&
          n.storage_gib_total !== null &&
          n.allocatable_memory_mib -
            n.platform_reserved_memory_mib -
            n.reserved_memory_mib >=
            needed &&
          n.storage_gib_total - n.reserved_storage_gib >= size.storage_gib,
      )
      .sort(
        (a, b) =>
          b.allocatable_memory_mib -
            b.platform_reserved_memory_mib -
            b.reserved_memory_mib -
            (a.allocatable_memory_mib -
              a.platform_reserved_memory_mib -
              a.reserved_memory_mib) || a.id.localeCompare(b.id),
      )[0] ?? null
  );
}
export async function placementNodes(
  db: D1Database,
  regionId: string,
): Promise<PlacementNode[]> {
  const result = await db
    .prepare(
      `SELECT n.*, COALESCE(SUM(s.memory_mib + ?),0) reserved_memory_mib, COALESCE(SUM(s.cpu_millicores + ?),0) reserved_cpu_millicores, COALESCE(SUM(s.storage_gib),0) reserved_storage_gib
    FROM nodes n LEFT JOIN databases d ON d.node_id=n.id AND d.observed_state <> 'deleted' LEFT JOIN size_classes s ON s.id=d.size_class_id
    WHERE n.region_id=? GROUP BY n.id`,
    )
    .bind(SIDECAR.requestMemoryMib, SIDECAR.requestCpuMillicores, regionId)
    .all<PlacementNode>();
  return result.results;
}
