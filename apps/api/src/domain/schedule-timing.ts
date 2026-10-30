// SPDX-License-Identifier: Apache-2.0
import {
  jitterMs,
  nextCronTime,
  nextEveryTime,
  parseCron,
} from "./cron-expression.ts";

/** What fixes the times of a schedule: a cron expression or a fixed interval from an anchor. */
export interface TimingSpec {
  cron: string | null;
  everySeconds: number | null;
  anchorMs: number;
}

/** The first scheduled instant strictly after `afterMs`, or null when none exists. */
export function nextOccurrence(
  spec: TimingSpec,
  afterMs: number,
): number | null {
  if (spec.everySeconds !== null)
    return nextEveryTime(spec.everySeconds, spec.anchorMs, afterMs);
  const parsed = parseCron(spec.cron ?? "");
  return parsed.ok ? nextCronTime(parsed.schedule, afterMs) : null;
}

/**
 * The gap between an occurrence and the one after it; at least a minute. It sizes the jitter and
 * the time after which a late or refused run is given up.
 */
export function intervalAfter(spec: TimingSpec, occurrenceMs: number): number {
  const following = nextOccurrence(spec, occurrenceMs);
  return following === null
    ? 86_400_000
    : Math.max(60_000, following - occurrenceMs);
}

/** When the occurrence is tried: its instant plus the schedule's own deterministic offset. */
export function fireTime(
  spec: TimingSpec,
  databaseId: string,
  name: string,
  occurrenceMs: number,
): number {
  return (
    occurrenceMs + jitterMs(databaseId, name, intervalAfter(spec, occurrenceMs))
  );
}

/** How long past its fire time an occurrence may still start; later ones are skipped. */
export function lateLimitMs(intervalMs: number): number {
  return Math.min(Math.floor(intervalMs / 2), 600_000);
}

/** The delay before a refused run is tried again when the node named none. */
export function capacityBackoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 300_000);
}
