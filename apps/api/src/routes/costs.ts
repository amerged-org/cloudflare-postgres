// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import { ErrorBody, IdempotencyKey } from "@pgcf/contracts";
import {
  InfrastructureCostFact,
  InfrastructureCostFactCreate,
  InfrastructureCostsQuery,
  InfrastructureCostsResponse,
} from "@pgcf/contracts/costs";
import type { ApiApp } from "../app.ts";
import type { ApiContext } from "../env.ts";
import {
  createInfrastructureCostFact,
  queryInfrastructureCosts,
} from "../domain/costs.ts";
const json = (schema: z.ZodType) => ({ "application/json": { schema } });
const errors = {
  400: { description: "Invalid cost scope or fact", content: json(ErrorBody) },
  401: { description: "Invalid credentials", content: json(ErrorBody) },
  403: { description: "Admin authority required", content: json(ErrorBody) },
  404: { description: "Node or region not found", content: json(ErrorBody) },
  409: {
    description: "Conflicting immutable cost fact",
    content: json(ErrorBody),
  },
};
export function registerCosts(app: ApiApp): void {
  const register = (
    route: RouteConfig,
    handler: (c: ApiContext) => Promise<Response>,
  ) => app.openapi(createRoute(route), handler);
  register(
    {
      method: "get",
      path: "/v1/costs",
      security: [{ bearerAuth: [] }],
      request: { query: InfrastructureCostsQuery },
      responses: {
        ...errors,
        200: {
          description:
            "Hourly operator infrastructure cost facts and explicit gaps",
          content: json(InfrastructureCostsResponse),
        },
      },
    },
    async (c) =>
      queryInfrastructureCosts(
        c,
        InfrastructureCostsQuery.parse(c.req.query()),
      ),
  );
  register(
    {
      method: "post",
      path: "/v1/costs/node-facts",
      security: [{ bearerAuth: [] }],
      request: {
        headers: z.object({ "Idempotency-Key": IdempotencyKey.optional() }),
        body: { required: true, content: json(InfrastructureCostFactCreate) },
      },
      responses: {
        ...errors,
        201: {
          description: "Immutable owner-recorded provider cost fact",
          content: json(InfrastructureCostFact),
        },
      },
    },
    async (c) =>
      createInfrastructureCostFact(
        c,
        InfrastructureCostFactCreate.parse(await c.req.json()),
      ),
  );
}
