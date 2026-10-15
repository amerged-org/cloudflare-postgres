// SPDX-License-Identifier: Apache-2.0
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import { cronErrorCode } from "./domain/cron-health.ts";
import { runCronWatchdog } from "./domain/infrastructure-alerts.ts";

export const CRON_WATCHDOG_INTERVAL_MS = 60_000;

/**
 * Checks the minute cron's heartbeat once a minute from a Durable Object alarm. An alarm is
 * scheduled by this object's own storage, not by the Worker's cron trigger, so it keeps firing when
 * the trigger is removed, the cron hangs or every step fails: the cron only arms it, and each
 * alarm schedules the next before it judges anything.
 */
export class CronWatchdog extends DurableObject<Env> {
  /** Idempotent: keeps the pending alarm and starts the chain when there is none. */
  async arm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + CRON_WATCHDOG_INTERVAL_MS);
  }
  override async alarm(): Promise<void> {
    // Scheduled first, so a failing or slow evaluation can never end the chain.
    await this.ctx.storage.setAlarm(Date.now() + CRON_WATCHDOG_INTERVAL_MS);
    try {
      await runCronWatchdog(this.env);
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Bounded: an unreachable object must not hold the steps of the run behind it.
    await Promise.race([
      env.CRON_WATCHDOG.get(env.CRON_WATCHDOG.idFromName("control")).arm(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("cron_watchdog_arm_timeout")),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "cron_watchdog_arm_failed",
        error_code: cronErrorCode(error),
      }),
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
