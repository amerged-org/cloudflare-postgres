// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  jitterMs,
  nextCronTime,
  nextEveryTime,
  parseCron,
} from "../../src/domain/cron-expression.ts";

function next(expression: string, after: string): string | null {
  const parsed = parseCron(expression);
  if (!parsed.ok) throw new Error(parsed.reason);
  const found = nextCronTime(parsed.schedule, Date.parse(after));
  return found === null ? null : new Date(found).toISOString();
}

describe("cron expressions", () => {
  it("steps through */15 minutes", () => {
    expect(next("*/15 * * * *", "2026-10-30T10:07:00Z")).toBe(
      "2026-10-30T10:15:00.000Z",
    );
    expect(next("*/15 * * * *", "2026-10-30T10:15:00Z")).toBe(
      "2026-10-30T10:30:00.000Z",
    );
  });

  it("skips the weekend for 1-5 and resumes on Monday", () => {
    // 2026-10-30 is a Friday; the 09:00 slot that just passed is not returned.
    expect(next("0 9 * * 1-5", "2026-10-30T09:00:00Z")).toBe(
      "2026-11-02T09:00:00.000Z",
    );
  });

  it("finds the next leap day for 29 February", () => {
    expect(next("30 2 29 2 *", "2026-03-01T00:00:00Z")).toBe(
      "2028-02-29T02:30:00.000Z",
    );
  });

  it("matches the 13th or a Friday when both day fields are restricted", () => {
    // 2026-10-02 is a Friday, 2026-10-13 a Tuesday, 2026-10-16 a Friday.
    expect(next("0 0 13 * 5", "2026-10-01T00:00:00Z")).toBe(
      "2026-10-02T00:00:00.000Z",
    );
    expect(next("0 0 13 * 5", "2026-10-09T00:00:00Z")).toBe(
      "2026-10-13T00:00:00.000Z",
    );
    expect(next("0 0 13 * 5", "2026-10-13T00:00:00Z")).toBe(
      "2026-10-16T00:00:00.000Z",
    );
  });

  it("treats day-of-week 7 as Sunday", () => {
    expect(next("0 0 * * 7", "2026-10-30T00:00:00Z")).toBe(
      next("0 0 * * 0", "2026-10-30T00:00:00Z"),
    );
    expect(next("0 0 * * 7", "2026-10-30T00:00:00Z")).toBe(
      "2026-11-01T00:00:00.000Z",
    );
  });

  it("returns null for a day that never occurs", () => {
    expect(next("0 0 31 2 *", "2026-10-30T00:00:00Z")).toBeNull();
  });

  it("accepts month and day names in any case", () => {
    expect(next("0 0 1 JAN,jul *", "2026-10-30T00:00:00Z")).toBe(
      "2027-01-01T00:00:00.000Z",
    );
    expect(next("0 0 * * MON", "2026-10-30T00:00:00Z")).toBe(
      "2026-11-02T00:00:00.000Z",
    );
  });

  it("refuses malformed, unsupported and out-of-range expressions", () => {
    for (const expression of [
      "* * * *",
      "60 * * * *",
      "*/0 * * * *",
      "5-1 * * * *",
      "@daily",
      "? * * * *",
      "0 0 L * *",
      "0 0 15W * *",
      "0 0 * * 5#2",
      "* * * * * *",
      "1,,2 * * * *",
      "0 0 0 * *",
      "*/60 * * * *",
      "* */24 * * *",
      "* * * * */8",
      "* 24 * * *",
      "* * * 13 *",
      "* * * 0 *",
      "* * * * 8",
    ])
      expect(parseCron(expression).ok, expression).toBe(false);
  });

  it("accepts a step equal to the field maximum", () => {
    expect(parseCron("*/59 * * * *").ok).toBe(true);
  });

  it("matches comma lists with every item, not only the first", () => {
    expect(next("0,30 8,17 * * *", "2026-10-30T08:30:00Z")).toBe(
      "2026-10-30T17:00:00.000Z",
    );
  });

  it("treats a field starting with * as unrestricted under the Vixie rule", () => {
    // The 2nd and 16th are Fridays on even days, so the first odd-day Friday is the 9th.
    expect(next("0 0 */2 * 5", "2026-10-01T00:00:00Z")).toBe(
      "2026-10-09T00:00:00.000Z",
    );
    // Day-of-week */2 covers Sun, Tue, Thu and Sat; 1 October is a Thursday, so OR would fire too early.
    expect(next("0 0 13 * */2", "2026-10-01T00:00:00Z")).toBe(
      "2026-10-13T00:00:00.000Z",
    );
  });

  it("accepts a name as a range endpoint", () => {
    // 2026-10-30 is a Friday; the following Monday is 2 November.
    expect(next("0 0 * * MON-FRI", "2026-10-30T00:00:00Z")).toBe(
      "2026-11-02T00:00:00.000Z",
    );
  });

  it("ignores surrounding and repeated whitespace, including tabs", () => {
    expect(next("  */15\t*  * * *  ", "2026-10-30T10:07:00Z")).toBe(
      "2026-10-30T10:15:00.000Z",
    );
  });

  it("steps a range from its start value", () => {
    expect(next("5-30/10 * * * *", "2026-10-30T10:00:00Z")).toBe(
      "2026-10-30T10:05:00.000Z",
    );
    expect(next("5-30/10 * * * *", "2026-10-30T10:25:00Z")).toBe(
      "2026-10-30T11:05:00.000Z",
    );
  });

  it("resolves every month and day name", () => {
    expect(next("0 0 1 AUG *", "2026-10-30T00:00:00Z")).toBe(
      "2027-08-01T00:00:00.000Z",
    );
    expect(next("0 0 * * FRI", "2026-10-30T00:00:00Z")).toBe(
      "2026-11-06T00:00:00.000Z",
    );
  });

  it("searches at most five years ahead", () => {
    // 2100 is not a leap year, so the next 29 February after 2096 is in 2104, beyond five years.
    expect(next("0 0 29 2 *", "2096-03-01T00:00:00Z")).toBeNull();
    // 29 February 2104 is inside the five-year window from March 2099.
    expect(next("0 0 29 2 *", "2099-03-01T00:00:00Z")).toBe(
      "2104-02-29T00:00:00.000Z",
    );
  });

  it("never returns a match before the instant it is asked from", () => {
    // Exactly on a matching minute, the next match is the following one.
    expect(next("*/5 * * * *", "2026-10-30T10:05:00Z")).toBe(
      "2026-10-30T10:10:00.000Z",
    );
    // Inside a minute, the rest of that minute is not a match.
    expect(next("*/5 * * * *", "2026-10-30T10:05:30Z")).toBe(
      "2026-10-30T10:10:00.000Z",
    );
  });
});

