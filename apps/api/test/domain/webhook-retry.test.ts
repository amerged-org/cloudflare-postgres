// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  decideRetry,
  parseRetryAfter,
} from "../../src/domain/webhook-retry.ts";

const NOW = 1_800_000_000_000;

function attempt(
  attempts: number,
  status: number | null,
  retryAfterSeconds: number | null = null,
  createdAtMs = NOW,
) {
  return decideRetry({
    attempts,
    nowMs: NOW,
    createdAtMs,
    status,
    retryAfterSeconds,
  });
}

describe("decideRetry", () => {
  it("retries the first failed attempt after one minute", () => {
    expect(attempt(1, 500)).toEqual({ state: "retry", at: NOW + 60_000 });
  });

  it("walks the delay table and keeps the 12 hour delay from the sixth attempt on", () => {
    [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000].forEach((ms, i) => {
      expect(attempt(i + 1, 500)).toEqual({ state: "retry", at: NOW + ms });
    });
    expect(attempt(6, 500)).toEqual({
      state: "retry",
      at: NOW + 43_200_000,
    });
    expect(attempt(9, 500)).toEqual({
      state: "retry",
      at: NOW + 43_200_000,
    });
  });

  it("lets a receiver ask for more time than the schedule gives, never for less", () => {
    // The first delay of the schedule is a minute: Retry-After 0 or 5 s does not shorten it.
    expect(attempt(1, 429, 0)).toEqual({ state: "retry", at: NOW + 60_000 });
    expect(attempt(1, 429, 5)).toEqual({ state: "retry", at: NOW + 60_000 });
    expect(attempt(1, 429, 600)).toEqual({ state: "retry", at: NOW + 600_000 });
    expect(attempt(1, 503, 99_999)).toEqual({
      state: "retry",
      at: NOW + 3_600_000,
    });
  });

  it("treats 404 and 410 as permanent", () => {
    expect(attempt(1, 404)).toEqual({
      state: "dead_letter",
      reason: "permanent",
    });
    expect(attempt(1, 410)).toEqual({
      state: "dead_letter",
      reason: "permanent",
    });
  });

  it("retries 408, 429, 500, 503 and a missing response", () => {
    for (const status of [408, 429, 500, 503, null]) {
      expect(attempt(1, status).state).toBe("retry");
    }
  });

  it("expires a retry that would land beyond 24 hours after creation", () => {
    // The retry lands at NOW + 60 s; the 24 h window closes exactly at createdAt + 24 h.
    expect(attempt(1, 500, null, NOW - 86_400_000 + 60_000)).toEqual({
      state: "retry",
      at: NOW + 60_000,
    });
    expect(attempt(1, 500, null, NOW - 86_400_000 + 59_999)).toEqual({
      state: "dead_letter",
      reason: "expired",
    });
  });

  it("rejects an attempt count below one", () => {
    expect(() => attempt(0, 500)).toThrow(RangeError);
    expect(() => attempt(1.5, 500)).toThrow(RangeError);
  });
});

describe("parseRetryAfter", () => {
  it("reads delta-seconds and rejects anything else", () => {
    expect(parseRetryAfter("120", NOW)).toBe(120);
    expect(parseRetryAfter("0", NOW)).toBe(0);
    expect(parseRetryAfter("abc", NOW)).toBeNull();
    expect(parseRetryAfter("-5", NOW)).toBeNull();
    expect(parseRetryAfter("1e3", NOW)).toBeNull();
    expect(parseRetryAfter(null, NOW)).toBeNull();
  });

  it("counts an HTTP-date from now and never below zero", () => {
    const ninetyAhead = new Date(NOW + 90_000).toUTCString();
    const past = new Date(NOW - 90_000).toUTCString();
    expect(parseRetryAfter(ninetyAhead, NOW)).toBe(90);
    expect(parseRetryAfter(past, NOW)).toBe(0);
  });

  it("reads the RFC 850 and asctime HTTP-date forms", () => {
    expect(parseRetryAfter("Sunday, 06-Nov-94 08:49:37 GMT", NOW)).toBe(0);
    expect(parseRetryAfter("Sun Nov  6 08:49:37 1994", NOW)).toBe(0);
  });

  it("rejects text that only contains a month, weekday or number run", () => {
    expect(parseRetryAfter("abc 5", NOW)).toBeNull();
    expect(parseRetryAfter("Retry 12", NOW)).toBeNull();
    expect(parseRetryAfter("12 March", NOW)).toBeNull();
    expect(parseRetryAfter("Tue 2099", NOW)).toBeNull();
  });
});
