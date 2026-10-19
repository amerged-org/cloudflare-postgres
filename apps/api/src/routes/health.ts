// SPDX-License-Identifier: Apache-2.0
import { createRoute, z } from "@hono/zod-openapi";
import { ErrorBody, ListQuery, listEnvelope } from "@pgcf/contracts";
import type { ApiApp } from "../app.ts";
import { requireAdminRead } from "../middleware/auth.ts";
import { page } from "../platform/pagination.ts";
import { CronHealth, readCronHealth } from "../domain/cron-health.ts";
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
    cron: CronHealth.describe(
      "Heartbeat of the minute cron, the same for every region; see the route description.",
    ),
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
        "With scope=regions each region carries infrastructure_alerts: one entry per alert kind ever recorded for it, active or cleared; the minute cron keeps one episode per region and kind. The event_id names the error, so the same error has the same event_id every time it occurs and a recurrence differs in occurred_at (the start of its episode); an episode is delivered at least once through the alert webhook or email of PUT /v1/infrastructure-backups/config; delivered_at and last_attempt_at show its delivery, and every event carries a short runbook action in its action field.",
        "Threshold kinds follow PUT /v1/regions/{id}/capacity-policy and are evaluated for the first four regions with a policy, in region ID order: regional_ram_warning, regional_node_cap_reached, regional_node_ram_warning, regional_node_cpu_warning and regional_node_storage_warning. Fixed-rule kinds are evaluated for every region: regional_node_stale (a node's observation is older than 180 s, or the node is marked lost and a database is still placed on it); infrastructure_backup_failed and infrastructure_backup_stale (the daily D1 backup failed, or none completed for 36 h; see GET /v1/infrastructure-backups); database_archive_failing (a running, awake database reports health.archiving failing); database_base_backup_stale (an awake database has no completed base backup within 36 h of awake time: a hibernated database is excluded and a wake restarts the count); thin_storage_blocked (a node's fresh physical sample shows the thin pool without data or metadata room, or a pool that holds thin volumes has no fresh sample; thin_storage lists its thin_pool_* error_code); node_enrollment_refused (a node's enrollment token was presented again with another key, or after it expired, within the last 24 h; node_ids lists the nodes); node_unexpected_reboot (a node rebooted without a maintenance order that was open when its last sample of the previous boot arrived, or closed after it, within the last 24 h; node_ids lists the nodes, and GET /v1/nodes/{id}/diagnostics lists the report (expected_reboot false), and GET /v1/nodes/{id}/diagnostics/{diagnostic_id} holds the previous boot's journal tail).",
        "Unknown measurements neither start nor clear an episode: an unknown archive or backup state, a missing sample or a stale report never starts one and keeps an active one. An episode names at most 64 databases or nodes (16 for Thin storage); a subject that fails and is not named yet replaces the episode with a new event that lists the current subjects, while a named one that recovers and fails again adds none.",
        "With scope=regions the response also carries cron, the minute cron's heartbeat: last_started_at is set when a run begins and last_completed_at when it has attempted every step. Each step runs in its own failure boundary, so a failing step is logged (cron_step_failed), counted in failing_steps and does not stop the steps after it; alerting runs first, then the daily backup dispatch. status is ok; failing (a step failed in each of its last 5 completed runs); stalled (no run completed for more than 300 s); or unknown (no run recorded yet). The CronWatchdog Durable Object alarm judges this heartbeat every minute, independently of the cron trigger, records its evaluation in watchdog_checked_at and raises control_cron_stalled and control_cron_step_failing in every region.",
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
      await requireAdminRead(c);
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
          ...(query.scope === "regions"
            ? { cron: await readCronHealth(c.env.DB) }
            : {}),
        }),
        200,
      );
    },
  );
}
