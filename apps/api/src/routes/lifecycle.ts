// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import {
  DatabaseId,
  ErrorBody,
  NodeId,
  OperationId,
  ProvenSleepRecord,
  RegionId,
  Timestamp,
} from "@pgcf/contracts";
import { ApiError, type ApiApp } from "../app.ts";
import {
  listDatabaseMoves,
  startDatabaseMove,
} from "../domain/database-moves.ts";
import { nodeLossStatus } from "../domain/node-loss.ts";
import { acknowledgeReinstallOverride } from "../domain/reinstall-guard.ts";
import type { ApiContext } from "../env.ts";
import { requireScope } from "../middleware/auth.ts";

const json = (schema: z.ZodType) => ({ "application/json": { schema } });
const errors = {
  400: { description: "Invalid request", content: json(ErrorBody) },
  401: { description: "Invalid credentials", content: json(ErrorBody) },
  403: {
    description: "Administrator scope required",
    content: json(ErrorBody),
  },
  404: { description: "Resource unavailable", content: json(ErrorBody) },
  409: { description: "State conflict", content: json(ErrorBody) },
};
const responses = (
  schema: z.ZodType,
  status = 200,
  description = "Result",
) => ({
  ...errors,
  [status]: { description, content: json(schema) },
});
const body = (schema: z.ZodType) => ({ required: true, content: json(schema) });
const security = [{ bearerAuth: [] }];
function register(
  app: ApiApp,
  route: RouteConfig,
  handler: (c: ApiContext) => Promise<Response>,
) {
  app.openapi(createRoute(route), handler);
}

const MoveRequest = z.strictObject({
  target_node_id: NodeId.describe(
    "The node that serves the database next. It may be the node the database is on: the move then goes from one volume to another.",
  ),
});
const DatabaseMove = z
  .strictObject({
    operation: OperationId,
    database_id: DatabaseId,
    source_node_id: NodeId,
    target_node_id: NodeId,
    status: z
      .enum(["proving", "restoring", "done", "failed"])
      .describe(
        "proving: the source proves its sleep. restoring: the generation was bumped and the target restores. done: the target is ready. failed: see failure.",
      ),
    failure: z
      .string()
      .nullable()
      .describe("The class of the failure, such as no_recovery_point."),
    source_storage_generation: z.number().int().min(1),
    target_storage_generation: z.number().int().min(2).nullable(),
    created_at: Timestamp,
    updated_at: Timestamp,
    completed_at: Timestamp.nullable(),
  })
  .meta({ id: "DatabaseMove" });
const NodeLossStatus = z
  .strictObject({
    node_id: NodeId,
    region_id: RegionId,
    declared_at: Timestamp,
    reason: z.string(),
    status: z
      .enum(["fencing", "fenced"])
      .describe("fenced: the Tunnel is deleted and the instance is stopped."),
    steps: z.strictObject({
      tunnel_deleted_at: Timestamp.nullable(),
      power_off_requested_at: Timestamp.nullable(),
      powered_off_at: Timestamp.nullable(),
    }),
    error: z
      .string()
      .nullable()
      .describe("The class of the step that failed last."),
    databases: z
      .array(
        z.strictObject({
          id: DatabaseId,
          storage_generation: z.number().int().min(1),
          recovery_point: z
            .strictObject({
              state: z.string(),
              proven_sleep: ProvenSleepRecord.nullable(),
              backup: z
                .strictObject({
                  backup_id: z.string(),
                  timeline: z.number().int(),
                  completed_at: Timestamp,
                })
                .nullable(),
              observed_at: Timestamp,
            })
            .nullable(),
        }),
      )
      .max(200),
    reinstall: z.strictObject({
      blocked: z
        .array(DatabaseId)
        .describe(
          "Databases without a proven-sleep record: reinstalling would overwrite WAL that may never have reached R2.",
        ),
      overridden: z.boolean(),
    }),
  })
  .meta({ id: "NodeLossStatus" });
