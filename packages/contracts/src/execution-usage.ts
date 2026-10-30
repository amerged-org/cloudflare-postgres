// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Timestamp } from "./api.ts";
import { DatabaseId, ProjectId } from "./ids.ts";
import { USAGE_FINAL_DELAY_MS, USAGE_HOUR_MS } from "./usage.ts";

export { USAGE_FINAL_DELAY_MS, USAGE_HOUR_MS };

export const EXECUTION_METRICS = [
  "schedule_runs_succeeded",
  "schedule_runs_failed",
  "schedule_runs_timed_out",
  "schedule_runs_outcome_unknown",
  "schedule_runs_rejected",
  "schedule_runs_skipped",
  "events_emitted",
  "event_bytes",
  "webhook_attempts",
  "webhook_deliveries_delivered",
  "webhook_deliveries_dead_lettered",
] as const;
export const ExecutionMetric = z.enum(EXECUTION_METRICS);
export type ExecutionMetric = z.infer<typeof ExecutionMetric>;

const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ExecutionMetrics = z.strictObject(
  Object.fromEntries(EXECUTION_METRICS.map((name) => [name, Count])) as Record<
    ExecutionMetric,
    typeof Count
  >,
);
export type ExecutionMetrics = z.infer<typeof ExecutionMetrics>;

export const ExecutionUsageRow = z
  .strictObject({
    database_id: DatabaseId,
    project_id: ProjectId,
    start: Timestamp,
    end: Timestamp,
    final: z.boolean(),
    metrics: ExecutionMetrics,
  })
  .meta({ id: "ExecutionUsageRow" });
export type ExecutionUsageRow = z.infer<typeof ExecutionUsageRow>;

const Cursor = z
  .string()
  .regex(/^[a-z][a-z0-9]{19}\|\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/);
export const ExecutionUsageQuery = z
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
  .meta({ id: "ExecutionUsageQuery" });
export type ExecutionUsageQuery = z.infer<typeof ExecutionUsageQuery>;
export const ExecutionUsageResponse = z
  .strictObject({
    data: z.array(ExecutionUsageRow).max(100),
    next_cursor: Cursor.nullable(),
  })
  .meta({ id: "ExecutionUsageResponse" });
export type ExecutionUsageResponse = z.infer<typeof ExecutionUsageResponse>;
