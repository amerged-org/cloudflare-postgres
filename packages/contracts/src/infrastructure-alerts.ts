// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Timestamp } from "./api.ts";
import { DatabaseId, NodeId, RegionId } from "./ids.ts";

export const InfraAlertKind = z
  .enum([
    "regional_ram_warning",
    "regional_node_cap_reached",
    "regional_node_stale",
    "infrastructure_backup_failed",
    "infrastructure_backup_stale",
    "regional_node_ram_warning",
    "regional_node_cpu_warning",
    "regional_node_storage_warning",
    "database_archive_failing",
    "database_base_backup_stale",
    "thin_storage_blocked",
    "regional_node_capacity_refusals",
    "regional_node_pool_closed",
    "database_volume_warning",
    "database_volume_critical",
    "control_cron_stalled",
    "control_cron_step_failing",
    "node_enrollment_refused",
    "node_unexpected_reboot",
  ])
  .describe(
    "regional_ram_warning: regional ten-minute RAM utilization at or above ram_warning_threshold_ppm. regional_node_cap_reached: allocated nodes reached max_nodes with cap_warning_enabled. regional_node_stale: a node's observation is older than 180 s or the node is marked lost; never-observed nodes are ignored. infrastructure_backup_failed / infrastructure_backup_stale: the daily D1 backup stored in the region is failing / has not completed for more than 36 h. regional_node_ram_warning, regional_node_cpu_warning, regional_node_storage_warning: a node reached the matching node_*_warning_threshold_ppm; RAM and CPU are the 30-minute average of the node's own samples, storage the fuller of its thin pool's data and metadata. Thresholds come from the region's capacity policy. " +
      "database_archive_failing: a running, awake database of the region reports health.archiving failing (database_ids, at most 64). database_base_backup_stale: an awake database has no completed base backup within 36 h of awake time; a hibernated database is excluded and a wake restarts the clock (database_ids). thin_storage_blocked: a node's newest sample says its thin pool has no room (thin_pool_no_room: no database starts, is created or restored there), or a node that holds databases has no sample of its pool within 180 s (thin_pool_unobserved); thin_storage lists each node with its thin_pool_* error_code. " +
      "regional_node_capacity_refusals: a node refused 5 or more wakes for awake capacity (57P03 \"node at awake capacity\") in the last 10 minutes (node_ids). regional_node_pool_closed: a node's newest sample closes its thin pool for placement, with its data at 80 % or more, its metadata at 50 % or more, or the storage sold at 4 times its data (node_ids); nothing is created or restored there, and running databases keep running. database_volume_warning, database_volume_critical: the space or the inodes of a database's volume are at least 80 % (below 90 %), or at least 90 %, used in the volume's newest report of at most 180 s (database_ids, at most 64). " +
      "control_cron_stalled: no run of the minute cron completed for 5 minutes, found by the CronWatchdog Durable Object alarm independently of the cron trigger. control_cron_step_failing: a cron step failed in each of its last 5 completed runs (cron.failing_steps). node_enrollment_refused: a node's enrollment token was presented again with another key or after it expired during the last 24 h (node_ids, at most 64); the refused token never enrolls a node. node_unexpected_reboot: a node rebooted and no maintenance order of it was open when its last sample of the previous boot arrived, or closed after it, according to the boot report the node sent when it started again, within the last 24 h (node_ids, at most 64); GET /v1/nodes/{id}/diagnostics holds the previous boot's journal tail. The database, Thin storage, pool, enrollment, reboot and cron kinds have fixed rules and no threshold; the cron kinds are raised in every region.",
  );
export type InfraAlertKind = z.infer<typeof InfraAlertKind>;

