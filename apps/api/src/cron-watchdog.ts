// SPDX-License-Identifier: Apache-2.0
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import {
  controlProducerPaused,
  maintenanceEnvironment,
} from "./control-maintenance.ts";
import {
  cronErrorCode,
  cronErrorMessage,
  runWithin,
} from "./domain/cron-health.ts";

export const CRON_WATCHDOG_INTERVAL_MS = 60_000;
/** Time one evaluation may spend sending notifications; the rest wait for the next minute. */
export const ALERT_DELIVERY_BUDGET_MS = 20_000;
/** A phase of the evaluation that has not answered after this long is abandoned for this minute. */
export const ALERT_PHASE_TIMEOUT_MS = 30_000;

/** The parts of one evaluation, in the order they run; each has a failure boundary of its own. */
const PHASES = ["health_alerts", "capacity_alerts", "cron_watchdog"] as const;
export type AlertPhase = (typeof PHASES)[number];
export interface AlertEvaluation {
  failed: { phase: AlertPhase; error_code: string }[];
  phase_ms: Record<AlertPhase, number>;
}

/**
 * Evaluates every alert of every region once: the health alarms, the capacity alarms and the
 * judgement of the minute cron's heartbeat. A phase that throws, or does not answer within
 * `phaseTimeoutMs`, is logged (`alert_phase_failed`) and the phases after it still run, so that one
 * lost D1 request cannot hold back the alarms that do not need it. One line (`alert_evaluation`)
 * says how long each phase took and which failed: a line a minute is the proof that the alarms
 * are judged every minute. `watchdog_checked_at` records the start of the latest evaluation.
 */
export async function evaluateAlerts(
  env: Env,
  now = Date.now(),
  fetcher: typeof fetch = fetch,
  limits: { deliveryBudgetMs?: number; phaseTimeoutMs?: number } = {},
): Promise<AlertEvaluation> {
  const began = Date.now(),
    deliverBefore =
      began + (limits.deliveryBudgetMs ?? ALERT_DELIVERY_BUDGET_MS),
    timeout = limits.phaseTimeoutMs ?? ALERT_PHASE_TIMEOUT_MS;
  // The alert domain loads with the first evaluation, not with the object.
  const alerts = await import("./domain/infrastructure-alerts.ts");
  const runs: Record<AlertPhase, () => Promise<unknown>> = {
    health_alerts: () =>
      alerts.runInfrastructureHealthAlerts(env, now, fetcher, deliverBefore),
    capacity_alerts: () =>
      alerts.runCapacityAlertsCron(env, now, fetcher, deliverBefore),
    cron_watchdog: () => alerts.runCronWatchdog(env, now, fetcher),
  };
  const result: AlertEvaluation = {
    failed: [],
    phase_ms: { health_alerts: 0, capacity_alerts: 0, cron_watchdog: 0 },
  };
  for (const phase of PHASES) {
    const phaseBegan = Date.now();
    try {
      await runWithin(timeout, "alert_phase_timeout", runs[phase]);
    } catch (error) {
      const error_code = cronErrorCode(error);
      result.failed.push({ phase, error_code });
      console.error(
        JSON.stringify({
          event: "alert_phase_failed",
          phase,
          error_code,
          message: cronErrorMessage(error),
        }),
      );
    }
    result.phase_ms[phase] = Date.now() - phaseBegan;
  }
  try {
    await runWithin(timeout, "cron_heartbeat_timeout", () =>
      env.DB.prepare(
        "UPDATE cron_heartbeat SET watchdog_checked_at=? WHERE singleton=1",
      )
        .bind(new Date(began).toISOString())
        .run(),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "alert_evaluation_unrecorded",
        error_code: cronErrorCode(error),
      }),
    );
  }
  console.log(
    JSON.stringify({
      event: "alert_evaluation",
      duration_ms: Date.now() - began,
      phase_ms: result.phase_ms,
      failed: result.failed.map((value) => value.phase),
    }),
  );
  return result;
}

/**
 * The clock of the alerts: a Durable Object alarm once a minute that evaluates every alert
 * (`evaluateAlerts`), including its judgement of the minute cron's heartbeat. An alarm is
 * scheduled by this object's own storage, not by the Worker's cron trigger, so it keeps firing
 * when the trigger is removed or the platform does not start it, when a cron step hangs and when
 * every step fails: the cron only arms it, and each alarm schedules the next before it evaluates
 * anything. On 2026-10-23 no cron trigger was delivered on time from 14:41 to 14:54 and from
 * 16:03 to 16:21 UTC (two re-deliveries of the 14:27 and 14:28 triggers ran from about 16:06,
 * which the invocation analytics do not list), and this alarm fired in 435 of the 435 minutes from
 * 11:00 to 18:15.
 */
export class CronWatchdog extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, maintenanceEnvironment(env));
  }
  /** Idempotent: keeps the pending alarm and starts the chain when there is none. */
  async arm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + CRON_WATCHDOG_INTERVAL_MS);
  }
  override async alarm(): Promise<void> {
    // Scheduled first, so a failing or slow evaluation can never end the chain.
    await this.ctx.storage.setAlarm(Date.now() + CRON_WATCHDOG_INTERVAL_MS);
    if (controlProducerPaused(this.env, "cron_watchdog")) return;
    try {
      await evaluateAlerts(this.env);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "cron_watchdog_failed",
          error_code: cronErrorCode(error),
        }),
      );
    }
  }
}

/** Starts or keeps the watchdog's alarm chain; a missing binding or fault is logged, never fatal. */
export async function armCronWatchdog(
  env: Env,
  timeoutMs = 2000,
): Promise<void> {
  if (!env.CRON_WATCHDOG) {
    console.error(JSON.stringify({ event: "cron_watchdog_unavailable" }));
    return;
  }
  try {
    // Bounded: an unreachable object must not hold the steps of the run behind it.
    await runWithin(timeoutMs, "cron_watchdog_arm_timeout", () =>
      env.CRON_WATCHDOG.get(env.CRON_WATCHDOG.idFromName("control")).arm(),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "cron_watchdog_arm_failed",
        error_code: cronErrorCode(error),
      }),
    );
  }
}
