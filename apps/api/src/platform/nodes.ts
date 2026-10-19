// SPDX-License-Identifier: Apache-2.0
import { OperationId, RegionId } from "@pgcf/contracts";
import {
  NodeAdditionRequest,
  NodeMaintenanceRequest,
  NodeRegionPolicy,
  ProviderInstanceId,
  CostedNodeApproval,
  NodeMarkLost,
} from "@pgcf/contracts/nodes";
import { z } from "zod";
import { ApiError } from "../api-error.ts";
import {
  withAdmissionMutation,
  type AdmissionMutation,
} from "../domain/admission-mutations.ts";
import type { ApiContext, Env } from "../env.ts";
import { requireScope } from "../middleware/auth.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import { page } from "./pagination.ts";
import {
  approveNodePurchase,
  configureNodeRegionPolicy,
  readNodeAddition,
  reserveNodeAddition,
  approveStandingNodePurchase,
} from "../domain/node-state.ts";
import {
  cancelAlreadyCancelledProviderAddition,
  stopCancelledNodeAdditionWorkflow,
} from "../domain/cancel-provider-addition.ts";
import { runNodeCapacity } from "../domain/node-capacity.ts";
import { declareNodeLost, runNodeFencingCron } from "../domain/node-loss.ts";
import { nodeActor } from "../domain/node-hints.ts";
import {
  readNodeMaintenance,
  startNodeMaintenance,
} from "../domain/lifecycle-orders.ts";

