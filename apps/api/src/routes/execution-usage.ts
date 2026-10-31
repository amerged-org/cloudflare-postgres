// SPDX-License-Identifier: Apache-2.0
import { createRoute } from "@hono/zod-openapi";
import { ErrorBody } from "@pgcf/contracts";
import {
  ExecutionUsageQuery,
  ExecutionUsageResponse,
} from "@pgcf/contracts/execution-usage";
import type { ApiApp } from "../app.ts";
import { queryExecutionUsage } from "../domain/execution-usage.ts";

const error = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorBody } },
});

export function registerExecutionUsage(app: ApiApp): void {
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/execution-usage",
      security: [{ bearerAuth: [] }],
      tags: ["Usage"],
      description:
        "Counts what the schedules, events and webhook deliveries of one project or one database did, by hour or day: `schedule_runs_*` (by outcome; the three `skipped_*` outcomes are summed), `events_emitted` and `event_bytes`, `webhook_attempts` (every request sent), `webhook_deliveries_delivered` and `webhook_deliveries_dead_lettered`. Give exactly one of `project_id` or `database_id`; `from` and `to` are aligned timestamps at most 31 days apart. A period without a row had no executions; a metric that is missing from an existing row is 0. Hours are written a minute after they end, and a row is `final` two hours after its period ended: bill only from final rows. A replay of a delivery counts again. PGCF reports counts only; prices and credits belong to the integrator.",
      request: { query: ExecutionUsageQuery },
      responses: {
        200: {
          description: "Counted executions",
          content: { "application/json": { schema: ExecutionUsageResponse } },
        },
        400: error("Invalid usage range or scope"),
        401: error("Invalid credentials"),
        404: error("Usage scope not found"),
        500: error("Internal server error"),
      },
    }),
    async (c) =>
      c.json(await queryExecutionUsage(c, c.req.valid("query")), 200),
  );
}
