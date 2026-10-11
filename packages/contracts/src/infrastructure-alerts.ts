// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Timestamp } from "./api.ts";
import { RegionId, NodeId } from "./ids.ts";

export const InfraAlertKind = z.enum([
  "regional_ram_warning",
  "regional_node_cap_reached",
  "regional_node_stale",
  "infrastructure_backup_failed",
  "infrastructure_backup_stale",
  "regional_node_ram_warning",
  "regional_node_cpu_warning",
  "regional_node_storage_warning",
]);
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
  active: z.boolean(),
  event_id: z.uuid().nullable(),
  occurred_at: Timestamp.nullable(),
  delivered_at: Timestamp.nullable(),
  last_attempt_at: Timestamp.nullable(),
});
export type InfraAlertStatus = z.infer<typeof InfraAlertStatus>;
