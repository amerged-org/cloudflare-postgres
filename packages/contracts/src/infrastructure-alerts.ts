// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Timestamp } from "./api.ts";
import { DatabaseId, NodeId, RegionId } from "./ids.ts";

export const InfraAlertKind = z
  .enum([
    "regional_node_capacity_warning",
    "regional_node_capacity_action",
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
    "database_delete_incomplete",
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
    "regional_node_cap_reached: allocated nodes reached max_nodes with cap_warning_enabled. regional_node_stale: a node's observation is older than 180 s or the node is marked lost and a database is still placed on it; never-observed nodes are ignored. infrastructure_backup_failed / infrastructure_backup_stale: the daily D1 backup stored in the region is failing / has not completed for more than 36 h. regional_node_ram_warning, regional_node_cpu_warning, regional_node_storage_warning: a node reached the matching node_*_warning_threshold_ppm; RAM and CPU are the 30-minute average of the node's own samples, storage the fuller of its thin pool's data and metadata. Thresholds come from the region's capacity policy. " +
      "database_archive_failing: a running, awake database of the region reports health.archiving failing (database_ids, at most 64). database_base_backup_stale: an awake database has no completed base backup within 36 h of awake time; a hibernated database is excluded and a wake restarts the clock (database_ids). thin_storage_blocked: a node's newest sample says its thin pool has no room (thin_pool_no_room: no database starts, is created or restored there), or a node that holds databases has no sample of its pool within 180 s (thin_pool_unobserved); thin_storage lists each node with its thin_pool_* error_code. database_delete_incomplete: a database was deleted more than 10 minutes ago and its node has not finished: it has not reported the database deleted, or its volume report still names a volume of it (database_ids, at most 64, oldest first); a node marked lost is ignored, and the kind ends when the database is reported deleted and no volume of it is reported. " +
      'regional_node_capacity_refusals: a node refused 5 or more wakes for awake capacity or for a full start queue (57P03 "node at awake capacity" or "node busy starting databases") in the last 10 minutes (node_ids). regional_node_pool_closed: the region cannot place the smallest size class on offer, because no node that reports and is open for new databases takes it; one node that is full beside a node that takes the class is no episode, and the episode ends as soon as one node takes the class again. node_ids lists the nodes whose thin pool refuses the class (data at 80 % or more, metadata at 50 % or more, the storage sold plus that class past 4 times its data, or 1,000 volumes or more) and, when the nodes that report, are open and have a pool with room have no RAM or CPU for it, every one of those. RAM uses the higher of the three-day peak and current sample plus the smallest class memory, without transient pending placements; CPU uses the three-day peak and the class must fit physical cores. Peaks are 30-minute averages and both loads must stay below 80 %. Nothing is created, restored or moved in the region, and running databases keep running. database_volume_warning, database_volume_critical: the bytes or inodes available to PostgreSQL in a database\'s filesystem are at least 80 % (below 90 %), or at least 90 %, used in the volume\'s newest report of at most 180 s; database_volume_critical also names a database whose node reports a filesystem smaller than the storage the database has, a growth the node could not make (database_ids, at most 64). ' +
      "control_cron_stalled: no run of the minute cron completed for 5 minutes, found by the CronWatchdog Durable Object alarm independently of the cron trigger. control_cron_step_failing: a cron step failed in each of its last 5 completed runs (cron.failing_steps); a step that does not answer within 240 s counts as failed with the error_code step_timeout. The same alarm evaluates every alert of every region once a minute, so no alert waits for the cron. node_enrollment_refused: a node's enrollment token was presented again with another key or after it expired during the last 24 h (node_ids, at most 64); the refused token never enrolls a node. node_unexpected_reboot: a node rebooted and no maintenance order of it was open when its last sample of the previous boot arrived, or closed after it, according to the boot report the node sent when it started again, within the last 24 h (node_ids, at most 64); GET /v1/nodes/{id}/diagnostics lists the report (expected_reboot false), and GET /v1/nodes/{id}/diagnostics/{diagnostic_id} holds the previous boot's journal tail. The database, Thin storage, pool, enrollment, reboot and cron kinds have fixed rules and no threshold; the cron kinds are raised in every region.",
  );
export type InfraAlertKind = z.infer<typeof InfraAlertKind>;

/** One short English runbook action per kind; it travels in every new event's `action` field. */
export const INFRA_ALERT_ACTIONS: Record<InfraAlertKind, string> = {
  regional_node_capacity_warning:
    "Current node pressure reached the configured warning threshold. Review the affected resource and available same-region capacity. This alert never purchases or moves a database.",
  regional_node_capacity_action:
    "Current node pressure stayed above its action threshold for the configured duration. Review same-region capacity and plan a database move or an approved node addition. Purchases and moves require separate authority.",
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
  database_delete_incomplete:
    "A listed database was deleted over 10 minutes ago and its node has not removed all of it (a unit, a volume, its user or its files remain). Read the delete_incomplete lines of the node in Workers Logs for the step and class; the agent retries every 30 s. See A delete that does not finish in docs/operations/recovery.md.",
  regional_node_capacity_refusals:
    "A listed node keeps refusing wakes because its awake capacity is full or it cannot start databases fast enough. Move its most active databases to another node, or add a node; see the capacity decision in GET /v1/regions/{id}/capacity-decision.",
  regional_node_pool_closed:
    "No node fits the smallest class: pool data 80%, metadata 50%, sold storage plus class >4x pool, or 1,000 volumes. RAM=max(3-day peak,current)+class, excluding pending placements; CPU uses peak and physical cores. Peaks are 30-minute averages; load must stay below 80%. Creates/restores/moves wait; running databases continue. Delete databases or add a node.",
  database_volume_warning:
    "The filesystem of each listed database is at least 80 % full, in bytes or inodes. Raise its storage with PUT /v1/databases/{id}/resources, or have the integrator free space.",
  database_volume_critical:
    "The filesystem of each listed database is at least 90 % full (bytes or inodes), or a resize left it smaller than its requested storage (filesystem_not_grown). Raise storage with PUT /v1/databases/{id}/resources. At full, PostgreSQL may stop; recovery by explicit growth is supported, while arbitrary SQL cleanup at zero free space is not guaranteed.",
  control_cron_stalled:
    "The minute cron has not completed a run for over 5 minutes. Check the Worker's cron trigger and logs (cron_step_failed, cron_completed) and redeploy the Worker if its trigger is missing.",
  control_cron_step_failing:
    "A cron step failed in each of its last runs. Read the Worker logs for cron_step_failed with the step named in cron.failing_steps and fix its cause; later steps keep running.",
  node_enrollment_refused:
    "A node's enrollment token was used again with another key, or after it expired. If you did not retry the install, treat the token as leaked: read the node_enrollment_refused log for the node and reinstall it, which issues new tokens.",
  node_unexpected_reboot:
    "A listed node rebooted without a maintenance order. List GET /v1/nodes/{id}/diagnostics for the report with expected_reboot false, then read its journal tail at GET /v1/nodes/{id}/diagnostics/{diagnostic_id} (kernel, agent, gateway, cloudflared, networkd and PID 1) to find out whether it panicked, ran out of memory or lost power; the episode ends 24 h after the report.",
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
  state: z
    .literal("resolved")
    .optional()
    .describe(
      "Present only on a recovery notification; absent on the initial warning and its retries.",
    ),
  episode_started_at: Timestamp.optional().describe(
    "For recovery notifications, the original warning's occurred_at.",
  ),
  event_id: z
    .uuid()
    .describe(
      "Identifier of the error, not of the delivery: a version 8 UUID (RFC 9562) made from the SHA-256 of region_id, kind and the sorted subjects: node_ids, database_ids, the nodes of thin_storage or, for control_cron_step_failing, the steps of cron.failing_steps with at least 5 consecutive failures. The same error has the same event_id every time it occurs, also after it cleared and came back; another set of subjects is another error with another event_id. A retry repeats event_id, occurred_at and the body; a recurrence has the same event_id and a new occurred_at.",
    ),
  kind: InfraAlertKind,
  region_id: RegionId,
  occurred_at: Timestamp.describe(
    "When the warning started, or when it resolved for a recovery notification. episode_started_at links a recovery to its warning.",
  ),
  regional_ram_utilization_ppm: z
    .null()
    .describe(
      "Always null. Nothing measures a regional RAM utilization any more; the field stays so a receiver that reads it keeps working.",
    ),
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
  capacity: z
    .array(
      z.strictObject({
        node_id: NodeId,
        resource: z.enum(["ram", "cpu", "data", "metadata"]),
        utilization_ppm: Ppm,
        threshold_ppm: Ppm,
      }),
    )
    .max(16)
    .optional(),
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

export const InfraAlertDeliveryStatus = z.strictObject({
  destination_id: z.string().min(1).max(80),
  channel: z.enum(["webhook", "email"]),
  recipient: z.string().nullable(),
  delivered_at: Timestamp.nullable(),
  last_attempt_at: Timestamp.nullable(),
  attempts: z.number().int().nonnegative(),
  last_status: z.number().int().nullable(),
  last_error: z.string().nullable(),
});
export const InfraAlertStatus = z.strictObject({
  kind: InfraAlertKind,
  deliveries: z.array(InfraAlertDeliveryStatus).default([]),
  recoveries: z
    .array(
      z.strictObject({
        event_id: z.uuid(),
        occurred_at: Timestamp,
        episode_started_at: Timestamp,
        delivered_at: Timestamp.nullable(),
        last_attempt_at: Timestamp.nullable(),
        deliveries: z.array(InfraAlertDeliveryStatus),
      }),
    )
    .default([]),
  active: z
    .boolean()
    .describe(
      "True while the episode's condition holds, or while its measurement is unknown; false once it cleared or its warning was disabled. A previously delivered warning creates a durable recovery notification, retried independently for every destination.",
    ),
  event_id: z
    .uuid()
    .nullable()
    .describe(
      "event_id of the current or last episode: the identifier of the error, which is the same every time the same error occurs. The Idempotency-Key of its notification is event_id and occurred_at joined by a colon.",
    ),
  occurred_at: Timestamp.nullable().describe(
    "When that episode started; two episodes of the same event_id differ in it.",
  ),
  delivered_at: Timestamp.nullable().describe(
    "When every configured destination accepted the episode with a 2xx status; this is not inbox delivery. Individual receipts are in deliveries. null while any configured destination is undelivered, including without a configured destination.",
  ),
  last_attempt_at: Timestamp.nullable().describe(
    "Start of the latest delivery attempt; null if none was made. A retry waits at least 60 s after it.",
  ),
});
export type InfraAlertStatus = z.infer<typeof InfraAlertStatus>;