describe("interval schedules", () => {
  const anchor = Date.parse("2026-10-30T00:00:00Z");

  it("returns the first anchor step strictly after the instant", () => {
    expect(nextEveryTime(3600, anchor, anchor - 1)).toBe(anchor);
    expect(nextEveryTime(3600, anchor, anchor)).toBe(anchor + 3_600_000);
    expect(nextEveryTime(3600, anchor, anchor + 1_000)).toBe(
      anchor + 3_600_000,
    );
  });

  it("returns the first step strictly after an instant several steps later", () => {
    const hour = 3_600_000;
    expect(nextEveryTime(3600, anchor, anchor + 5.5 * hour)).toBe(
      anchor + 6 * hour,
    );
    // An exact multiple of the step is excluded, as the next step is strictly later.
    expect(nextEveryTime(3600, anchor, anchor + 5 * hour)).toBe(
      anchor + 6 * hour,
    );
    expect(nextEveryTime(86400, anchor, anchor + 1000 * 86_400_000 + 1)).toBe(
      anchor + 1001 * 86_400_000,
    );
  });

  it("returns the anchor for any instant before it", () => {
    expect(nextEveryTime(3600, anchor, anchor - 10 * 3_600_000)).toBe(anchor);
  });

  it("returns promptly for a far-past anchor and an instant near zero", () => {
    // -1e22 is a finite integer; the grid of 60 s steps from it first passes zero at 20 000 ms.
    expect(nextEveryTime(60, -1e22, 0)).toBe(20_000);
  });

  it("rejects non-finite instants instead of looping", () => {
    expect(() => nextEveryTime(60, 0, Number.POSITIVE_INFINITY)).toThrow(
      RangeError,
    );
    expect(() => nextEveryTime(60, 0, Number.NaN)).toThrow(RangeError);
  });

  it("rejects intervals under a minute and non-integer anchors", () => {
    expect(() => nextEveryTime(59, anchor, anchor)).toThrow(RangeError);
    expect(() => nextEveryTime(60.5, anchor, anchor)).toThrow(RangeError);
    expect(() => nextEveryTime(60, Number.NaN, anchor)).toThrow(RangeError);
    expect(() => nextEveryTime(60, Number.POSITIVE_INFINITY, anchor)).toThrow(
      RangeError,
    );
  });
});

describe("jitter", () => {
  it("is deterministic, stays in its window and differs between schedules", () => {
    const value = jitterMs("db_a", "sched", 3_600_000);
    expect(value).toBe(jitterMs("db_a", "sched", 3_600_000));
    expect(value).toBe(19_828);
    expect(jitterMs("db_b", "sched", 3_600_000)).toBe(49_009);
    expect(jitterMs("db_a", "other", 3_600_000)).toBe(4_217);
    // A one-minute interval spreads over a quarter of it.
    expect(jitterMs("db_a", "sched", 60_000)).toBe(4_828);
  });

  it("hashes the UTF-8 bytes of non-ASCII names", () => {
    expect(jitterMs("dätä_é€😀", "s", 3_600_000)).toBe(42_976);
    expect(jitterMs("db", "näme", 3_600_000)).toBe(42_724);
  });

  it("rejects intervals under a minute", () => {
    expect(() => jitterMs("db_a", "sched", 59_999)).toThrow(RangeError);
    expect(() => jitterMs("db_a", "sched", 60_000.5)).toThrow(RangeError);
  });
});
