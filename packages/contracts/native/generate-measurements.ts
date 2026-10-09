// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from "node:fs/promises";
import { format } from "prettier";
import {
  MEASUREMENT_CHECKPOINT_KEY,
  MEASUREMENT_CURSOR_ANNOTATION,
  MEASUREMENT_CHECKPOINT_BYTES,
  MEASUREMENT_MAX_OUTBOX,
  MEASUREMENT_COHORT,
  MEASUREMENT_BODY_BYTES,
  MEASUREMENT_INTERVAL_MS,
  measurementCheckpoint,
  measurementDifferences,
} from "../../../apps/regional/src/agent/measurements.ts";
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
    name: "cross_hour_never_distributes_counter_delta",
    previous: { ...prior, observedAt: at(USAGE_HOUR_MS - 1000) },
    current: { ...current, observedAt: at(USAGE_HOUR_MS + 1000) },
    continuous: true,
  },
  {
    name: "backward_clock_does_not_emit_interval",
    previous: prior,
    current: { ...current, observedAt: at(99000) },
    continuous: true,
  },
];
const identity = {
  storage: uid(5),
  namespace: uid(6),
  cluster: uid(7),
  fence: uid(8),
  state: JSON.stringify({
    namespaceUid: uid(6),
    clusterUid: uid(7),
    node: "node-test",
    archivePath: "s3://test/eu-test/db/g1-op",
  }),
};
const baseline = {
  sampledAt: at(115000),
  inventory: [{ name: "gateway", uid: uid(1), ip: "10.0.0.7", restarts: 0 }],
  keyUid: uid(9),
  keyVersion: "1",
  reports: [current],
};
const checkpoints = [
  { name: "empty", data: {} },
  {
    name: "persisted_baseline",
    data: {
      [MEASUREMENT_CHECKPOINT_KEY]: JSON.stringify({
        version: 1,
        identity,
        outbox: [],
        baseline,
      }),
    },
  },
  {
    name: "changed_custody",
    data: {
      [MEASUREMENT_CHECKPOINT_KEY]: JSON.stringify({
        version: 1,
        identity: { ...identity, storage: uid(99) },
        outbox: [],
      }),
    },
  },
  {
    name: "idle_window_without_baseline",
    data: {
      [MEASUREMENT_CHECKPOINT_KEY]: JSON.stringify({
        version: 1,
        identity,
        outbox: [],
        idleObservedSince: at(100000),
      }),
    },
  },
  {
    name: "unknown_outbox_record",
    data: {
      [MEASUREMENT_CHECKPOINT_KEY]: JSON.stringify({
        version: 1,
        identity,
        outbox: [{}],
      }),
    },
  },
].map((value) => {
  try {
    return {
      ...value,
      identity,
      result: measurementCheckpoint(
        {
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: {
            name: `storage-${database}`,
            uid: uid(5),
            resourceVersion: "1",
          },
          data: value.data,
        },
        identity,
      ),
      rejected: false,
    };
  } catch {
    return { ...value, identity, rejected: true };
  }
});
const constants = {
  MEASUREMENT_CHECKPOINT_KEY,
  MEASUREMENT_CURSOR_ANNOTATION,
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
    checkpoints,
  },
})) {
  const path = new URL(name, import.meta.url);
  const source = await format(JSON.stringify(value), { parser: "json" });
  if (process.argv.includes("--check")) {
    if ((await readFile(path, "utf8")) !== source)
      throw new Error(`Regenerate ${name}`);
  } else await writeFile(path, source);
}
