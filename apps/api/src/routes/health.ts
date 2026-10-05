// SPDX-License-Identifier: Apache-2.0
import { createRoute, z } from "@hono/zod-openapi";
import { ErrorBody, ListQuery, listEnvelope } from "@pgcf/contracts";
import type { ApiApp } from "../app.ts";
import { requireScope } from "../middleware/auth.ts";
import { page } from "../platform/pagination.ts";
import {
  OperationalDatabaseHealth,
  OperationalNodeHealth,
  OperationalRegionHealth,
  readOperationalHealth,
} from "../domain/operational-health.ts";

export const OperationalHealthQuery = ListQuery.safeExtend({
  scope: z.enum(["regions", "nodes", "databases"]).default("databases"),
});
const OperationalHealthResponse = z.discriminatedUnion("scope", [
  listEnvelope(OperationalRegionHealth).safeExtend({
    scope: z.literal("regions"),
  }),
  listEnvelope(OperationalNodeHealth).safeExtend({ scope: z.literal("nodes") }),
  listEnvelope(OperationalDatabaseHealth).safeExtend({
    scope: z.literal("databases"),
  }),
]);

export function registerOperationalHealth(app: ApiApp): void {
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/operational-health",
      tags: ["Health"],
      security: [{ bearerAuth: [] }],
      request: { query: OperationalHealthQuery },
      responses: {
        200: {
          description:
            "Actual operational samples with explicit unknown health",
          content: {
            "application/json": { schema: OperationalHealthResponse },
          },
        },
        400: {
          description: "Invalid health query",
          content: { "application/json": { schema: ErrorBody } },
        },
        401: {
          description: "Invalid credentials",
          content: { "application/json": { schema: ErrorBody } },
        },
        403: {
          description: "Administrator scope required",
          content: { "application/json": { schema: ErrorBody } },
        },
      },
    }),
    async (c) => {
      await requireScope(c, "admin");
      const query = c.req.valid("query");
      const pagination = page(c, { limit: query.limit, cursor: query.cursor });
      const rows = await readOperationalHealth(c.env.DB, query.scope, {
        limit: pagination.limit,
        cursor: pagination.where(),
      });
      return c.json(
        OperationalHealthResponse.parse({
          scope: query.scope,
          ...pagination.envelope(rows),
        }),
        200,
      );
    },
  );
}
