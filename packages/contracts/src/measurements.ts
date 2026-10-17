// SPDX-License-Identifier: Apache-2.0
import type { GatewayActivityReport } from "./gateway-activity.ts";
import { UsageSample, USAGE_HOUR_MS } from "./usage.ts";

export const MEASUREMENT_COHORT = 25,
  MEASUREMENT_BODY_BYTES = 64 * 1024;
export const MEASUREMENT_INTERVAL_MS = 15_000;
export const MEASUREMENT_CHECKPOINT_BYTES = 48 * 1024,
  MEASUREMENT_MAX_OUTBOX = 64;
export const producer = (report: GatewayActivityReport) =>
  `gw_${report.pod}_${report.processEpoch}_${report.epoch}`;
export function history(report: GatewayActivityReport): boolean {
  return (
    report.countersSince !== null &&
    (report.history === "current_process_absence" ||
      (report.history === "complete" && report.lastActivityAt !== null))
  );
}
export function sameEpoch(
  a: GatewayActivityReport,
  b: GatewayActivityReport,
): boolean {
  return (
    a.pod === b.pod &&
    a.processEpoch === b.processEpoch &&
    a.epoch === b.epoch &&
    a.startedAt === b.startedAt &&
    a.counterStartedAt === b.counterStartedAt &&
    a.countersSince === b.countersSince
  );
}
/**
 * The traffic between two observations of one gateway counter run. A sample never crosses a UTC
 * hour, so a span that touches two adjacent hours is two fragments. A known delta is split between
 * them pro rata by elapsed time in exact integer arithmetic: the earlier fragment takes the floor of
 * its share and the later one the remainder, so the parts always add up to the measured delta. The
 * timing error is bounded by the span, one measurement interval. A restart, counter reset,
 * inventory change or incomplete report is unknown in every fragment, and so is a span over more
 * than two hours: the hours in between have no fragment to receive a share.
 */
export function measurementDifferences(
  previous: GatewayActivityReport,
  current: GatewayActivityReport,
  expected: string[],
  continuous: boolean,
): UsageSample[] {
  const start = Date.parse(previous.observedAt),
    end = Date.parse(current.observedAt);
  if (end <= start) return [];
  const fields = [
    "ingressBytes",
    "egressBytes",
    "totalConnections",
    "connectionMilliseconds",
  ] as const;
  const known =
    continuous &&
    sameEpoch(previous, current) &&
    history(previous) &&
    history(current) &&
    fields.every(
      (field) =>
        previous[field] !== null &&
        current[field] !== null &&
        current[field]! >= previous[field]!,
    );
  const firstHour = Math.floor(start / USAGE_HOUR_MS),
    lastHour = Math.floor((end - 1) / USAGE_HOUR_MS);
  const boundary = (firstHour + 1) * USAGE_HOUR_MS;
  const intervals =
    firstHour === lastHour
      ? [{ start, end }]
      : [
          { start, end: boundary },
          { start: lastHour * USAGE_HOUR_MS, end },
        ];
  /** The share of each fragment of one counter's delta, or null where it is unknown. */
  const shares = (field: (typeof fields)[number]): (number | null)[] => {
    if (!known) return intervals.map(() => null);
    const delta = current[field]! - previous[field]!;
    if (intervals.length === 1) return [delta];
    if (lastHour !== firstHour + 1) return [null, null];
    const earlier = Number(
      (BigInt(delta) * BigInt(boundary - start)) / BigInt(end - start),
    );
    return [earlier, delta - earlier];
  };
  const [ingress, egress, connections, milliseconds] = fields.map(shares);
  return intervals.map((interval, index) =>
    UsageSample.parse({
      database_id: current.database,
      source: "gateway",
      producer_id: producer(current),
      sequence: interval.end,
      observed_at: current.observedAt,
      interval_start: new Date(interval.start).toISOString(),
      interval_end: new Date(interval.end).toISOString(),
      expected_producers: expected,
      ingress_bytes: ingress![index],
      egress_bytes: egress![index],
      connections: connections![index],
      connection_seconds:
        milliseconds![index] === null ? null : milliseconds![index]! / 1000,
    }),
  );
}
