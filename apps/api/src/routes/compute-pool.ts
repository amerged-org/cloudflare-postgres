// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import { ErrorBody, NodeId, IdempotencyKey } from "@pgcf/contracts";
import {
  ComputePoolPolicyState,
  ComputePoolPolicyUpdate,
  ComputePoolLease,
  ComputePoolObservation,
} from "@pgcf/contracts/compute-pool";
import type { ApiApp } from "../app.ts";
import type { ApiContext } from "../env.ts";
import {
  getComputePoolPolicy,
  setComputePoolPolicy,
  getComputePoolLease,
  reportComputePool,
  getComputePoolObservations,
} from "../domain/compute-pool.ts";
const content = (schema: z.ZodType) => ({ "application/json": { schema } });
function route(
  app: ApiApp,
  method: "get" | "put" | "post",
  path: string,
  response: z.ZodType,
  handler: (c: ApiContext) => Promise<Response>,
  body?: z.ZodType,
  agent = false,
) {
  const value: RouteConfig = {
    method,
    path,
    tags: ["Compute pool"],
    security: [agent ? { AgentBearer: [] } : { bearerAuth: [] }],
    request: {
      params: z.object({ id: NodeId }),
      ...(body
        ? {
            body: { required: true, content: content(body) },
            ...(!agent
              ? {
                  headers: z.object({
                    "Idempotency-Key": IdempotencyKey.optional(),
                  }),
                }
              : {}),
          }
        : {}),
    },
    responses: {
      200: {
        description: "Current bounded compute pool state",
        content: content(response),
      },
      ...Object.fromEntries(
        [400, 401, 403, 404, 409, 500].map((code) => [
          code,
          { description: "Request refused", content: content(ErrorBody) },
        ]),
      ),
    },
  };
  app.openapi(createRoute(value), handler);
}
export function registerComputePool(app: ApiApp) {
  route(
    app,
    "get",
    "/v1/nodes/{id}/compute-pool/observations",
    z.strictObject({
      policy: ComputePoolPolicyState,
      observation: ComputePoolObservation.nullable(),
      freshness: z.enum(["current", "stale", "missing"]),
    }),
    (c) => getComputePoolObservations(c, NodeId.parse(c.req.param("id"))),
  );
  route(
    app,
    "get",
    "/v1/nodes/{id}/compute-pool",
    ComputePoolPolicyState,
    (c) => getComputePoolPolicy(c, NodeId.parse(c.req.param("id"))),
  );
  route(
    app,
    "put",
    "/v1/nodes/{id}/compute-pool",
    ComputePoolPolicyState,
    async (c) =>
      setComputePoolPolicy(
        c,
        NodeId.parse(c.req.param("id")),
        ComputePoolPolicyUpdate.parse(await c.req.json()),
      ),
    ComputePoolPolicyUpdate,
  );
  route(
    app,
    "get",
    "/agent/v1/nodes/{id}/compute-pool",
    ComputePoolLease,
    (c) => getComputePoolLease(c, NodeId.parse(c.req.param("id"))),
    undefined,
    true,
  );
  route(
    app,
    "post",
    "/agent/v1/nodes/{id}/compute-pool",
    z.strictObject({ accepted: z.literal(true) }),
    async (c) =>
      reportComputePool(
        c,
        NodeId.parse(c.req.param("id")),
        ComputePoolObservation.parse(await c.req.json()),
      ),
    ComputePoolObservation,
    true,
  );
}
