// SPDX-License-Identifier: Apache-2.0
import {
  DatabaseId,
  RegionId,
  SIDECAR,
  databaseCpuReservationMillicores,
  postgresCpuRequestMillicores,
} from "@pgcf/contracts";
import {
  choosePlacement,
  placementNodes,
  nodePlacementGuard,
  nodePlacementBindings,
  nodeDatabasePlacementGuard,
  nodeMemoryReservationGuard,
  databaseMemoryPolicyAllows,
  type PlacementNode,
} from "./placement.ts";
import type { DatabaseRow, SizeRow } from "./rows.ts";
import type { Env } from "../env.ts";
import { regionalRamWindowSql } from "./memory-capacity.ts";
import { runInfrastructureAlerts } from "./infrastructure-alerts.ts";
import {
  NodeAdditionRequest,
  NodeOrderConfiguration,
} from "@pgcf/contracts/nodes";
import {
  NodeStateError,
  nodeRegionOccupiedSlots,
  readNodeAddition,
  reserveNodeAddition,
  approveStandingNodePurchase,
} from "./node-state.ts";
import { startAddNode } from "../platform/nodes.ts";
import {
  startupHeadroomSql,
  computePoolOverheadSql,
  startupReservationStatement,
  nodeCpuHeadroomSql,
} from "./startup-admission.ts";