/** One short English runbook action per kind; it travels in every new event's `action` field. */
export const INFRA_ALERT_ACTIONS: Record<InfraAlertKind, string> = {
  regional_ram_warning:
    "Regional RAM use is above its threshold. Read GET /v1/regions/{id}/capacity-decision, then add a node or reduce awake databases; review ram_warning_threshold_ppm.",
  regional_node_cap_reached:
    "The region reached max_nodes. Raise max_nodes with PUT /v1/regions/{id}/capacity-policy or free a node slot; no node is added while the cap holds.",
  regional_node_stale:
    "A node stopped reporting or is marked lost. Check the server and its node agent; if the server is gone, follow the lost-node runbook in docs/operations/recovery.md.",
  infrastructure_backup_failed:
    "The daily D1 backup failed. Read GET /v1/infrastructure-backups for the artifact error_code and fix it; same-day retries run automatically (docs/operations/infrastructure-backups.md).",
  infrastructure_backup_stale:
    "No complete infrastructure backup for over 36 h. Read GET /v1/infrastructure-backups and the cron heartbeat in GET /v1/operational-health?scope=regions, and fix the cause before the next 00:00Z run.",
  regional_node_ram_warning:
    "A node's ten-minute RAM average is above its threshold. Find the node in node_ids and reduce awake databases there or add capacity.",
  regional_node_cpu_warning:
    "A node's ten-minute CPU average is above its threshold. Find the node in node_ids and reduce awake databases there or add capacity.",
  regional_node_storage_warning:
    "A node's thin pool or volume group is filling. Free space by deleting databases on the node; the pool does not grow. See Thin storage admission in docs/operations/recovery.md.",
  database_archive_failing:
    "WAL archiving of the listed databases is failing. Check R2 reachability and the region's archive credentials; WAL accumulates on the volume until archiving works again.",
  database_base_backup_stale:
    "The listed awake databases have no completed base backup for 36 h of awake time. Check their scheduled backup and R2 access; read backup.status in GET /v1/operational-health?scope=databases.",
  thin_storage_blocked:
    "A listed node's thin pool is out of room or unobserved. thin_pool_no_room: nothing starts, is created or is restored there until deleting databases on the node frees space; the pool does not grow. thin_pool_unobserved: fix the node's samples.",
  regional_node_capacity_refusals:
    "A listed node keeps refusing wakes because its awake capacity is full. Move its most active databases to another node, or add a node; see the capacity decision in GET /v1/regions/{id}/capacity-decision.",
  regional_node_pool_closed:
    "A listed node's thin pool is closed for placement: no database is created or restored there, and running databases keep running. Free space by deleting databases on the node, or add a node; the pool does not grow.",
  database_volume_warning:
    "The volume of each listed database is at least 80 % full, in space or inodes. Raise its storage with PUT /v1/databases/{id}/resources, or have the integrator free space.",
  database_volume_critical:
    "The volume of each listed database is at least 90 % full, in space or inodes. Raise its storage with PUT /v1/databases/{id}/resources now: a full volume stops the database.",
  control_cron_stalled:
    "The minute cron has not completed a run for over 5 minutes. Check the Worker's cron trigger and logs (cron_step_failed, cron_completed) and redeploy the Worker if its trigger is missing.",
  control_cron_step_failing:
    "A cron step failed in each of its last runs. Read the Worker logs for cron_step_failed with the step named in cron.failing_steps and fix its cause; later steps keep running.",
  node_enrollment_refused:
    "A node's enrollment token was used again with another key, or after it expired. If you did not retry the install, treat the token as leaked: read the node_enrollment_refused log for the node and reinstall it, which issues new tokens.",
  node_unexpected_reboot:
    "A listed node rebooted without a maintenance order. Read the previous boot's journal tail in GET /v1/nodes/{id}/diagnostics (kernel, agent, gateway, cloudflared, networkd and PID 1) to find out whether it panicked, ran out of memory or lost power; the episode ends 24 h after the report.",
};

const Ppm = z.number().int().min(0).max(1_000_000);
export const InfraCronFailingStep = z.strictObject({
  step: z.string().min(1).max(32),
  consecutive_failures: z.number().int().min(1).max(1_000_000),
  error_code: z.string().max(64).nullable(),
});
export type InfraCronFailingStep = z.infer<typeof InfraCronFailingStep>;
export const InfraCronHeartbeat = z.strictObject({
  last_started_at: Timestamp.nullable(),
  last_completed_at: Timestamp.nullable(),
  failing_steps: z.array(InfraCronFailingStep).max(20),
});
export type InfraCronHeartbeat = z.infer<typeof InfraCronHeartbeat>;
export const InfraAlert = z.strictObject({
  version: z.literal(1),
  event_id: z.uuid(),
  kind: InfraAlertKind,
  region_id: RegionId,
  occurred_at: Timestamp,
  regional_ram_utilization_ppm: Ppm.nullable(),
  allocated_nodes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  max_nodes: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  backup_artifacts: z
    .array(
      z.strictObject({
        kind: z.enum(["d1", "etcd"]),
        status: z.enum(["unknown", "stale", "failing"]),
        last_completed_at: Timestamp.nullable(),
        error_code: z.string().max(128).nullable(),
      }),
    )
    .max(2)
    .optional(),
  node_ids: z.array(NodeId).max(64).optional(),
  /** Per-node warnings: the configured threshold and the highest utilization among node_ids. */
  threshold_ppm: Ppm.nullable().optional(),
  utilization_ppm: Ppm.nullable().optional(),
  /** Database kinds: the affected databases, longest-standing first. */
  database_ids: z.array(DatabaseId).max(64).optional(),
  /** thin_storage_blocked: each listed node with its thin_pool_* code. */
  thin_storage: z
    .array(
      z.strictObject({
        node_id: NodeId,
        error_code: z.string().max(128).nullable(),
      }),
    )
    .max(16)
    .optional(),
  /** Cron kinds: the heartbeat the watchdog read and every step that failed in the latest completed run. */
  cron: InfraCronHeartbeat.optional(),
  /** Short runbook action of the kind (INFRA_ALERT_ACTIONS); absent on episodes started before it existed. */
  action: z.string().max(512).optional(),
});
export type InfraAlert = z.infer<typeof InfraAlert>;

export const InfraAlertStatus = z.strictObject({
  kind: InfraAlertKind,
  active: z
    .boolean()
    .describe(
      "True while the episode's condition holds, or while its measurement is unknown; false once it cleared or its warning was disabled. A cleared episode sends nothing.",
    ),
  event_id: z
    .uuid()
    .nullable()
    .describe(
      "ID of the current or last episode; the Idempotency-Key of its notification.",
    ),
  occurred_at: Timestamp.nullable().describe("When that episode started."),
  delivered_at: Timestamp.nullable().describe(
    "When the alert webhook or the Resend API accepted the notification with a 2xx status; this is not inbox delivery. null while undelivered, including without a configured destination.",
  ),
  last_attempt_at: Timestamp.nullable().describe(
    "Start of the latest delivery attempt; null if none was made. A retry waits at least 60 s after it.",
  ),
});
export type InfraAlertStatus = z.infer<typeof InfraAlertStatus>;
