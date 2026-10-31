// SPDX-License-Identifier: Apache-2.0
export const MIN_SCHEDULE_INTERVAL_SECONDS = 60;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const SEARCH_YEARS = 5;

export interface CronSchedule {
  readonly minutes: readonly boolean[];
  readonly hours: readonly boolean[];
  readonly daysOfMonth: readonly boolean[];
  readonly months: readonly boolean[];
  /** Sunday is index 0; the value 7 is folded into 0 while parsing. */
  readonly daysOfWeek: readonly boolean[];
  readonly dayOfMonthStar: boolean;
  readonly dayOfWeekStar: boolean;
}

interface CronField {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly names?: Readonly<Record<string, number>>;
}

const MONTH_NAMES: Readonly<Record<string, number>> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};
const DAY_NAMES: Readonly<Record<string, number>> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

const FIELDS: readonly CronField[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES },
  { name: "day-of-week", min: 0, max: 7, names: DAY_NAMES },
];

type FieldValues =
  { ok: true; values: number[] } | { ok: false; reason: string };

function parseValue(token: string, field: CronField): number | null {
  const upper = token.toUpperCase();
  if (/^\d+$/.test(upper)) return Number(upper);
  if (field.names && Object.hasOwn(field.names, upper))
    return field.names[upper] ?? null;
  return null;
}

function parseField(text: string, field: CronField): FieldValues {
  const values: number[] = [];
  for (const item of text.split(",")) {
    const [base, step, extra] = item.split("/");
    if (base === undefined || base === "" || extra !== undefined)
      return { ok: false, reason: `invalid ${field.name} field "${text}"` };
    let stride = 1;
    if (step !== undefined) {
      if (!/^\d+$/.test(step) || Number(step) < 1 || Number(step) > field.max)
        return { ok: false, reason: `invalid ${field.name} step "${step}"` };
      stride = Number(step);
    }
    let low: number, high: number;
    if (base === "*") {
      low = field.min;
      high = field.max;
    } else if (base.includes("-")) {
      const [from, to, more] = base.split("-");
      const start = from === undefined ? null : parseValue(from, field);
      const end = to === undefined ? null : parseValue(to, field);
      if (more !== undefined || start === null || end === null || start > end)
        return { ok: false, reason: `invalid ${field.name} range "${base}"` };
      low = start;
      high = end;
    } else {
      if (step !== undefined)
        return {
          ok: false,
          reason: `a step in the ${field.name} field needs * or a range`,
        };
      const value = parseValue(base, field);
      if (value === null)
        return {
          ok: false,
          reason: `invalid ${field.name} value "${base}"`,
        };
      low = value;
      high = value;
    }
    if (low < field.min || high > field.max)
      return {
        ok: false,
        reason: `${field.name} value out of range ${field.min}-${field.max}`,
      };
    for (let value = low; value <= high; value += stride) values.push(value);
  }
  return { ok: true, values };
}

/** Parses a five-field UTC cron expression. Never throws. */
export function parseCron(
  expression: string,
): { ok: true; schedule: CronSchedule } | { ok: false; reason: string } {
  const trimmed = expression.trim();
  if (trimmed.startsWith("@"))
    return {
      ok: false,
      reason: "cron macros such as @daily are not supported",
    };
  const texts = trimmed.split(/\s+/);
  if (texts.length !== 5)
    return { ok: false, reason: "a cron expression has exactly five fields" };
  const parsed: number[][] = [];
  for (const [index, field] of FIELDS.entries()) {
    const text = texts[index] ?? "";
    const result = parseField(text, field);
    if (!result.ok) return result;
    parsed.push(result.values);
  }
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parsed as [
    number[],
    number[],
    number[],
    number[],
    number[],
  ];
  const flags = (size: number, values: number[], fold = false) => {
    const list = new Array<boolean>(size).fill(false);
    for (const value of values) list[fold && value === 7 ? 0 : value] = true;
    return list;
  };
  return {
    ok: true,
    schedule: {
      minutes: flags(60, minutes),
      hours: flags(24, hours),
      daysOfMonth: flags(32, daysOfMonth),
      months: flags(13, months),
      daysOfWeek: flags(7, daysOfWeek, true),
      dayOfMonthStar: texts[2]!.startsWith("*"),
      dayOfWeekStar: texts[4]!.startsWith("*"),
    },
  };
}

function dayMatches(schedule: CronSchedule, day: number): boolean {
  const date = new Date(day);
  if (schedule.months[date.getUTCMonth() + 1] !== true) return false;
  const dayOfMonth = schedule.daysOfMonth[date.getUTCDate()] === true;
  const dayOfWeek = schedule.daysOfWeek[date.getUTCDay()] === true;
  // Vixie cron: a field that starts with * does not restrict the day on its own.
  return schedule.dayOfMonthStar || schedule.dayOfWeekStar
    ? dayOfMonth && dayOfWeek
    : dayOfMonth || dayOfWeek;
}

/** The first matching UTC minute strictly after `afterMs`, or null within five years. */
export function nextCronTime(
  schedule: CronSchedule,
  afterMs: number,
): number | null {
  const first = (Math.floor(afterMs / MINUTE_MS) + 1) * MINUTE_MS;
  const start = new Date(first);
  const limit = Date.UTC(
    start.getUTCFullYear() + SEARCH_YEARS,
    start.getUTCMonth(),
    start.getUTCDate(),
    start.getUTCHours(),
    start.getUTCMinutes(),
  );
  const startDay = Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate(),
  );
  for (let day = startDay; day <= limit; day += DAY_MS) {
    if (!dayMatches(schedule, day)) continue;
    for (let hour = 0; hour < 24; hour++) {
      if (schedule.hours[hour] !== true) continue;
      for (let minute = 0; minute < 60; minute++) {
        if (schedule.minutes[minute] !== true) continue;
        const at = day + hour * HOUR_MS + minute * MINUTE_MS;
        if (at < first) continue;
        return at > limit ? null : at;
      }
    }
  }
  return null;
}

/** The first anchor + k * everySeconds (k >= 0) strictly after `afterMs`. */
export function nextEveryTime(
  everySeconds: number,
  anchorMs: number,
  afterMs: number,
): number {
  if (
    !Number.isInteger(everySeconds) ||
    everySeconds < MIN_SCHEDULE_INTERVAL_SECONDS
  )
    throw new RangeError("Interval must be an integer of at least 60 seconds");
  if (!Number.isInteger(anchorMs))
    throw new RangeError("Interval anchor must be a finite integer");
  if (!Number.isFinite(afterMs))
    throw new RangeError("Interval query instant must be finite");
  // Exact BigInt arithmetic: float division is inexact beyond 2^53 and cannot be corrected by stepping.
  const step = BigInt(everySeconds) * BigInt(1000);
  const anchor = BigInt(anchorMs);
  const after = BigInt(Math.floor(afterMs));
  if (after < anchor) return anchorMs;
  return Number(anchor + ((after - anchor) / step + BigInt(1)) * step);
}

/** A deterministic offset in [0, window) so databases sharing a schedule do not fire together. */
export function jitterMs(
  databaseId: string,
  scheduleName: string,
  intervalMs: number,
): number {
  if (
    !Number.isInteger(intervalMs) ||
    intervalMs < MIN_SCHEDULE_INTERVAL_SECONDS * 1000
  )
    throw new RangeError(
      "Jitter needs an integer interval of at least 60000 ms",
    );
  const window = Math.min(Math.floor(intervalMs / 4), 60_000);
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(`${databaseId}|${scheduleName}`))
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash % window;
}
