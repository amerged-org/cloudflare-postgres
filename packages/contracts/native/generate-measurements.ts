// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from "node:fs/promises";
import { format } from "prettier";
import {
  MEASUREMENT_CHECKPOINT_KEY,
  MEASUREMENT_CHECKPOINT_BYTES,
  MEASUREMENT_MAX_OUTBOX,
  MEASUREMENT_COHORT,
  MEASUREMENT_BODY_BYTES,
  MEASUREMENT_INTERVAL_MS,
  measurementDifferences,
} from "../src/measurements.ts";
import {
  GATEWAY_ACTIVITY_FRESH_MS,
  GATEWAY_ACTIVITY_FUTURE_MS,
} from "../src/agent.ts";
import { USAGE_HOUR_MS } from "../src/usage.ts";
import { gatewayActivityReportSchema } from "../src/gateway-activity.ts";
const uid = (n: number) =>
  `01234567-89ab-4def-8123-${n.toString(16).padStart(12, "0")}`;
const database = "aaaaaaaaaaaaaaaaaaaa";
const at = (ms: number) => new Date(ms).toISOString();
function report(observed = 100000) {
  return gatewayActivityReportSchema.parse({
    region: "eu-test",
    database,
    revision: 1,
    pod: uid(1),
    processEpoch: uid(2),
    epoch: uid(3),
    startedAt: at(0),
    counterStartedAt: at(0),
    observedAt: at(observed),
    history: "complete",
    countersSince: at(0),
    ingressBytes: 100,
    egressBytes: 200,
    totalConnections: 4,
    connectionMilliseconds: 3000,
    connections: 0,
    authenticatedConnections: 0,
    busyConnections: 0,
    pendingDials: 0,
    lastActivityAt: at(50000),
  });
}
const prior = report();
const current = {
  ...report(115000),
  ingressBytes: 150,
  egressBytes: 300,
  totalConnections: 5,
  connectionMilliseconds: 3500,
};
const cases = [
  {
    name: "measured_monotonic_delta",
    previous: prior,
    current,
    continuous: true,
  },
  {
    name: "inventory_gap_stays_unknown",
    previous: prior,
    current,
    continuous: false,
  },
  {
    name: "process_restart_stays_unknown",
    previous: prior,
    current: { ...current, processEpoch: uid(4) },
    continuous: true,
  },
  {
    name: "counter_regression_stays_unknown",
    previous: prior,
    current: { ...current, ingressBytes: 99 },
    continuous: true,
  },
  {
    // 10 s before and 5 s after the boundary: floor(50*10/15)=33, 66, 0 and 333 ms; the rest is later.
    name: "cross_hour_splits_known_delta_pro_rata",
    previous: { ...prior, observedAt: at(USAGE_HOUR_MS - 10000) },
    current: { ...current, observedAt: at(USAGE_HOUR_MS + 5000) },
    continuous: true,
  },
  {
    name: "cross_hour_quiet_interval_is_two_known_zeros",
    previous: { ...prior, observedAt: at(USAGE_HOUR_MS - 10000) },
    current: { ...prior, observedAt: at(USAGE_HOUR_MS + 5000) },
    continuous: true,
  },
  {
    // A counter product above 2^53: the earlier fragment takes floor(MAX*2/3), computed exactly.
    name: "cross_hour_split_is_exact_beyond_2_pow_53",
    previous: {
      ...prior,
      observedAt: at(USAGE_HOUR_MS - 2),
      ingressBytes: 0,
    },
    current: {
      ...prior,
      observedAt: at(USAGE_HOUR_MS + 1),
      ingressBytes: Number.MAX_SAFE_INTEGER,
    },
    continuous: true,
  },
  {
    name: "cross_hour_restart_stays_unknown",
    previous: { ...prior, observedAt: at(USAGE_HOUR_MS - 10000) },
    current: {
      ...current,
      processEpoch: uid(4),
      observedAt: at(USAGE_HOUR_MS + 5000),
    },
    continuous: true,
  },
  {
    // The hour in between has no fragment, so the delta of a span over two boundaries stays unknown.
    name: "span_over_two_boundaries_stays_unknown",
    previous: { ...prior, observedAt: at(USAGE_HOUR_MS - 10000) },
    current: { ...current, observedAt: at(2 * USAGE_HOUR_MS + 5000) },
    continuous: true,
  },
  {
    name: "backward_clock_does_not_emit_interval",
    previous: prior,
    current: { ...current, observedAt: at(99000) },
    continuous: true,
  },
];
const constants = {
  MEASUREMENT_CHECKPOINT_KEY,
  MEASUREMENT_CHECKPOINT_BYTES,
  MEASUREMENT_MAX_OUTBOX,
  MEASUREMENT_COHORT,
  MEASUREMENT_BODY_BYTES,
  MEASUREMENT_INTERVAL_MS,
  GATEWAY_ACTIVITY_FRESH_MS,
  GATEWAY_ACTIVITY_FUTURE_MS,
  USAGE_HOUR_MS,
};
for (const [name, value] of Object.entries({
  "measurements.generated.json": { version: 1, constants },
  "measurements-vectors.generated.json": {
    differences: cases.map((value) => {
      const expected = [
        `gw_${value.current.pod}_${value.current.processEpoch}_${value.current.epoch}`,
      ];
      return {
        ...value,
        expected_producers: expected,
        result: measurementDifferences(
          value.previous,
          value.current,
          expected,
          value.continuous,
        ),
      };
    }),
  },
})) {
  const path = new URL(name, import.meta.url);
  const source = await format(JSON.stringify(value), { parser: "json" });
  if (process.argv.includes("--check")) {
    if ((await readFile(path, "utf8")) !== source)
      throw new Error(`Regenerate ${name}`);
  } else await writeFile(path, source);
}
