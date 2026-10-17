// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import {
  ErrorBody,
  ListQuery,
  OperationId,
  RegionId,
  NodeId,
  listEnvelope,
  NodeStorageSample,
  base64urlToBytes,
} from "@pgcf/contracts";
import {
  NodeAddition,
  NodeAdditionRequest,
  NodeMarkLost,
  NodeLoss,
} from "@pgcf/contracts/nodes";
import { NodeBootstrapStatus } from "@pgcf/contracts/node-bootstrap";
import {
  BOOTSTRAP_RELAY_HEADER,
  BOOTSTRAP_RELAY_PATH,
  BOOTSTRAP_RELAY_TOKEN_MAX_LENGTH,
  bootstrapRelayClaimsSchema,
} from "@pgcf/contracts/bootstrap-relay";
import type { ApiContext } from "../env.ts";
import { ApiError, type ApiApp } from "../app.ts";
import {
  bootstrapCallback,
  NodeBootstrapConfiguration,
  authenticateBootstrapCallback,
  readBootstrapJob,
} from "../domain/bootstrap-jobs.ts";
import {
  approvePurchase,
  capacityDecision,
  cancelNodeAddition,
  configureNodeBootstrap,
  getCapacityPolicy,
  getNodeAddition,
  getNodeBootstrap,
  listNodeAdditions,
  NodeCapacityPolicy,
  NodePurchaseApproval,
  NodeRevision,
  NodeVerificationRequest,
  requestNodeAddition,
  setCapacityPolicy,
  verifyNodeProof,
  markLostNode,
  NodeDatabasePlacement,
  setNodeDatabasePlacement,
  getNodeStorage,
} from "../platform/nodes.ts";

const json = (schema: z.ZodType) => ({ "application/json": { schema } });
const errors = {
  400: { description: "Invalid request", content: json(ErrorBody) },
  401: { description: "Invalid credentials", content: json(ErrorBody) },
  403: {
    description: "Administrator scope required",
    content: json(ErrorBody),
  },
  404: { description: "Resource unavailable", content: json(ErrorBody) },
  409: { description: "State or approval conflict", content: json(ErrorBody) },
  503: { description: "Capacity cap unavailable", content: json(ErrorBody) },
};
const responses = (
  schema: z.ZodType,
  status = 200,
  description = "Node state",
) => ({
  ...errors,
  [status]: { description, content: json(schema) },
});
const headers = z.object({
  "Idempotency-Key": z
    .string()
    .regex(/^[A-Za-z0-9._~-]{1,128}$/)
    .optional(),
});
const params = z.object({ id: OperationId }),
  regionParams = z.object({ id: RegionId });
