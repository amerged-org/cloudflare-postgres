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
      description:
        "Hourly or daily measured usage of the databases of one project or of one database: give exactly one of `project_id` or `database_id`. `from` and `to` are timestamps aligned to the UTC hour (`granularity=hour`) or day (`day`) and at most 31 days apart; a request outside that is a 400. `limit` is 1 to 100 and `cursor` the `next_cursor` of the previous page. A metric is a number or null: null is unknown, never zero, and its name is in `gaps`; an hour is final two hours after it ends.",
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