import {
  nodeStoragePlacementSql,
  selectedStorageProfileSql,
} from "./storage-capacity.ts";
import { recoverStorageProtectedDatabases } from "./lifecycle.ts";
/** Read selection avoids busy workers; the final mutation still checks the same guard atomically. */
export async function startupPlacementNodes(
  db: D1Database,
  regionId: string,
  sizeClassId: string,
): Promise<PlacementNode[]> {
  const nodes = await placementNodes(db, regionId);
  const available = await db
    .prepare(
      `SELECT n.id FROM nodes n JOIN size_classes s ON s.id=? AND s.enabled=1
    WHERE n.region_id=? AND ${nodeCpuHeadroomSql()} AND ${startupHeadroomSql()} AND ${nodeStoragePlacementSql()}`,
    )
    .bind(sizeClassId, regionId)
    .all<{ id: string }>();
  const ids = new Set(available.results.map((node) => node.id));
  return nodes.filter((node) => ids.has(node.id));
}

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
      `SELECT d.*,(SELECT o.id FROM operations o WHERE o.database_id=d.id AND o.project_id=d.project_id
        AND o.kind IN('database.create','database.restore') AND o.status='pending' ORDER BY o.created_at,o.id LIMIT 1) startup_operation_id
      FROM databases d JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL
    WHERE d.region_id=? AND d.node_id IS NULL AND d.desired_state='running' AND d.deleted_at IS NULL
    AND EXISTS(SELECT 1 FROM operations o WHERE o.database_id=d.id AND o.project_id=d.project_id
      AND o.kind IN('database.create','database.restore') AND o.status='pending') ORDER BY d.created_at,d.id LIMIT ?`,
    )
    .bind(regionId, limit)
    .all<DatabaseRow & { startup_operation_id: string }>();
  const placed: string[] = [];
  for (const row of pending.results) {
    DatabaseId.parse(row.id);
    const size = await db
      .prepare("SELECT * FROM size_classes WHERE id=? AND enabled=1")
      .bind(row.size_class_id)
      .first<SizeRow>();
    if (!size) continue;
    const node = choosePlacement(
      await startupPlacementNodes(db, regionId, size.id),
      regionId,
      size,
    );
    if (!node) continue;
    const now = new Date().toISOString();
    const results = await db.batch([
      db
        .prepare(
          `UPDATE databases SET node_id=?,storage_profile_json=(SELECT ${selectedStorageProfileSql("storage_node")} FROM nodes storage_node WHERE storage_node.id=?),status_message=NULL,updated_at=?
        WHERE (id=? AND project_id=? AND region_id=? AND node_id IS NULL AND generation=? AND updated_at=?)
        AND (desired_state='running' AND deleted_at IS NULL AND size_class_id=?)
        AND EXISTS(SELECT 1 FROM projects p WHERE p.id=databases.project_id AND p.deleted_at IS NULL)
        AND EXISTS(SELECT 1 FROM operations o WHERE o.id=? AND o.database_id=databases.id AND o.project_id=databases.project_id
          AND o.kind IN('database.create','database.restore') AND o.status='pending')
        AND EXISTS(SELECT 1 FROM nodes n JOIN size_classes s ON s.id=databases.size_class_id AND s.enabled=1
          WHERE (n.id=? AND n.region_id=databases.region_id AND n.ready=1 AND n.schedulable=1)
          AND ((${nodePlacementGuard()})
          AND ${nodeDatabasePlacementGuard()}
          AND ${startupHeadroomSql()}
          AND n.platform_reserved_cpu_millicores IS NOT NULL)
          AND (${nodeMemoryReservationGuard(`n.allocatable_memory_mib-n.platform_reserved_memory_mib-COALESCE((SELECT SUM(sc.memory_mib+?+${computePoolOverheadSql("d", "memory_mib")}) FROM databases d JOIN size_classes sc ON sc.id=d.size_class_id WHERE d.node_id=n.id AND d.observed_state<>'deleted'),0)>=s.memory_mib+?+${computePoolOverheadSql("n", "memory_mib")}`)}
          AND ${nodeCpuHeadroomSql()})
          AND ${nodeStoragePlacementSql()}
          AND (s.memory_mib=? AND s.cpu_millicores=?
          AND COALESCE(s.cpu_request_millicores,s.cpu_millicores)=? AND s.storage_gib=?))`,
        )
        .bind(
          node.id,
          node.id,
          now,
          row.id,
          row.project_id,
          regionId,
          row.generation,
          row.updated_at,
          row.size_class_id,
          row.startup_operation_id,
          node.id,
          ...nodePlacementBindings(),
          SIDECAR.requestMemoryMib,
          SIDECAR.requestMemoryMib,
          size.memory_mib,
          size.cpu_millicores,
          postgresCpuRequestMillicores(size),
          size.storage_gib,
        ),
      db
        .prepare(
          `INSERT INTO lifecycle_events(database_id,kind,node_id,size_class_id,generation,occurred_at,resource_snapshot)
        SELECT id,'created',node_id,size_class_id,generation,?,json_set(?,'$.storage_allocated_bytes',CASE WHEN storage_profile_json IS NULL THEN ? ELSE NULL END,'$.reserved_cpu_millicores',?+${computePoolOverheadSql("databases", "cpu_millicores")},'$.reserved_memory_mib',?+${computePoolOverheadSql("databases", "memory_mib")}) FROM databases
        WHERE changes()=1 AND id=? AND node_id=? AND updated_at=?`,
        )
        .bind(
          now,
          JSON.stringify({
            memory_mib: size.memory_mib,
            cpu_millicores: size.cpu_millicores,
            reserved_memory_mib: size.memory_mib + SIDECAR.requestMemoryMib,
            reserved_cpu_millicores: databaseCpuReservationMillicores(size),
            storage_allocated_bytes: size.storage_gib * 2 ** 30,
          }),
          size.storage_gib * 2 ** 30,
          databaseCpuReservationMillicores(size),
          size.memory_mib + SIDECAR.requestMemoryMib,
          row.id,
          node.id,
          now,
        ),
      db
        .prepare(
          `UPDATE operations SET updated_at=? WHERE database_id=? AND kind IN('database.create','database.restore') AND status='pending'
        AND EXISTS(SELECT 1 FROM databases d WHERE d.id=? AND d.node_id=? AND d.updated_at=?)`,
        )
        .bind(now, row.id, row.id, node.id, now),
      startupReservationStatement(db, {
        databaseId: row.id,
        operationId: row.startup_operation_id,
        generation: row.generation,
        nodeId: node.id,
        now,
      }),
    ]);
    if (results[0]!.meta.changes === 1) placed.push(row.id);
  }
  return placed;
}

