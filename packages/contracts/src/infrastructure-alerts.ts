// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Timestamp } from "./api.ts";
import { RegionId, NodeId } from "./ids.ts";

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
  ])
  .describe(
    "regional_ram_warning: regional ten-minute RAM utilization at or above ram_warning_threshold_ppm. regional_node_cap_reached: allocated nodes reached max_nodes with cap_warning_enabled. regional_node_stale: a node's observation is older than 180 s or the node is marked lost; never-observed nodes are ignored. infrastructure_backup_failed / infrastructure_backup_stale: a daily D1 or etcd backup of the region is failing / has not completed for more than 36 h. regional_node_ram_warning, regional_node_cpu_warning, regional_node_storage_warning: a node reached the matching node_*_warning_threshold_ppm. Thresholds come from the region's capacity policy.",
  );
export type InfraAlertKind = z.infer<typeof InfraAlertKind>;

const Ppm = z.number().int().min(0).max(1_000_000);
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
