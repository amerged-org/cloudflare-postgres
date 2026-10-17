// SPDX-License-Identifier: Apache-2.0
import { createRoute, z } from "@hono/zod-openapi";
import { ErrorBody, InfraAlertKind } from "@pgcf/contracts";
import {
  InfrastructureBackupConfig,
  InfrastructureBackupConfigInput,
  InfrastructureBackupDeferral,
  InfrastructureBackupHealth,
  InfrastructureBackupRunStatus,
} from "@pgcf/contracts/infrastructure-backups";
import { ApiError, type ApiApp } from "../app.ts";
import { requireScope } from "../middleware/auth.ts";
import {
  authorizeBackupOperator,
  configureInfrastructureBackups,
  infrastructureBackupDeferral,
  infrastructureBackupHealth,
  infrastructureBackupStatus,
  readInfrastructureBackupConfig,
} from "../domain/infrastructure-backups.ts";
import { operatorKubernetesRelay } from "../domain/node-operator.ts";
const error = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorBody } },
});
const admin = {
  401: error("Invalid credentials"),
  403: error("Administrator scope required"),
};
export function registerInfrastructureBackups(app: ApiApp) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/infrastructure-backups/config",
      tags: ["Infrastructure"],
      security: [{ bearerAuth: [] }],
      summary: "Read infrastructure backup and alert email settings",
      description:
        "Returns the singleton settings of daily infrastructure backups and of alert email delivery. Fresh installations have backups disabled and every identifier and address null. Secrets are never returned, and whether RESEND_API_KEY or an alert webhook is configured is not visible here; last_attempt_at and delivered_at in GET /v1/operational-health?scope=regions show delivery.",
      responses: {
        200: {
          description:
            "Operator-configured daily infrastructure backups and optional generic email delivery",
          content: {
            "application/json": { schema: InfrastructureBackupConfig },
          },
        },
        ...admin,
      },
    }),
    async (c) => {
      await requireScope(c, "admin");
      return c.json(await readInfrastructureBackupConfig(c.env.DB), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/infrastructure-backups/config",
      tags: ["Infrastructure"],
      security: [{ bearerAuth: [] }],
      summary: "Configure infrastructure backups and alert email",
      description: [
        "Replaces the singleton settings; send all six fields, null clears an identifier or address. The alert email addresses work independently of enabled.",
        `Alert email: when the Worker secret RESEND_API_KEY and both notification_recipient and notification_sender are set and no valid alert webhook is configured, every new episode of any alert kind (${InfraAlertKind.options.join(", ")}) is sent through the Resend API with subject "PGCF infrastructure: <kind> (<region_id>)" and the event JSON as plain-text body. A cleared episode sends nothing.`,
        "Event JSON: version (1), event_id, kind, region_id, occurred_at (episode start), regional_ram_utilization_ppm, allocated_nodes, max_nodes and action (a short runbook action for the kind; absent on episodes that started before it existed). Backup kinds add backup_artifacts (kind, status, last_completed_at, error_code); regional_node_stale and the per-node warnings add node_ids (at most 64; per-node warnings highest first), and the per-node warnings add threshold_ppm and the highest utilization_ppm. The database kinds add database_ids (at most 64), thin_storage_blocked adds thin_storage (node_id and its thin_storage_* error_code, null while only the pool reserve is short, which refuses new starts) and the cron kinds add cron (last_started_at, last_completed_at and failing_steps).",
        "Delivery: the minute cron sends with a 5 s deadline and event_id as Idempotency-Key; a 2xx response sets delivered_at. Any other outcome is retried with the same event_id and body at least 60 s after last_attempt_at while the episode stays active; capacity policy warnings only while that minute's evaluation still confirms them. Each refused or timed-out attempt is logged as infrastructure_alert_delivery_failed with the HTTP status or a timeout/transport reason, never the body or the destination. The cron kinds control_cron_stalled and control_cron_step_failing are sent by the CronWatchdog Durable Object alarm, which runs without the cron. Resend deduplicates the Idempotency-Key within its own retention window. Status: GET /v1/operational-health?scope=regions.",
        "Webhook alternative: set the Worker secret INFRASTRUCTURE_ALERT_WEBHOOK_TOKEN (16 to 512 characters of A-Z a-z 0-9 . _ ~ -) with the service binding INFRASTRUCTURE_ALERT_WEBHOOK (requests go through it) or INFRASTRUCTURE_ALERT_WEBHOOK_URL (https without credentials, query or fragment, at most 2048 characters). A valid webhook takes precedence and email is then not sent. PGCF POSTs the event JSON with Authorization: Bearer <token> and Idempotency-Key: <event_id>, follows no redirects and treats any 2xx as acknowledged; the receiver must verify the token and durably deduplicate event_id. Without either destination, episodes are only recorded.",
        "Every successful PUT increments revision. Alert email changes preserve valid pending or running backups without extending their deadlines. Changing enabled or the D1 account, database or archive region invalidates earlier capture authority; a later email change cannot revive it. 400: invalid body, or enabled without d1_account_id, d1_database_id and d1_region_id. 404: d1_region_id does not exist. 409: enabled without the INFRASTRUCTURE_BACKUP Workflow binding or the INFRASTRUCTURE_BACKUP_CF_TOKEN secret.",
      ].join("\n\n"),
      request: {
        body: {
          required: true,
          content: {
            "application/json": { schema: InfrastructureBackupConfigInput },
          },
        },
      },
      responses: {
        200: {
          description:
            "Configuration persisted; defaults remain off until the operator enables them",
          content: {
            "application/json": { schema: InfrastructureBackupConfig },
          },
        },
        400: error("Invalid configuration"),
        ...admin,
        404: error("Backup region not found"),
        409: error("Backup Workflow binding or D1 export secret missing"),
      },
    }),
    async (c) => {
      await requireScope(c, "admin");
      return c.json(
        await configureInfrastructureBackups(c.env, c.req.valid("json")),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/infrastructure-backups",
      tags: ["Infrastructure"],
      security: [{ bearerAuth: [] }],
      summary: "Read the latest infrastructure backup run and backup freshness",
      description:
        "Returns the latest attempt of the latest UTC day with per-artifact receipts and the freshness of every expected backup: the D1 export in d1_region_id and one etcd snapshot per region with a current cluster and a node that is not lost. Earlier attempts of that day stay in D1 only and are not returned. While enabled, the minute cron starts one run per UTC day and retries a failed run on the same day: the next attempt starts at least 90 minutes after the failed attempt ended, at most 3 attempts per day, and never while another run of any day is pending or running. A due attempt waits, without taking an attempt number, while a fleet patch operation is unfinished or changed in the last 15 minutes and while a thin database start granted in the last 15 minutes is not ready; deferral shows the latest such wait. A run fails after two hours. Health status failing raises infrastructure_backup_failed and stale raises infrastructure_backup_stale for that region; a later complete attempt clears failing. No credentials, signed URLs or keys are returned.",
      responses: {
        200: {
          description: "Latest safe backup receipts and current freshness",
          content: {
            "application/json": {
              schema: z.object({
                latest: InfrastructureBackupRunStatus.nullable().describe(
                  "Latest attempt of the latest UTC day; null before the first run.",
                ),
                health: z
                  .array(InfrastructureBackupHealth)
                  .describe("Freshness of every expected backup."),
                deferral: InfrastructureBackupDeferral.nullable().describe(
                  "The latest time a due attempt was held back, with its reason; null when none ever was. It is current only while last_at is recent: the cron checks every minute.",
                ),
              }),
            },
          },
        },
        ...admin,
      },
    }),
    async (c) => {
      await requireScope(c, "admin");
      return c.json(
        {
          latest: await infrastructureBackupStatus(c.env.DB),
          health: await infrastructureBackupHealth(c.env),
          deferral: await infrastructureBackupDeferral(c.env.DB),
        },
        200,
      );
    },
  );
  app.get(
    "/internal/v1/infrastructure-backups/:run/:artifact/kubernetes",
    async (c) => {
      if (c.req.header("Upgrade")?.toLowerCase() !== "websocket")
        throw new ApiError(
          "invalid_request",
          "A backup Kubernetes WebSocket is required",
        );
      const run = z.uuid().parse(c.req.param("run")),
        artifact = c.req.param("artifact"),
        bearer = c.req.header("authorization");
      const authorize = async () => {
        await authorizeBackupOperator(c.env, run, artifact, bearer);
      };
      const selected = await authorizeBackupOperator(
        c.env,
        run,
        artifact,
        bearer,
      );
      return operatorKubernetesRelay(
        c.env,
        selected.node_id!,
        selected.node_uid!,
        authorize,
      );
    },
  );
}
