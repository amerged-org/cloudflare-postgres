// SPDX-License-Identifier: Apache-2.0
import { DatabaseId, RegionId, SIDECAR } from "@pgcf/contracts";
import { choosePlacement, placementNodes } from "./placement.ts";
import type { DatabaseRow, SizeRow } from "./rows.ts";

export async function placePendingDatabases(
  db: D1Database,
  regionId: string,
  limit = 8,
): Promise<string[]> {
  RegionId.parse(regionId);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8)
    throw new Error("invalid_pending_placement_limit");
  const pending = await db
    .prepare(
      `SELECT d.* FROM databases d JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL
    WHERE d.region_id=? AND d.node_id IS NULL AND d.desired_state='running' AND d.deleted_at IS NULL
    AND EXISTS(SELECT 1 FROM operations o WHERE o.database_id=d.id AND o.project_id=d.project_id
      AND o.kind='database.create' AND o.status='pending') ORDER BY d.created_at,d.id LIMIT ?`,
    )
    .bind(regionId, limit)
    .all<DatabaseRow>();
  const placed: string[] = [];
  for (const row of pending.results) {
    DatabaseId.parse(row.id);
    const size = await db
      .prepare("SELECT * FROM size_classes WHERE id=? AND enabled=1")
      .bind(row.size_class_id)
      .first<SizeRow>();
    if (!size) continue;
    const node = choosePlacement(
      await placementNodes(db, regionId),
      regionId,
      size,
    );
    if (!node) continue;
    const now = new Date().toISOString();
    const results = await db.batch([
      db
        .prepare(
          `UPDATE databases SET node_id=?,status_message=NULL,updated_at=?
        WHERE id=? AND project_id=? AND region_id=? AND node_id IS NULL AND generation=? AND updated_at=?
        AND desired_state='running' AND deleted_at IS NULL AND size_class_id=?
        AND EXISTS(SELECT 1 FROM projects p WHERE p.id=databases.project_id AND p.deleted_at IS NULL)
        AND EXISTS(SELECT 1 FROM nodes n JOIN size_classes s ON s.id=databases.size_class_id AND s.enabled=1
          WHERE n.id=? AND n.region_id=databases.region_id AND n.ready=1 AND n.schedulable=1
          AND n.platform_reserved_cpu_millicores IS NOT NULL AND n.storage_gib_total IS NOT NULL
          AND n.allocatable_memory_mib-n.platform_reserved_memory_mib-COALESCE((SELECT SUM(sc.memory_mib+?) FROM databases d JOIN size_classes sc ON sc.id=d.size_class_id WHERE d.node_id=n.id AND d.observed_state<>'deleted'),0)>=s.memory_mib+?
          AND n.allocatable_cpu_millicores-n.platform_reserved_cpu_millicores-COALESCE((SELECT SUM(sc.cpu_millicores+?) FROM databases d JOIN size_classes sc ON sc.id=d.size_class_id WHERE d.node_id=n.id AND d.observed_state<>'deleted'),0)>=s.cpu_millicores+?
          AND n.storage_gib_total-COALESCE((SELECT SUM(sc.storage_gib) FROM databases d JOIN size_classes sc ON sc.id=d.size_class_id WHERE d.node_id=n.id AND d.observed_state<>'deleted'),0)>=s.storage_gib
          AND s.memory_mib=? AND s.cpu_millicores=? AND s.storage_gib=?)`,
        )
        .bind(
          node.id,
          now,
          row.id,
          row.project_id,
          regionId,
          row.generation,
          row.updated_at,
          row.size_class_id,
          node.id,
          SIDECAR.requestMemoryMib,
          SIDECAR.requestMemoryMib,
          SIDECAR.requestCpuMillicores,
          SIDECAR.requestCpuMillicores,
          size.memory_mib,
          size.cpu_millicores,
          size.storage_gib,
        ),
      db
        .prepare(
          `INSERT INTO lifecycle_events(database_id,kind,node_id,size_class_id,generation,occurred_at,resource_snapshot)
        SELECT id,'created',node_id,size_class_id,generation,?,? FROM databases
        WHERE changes()=1 AND id=? AND node_id=? AND updated_at=?`,
        )
        .bind(
          now,
          JSON.stringify({
            memory_mib: size.memory_mib,
            cpu_millicores: size.cpu_millicores,
            reserved_memory_mib: size.memory_mib + SIDECAR.requestMemoryMib,
            reserved_cpu_millicores:
              size.cpu_millicores + SIDECAR.requestCpuMillicores,
            storage_allocated_bytes: size.storage_gib * 2 ** 30,
          }),
          row.id,
          node.id,
          now,
        ),
      db
        .prepare(
          `UPDATE operations SET updated_at=? WHERE database_id=? AND kind='database.create' AND status='pending'
        AND EXISTS(SELECT 1 FROM databases d WHERE d.id=? AND d.node_id=? AND d.updated_at=?)`,
        )
        .bind(now, row.id, row.id, node.id, now),
    ]);
    if (results[0]!.meta.changes === 1) placed.push(row.id);
  }
  return placed;
}
