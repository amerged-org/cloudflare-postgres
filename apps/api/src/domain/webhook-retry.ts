// SPDX-License-Identifier: Apache-2.0

export const WEBHOOK_RETRY_DELAYS_MS = [
  60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000,
] as const;
export const WEBHOOK_MAX_AGE_MS = 86_400_000;
export const WEBHOOK_RETRY_AFTER_CAP_MS = 3_600_000;
export const WEBHOOK_ATTEMPT_TIMEOUT_MS = 5_000;

export type RetryDecision =
  | { state: "retry"; at: number }
  | { state: "dead_letter"; reason: "expired" | "permanent" };

/** Client errors that a receiver rejects for good; 408, 425 and 429 ask for another try. */
function isPermanentStatus(status: number | null): boolean {
  return (
    status !== null &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 425 &&
    status !== 429
  );
}

/** The table delay for an attempt; attempts past the table keep the last delay. */
function scheduledDelayMs(attempts: number): number {
  const last = WEBHOOK_RETRY_DELAYS_MS.length - 1;
  return WEBHOOK_RETRY_DELAYS_MS[Math.min(attempts - 1, last)] ?? 0;
}

export function decideRetry(input: {
  attempts: number;
  nowMs: number;
  createdAtMs: number;
  status: number | null;
  retryAfterSeconds: number | null;
}): RetryDecision {
  if (!Number.isInteger(input.attempts) || input.attempts < 1) {
    throw new RangeError("attempts must be an integer of at least 1");
  }
  if (isPermanentStatus(input.status)) {
    return { state: "dead_letter", reason: "permanent" };
  }
  const requested = input.retryAfterSeconds;
  const scheduled = scheduledDelayMs(input.attempts);
  // A receiver may ask for more time, never for less than the schedule gives: Retry-After 0 or 1
  // would otherwise be one attempt a second for a day.
  const delay =
    typeof requested === "number" &&
    Number.isFinite(requested) &&
    requested >= 0
      ? Math.max(
          scheduled,
          Math.min(requested * 1000, WEBHOOK_RETRY_AFTER_CAP_MS),
        )
      : scheduled;
  const at = input.nowMs + delay;
  if (at - input.createdAtMs > WEBHOOK_MAX_AGE_MS) {
    return { state: "dead_letter", reason: "expired" };
  }
  return { state: "retry", at };
}

/**
 * Seconds in a Retry-After header: delta-seconds, or an HTTP-date counted from `nowMs`.
 * Date.parse is lenient and reads text such as "abc 5" or "Tue 2099", so an HTTP-date must
 * also carry an hh:mm:ss time, which all three HTTP-date forms contain.
 */
export function parseRetryAfter(
  header: string | null,
  nowMs: number,
): number | null {
  if (header === null) {
    return null;
  }
  if (/^\d{1,9}$/.test(header)) {
    return Number(header);
  }
  if (!/[A-Za-z]{3}/.test(header) || !/\b\d{1,2}:\d{2}:\d{2}\b/.test(header)) {
    return null;
  }
  const at = Date.parse(header);
  if (Number.isNaN(at)) {
    return null;
  }
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}
