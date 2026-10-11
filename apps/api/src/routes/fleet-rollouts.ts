// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import { ErrorBody, IdempotencyKey, OperationId } from "@pgcf/contracts";
import {
  FleetRolloutRequest,
  FleetRolloutStatus,
} from "@pgcf/contracts/fleet-rollouts";
import type { ApiApp } from "../app.ts";
import type { ApiContext } from "../env.ts";
import {
  createFleetRollout,
  getFleetRollout,
} from "../domain/fleet-rollouts.ts";
const json = (schema: z.ZodType) => ({ "application/json": { schema } });
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 500].map((status) => [
    status,
    { description: "Request failed", content: json(ErrorBody) },
  ]),
);
export function registerFleetRollouts(app: ApiApp) {
  const register = (
    route: RouteConfig,
    handler: (c: ApiContext) => Promise<Response>,
  ) => app.openapi(createRoute(route), handler);
  register(
    {
      method: "post",
      path: "/v1/fleet/rollouts",
      tags: ["Fleet patches"],
      security: [{ bearerAuth: [] }],
      description:
        "Atomically selects an approved release for ordered region/physical-node members and starts serial Cloudflare convergence. An explicit expected_previous_rollout_id may replace a quiescent held intent while preserving physical identities and immutable patch receipts; dispatched or uncertain writes block replacement. Only the immediate predecessor intent is retained. Fresh identities and acknowledged maintenance are required. No server is bought or reinstalled.",
      request: {
        headers: z.object({ "Idempotency-Key": IdempotencyKey }),
        body: { required: true, content: json(FleetRolloutRequest) },
      },
      responses: {
        ...errors,
        202: {
          description: "Persisted fleet rollout and current member state",
          content: json(FleetRolloutStatus),
        },
      },
    },
    async (c) =>
      createFleetRollout(c, FleetRolloutRequest.parse(await c.req.json())),
  );
  register(
    {
      method: "get",
      path: "/v1/fleet/rollouts/{id}",
      tags: ["Fleet patches"],
      security: [{ bearerAuth: [] }],
      request: { params: z.object({ id: OperationId }) },
      responses: {
        ...errors,
        200: {
          description:
            "Current release/patch readbacks for the original ordered intent",
          content: json(FleetRolloutStatus),
        },
      },
    },
    async (c) => getFleetRollout(c, OperationId.parse(c.req.param("id"))),
  );
}
