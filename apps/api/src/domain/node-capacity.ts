// SPDX-License-Identifier: Apache-2.0
import { DatabaseId, RegionId } from "@pgcf/contracts";
import {
  choosePlacement,
  nodeOnline,
  placementGuard,
  placementNodes,
} from "./placement.ts";
import type { DatabaseRow, SizeRow } from "./rows.ts";
import type { Env } from "../env.ts";
import { cronErrorCode } from "./cron-health.ts";
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
import { admissionScopesOpenSql } from "./admission-state.ts";
import { hintDatabases } from "./node-hints.ts";
import { ApiError } from "../api-error.ts";
import {
  assertResourcesAllowed,
  effectiveResources,
  NO_OVERRIDES,
  ownResources,
  regionBounds,
  usageSnapshot,
} from "./resources.ts";

/** Places the databases that wait for verified regional capacity, oldest first, where they now fit. */
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
    const effective = effectiveResources(size, ownResources(row)),
      decidedAt = Date.now(),
      node = choosePlacement(
        await placementNodes(db, regionId, decidedAt),
        effective,
        decidedAt,
      );
    if (!node) continue;
    const now = new Date().toISOString(),
      guard = placementGuard("n", {
        nodeId: node.id,
        pendingMemoryMib: node.pending_memory_mib,
        pendingStorageGib: node.pending_storage_gib,
        now: decidedAt,
      });
    const results = await db.batch([
      db
        .prepare(
          `UPDATE databases SET node_id=?,placed_at=?,status_message=NULL,updated_at=?
        WHERE (id=? AND project_id=? AND region_id=? AND node_id IS NULL AND generation=? AND updated_at=?)
        AND (desired_state='running' AND deleted_at IS NULL AND size_class_id=?)
        AND EXISTS(SELECT 1 FROM projects p WHERE p.id=databases.project_id AND p.deleted_at IS NULL)
        AND EXISTS(SELECT 1 FROM operations o WHERE o.id=? AND o.database_id=databases.id AND o.project_id=databases.project_id
          AND o.kind IN('database.create','database.restore') AND o.status='pending')
        AND EXISTS(SELECT 1 FROM nodes n JOIN size_classes s ON s.id=databases.size_class_id AND s.enabled=1
          WHERE n.region_id=databases.region_id AND ${guard.sql}
          AND ${admissionScopesOpenSql("databases.project_id", "databases.region_id", "n.id")}
          AND s.memory_mib=? AND s.cpu_millicores=? AND s.storage_gib=?)`,
        )
        .bind(
          node.id,
          now,
          now,
          row.id,
          row.project_id,
          regionId,
          row.generation,
          row.updated_at,
          row.size_class_id,
          row.startup_operation_id,
          ...guard.bindings,
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
          JSON.stringify(usageSnapshot(effective)),
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
    ]);
    if (results[0]!.meta.changes === 1) placed.push(row.id);
  }
  return placed;
}

/**
 * The next capacity step of a region (ULTRA plan 9.7). Waiting databases are placed where they fit
 * first. A node is added only when no node fits the waiting database, or the smallest size class
 * when none waits, and every node that should report does: nodes that went quiet are not a reason
 * to buy.
 */
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
      autoscale_enabled: number;
      order_config: string | null;
      adopt_instance_ids: string;
    }>();
  const placed = dryRun ? [] : await placePendingDatabases(env.DB, regionId);
  if (placed.length) await hintDatabases(env, placed);
  const result = {
    region_id: regionId,
    dry_run: dryRun,
    placed: placed.length,
    action: "idle",
    operation_id: null as string | null,
  };
  if (!policy) return { ...result, action: "unconfigured" };
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
  const waiting = await env.DB.prepare(
    `SELECT d.* FROM databases d JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL
    WHERE d.region_id=? AND d.node_id IS NULL AND d.desired_state='running' AND d.deleted_at IS NULL ORDER BY d.created_at,d.id LIMIT 1`,
  )
    .bind(regionId)
    .first<DatabaseRow>();
  const size = waiting
    ? await env.DB.prepare(
        "SELECT * FROM size_classes WHERE id=? AND enabled=1",
      )
        .bind(waiting.size_class_id)
        .first<SizeRow>()
    : await env.DB.prepare(
        "SELECT * FROM size_classes WHERE enabled=1 ORDER BY memory_mib,cpu_millicores,storage_gib,id LIMIT 1",
      ).first<SizeRow>();
  // A disabled class cannot be placed, and a region without classes has nothing to place.
  if (!size)
    return waiting ? { ...result, action: "size_policy_unavailable" } : result;
  const own = waiting ? ownResources(waiting) : NO_OVERRIDES,
    need = effectiveResources(size, own);
  try {
    assertResourcesAllowed(need, own, await regionBounds(env.DB, regionId));
  } catch (error) {
    if (error instanceof ApiError)
      return { ...result, action: "size_policy_unavailable" };
    throw error;
  }
  const now = Date.now(),
    nodes = await placementNodes(env.DB, regionId, now);
  if (choosePlacement(nodes, need, now) !== null)
    return { ...result, action: waiting ? "placement_pending" : "idle" };
  if (
    nodes.some(
      (node) =>
        node.lost_at === null &&
        node.database_placement_enabled === 1 &&
        !nodeOnline(node, now),
    )
  )
    return { ...result, action: "observations_stale" };
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
      key = `capacity-adopt-${instanceId}`;
      break;
    }
  }
  if (request === null && policy.order_config !== null) {
    const order = NodeOrderConfiguration.parse(JSON.parse(policy.order_config));
    request = { region_id: regionId, mode: "order", order };
    // One purchase attempt per hour of continued shortage.
    key = `capacity-headroom-${regionId}-${Math.floor(now / 3_600_000)}`;
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
  let failure: { error: unknown } | undefined;
  for (const row of policies.results) {
    try {
      const decision = await runNodeCapacity(env, row.region_id);
      decisions.push(decision);
      if (decision.action !== "idle")
        console.log(
          JSON.stringify({ event: "node_capacity_decision", ...decision }),
        );
    } catch (error) {
      // One region's failure must not skip the other regions; the cron step still reports it.
      console.error(
        JSON.stringify({
          event: "node_capacity_failed",
          region_id: row.region_id,
          error_code: cronErrorCode(error),
        }),
      );
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
  return decisions;
}
