// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import { DatabaseId, NodeId, ErrorBody, IdempotencyKey } from "@pgcf/contracts";
import {
  ReclaimIntentSnapshot,
  ReclaimObservations,
} from "@pgcf/contracts/reclaim";
import type { ApiApp } from "../app.ts";
import type { ApiContext } from "../env.ts";
import {
  WarmReclaimPolicyState,
  WarmReclaimPolicyUpdate,
  WarmReclaimQualificationState,
  WarmReclaimQualificationUpdate,
  getWarmReclaimPolicy,
  setWarmReclaimPolicy,
  getWarmReclaimQualification,
  setWarmReclaimQualification,
  getReclaimIntents,
  observeReclaim,
} from "../domain/warm-reclaim.ts";
function route(
  app: ApiApp,
  method: "get" | "put" | "post",
  path: string,
  id: z.ZodType,
  response: z.ZodType,
  handler: (c: ApiContext) => Promise<Response>,
  body?: z.ZodType,
  agent = false,
) {
  const content = (schema: z.ZodType) => ({ "application/json": { schema } }),
    value: RouteConfig = {
      method,
      path,
      tags: ["Warm reclaim"],
      security: [agent ? { AgentBearer: [] } : { bearerAuth: [] }],
      request: {
        params: z.object({ id }),
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
          description:
            "Current reclaim control state; no hibernation or CPU release is implied",
          content: content(response),
        },
        ...Object.fromEntries(
          [400, 401, 403, 404, 409, 500].map((status) => [
            status,
            { description: "Request refused", content: content(ErrorBody) },
          ]),
        ),
      },
    };
  app.openapi(createRoute(value), handler);
}
export function registerReclaim(app: ApiApp) {
  route(
    app,
    "get",
    "/v1/databases/{id}/warm-reclaim",
    DatabaseId,
    WarmReclaimPolicyState,
    (c) => getWarmReclaimPolicy(c, DatabaseId.parse(c.req.param("id"))),
  );
  route(
    app,
    "put",
    "/v1/databases/{id}/warm-reclaim",
    DatabaseId,
    WarmReclaimPolicyState,
    async (c) =>
      setWarmReclaimPolicy(
        c,
        DatabaseId.parse(c.req.param("id")),
        WarmReclaimPolicyUpdate.parse(await c.req.json()),
      ),
    WarmReclaimPolicyUpdate,
  );
  route(
    app,
    "get",
    "/v1/nodes/{id}/warm-reclaim-qualification",
    NodeId,
    WarmReclaimQualificationState,
    (c) => getWarmReclaimQualification(c, NodeId.parse(c.req.param("id"))),
  );
  route(
    app,
    "put",
    "/v1/nodes/{id}/warm-reclaim-qualification",
    NodeId,
    WarmReclaimQualificationState,
    async (c) =>
      setWarmReclaimQualification(
        c,
        NodeId.parse(c.req.param("id")),
        WarmReclaimQualificationUpdate.parse(await c.req.json()),
      ),
    WarmReclaimQualificationUpdate,
  );
  route(
    app,
    "get",
    "/agent/v1/nodes/{id}/reclaim",
    NodeId,
    ReclaimIntentSnapshot,
    (c) => getReclaimIntents(c, NodeId.parse(c.req.param("id"))),
    undefined,
    true,
  );
  route(
    app,
    "post",
    "/agent/v1/nodes/{id}/reclaim-observations",
    NodeId,
    z.strictObject({ accepted: z.number().int().nonnegative() }),
    async (c) =>
      observeReclaim(c, NodeId.parse(c.req.param("id")), await c.req.json()),
    ReclaimObservations,
    true,
  );
}
