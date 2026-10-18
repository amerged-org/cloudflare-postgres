// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Timestamp, type InfraCronFailingStep } from "@pgcf/contracts";

/**
 * The minute cron's steps in execution order. Alerting needs only D1 and a bounded send, so it
 * leads; the daily backup dispatch follows, ahead of the steps that call out to other systems. No
 * more than 20 steps: an alert event lists at most that many failing steps (a payload of 20 at
 * their longest stays under D1's 4 KB check). Every step runs in its own failure boundary (see
 * runCron).
 */
export const CRON_STEPS = [
  "health_alerts",
  "capacity_alerts",
  "infrastructure_backup_dispatch",
  "admission_recovery",
  "node_fencing",
  "resource_profile_rollouts",
  "power_timeouts",
  "operation_timeouts",
  "role_deletion_timeouts",
  "idempotency_purge",
  "node_hints",
  "database_actors",
  "usage",
  "node_capacity",
  "retained_archives",
  "backup_retention",
] as const;
export type CronStep = (typeof CRON_STEPS)[number];
export interface CronStepFailure {
  step: CronStep;
  error_code: string;
}

/** No run completed for this long: the cron is stalled. */
export const CRON_STALL_MS = 5 * 60_000;
/** A step that failed in this many consecutive completed runs is failing. */
export const CRON_STEP_FAILURE_RUNS = 5;

const Counters = z.record(
  z.string(),
  z.strictObject({
    consecutive_failures: z.number().int().min(1).max(1_000_000),
    error_code: z.string().max(64).nullable(),
  }),
);
type Counters = z.infer<typeof Counters>;
function parseCounters(value: string | null | undefined): Counters {
  if (!value) return {};
  try {
    const parsed = Counters.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

const CODE = /^[a-z][a-z0-9_]{2,63}$/;

/**
 * A code that names a failure without carrying a message: the repository throws code-shaped
 * messages, so those pass through; everything else is reduced to a class so that SQL text, URLs and
 * provider bodies never reach a log line or an alert.
 */
export function cronErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "step_failed";
  // ApiError carries a snake_case `code`; runtime errors carry upper-case ones that do not pass.
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && CODE.test(code)) return code;
  if (CODE.test(error.message)) return error.message;
  if (error.message.startsWith("D1_ERROR")) return "d1_error";
  const name = error.name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .slice(0, 64);
  return CODE.test(name) && name !== "error" ? name : "step_failed";
}

/**
 * A thrown message for a log line only (alerts and the heartbeat carry the code): URLs and long
 * token-like runs are replaced and the text is bounded, so a provider error cannot leak a signed
 * URL or a credential into the log.
 */
export function cronErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .slice(0, 2000)
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/(?=[A-Za-z0-9+/_=-]*[A-Z0-9])[A-Za-z0-9+/_=-]{32,}/g, "<token>")
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

/** Marks the run as started and returns the failing-step counters of the previous completed run. */
export async function beginCronRun(
  db: D1Database,
  now: number,
): Promise<Counters> {
  const row = await db
    .prepare(
      "INSERT INTO cron_heartbeat(singleton,started_at) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET started_at=excluded.started_at RETURNING failing_steps_json",
    )
    .bind(new Date(now).toISOString())
    .first<{ failing_steps_json: string }>();
  return parseCounters(row?.failing_steps_json);
}

/** Records that every step was attempted, with each failing step's consecutive failed runs. */
export async function finishCronRun(
  db: D1Database,
  previous: Counters,
  failures: readonly CronStepFailure[],
  finishedAt: number,
): Promise<void> {
  const next: Counters = {};
  for (const failure of failures)
    next[failure.step] = {
      consecutive_failures: Math.min(
        (previous[failure.step]?.consecutive_failures ?? 0) + 1,
        1_000_000,
      ),
      error_code: failure.error_code.slice(0, 64),
    };
  await db
    .prepare(
      "UPDATE cron_heartbeat SET completed_at=?,failing_steps_json=? WHERE singleton=1",
    )
    .bind(new Date(finishedAt).toISOString(), JSON.stringify(next))
    .run();
}

export const CronHealth = z.strictObject({
  status: z
    .enum(["ok", "stalled", "failing", "unknown"])
    .describe(
      "ok: a run completed within the last 300 s and no step failed in each of its last 5 runs; stalled: no run completed for more than 300 s; failing: a step failed in each of its last 5 completed runs; unknown: the cron has not recorded a heartbeat yet.",
    ),
  last_started_at: Timestamp.nullable().describe(
    "Start of the latest run; a start long after last_completed_at means runs begin but do not finish.",
  ),
  last_completed_at: Timestamp.nullable().describe(
    "Latest run that attempted every step, whether or not steps failed.",
  ),
  watchdog_checked_at: Timestamp.nullable().describe(
    "Latest evaluation by the CronWatchdog Durable Object alarm, which runs independently of the cron trigger; null if it never ran.",
  ),
  failing_steps: z
    .array(
      z.strictObject({
        step: z.string(),
        consecutive_failures: z.number().int().min(1),
        error_code: z.string().nullable(),
      }),
    )
    .max(CRON_STEPS.length)
    .describe(
      "Steps that failed in the latest completed run, with the consecutive runs each has failed and its last error code.",
    ),
});
export type CronHealth = z.infer<typeof CronHealth>;

export async function readCronHealth(
  db: D1Database,
  now = Date.now(),
): Promise<CronHealth> {
  const row = await db
    .prepare(
      "SELECT started_at,completed_at,watchdog_checked_at,failing_steps_json FROM cron_heartbeat WHERE singleton=1",
    )
    .first<{
      started_at: string;
      completed_at: string | null;
      watchdog_checked_at: string | null;
      failing_steps_json: string;
    }>();
  if (!row)
    return {
      status: "unknown",
      last_started_at: null,
      last_completed_at: null,
      watchdog_checked_at: null,
      failing_steps: [],
    };
  const counters = parseCounters(row.failing_steps_json),
    failing_steps: InfraCronFailingStep[] = CRON_STEPS.filter(
      (step) => counters[step] !== undefined,
    ).map((step) => ({
      step,
      consecutive_failures: counters[step]!.consecutive_failures,
      error_code: counters[step]!.error_code,
    })),
    reference = Date.parse(row.completed_at ?? row.started_at);
  return {
    status:
      now - reference > CRON_STALL_MS
        ? "stalled"
        : failing_steps.some(
              (value) => value.consecutive_failures >= CRON_STEP_FAILURE_RUNS,
            )
          ? "failing"
          : "ok",
    last_started_at: row.started_at,
    last_completed_at: row.completed_at,
    watchdog_checked_at: row.watchdog_checked_at,
    failing_steps,
  };
}