const body = (schema: z.ZodType) => ({ required: true, content: json(schema) });
const security = [{ bearerAuth: [] }];
function register(
  app: ApiApp,
  route: RouteConfig,
  handler: (c: ApiContext) => Promise<Response>,
) {
  app.openapi(createRoute(route), handler);
}
export function registerNodes(app: ApiApp): void {
  register(
    app,
    {
      method: "get",
      path: "/v1/nodes/{id}/storage",
      security,
      tags: ["Nodes"],
      request: { params: z.object({ id: NodeId }) },
      responses: responses(
        z.strictObject({
          node_id: NodeId,
          region_id: RegionId,
          sample: NodeStorageSample.nullable(),
        }),
      ),
    },
    (c) => getNodeStorage(c, NodeId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      method: "put",
      path: "/v1/nodes/{id}/database-placement",
      security,
      tags: ["Nodes"],
      request: {
        params: z.object({ id: NodeId }),
        body: body(NodeDatabasePlacement),
      },
      responses: responses(
        NodeDatabasePlacement.safeExtend({ node_id: NodeId }),
      ),
    },
    async (c) =>
      setNodeDatabasePlacement(
        c,
        NodeId.parse(c.req.param("id")),
        NodeDatabasePlacement.parse(await c.req.json()),
      ),
  );
  register(
    app,
    {
      method: "post",
      path: "/v1/nodes/{id}/mark-lost",
      security,
      tags: ["Nodes"],
      request: { params: z.object({ id: NodeId }), body: body(NodeMarkLost) },
      responses: responses(NodeLoss),
    },
    async (c) =>
      markLostNode(
        c,
        NodeId.parse(c.req.param("id")),
        NodeMarkLost.parse(await c.req.json()),
      ),
  );
  register(
    app,
    {
      method: "post",
      path: "/v1/nodes/additions",
      security,
      tags: ["Nodes"],
      request: { headers, body: body(NodeAdditionRequest) },
      responses: responses(NodeAddition, 202),
    },
    async (c) =>
      requestNodeAddition(c, NodeAdditionRequest.parse(await c.req.json())),
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/nodes/additions",
      security,
      tags: ["Nodes"],
      request: { query: ListQuery },
      responses: responses(listEnvelope(NodeAddition)),
    },
    listNodeAdditions,
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/nodes/additions/{id}",
      security,
      tags: ["Nodes"],
      request: { params },
      responses: responses(NodeAddition),
    },
    async (c) => getNodeAddition(c, OperationId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      method: "post",
      path: "/v1/nodes/additions/{id}/approve",
      security,
      tags: ["Nodes"],
      request: { params, body: body(NodePurchaseApproval) },
      responses: responses(NodeAddition, 202),
    },
    async (c) =>
      approvePurchase(
        c,
        OperationId.parse(c.req.param("id")),
        NodePurchaseApproval.parse(await c.req.json()),
      ),
  );
  register(
    app,
    {
      method: "post",
      path: "/v1/nodes/additions/{id}/cancel",
      security,
      tags: ["Nodes"],
      request: { params, body: body(NodeRevision) },
      responses: responses(NodeAddition),
    },
    async (c) =>
      cancelNodeAddition(
        c,
        OperationId.parse(c.req.param("id")),
        NodeRevision.parse(await c.req.json()),
      ),
  );
  register(
    app,
    {
      method: "post",
      path: "/v1/nodes/additions/{id}/bootstrap",
      security,
      tags: ["Nodes"],
      request: { params, body: body(NodeBootstrapConfiguration) },
      responses: responses(NodeBootstrapStatus, 202),
    },
    async (c) =>
      configureNodeBootstrap(
        c,
        OperationId.parse(c.req.param("id")),
        NodeBootstrapConfiguration.parse(await c.req.json()),
      ),
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/nodes/additions/{id}/bootstrap",
      security,
      tags: ["Nodes"],
      request: { params },
      responses: responses(NodeBootstrapStatus),
    },
    async (c) => getNodeBootstrap(c, OperationId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      method: "post",
      path: "/v1/nodes/additions/{id}/verify",
      security,
      tags: ["Nodes"],
      request: { params, body: body(NodeVerificationRequest) },
      responses: responses(NodeAddition, 202),
    },
    async (c) =>
      verifyNodeProof(
        c,
        OperationId.parse(c.req.param("id")),
        NodeVerificationRequest.parse(await c.req.json()),
      ),
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/regions/{id}/capacity-policy",
      security,
      tags: ["Nodes"],
      summary: "Read a region's capacity policy",
      description:
        "Returns the stored policy: node ceiling, purchase and autoscale switches, placement settings and the infrastructure alert thresholds. Unset values are null or false (compute_pool and thin_storage are omitted), so the body can be edited and sent back with PUT. 404 until a policy has been created with PUT.",
      request: { params: regionParams },
      responses: responses(NodeCapacityPolicy, 200, "Stored capacity policy"),
    },
    async (c) => getCapacityPolicy(c, RegionId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      method: "put",
      path: "/v1/regions/{id}/capacity-policy",
      security,
      tags: ["Nodes"],
      summary: "Replace a region's capacity policy and alert thresholds",
      description: [
        "Replaces the policy and returns it as stored. Read it with GET, change fields and send the complete object back; region_id must equal the path id.",
        "Omitted fields with a default are reset to it: purchases_enabled, autoscale_enabled, adopt_instance_ids, order, placement_mode, maximum_database_memory_mib, postgres_memory_request_mib and standing_cost_profile. Omitted max_nodes, ram_expansion_threshold_ppm, the four *_warning_threshold_ppm fields, cap_warning_enabled, compute_pool and thin_storage keep their stored values; send null (false for cap_warning_enabled) to clear them.",
        "Thresholds are integers in parts per million (ppm): 1000000 = 100 %, 800000 = 80 %, valid 1 to 1000000; null disables. A warning is active while its measured value is at or above the threshold. Unknown measurements neither start nor clear an episode; disabling a warning clears it. The minute cron evaluates the first four regions with a policy, in region ID order, and delivers each new episode at least once through the alert webhook or email (see PUT /v1/infrastructure-backups/config); GET /v1/operational-health?scope=regions shows each episode. Alert kinds without a threshold (node heartbeats, daily backups, a database's WAL archive and base backup, blocked Thin storage, protective stops and the cron heartbeat) are not part of this policy: they follow fixed rules in every region and are described there.",
        "400: invalid body, including purchases_enabled without order, actual_ram without a valid memory range, a standing_cost_profile bound to another order, or a region_id that differs from the path. 404: unknown or non-Contabo region. 409: autoscale_enabled, purchases_enabled and order without an effective ram_expansion_threshold_ppm, or a placement_mode or actual_ram postgres_memory_request_mib change while databases are assigned (and not manually suspended) or starting, or an actual_ram memory range that excludes existing databases.",
      ].join("\n\n"),
      request: { params: regionParams, body: body(NodeCapacityPolicy) },
      responses: responses(
        NodeCapacityPolicy,
        200,
        "Capacity policy as stored after the update",
      ),
    },
    async (c) =>
      setCapacityPolicy(
        c,
        RegionId.parse(c.req.param("id")),
        NodeCapacityPolicy.parse(await c.req.json()),
      ),
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/regions/{id}/capacity-decision",
      security,
      tags: ["Nodes"],
      summary: "Preview the capacity decision for a region",
      description:
        "Dry run of the minute capacity cron step for this region under its current capacity policy and measurements. Nothing is placed, reserved, approved or ordered, and no provider is called.",
      request: { params: regionParams },
      responses: responses(
        z.strictObject({
          region_id: RegionId,
          dry_run: z
            .literal(true)
            .describe("Always true: nothing was changed."),
          placed: z
            .number()
            .int()
            .nonnegative()
            .describe("Databases placed by this call; always 0 in a dry run."),
          action: z
            .string()
            .describe(
              "Next capacity step: unconfigured (no policy); idle (no capacity needed); waiting_for_approval or addition_in_progress (a held node addition, see operation_id); observations_stale (a placement-enabled node has no observation within 180 s); size_policy_unavailable (actual_ram: the waiting database's size class is disabled or outside the memory range); starts_in_progress or memory_headroom_wait (actual_ram: a fitting node is busy with starts or lacks startup headroom); memory_observations_unknown (no usable regional or node RAM window, or neither actual_ram nor ram_expansion_threshold_ppm is set while only an order could add capacity); capacity_wait (regional RAM is below ram_expansion_threshold_ppm, or it is null); disabled (autoscale_enabled is false); cap_reached (max_nodes reached); selection_unconfigured (no unused adopt_instance_ids entry and no order); adopt or order (the next cron run starts this kind of addition).",
            ),
          operation_id: OperationId.nullable().describe(
            "Held node addition for waiting_for_approval and addition_in_progress; otherwise null.",
          ),
        }),
        200,
        "Dry-run capacity decision",
      ),
    },
    (c) => capacityDecision(c, RegionId.parse(c.req.param("id"))),
  );
  app.post("/internal/v1/node-bootstrap/:operation_id", async (c) =>
    bootstrapCallback(
      c,
      OperationId.parse(c.req.param("operation_id")),
      await c.req.json(),
    ),
  );
  app.get("/internal/v1/node-bootstrap/:operation_id/relay", async (c) => {
    const operationId = OperationId.parse(c.req.param("operation_id"));
    await authenticateBootstrapCallback(c, operationId);
    const job = await readBootstrapJob(c.env.DB, operationId);
    const token = c.req.header(BOOTSTRAP_RELAY_HEADER);
    if (
      c.req.header("Upgrade")?.toLowerCase() !== "websocket" ||
      !token ||
      token.length > BOOTSTRAP_RELAY_TOKEN_MAX_LENGTH ||
      !/^br1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ||
      !c.env.BOOTSTRAP_RELAY_SERVICE
    )
      throw new ApiError(
        "unauthorized",
        "A valid bootstrap transport capability is required",
      );
    const bytes = base64urlToBytes(token.split(".")[1]!);
    let parsed: ReturnType<typeof bootstrapRelayClaimsSchema.safeParse>;
    try {
      parsed = bootstrapRelayClaimsSchema.safeParse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
            bytes ?? new Uint8Array(),
          ),
        ),
      );
    } catch {
      throw new ApiError("unauthorized", "Invalid bootstrap capability scope");
    }
    if (
      !parsed.success ||
      parsed.data.operation !== operationId ||
      parsed.data.node !== job.node_id ||
      parsed.data.region !== job.region_id
    )
      throw new ApiError(
        "forbidden",
        "Bootstrap capability differs from the authenticated operation",
      );
    const target = new URL(BOOTSTRAP_RELAY_PATH, c.env.BOOTSTRAP_RELAY_URL);
    return c.env.BOOTSTRAP_RELAY_SERVICE.fetch(
      new Request(target, {
        headers: { Upgrade: "websocket", [BOOTSTRAP_RELAY_HEADER]: token },
      }),
    );
  });
}
