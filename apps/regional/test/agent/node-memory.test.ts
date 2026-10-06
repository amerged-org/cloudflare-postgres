// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { newNodeId, type ObservationRequest } from "@pgcf/contracts";
import {
  nodeMemorySample,
  RegionalNodeMemory,
} from "../../src/agent/node-memory.ts";
import { nodeObservations } from "../../src/agent/observe.ts";
import { record } from "../../src/agent/types.ts";
import { MemoryKubernetes } from "./fixtures.ts";

const now = Date.parse("2026-10-06T12:00:00.000Z");
function fixture() {
  const k8s = new MemoryKubernetes();
  const node = k8s.put({
    apiVersion: "v1",
    kind: "Node",
    metadata: {
      name: "worker",
      labels: {
        "pgcf.io/node-id": newNodeId(),
        "pgcf.io/provider-instance-id": "123",
      },
    },
    status: {
      capacity: { memory: "1Gi" },
      allocatable: { memory: "512Mi", cpu: "1" },
      conditions: [
        { type: "Ready", status: "True" },
        { type: "MemoryPressure", status: "False" },
      ],
    },
  });
  node.metadata.uid = randomUUID();
  const summary = {
    node: {
      nodeName: "worker",
      memory: {
        time: new Date(now - 1000).toISOString(),
        workingSetBytes: 810_000_000,
        availableBytes: 200_000_000,
      },
    },
    pods: [],
  };
  return { k8s, node, summary };
}

test("whole-node working set uses physical capacity and includes an empty database node", () => {
  const { node, summary } = fixture();
  assert.deepEqual(nodeMemorySample(node, summary, now), {
    node_uid: node.metadata.uid,
    observed_at: summary.node.memory.time,
    working_set_bytes: 810_000_000,
    capacity_memory_bytes: 2 ** 30,
    available_bytes: 200_000_000,
    memory_pressure: false,
  });
  delete (summary.node.memory as { availableBytes?: number }).availableBytes;
  record(node.status).conditions = [
    { type: "Ready", status: "True" },
    { type: "MemoryPressure", status: "Unknown" },
  ];
  assert.equal(nodeMemorySample(node, summary, now)?.available_bytes, null);
  assert.equal(nodeMemorySample(node, summary, now)?.memory_pressure, null);
});

test("missing, wrong-node, stale and impossible metrics remain unknown rather than zero", () => {
  const { node, summary } = fixture();
  assert.equal(nodeMemorySample(node, {}, now), null);
  assert.equal(
    nodeMemorySample(
      node,
      { node: { ...summary.node, nodeName: "foreign" } },
      now,
    ),
    null,
  );
  summary.node.memory.time = new Date(now - 90_001).toISOString();
  assert.equal(nodeMemorySample(node, summary, now), null);
  summary.node.memory.time = new Date(now + 1).toISOString();
  assert.equal(nodeMemorySample(node, summary, now), null);
  summary.node.memory.time = new Date(now).toISOString();
  summary.node.memory.workingSetBytes = 2 ** 30 + 1;
  assert.equal(nodeMemorySample(node, summary, now), null);
  summary.node.memory.workingSetBytes = 10;
  record(node.status).conditions = [{ type: "Ready", status: "False" }];
  assert.equal(nodeMemorySample(node, summary, now), null);
  record(node.status).conditions = [{ type: "Ready", status: "True" }];
  record(record(node.status).capacity).memory = "0";
  assert.equal(nodeMemorySample(node, summary, now), null);
});

test("collector reads all audited nodes independently of desired databases and rejects UID replacement", async () => {
  const { k8s, node, summary } = fixture();
  const bodies: ObservationRequest[] = [];
  let calls = 0;
  const statsK8s = Object.assign(k8s, {
    statsSummary: async () => {
      calls++;
      return summary;
    },
  });
  const collector = new RegionalNodeMemory({
    k8s: statsK8s,
    api: {
      observations: async (body) => {
        bodies.push(body);
      },
    },
    signal: new AbortController().signal,
    now: () => now,
  });
  await collector.cycle();
  assert.equal(calls, 1);
  assert.equal(
    bodies[0]?.node_memory_samples?.[0]?.memory?.working_set_bytes,
    810_000_000,
  );
  assert.deepEqual(bodies[0]?.nodes, []);
  assert.deepEqual(bodies[0]?.databases, []);
  const original = node.metadata.uid;
  statsK8s.statsSummary = async () => {
    node.metadata.uid = randomUUID();
    return summary;
  };
  await collector.cycle();
  assert.equal(bodies[1]?.node_memory_samples?.[0]?.node_uid, original);
  assert.equal(bodies[1]?.node_memory_samples?.[0]?.memory, null);
});

test("failed authenticated metrics are explicit unknown and sampling concurrency stays bounded", async () => {
  const { k8s, node, summary } = fixture();
  for (let i = 0; i < 8; i++) {
    const next = structuredClone(node);
    next.metadata.name = `worker-${i}`;
    next.metadata.labels!["pgcf.io/node-id"] = newNodeId();
    next.metadata.uid = randomUUID();
    k8s.put(next);
  }
  let active = 0,
    maximum = 0;
  const bodies: ObservationRequest[] = [];
  await new RegionalNodeMemory({
    k8s: Object.assign(k8s, {
      statsSummary: async (value: typeof node) => {
        maximum = Math.max(maximum, ++active);
        await Promise.resolve();
        active--;
        if (value.metadata.name === node.metadata.name)
          throw new Error("kubelet_tls_failed");
        return {
          ...summary,
          node: { ...summary.node, nodeName: value.metadata.name },
        };
      },
    }),
    api: {
      observations: async (body) => {
        bodies.push(body);
      },
    },
    signal: new AbortController().signal,
    now: () => now,
  }).cycle();
  assert.equal(maximum, 4);
  assert.equal(bodies[0]?.node_memory_samples?.length, 9);
  assert.equal(
    bodies[0]?.node_memory_samples?.find(
      (value) => value.node_uid === node.metadata.uid,
    )?.memory,
    null,
  );
  assert.equal(
    bodies[0]?.node_memory_samples?.filter((value) => value.memory !== null)
      .length,
    8,
  );
});

test("disabled database placement reports the operator label without changing node readiness", () => {
  const { node } = fixture();
  node.metadata.labels!["pgcf.io/database-placement"] = "disabled";
  const observed = nodeObservations([node], [], [])[0]!;
  assert.equal(observed.database_placement_enabled, false);
  assert.equal(observed.ready, true);
  assert.notEqual(record(node.spec).unschedulable, true);
  delete node.metadata.labels!["pgcf.io/database-placement"];
  assert.equal(
    nodeObservations([node], [], [])[0]?.database_placement_enabled,
    undefined,
  );
});
