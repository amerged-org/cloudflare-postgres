// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Timestamp } from "./api.ts";
import { DatabaseId, NodeId, ProjectId, RegionId, SizeClassId } from "./ids.ts";

export const USAGE_HOUR_MS = 3_600_000;
export const USAGE_FINAL_DELAY_MS = 2 * USAGE_HOUR_MS;
const Count = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Integer = Count.int();
export const USAGE_METRICS = [
  "provisioned_seconds",
  "awake_seconds",
  "memory_mib_seconds",
  "cpu_millicore_seconds",
  "reserved_memory_mib_seconds",
  "reserved_cpu_millicore_seconds",
  "reserved_storage_byte_seconds",
  "storage_used_bytes_max",
  "storage_allocated_bytes",
  "backup_bytes_max",
  "ingress_bytes",
  "egress_bytes",
  "connections",
  "connection_seconds",
] as const;
export const UsageMetric = z.enum(USAGE_METRICS);
export type UsageMetric = z.infer<typeof UsageMetric>;
export const UsageGap = z.enum([
  ...USAGE_METRICS,
  "lifecycle",
  "resource_snapshot",
  "traffic_coverage",
  "rollup_pending",
]);
export type UsageGap = z.infer<typeof UsageGap>;
export const UsageMetrics = z.strictObject(
  Object.fromEntries(
    USAGE_METRICS.map((name) => [name, Count.nullable()]),
  ) as Record<UsageMetric, z.ZodNullable<typeof Count>>,
);
export type UsageMetrics = z.infer<typeof UsageMetrics>;
export const UsageRow = z
  .strictObject({
    database_id: DatabaseId,
    project_id: ProjectId,
    start: Timestamp,
    end: Timestamp,
    final: z.boolean(),
    metrics: UsageMetrics,
    gaps: z.array(UsageGap).max(USAGE_METRICS.length + 4),
  })
  .meta({ id: "UsageRow" });
export type UsageRow = z.infer<typeof UsageRow>;
const Cursor = z
  .string()
  .regex(/^[a-z][a-z0-9]{19}\|\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/);
export const UsageQuery = z
  .strictObject({
    project_id: ProjectId.optional(),
    database_id: DatabaseId.optional(),
    from: Timestamp,
    to: Timestamp,
    granularity: z.enum(["hour", "day"]),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: Cursor.optional(),
  })
  .superRefine((query, context) => {
    if ((query.project_id === undefined) === (query.database_id === undefined))
      context.addIssue({
        code: "custom",
        message: "Specify exactly one usage scope",
      });
    const start = Date.parse(query.from),
      end = Date.parse(query.to);
    const unit =
      query.granularity === "hour" ? USAGE_HOUR_MS : 24 * USAGE_HOUR_MS;
    if (
      end <= start ||
      end - start > 31 * 24 * USAGE_HOUR_MS ||
      start % unit !== 0 ||
      end % unit !== 0
    )
      context.addIssue({
        code: "custom",
        message: "Use aligned UTC boundaries and a range of at most 31 days",
      });
  })
  .meta({ id: "UsageQuery" });
export type UsageQuery = z.infer<typeof UsageQuery>;
export const UsageResponse = z
  .strictObject({
    data: z.array(UsageRow).max(100),
    next_cursor: Cursor.nullable(),
  })
  .meta({ id: "UsageResponse" });
export type UsageResponse = z.infer<typeof UsageResponse>;

export const UsageResourceSnapshot = z
  .strictObject({
    memory_mib: Integer,
    cpu_millicores: Integer,
    reserved_memory_mib: Integer,
    reserved_cpu_millicores: Integer,
    storage_allocated_bytes: Integer,
  })
  .meta({ id: "UsageResourceSnapshot" });
export type UsageResourceSnapshot = z.infer<typeof UsageResourceSnapshot>;
export const UsageLifecycleEvent = z.strictObject({
  database_id: DatabaseId,
  kind: z.enum([
    "created",
    "ready",
    "hibernated",
    "woke",
    "resized",
    "suspended",
    "deleted",
  ]),
  node_id: NodeId.nullable(),
  size_class_id: SizeClassId,
  generation: Integer.min(1),
  occurred_at: Timestamp,
  resources: UsageResourceSnapshot,
});
export type UsageLifecycleEvent = z.infer<typeof UsageLifecycleEvent>;

const Producer = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const SampleBase = {
  database_id: DatabaseId,
  producer_id: Producer,
  sequence: Integer,
  observed_at: Timestamp,
};
export const UsageSample = z
  .discriminatedUnion("source", [
    z.strictObject({
      ...SampleBase,
      source: z.literal("agent"),
      storage_used_bytes: Integer.nullable(),
      storage_allocated_bytes: Integer.nullable(),
    }),
    z.strictObject({
      ...SampleBase,
      source: z.literal("backup"),
      backup_bytes: Integer.nullable(),
    }),
    z.strictObject({
      ...SampleBase,
      source: z.literal("gateway"),
      interval_start: Timestamp,
      interval_end: Timestamp,
      expected_producers: z.array(Producer).min(1).max(16),
      ingress_bytes: Integer.nullable(),
      egress_bytes: Integer.nullable(),
      connections: Integer.nullable(),
      connection_seconds: Count.nullable(),
    }),
  ])
  .superRefine((sample, context) => {
    if (sample.source !== "gateway") return;
    const start = Date.parse(sample.interval_start),
      end = Date.parse(sample.interval_end);
    if (
      end <= start ||
      Math.floor(start / USAGE_HOUR_MS) !==
        Math.floor((end - 1) / USAGE_HOUR_MS) ||
      Date.parse(sample.observed_at) < end
    )
      context.addIssue({
        code: "custom",
        message:
          "Counter intervals must stay within one UTC hour and precede observation",
      });
    if (
      new Set(sample.expected_producers).size !==
        sample.expected_producers.length ||
      !sample.expected_producers.includes(sample.producer_id)
    )
      context.addIssue({
        code: "custom",
        message: "Expected producers must be unique and include this producer",
      });
  });
export type UsageSample = z.infer<typeof UsageSample>;
export const UsageRecorderPrincipal = z.strictObject({
  region_id: RegionId,
  source: z.enum(["agent", "gateway", "backup"]),
});
export type UsageRecorderPrincipal = z.infer<typeof UsageRecorderPrincipal>;