const ReinstallOverrideRequest = z.strictObject({
  reason: z.string().trim().min(1).max(500),
});
const ReinstallOverride = z
  .strictObject({
    node_id: NodeId,
    overridden: z.literal(true),
    reason: z.string(),
    acknowledged_at: Timestamp,
  })
  .meta({ id: "NodeReinstallOverride" });

export function registerLifecycle(app: ApiApp): void {
  register(
    app,
    {
      method: "post",
      path: "/v1/databases/{id}/move",
      security,
      tags: ["Nodes"],
      summary: "Move a database to another node under the same ID",
      description:
        "Starts a move: the source proves the sleep of the database and holds its connections with 57P03, D1 then bumps the generation and the target restores the newest base backup and the WAL up to the source's proven end. The route reopens when the target reports the database ready; the source then removes its volume. The same request again returns the running move; another target is refused with `mutation_in_progress` while one runs. 409: the database is deleted or not settled, or a node is lost or fenced.",
      request: {
        params: z.object({ id: DatabaseId }),
        body: body(MoveRequest),
      },
      responses: responses(DatabaseMove, 202, "Move started or running"),
    },
    async (c) => {
      await requireScope(c, "admin");
      const request = MoveRequest.parse(await c.req.json());
      return c.json(
        await startDatabaseMove(c.env, {
          databaseId: DatabaseId.parse(c.req.param("id")),
          targetNodeId: request.target_node_id,
        }),
        202,
      );
    },
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/databases/{id}/moves",
      security,
      tags: ["Nodes"],
      summary: "List the moves of a database",
      description: "The newest 20 moves, newest first.",
      request: { params: z.object({ id: DatabaseId }) },
      responses: responses(
        z.strictObject({ data: z.array(DatabaseMove).max(20) }),
      ),
    },
    async (c) => {
      await requireScope(c, "admin");
      const id = DatabaseId.parse(c.req.param("id"));
      const exists = await c.env.DB.prepare(
        "SELECT 1 found FROM databases WHERE id=?",
      )
        .bind(id)
        .first();
      if (!exists) throw new ApiError("not_found", "Database not found");
      return c.json({ data: await listDatabaseMoves(c.env.DB, id) });
    },
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/nodes/{id}/loss",
      security,
      tags: ["Nodes"],
      summary: "Read the fencing and the recovery points of a lost node",
      description:
        "Where the fence of a node declared lost stands (Tunnel deleted, instance powered off, instance confirmed stopped) and, for each database on it, the proven-sleep record and newest base backup its node last reported. 404 until the node was declared lost with POST /v1/nodes/{id}/mark-lost.",
      request: { params: z.object({ id: NodeId }) },
      responses: responses(NodeLossStatus),
    },
    async (c) => {
      await requireScope(c, "admin");
      const status = await nodeLossStatus(
        c.env.DB,
        NodeId.parse(c.req.param("id")),
      );
      if (!status)
        throw new ApiError("not_found", "The node was not declared lost");
      return c.json(status);
    },
  );
  register(
    app,
    {
      method: "post",
      path: "/v1/nodes/{id}/reinstall-override",
      security,
      tags: ["Nodes"],
      summary:
        "Acknowledge that reinstalling a lost node may overwrite unarchived WAL",
      description:
        "A lost node's instance is not reinstalled, and AddNode does not run in recover mode on it, while a database on it has no proven-sleep record. This acknowledges that data may be lost for good. The answer to a repeat is the first acknowledgement. 409: the node was not declared lost.",
      request: {
        params: z.object({ id: NodeId }),
        body: body(ReinstallOverrideRequest),
      },
      responses: responses(ReinstallOverride),
    },
    async (c) => {
      const auth = await requireScope(c, "admin");
      const request = ReinstallOverrideRequest.parse(await c.req.json());
      const nodeId = NodeId.parse(c.req.param("id"));
      return c.json(
        await acknowledgeReinstallOverride(
          c.env.DB,
          nodeId,
          auth.id,
          request.reason,
          Date.now(),
        ),
      );
    },
  );
}
