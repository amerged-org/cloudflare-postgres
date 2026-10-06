// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import {
  ErrorBody,
  ListQuery,
  OperationId,
  RegionId,
  NodeId,
  listEnvelope,
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
const responses = (schema: z.ZodType, status = 200) => ({
  ...errors,
  [status]: { description: "Node state", content: json(schema) },
});
const headers = z.object({
  "Idempotency-Key": z.string().regex(/^[A-Za-z0-9._~-]{1,128}$/),
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
      request: { params: regionParams },
      responses: responses(NodeCapacityPolicy),
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
      request: { params: regionParams, body: body(NodeCapacityPolicy) },
      responses: responses(NodeCapacityPolicy),
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
      request: { params: regionParams },
      responses: responses(
        z.strictObject({
          region_id: RegionId,
          dry_run: z.literal(true),
          placed: z.number().int().nonnegative(),
          action: z.string(),
          operation_id: OperationId.nullable(),
        }),
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
