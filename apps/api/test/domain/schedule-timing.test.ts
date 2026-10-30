// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  capacityBackoffMs,
  fireTime,
  intervalAfter,
  lateLimitMs,
  nextOccurrence,
  type TimingSpec,
} from "../../src/domain/schedule-timing.ts";

const HOURLY: TimingSpec = {
  cron: "0 * * * *",
  everySeconds: null,
  anchorMs: 0,
};
const T = Date.UTC(2026, 9, 30, 12, 30, 0);

describe("schedule timing", () => {
  it("finds the next cron instant and the next interval instant", () => {
    expect(nextOccurrence(HOURLY, T)).toBe(Date.UTC(2026, 9, 30, 13, 0, 0));
    const every: TimingSpec = { cron: null, everySeconds: 300, anchorMs: T };
    expect(nextOccurrence(every, T)).toBe(T + 300_000);
    expect(nextOccurrence(every, T + 299_999)).toBe(T + 300_000);
    expect(
      nextOccurrence({ cron: "nonsense", everySeconds: null, anchorMs: 0 }, T),
    ).toBeNull();
  });

  it("measures the interval to the following occurrence", () => {
    expect(intervalAfter(HOURLY, Date.UTC(2026, 9, 30, 13, 0, 0))).toBe(
      3_600_000,
    );
    const monthly: TimingSpec = {
      cron: "0 0 1 * *",
      everySeconds: null,
      anchorMs: 0,
    };
    expect(intervalAfter(monthly, Date.UTC(2026, 9, 1))).toBe(31 * 86_400_000);
  });

  it("spreads databases inside a quarter of the interval, at most a minute", () => {
    const hour = Date.UTC(2026, 9, 30, 13, 0, 0);
    const offsets = new Set<number>();
    for (let i = 0; i < 50; i += 1) {
      const fire = fireTime(
        HOURLY,
        `database${i}`.padEnd(20, "x"),
        "job",
        hour,
      );
      expect(fire).toBeGreaterThanOrEqual(hour);
      expect(fire).toBeLessThan(hour + 60_000);
      offsets.add(fire - hour);
    }
    expect(offsets.size).toBeGreaterThan(20);
    expect(fireTime(HOURLY, "a".repeat(20), "job", hour)).toBe(
      fireTime(HOURLY, "a".repeat(20), "job", hour),
    );
    const minutely: TimingSpec = {
      cron: "* * * * *",
      everySeconds: null,
      anchorMs: 0,
    };
    expect(fireTime(minutely, "a".repeat(20), "job", hour) - hour).toBeLessThan(
      15_000,
    );
  });

  it("gives up late runs after half an interval but never more than ten minutes", () => {
    expect(lateLimitMs(60_000)).toBe(30_000);
    expect(lateLimitMs(3_600_000)).toBe(600_000);
  });

  it("doubles the refusal backoff from 30 seconds to 5 minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(capacityBackoffMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000,
    ]);
  });
});
