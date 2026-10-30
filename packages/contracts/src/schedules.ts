// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Timestamp } from "./api.ts";
import { RoleName } from "./ids.ts";

export const SCHEDULE_MAX_PER_DATABASE = 20;
export const SCHEDULE_MIN_EVERY_SECONDS = 60;
export const SCHEDULE_MAX_EVERY_SECONDS = 31 * 86_400;
export const SCHEDULE_DEFAULT_TIMEOUT_MS = 60_000;
export const SCHEDULE_MAX_STATEMENTS = 20;
export const SCHEDULE_STATEMENT_MAX_BYTES = 16 * 1024;
export const SCHEDULE_STATEMENTS_MAX_BYTES = 64 * 1024;

export const ScheduleName = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,62}$/)
  .meta({ id: "ScheduleName" });
export type ScheduleName = z.infer<typeof ScheduleName>;

const Statement = z
  .string()
  .min(1)
  .max(SCHEDULE_STATEMENT_MAX_BYTES)
  .refine((text) => text.trim().length > 0, "empty statement");

/** The run statements are one transaction sent through the Edge's `/sql`, so one per element. */
export const ScheduleUpsert = z
  .strictObject({
    cron: z.string().min(9).max(120).optional(),
    every_seconds: z
      .number()
      .int()
      .min(SCHEDULE_MIN_EVERY_SECONDS)
      .max(SCHEDULE_MAX_EVERY_SECONDS)
      .optional(),
    statements: z.array(Statement).min(1).max(SCHEDULE_MAX_STATEMENTS),
    role: RoleName,
    timeout_ms: z.number().int().min(1_000).max(900_000).optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (body) => (body.cron === undefined) !== (body.every_seconds === undefined),
    {
      message: "Give exactly one of cron and every_seconds",
    },
  )
  .refine(
    (body) =>
      new TextEncoder().encode(body.statements.join("")).length <=
      SCHEDULE_STATEMENTS_MAX_BYTES,
    { message: "The statements are too long together" },
  )
  .meta({ id: "ScheduleUpsert" });
export type ScheduleUpsert = z.infer<typeof ScheduleUpsert>;

export const Schedule = z
  .strictObject({
    name: ScheduleName,
    cron: z.string().nullable(),
    every_seconds: z.number().int().nullable(),
    statements: z.array(z.string()),
    role: RoleName,
    timeout_ms: z.number().int(),
    enabled: z.boolean(),
    next_run_at: Timestamp.nullable(),
    created_at: Timestamp,
  })
  .meta({ id: "Schedule" });
export type Schedule = z.infer<typeof Schedule>;

export const SCHEDULE_OUTCOMES = [
  "succeeded",
  "failed",
  "timed_out",
  "outcome_unknown",
  "rejected",
  "skipped_capacity",
  "skipped_suspended",
  "skipped_deleted",
  "skipped_missed",
] as const;
export const ScheduleRun = z
  .strictObject({
    id: z.number().int(),
    schedule: ScheduleName,
    scheduled_at: Timestamp,
    started_at: Timestamp.nullable(),
    finished_at: Timestamp,
    outcome: z.enum(SCHEDULE_OUTCOMES),
    sqlstate: z.string().nullable(),
    attempts: z.number().int(),
    manual: z.boolean(),
  })
  .meta({ id: "ScheduleRun" });
export type ScheduleRun = z.infer<typeof ScheduleRun>;

export const ScheduleRunAccepted = z
  .strictObject({ schedule: ScheduleName, state: z.literal("queued") })
  .meta({ id: "ScheduleRunAccepted" });
export type ScheduleRunAccepted = z.infer<typeof ScheduleRunAccepted>;