export const NodeCapacityPolicy = NodeRegionPolicy.safeExtend({
  autoscale_enabled: z
    .boolean()
    .default(false)
    .describe(
      "Lets the minute capacity cron add a node when capacity is needed: it adopts the first unused adopt_instance_ids entry, otherwise reserves an addition of `order` once regional RAM reaches ram_expansion_threshold_ppm. Dispatching an order still needs purchases_enabled and a cost approval. GET /v1/regions/{id}/capacity-decision previews the next step.",
    ),
  adopt_instance_ids: z
    .array(ProviderInstanceId)
    .max(100)
    .default([])
    .describe(
      "Provider instance IDs that autoscale may adopt, in list order; instances already registered or held by an addition are skipped.",
    ),
});
export const NodePurchaseApproval = z.strictObject({
  expected_revision: z.number().int().positive(),
  approval: CostedNodeApproval,
});
export const NodeRevision = z.strictObject({
  expected_revision: z.number().int().positive(),
});
export const NodeDatabasePlacement = z.strictObject({
  expected_node_uid: z.uuid(),
  database_placement_enabled: z.boolean(),
});
export async function setNodeDatabasePlacement(
  c: ApiContext,
  id: string,
  raw: z.infer<typeof NodeDatabasePlacement>,
): Promise<Response> {
  await requireScope(c, "admin");
  const body = NodeDatabasePlacement.parse(raw);
  const result = await c.env.DB.prepare(
    "UPDATE nodes SET database_placement_enabled=?,database_placement_closed_at=?,updated_at=? WHERE id=? AND node_uid=? AND lost_at IS NULL",
  )
    .bind(
      Number(body.database_placement_enabled),
      body.database_placement_enabled ? null : new Date().toISOString(),
      new Date().toISOString(),
      id,
      body.expected_node_uid,
    )
    .run();
  if (result.meta.changes !== 1)
    throw new ApiError(
      "conflict",
      "Placement control requires the current physical node identity",
    );
  return c.json({ node_id: id, ...body });
}
export async function startAddNode(
  env: Env,
  operationId: string,
): Promise<void> {
  OperationId.parse(operationId);
  try {
    await env.ADD_NODE.create({
      id: operationId,
      params: { operation_id: operationId },
    });
  } catch {
    const instance = await env.ADD_NODE.get(operationId);
    const status = await instance.status();
    if (
      status.status === "errored" ||
      status.status === "terminated" ||
      status.status === "complete"
    )
      await instance.restart();
  }
}
export async function requestNodeAddition(
  c: ApiContext,
  raw: NodeAdditionRequest,
): Promise<Response> {
  await requireScope(c, "admin");
  const body = NodeAdditionRequest.parse(raw);
  return withIdempotency(c, {
    replay: async (id) => nodeAdditionResponse(c, id),
    execute: async (lease) => {
      let addition = await reserveNodeAddition(c.env.DB, {
        // withIdempotency has refused a request without the key: the route is required.
        request_key: c.req.header("Idempotency-Key")!,
        request: body,
      });
      addition = await approveStandingNodePurchase(
        c.env.DB,
        addition.intent.operation_id,
      );
      await lease
        .completeStatement(addition.intent.operation_id, 202, {
          sql: "EXISTS(SELECT 1 FROM node_additions WHERE operation_id=?)",
          bindings: [addition.intent.operation_id],
        })
        .run();
      c.executionCtx.waitUntil(
        startAddNode(c.env, addition.intent.operation_id),
      );
      return nodeAdditionResponse(c, addition.intent.operation_id);
    },
  });
}
export async function nodeAdditionResponse(
  c: ApiContext,
  id: string,
): Promise<Response> {
  await requireScope(c, "admin");
  c.header("Location", `/v1/nodes/additions/${id}`);
  return c.json(await readNodeAddition(c.env.DB, id), 202);
}
export async function getNodeAddition(
  c: ApiContext,
  id: string,
): Promise<Response> {
  await requireScope(c, "admin");
  return c.json(await readNodeAddition(c.env.DB, id));
}
export async function markLostNode(
  c: ApiContext,
  id: string,
  raw: NodeMarkLost,
): Promise<Response> {
  await requireScope(c, "admin");
  const loss = await declareNodeLost(c.env, id, raw);
  // The agent is told to pull the fence at once, and the first fencing step does not wait for the
  // next minute.
  c.executionCtx.waitUntil(
    Promise.allSettled([
      nodeActor(c.env, id).fence(),
      runNodeFencingCron(c.env, Date.now()),
    ]),
  );
  return c.json(loss);
}
export async function maintenanceResponse(
  c: ApiContext,
  nodeId: string,
  operation: string,
): Promise<Response> {
  const maintenance = await readNodeMaintenance(c.env.DB, nodeId, operation);
  if (!maintenance)
    throw new ApiError("not_found", "Maintenance operation not found");
  c.header("Location", `/v1/nodes/${nodeId}/maintenance/${operation}`);
  return c.json(maintenance, 202);
}
export async function requestNodeMaintenance(
  c: ApiContext,
  id: string,
  raw: NodeMaintenanceRequest,
): Promise<Response> {
  await requireScope(c, "admin");
  const body = NodeMaintenanceRequest.parse(raw);
  return withIdempotency(c, {
    replay: (operation) => maintenanceResponse(c, id, operation),
    execute: async (lease) => {
      const maintenance = await startNodeMaintenance(
        c.env,
        { nodeId: id, nodeUid: body.expected_node_uid },
        (operation) =>
          lease.completeStatement(operation, 202, {
            sql: "EXISTS(SELECT 1 FROM lifecycle_orders WHERE operation=? AND node_id=?)",
            bindings: [operation, id],
          }),
      );
      return maintenanceResponse(c, id, maintenance.operation);
    },
  });
}
export async function getNodeMaintenance(
  c: ApiContext,
  id: string,
  operation: string,
): Promise<Response> {
  await requireScope(c, "admin");
  const maintenance = await readNodeMaintenance(c.env.DB, id, operation);
  if (!maintenance)
    throw new ApiError("not_found", "Maintenance operation not found");
  return c.json(maintenance);
}
export async function listNodeAdditions(c: ApiContext): Promise<Response> {
  await requireScope(c, "admin");
  const pagination = page(c),
    cursor = pagination.where("created_at", "operation_id");
  const result = await c.env.DB.prepare(
    `SELECT operation_id id,created_at FROM node_additions WHERE ${cursor.sql} ORDER BY created_at DESC,operation_id DESC LIMIT ?`,
  )
    .bind(...cursor.bindings, pagination.limit + 1)
    .all<{ id: string; created_at: string }>();
  const additions = await Promise.all(
    result.results.map((row) => readNodeAddition(c.env.DB, row.id)),
  );
  const envelope = pagination.envelope(result.results);
  return c.json({
    data: additions.slice(0, pagination.limit),
    next_cursor: envelope.next_cursor,
  });
}
export async function approvePurchase(
  c: ApiContext,
  id: string,
  raw: z.infer<typeof NodePurchaseApproval>,
): Promise<Response> {
  await requireScope(c, "admin");
  const body = NodePurchaseApproval.parse(raw);
  const addition = await approveNodePurchase(
    c.env.DB,
    id,
    body.expected_revision,
    body.approval,
  );
  c.executionCtx.waitUntil(startAddNode(c.env, id));
  return c.json(addition, 202);
}
export async function cancelNodeAddition(
  c: ApiContext,
  id: string,
  raw: z.infer<typeof NodeRevision>,
): Promise<Response> {
  await requireScope(c, "admin");
  const body = NodeRevision.parse(raw);
  const addition = await cancelAlreadyCancelledProviderAddition(
    c.env,
    id,
    body.expected_revision,
  );
  c.executionCtx.waitUntil(stopCancelledNodeAdditionWorkflow(c.env, id));
  return c.json(addition);
}
export async function getCapacityPolicy(
  c: ApiContext,
  id: string,
): Promise<Response> {
  await requireScope(c, "admin");
  RegionId.parse(id);
  const row = await c.env.DB.prepare(
    "SELECT * FROM node_region_policies WHERE region_id=?",
  )
    .bind(id)
    .first<{
      region_id: string;
      max_nodes: number | null;
      ram_expansion_threshold_ppm: number | null;
      ram_warning_threshold_ppm: number | null;
      node_ram_warning_threshold_ppm: number | null;
      node_cpu_warning_threshold_ppm: number | null;
      node_storage_warning_threshold_ppm: number | null;
      cap_warning_enabled: number;
      purchases_enabled: number;
      order_config: string | null;
      autoscale_enabled: number;
      adopt_instance_ids: string;
      placement_mode: "reserved" | "actual_ram";
      maximum_database_memory_mib: number | null;
      postgres_memory_request_mib: number | null;
      standing_cost_profile: string | null;
    }>();
  if (!row)
    throw new ApiError("not_found", "Region capacity policy is not configured");
  return c.json(
    NodeCapacityPolicy.parse({
      region_id: row.region_id,
      max_nodes: row.max_nodes,
      ram_expansion_threshold_ppm: row.ram_expansion_threshold_ppm,
      ram_warning_threshold_ppm: row.ram_warning_threshold_ppm,
      node_ram_warning_threshold_ppm: row.node_ram_warning_threshold_ppm,
      node_cpu_warning_threshold_ppm: row.node_cpu_warning_threshold_ppm,
      node_storage_warning_threshold_ppm:
        row.node_storage_warning_threshold_ppm,
      cap_warning_enabled: Boolean(row.cap_warning_enabled),
      purchases_enabled: Boolean(row.purchases_enabled),
      autoscale_enabled: Boolean(row.autoscale_enabled),
      order: row.order_config === null ? null : JSON.parse(row.order_config),
      adopt_instance_ids: JSON.parse(row.adopt_instance_ids),
      placement_mode: row.placement_mode,
      maximum_database_memory_mib: row.maximum_database_memory_mib,
      postgres_memory_request_mib: row.postgres_memory_request_mib,
      standing_cost_profile:
        row.standing_cost_profile === null
          ? null
          : JSON.parse(row.standing_cost_profile),
    }),
  );
}
export async function setCapacityPolicy(
  c: ApiContext,
  id: string,
  raw: z.infer<typeof NodeCapacityPolicy>,
): Promise<Response> {
  await requireScope(c, "admin");
  const policy = NodeCapacityPolicy.parse(raw);
  if (policy.region_id !== id)
    throw new ApiError(
      "invalid_request",
      "Policy region differs from the route",
    );
  const previous = await c.env.DB.prepare(
    "SELECT placement_mode,postgres_memory_request_mib FROM node_region_policies WHERE region_id=?",
  )
    .bind(id)
    .first<{
      placement_mode: string;
      postgres_memory_request_mib: number | null;
    }>();
  const changesRuntime =
    policy.placement_mode !== (previous?.placement_mode ?? "reserved") ||
    (policy.placement_mode === "actual_ram" &&
      policy.postgres_memory_request_mib !==
        (previous?.postgres_memory_request_mib ?? null));
  const execute = async (mutation?: AdmissionMutation) =>
    configureNodeRegionPolicy(
      c.env.DB,
      {
        region_id: id,
        max_nodes: policy.max_nodes,
        ram_expansion_threshold_ppm: policy.ram_expansion_threshold_ppm,
        ram_warning_threshold_ppm: policy.ram_warning_threshold_ppm,
        node_ram_warning_threshold_ppm: policy.node_ram_warning_threshold_ppm,
        node_cpu_warning_threshold_ppm: policy.node_cpu_warning_threshold_ppm,
        node_storage_warning_threshold_ppm:
          policy.node_storage_warning_threshold_ppm,
        cap_warning_enabled: policy.cap_warning_enabled,
        purchases_enabled: policy.purchases_enabled,
        order: policy.order,
        placement_mode: policy.placement_mode,
        maximum_database_memory_mib: policy.maximum_database_memory_mib,
        postgres_memory_request_mib: policy.postgres_memory_request_mib,
        standing_cost_profile: policy.standing_cost_profile,
        autoscale_enabled: policy.autoscale_enabled,
        adopt_instance_ids: policy.adopt_instance_ids,
      },
      mutation,
      previous ?? { placement_mode: null, postgres_memory_request_mib: null },
    );
  if (changesRuntime)
    await withAdmissionMutation(c.env, [], execute, { kind: "region", id });
  else await execute();
  return getCapacityPolicy(c, id);
}
export async function capacityDecision(
  c: ApiContext,
  id: string,
): Promise<Response> {
  await requireScope(c, "admin");
  const decision = await runNodeCapacity(c.env, id, true);
  console.log(JSON.stringify({ event: "node_capacity_decision", ...decision }));
  return c.json(decision);
}
