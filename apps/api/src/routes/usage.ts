// SPDX-License-Identifier: Apache-2.0
import { createRoute } from "@hono/zod-openapi";
import { ErrorBody } from "@pgcf/contracts";
import { UsageQuery, UsageResponse } from "@pgcf/contracts/usage";
import type { ApiApp } from "../app.ts";
import { queryUsage } from "../domain/usage.ts";

export function registerUsage(app: ApiApp): void {
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/usage",
      security: [{ bearerAuth: [] }],
      request: { query: UsageQuery },
      responses: {
        200: {
          description: "Measured usage with explicit gaps",
          content: { "application/json": { schema: UsageResponse } },
        },
        400: {
          description: "Invalid usage range or scope",
          content: { "application/json": { schema: ErrorBody } },
        },
        401: {
          description: "Invalid credentials",
          content: { "application/json": { schema: ErrorBody } },
        },
        404: {
          description: "Usage scope not found",
          content: { "application/json": { schema: ErrorBody } },
        },
      },
    }),
    async (c) => c.json(await queryUsage(c, c.req.valid("query")), 200),
  );
}