export async function runNodeCapacity(
  env: Env,
  regionId: string,
  dryRun = false,
) {
  RegionId.parse(regionId);
  const policy = await env.DB.prepare(
    "SELECT * FROM node_region_policies WHERE region_id=?",
  )
    .bind(regionId)
    .first<{
      max_nodes: number | null;
      ram_expansion_threshold_ppm: number | null;
      autoscale_enabled: number;
      order_config: string | null;
      adopt_instance_ids: string;
      placement_mode: "reserved" | "actual_ram";
    }>();
  const recovered = dryRun
    ? []
    : await recoverStorageProtectedDatabases(env.DB, regionId);
  const placed = dryRun ? [] : await placePendingDatabases(env.DB, regionId);
  if (placed.length || recovered.length)
    await env.REGION_LINK.get(env.REGION_LINK.idFromName(regionId)).notify([
      ...recovered,
      ...placed,
    ]);
  const result = {
    region_id: regionId,
    dry_run: dryRun,
    placed: placed.length,
    action: "idle",
    operation_id: null as string | null,
  };
  if (!policy) return { ...result, action: "unconfigured" };
  const pending = await env.DB.prepare(
    `SELECT d.id,d.size_class_id FROM databases d JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL
    WHERE d.region_id=? AND d.node_id IS NULL AND d.desired_state='running' AND d.deleted_at IS NULL ORDER BY d.created_at,d.id LIMIT 1`,
  )
    .bind(regionId)
    .first<{ id: string; size_class_id: string }>();
  const smallest = await env.DB.prepare(
    "SELECT * FROM size_classes WHERE enabled=1 ORDER BY memory_mib,COALESCE(cpu_request_millicores,cpu_millicores),cpu_millicores,storage_gib,id LIMIT 1",
  ).first<SizeRow>();
  const regionalWindow =
    policy.placement_mode === "actual_ram" ||
    policy.ram_expansion_threshold_ppm !== null
      ? await env.DB.prepare(regionalRamWindowSql("?")).bind(regionId).first<{
          minute: number;
          working_set_bytes: number;
          capacity_memory_bytes: number;
        }>()
      : null;
  const threshold =
    regionalWindow !== null &&
    policy.ram_expansion_threshold_ppm !== null &&
    BigInt(regionalWindow.working_set_bytes) * 1_000_000n >=
      BigInt(regionalWindow.capacity_memory_bytes) *
        BigInt(policy.ram_expansion_threshold_ppm)
      ? regionalWindow
      : null;
  const active = await env.DB.prepare(
    "SELECT operation_id FROM node_additions WHERE region_id=? AND slot_held=1 AND status NOT IN('ready','cancelled') ORDER BY created_at LIMIT 1",
  )
    .bind(regionId)
    .first<{ operation_id: string }>();
  if (active) {
    let addition;
    try {
      addition = dryRun
        ? await readNodeAddition(env.DB, active.operation_id)
        : await approveStandingNodePurchase(env.DB, active.operation_id);
    } catch (error) {
      if (error instanceof NodeStateError && error.code === "approval_required")
        return {
          ...result,
          action: "waiting_for_approval",
          operation_id: active.operation_id,
        };
      throw error;
    }
    if (!dryRun) await startAddNode(env, active.operation_id);
    return {
      ...result,
      action:
        addition.intent.request.mode === "order" && addition.approval === null
          ? "waiting_for_approval"
          : "addition_in_progress",
      operation_id: active.operation_id,
    };
  }
  if (
    !pending &&
    !threshold &&
    ((policy.placement_mode === "actual_ram" && regionalWindow !== null) ||
      !smallest ||
      choosePlacement(
        await placementNodes(env.DB, regionId),
        regionId,
        smallest,
      ))
  )
    return result;
  const stale = await env.DB.prepare(
    `SELECT id FROM nodes n WHERE region_id=? AND lost_at IS NULL AND database_placement_enabled=1 AND NOT COALESCE((${nodePlacementGuard()}),0) LIMIT 1`,
  )
    .bind(regionId, ...nodePlacementBindings())
    .first();
  if (stale) return { ...result, action: "observations_stale" };
  if (policy.placement_mode === "actual_ram" && threshold === null && pending) {
    const size = await env.DB.prepare(
      "SELECT * FROM size_classes WHERE id=? AND enabled=1",
    )
      .bind(pending.size_class_id)
      .first<SizeRow>();
    if (
      !size ||
      !(await databaseMemoryPolicyAllows(env.DB, regionId, size.memory_mib))
    )
      return { ...result, action: "size_policy_unavailable" };
    const candidate = choosePlacement(
      await placementNodes(env.DB, regionId),
      regionId,
      size,
    );
    if (candidate) {
      const held = await env.DB.prepare(
        "SELECT 1 FROM database_start_admissions WHERE node_id=? AND node_uid=? LIMIT 1",
      )
        .bind(candidate.id, candidate.node_uid!)
        .first();
      return {
        ...result,
        action: held ? "starts_in_progress" : "memory_headroom_wait",
      };
    }
  }
  if (policy.placement_mode === "actual_ram" && threshold === null) {
    const unknown = await env.DB.prepare(
      `SELECT id FROM nodes n WHERE region_id=? AND lost_at IS NULL AND database_placement_enabled=1 AND database_placement_closed_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM node_memory_samples m WHERE m.node_id=n.id AND m.node_uid=n.node_uid
        AND m.observed_at=(SELECT MAX(observed_at) FROM node_memory_samples WHERE node_id=n.id AND node_uid=n.node_uid)
        AND julianday(m.observed_at)>=julianday('now','-90 seconds') AND julianday(m.observed_at)<=julianday('now','+5 seconds')
        AND m.memory_pressure=0 AND m.capacity_memory_bytes>0 AND m.working_set_bytes BETWEEN 0 AND m.capacity_memory_bytes
        AND m.available_bytes BETWEEN 0 AND m.capacity_memory_bytes) LIMIT 1`,
    )
      .bind(regionId)
      .first();
    if (unknown || regionalWindow === null)
      return { ...result, action: "memory_observations_unknown" };
    if (pending) return { ...result, action: "capacity_wait" };
  }
  if (!policy.autoscale_enabled) return { ...result, action: "disabled" };
  if (
    policy.max_nodes !== null &&
    (await nodeRegionOccupiedSlots(env.DB, regionId)) >= policy.max_nodes
  )
    return { ...result, action: "cap_reached" };
  let request: NodeAdditionRequest | null = null,
    key: string | null = null;
  const configured = JSON.parse(policy.adopt_instance_ids) as string[];
  for (const instanceId of configured) {
    const used = await env.DB.prepare(
      "SELECT 1 present FROM nodes WHERE provider_instance_id=? UNION SELECT 1 FROM node_additions WHERE slot_held=1 AND (requested_instance_id=? OR provider_instance_id=?) LIMIT 1",
    )
      .bind(instanceId, instanceId, instanceId)
      .first();
    if (!used) {
      request = NodeAdditionRequest.parse({
        region_id: regionId,
        mode: "adopt",
        provider_instance_id: instanceId,
      });
      key = threshold
        ? `capacity-ram-${threshold.minute}`
        : `capacity-adopt-${instanceId}`;
      break;
    }
  }
  if (request === null && policy.order_config !== null) {
    if (threshold === null)
      return {
        ...result,
        action:
          regionalWindow === null
            ? "memory_observations_unknown"
            : "capacity_wait",
      };
    const order = NodeOrderConfiguration.parse(JSON.parse(policy.order_config));
    request = { region_id: regionId, mode: "order", order };
    key = `capacity-ram-${threshold.minute}`;
  }
  if (request === null || key === null)
    return { ...result, action: "selection_unconfigured" };
  if (dryRun) return { ...result, action: request.mode };
  try {
    let addition = await reserveNodeAddition(env.DB, {
      request_key: key,
      request,
      exclusive_region_addition: true,
    });
    addition = await approveStandingNodePurchase(
      env.DB,
      addition.intent.operation_id,
    );
    await startAddNode(env, addition.intent.operation_id);
    return {
      ...result,
      action:
        request.mode === "order" && addition.approval === null
          ? "waiting_for_approval"
          : request.mode,
      operation_id: addition.intent.operation_id,
    };
  } catch (error) {
    if (
      error instanceof NodeStateError &&
      error.code === "capacity_unavailable"
    )
      return { ...result, action: "cap_reached" };
    throw error;
  }
}
export async function runNodeCapacityCron(env: Env) {
  const policies = await env.DB.prepare(
    "SELECT region_id FROM node_region_policies ORDER BY region_id LIMIT 4",
  ).all<{ region_id: string }>();
  const decisions = [];
  for (const row of policies.results) {
    const decision = await runNodeCapacity(env, row.region_id);
    decisions.push(decision);
    try {
      await runInfrastructureAlerts(env, row.region_id);
    } catch {
      console.error(
        JSON.stringify({
          event: "infrastructure_alert_check_failed",
          region_id: row.region_id,
        }),
      );
    }
    if (decision.action !== "idle")
      console.log(
        JSON.stringify({ event: "node_capacity_decision", ...decision }),
      );
  }
  return decisions;
}
