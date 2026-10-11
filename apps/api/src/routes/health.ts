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
  scope: z
    .enum(["regions", "nodes", "databases"])
    .default("databases")
    .describe(
      "regions: regional agent heartbeat and infrastructure alert status; nodes: node heartbeats; databases: base backup and disk health.",
    ),
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
      summary: "Read operational health and infrastructure alert status",
      description: [
        "Lists measured health with explicit unknown states; a missing measurement is unknown, never ok. Heartbeats older than 180 s are stale; backup and disk reports older than 180 s are unknown.",
        "With scope=regions each region carries infrastructure_alerts: one entry per alert kind ever recorded for it, active or cleared. The minute cron keeps one episode per region and kind. regional_ram_warning, regional_node_cap_reached and the three per-node warnings follow the thresholds of PUT /v1/regions/{id}/capacity-policy and are evaluated for the first four regions with a policy, in region ID order; regional_node_stale, infrastructure_backup_failed and infrastructure_backup_stale (see GET /v1/infrastructure-backups) are evaluated for every region. A new episode gets a new event_id and is delivered at least once through the alert webhook or email of PUT /v1/infrastructure-backups/config; delivered_at and last_attempt_at show its delivery.",
      ].join("\n\n"),
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
