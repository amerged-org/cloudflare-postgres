// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { inventoryPages } from "../../src/agent/kubernetes.ts";
import {
  nodeObservations,
  parseArchiveProgress,
  parseReadyWalFiles,
  podMemoryRequest,
  podCpuRequestMillicores,
  quantity,
} from "../../src/agent/observe.ts";
import { fixture, MemoryKubernetes } from "./fixtures.ts";
import { record } from "../../src/agent/types.ts";

test("node capacity uses measured dedicated LVM annotation and live pod reservation", () => {
  const { db } = fixture();
  const k8s = new MemoryKubernetes();
  const namespace = k8s.ownedNamespace(db);
  const node = k8s.put({
    apiVersion: "v1",
    kind: "Node",
    metadata: {
      name: "test-node",
      annotations: { "pgcf.io/storage-gib-total": "96" },
    },
    status: {
      allocatable: {
        memory: "8Gi",
        cpu: "3900m",
        "ephemeral-storage": "999Gi",
      },
      conditions: [{ type: "Ready", status: "True" }],
    },
  });
  const pod = k8s.put({
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: "agent", namespace: "pgcf-system" },
    spec: {
      nodeName: "test-node",
      containers: [{ resources: { requests: { memory: "128Mi" } } }],
      initContainers: [{ resources: { requests: { memory: "256Mi" } } }],
      overhead: { memory: "32Mi" },
    },
    status: { phase: "Running" },
  });
  const database = k8s.put({
    ...pod,
    metadata: { name: "database-1", namespace: namespace.metadata.name },
  });
  assert.equal(podMemoryRequest(pod), 288 * 2 ** 20);
  assert.deepEqual(nodeObservations([node], [pod, database], [namespace])[0], {
    name: "test-node",
    ready: true,
    allocatable_memory_mib: 8192,
    allocatable_cpu_millicores: 3900,
    platform_reserved_memory_mib: 288,
    platform_reserved_cpu_millicores: 0,
    storage_gib_total: 96,
  });
  node.metadata.annotations = {};
  assert.equal(
    nodeObservations([node], [pod], [namespace])[0]?.storage_gib_total,
    null,
  );
  assert.equal(quantity("500m"), 0.5);
});

test("platform CPU measurement includes app, restartable init peak and overhead while excluding owned database and completed pods", () => {
  const { db } = fixture();
  const k8s = new MemoryKubernetes();
  const namespace = k8s.ownedNamespace(db);
  const node = k8s.put({
    apiVersion: "v1",
    kind: "Node",
    metadata: { name: "test-node" },
    status: {
      allocatable: { memory: "8Gi", cpu: "3" },
      conditions: [{ type: "Ready", status: "True" }],
    },
  });
  const cpu = (value: string) => ({ resources: { requests: { cpu: value } } });
  const platform = k8s.put({
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: "platform", namespace: "pgcf-system" },
    spec: {
      nodeName: node.metadata.name,
      containers: [cpu("1000m"), cpu("0.5")],
      initContainers: [
        { ...cpu("100m"), restartPolicy: "Always" },
        cpu("2"),
        { ...cpu("200m"), restartPolicy: "Always" },
        cpu("600m"),
      ],
      overhead: { cpu: "50m" },
    },
    status: { phase: "Running" },
  });
  const databasePod = k8s.put({
    ...platform,
    metadata: { name: "database-1", namespace: namespace.metadata.name },
  });
  const completed = k8s.put({
    ...platform,
    metadata: { name: "completed", namespace: "pgcf-system" },
    status: { phase: "Succeeded" },
  });
  const failed = k8s.put({
    ...platform,
    metadata: { name: "failed", namespace: "pgcf-system" },
    status: { phase: "Failed" },
  });
  const missing = k8s.put({
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: "without-request", namespace: "pgcf-system" },
    spec: { nodeName: node.metadata.name, containers: [{}] },
  });
  const measured = nodeObservations(
    [node],
    [platform, databasePod, completed, failed, missing],
    [namespace],
  )[0]!;
  assert.equal(measured.allocatable_cpu_millicores, 3000);
  assert.equal(measured.platform_reserved_cpu_millicores, 2150);
  assert.equal(podCpuRequestMillicores(platform), 2150);
  const singleCpu = structuredClone(missing);
  record(singleCpu.spec).containers = [cpu("1000m")];
  assert.equal(podCpuRequestMillicores(singleCpu), 1000);
  record(singleCpu.spec).containers = [cpu("1")];
  assert.equal(podCpuRequestMillicores(singleCpu), 1000);
  assert.equal(
    nodeObservations([node], [missing], [])[0]
      ?.platform_reserved_cpu_millicores,
    0,
  );
  namespace.metadata.labels = {};
  assert.equal(
    nodeObservations([node], [databasePod], [namespace])[0]
      ?.platform_reserved_cpu_millicores,
    2150,
    "namespace prefix alone cannot exclude reservations",
  );
});

test("archive metric is measured exactly, refuses unavailable, negative and noninteger samples", () => {
  assert.equal(
    parseReadyWalFiles(
      'cnpg_collector_pg_wal_archive_status{value="done"} 20\ncnpg_collector_pg_wal_archive_status{value="ready"} 7\n',
    ),
    7,
  );
  assert.throws(() => parseReadyWalFiles(""), /missing/);
  assert.throws(
    () =>
      parseReadyWalFiles(
        'cnpg_collector_pg_wal_archive_status{value="ready"} -1\n',
      ),
    /invalid/,
  );
  assert.throws(
    () =>
      parseReadyWalFiles(
        'cnpg_collector_pg_wal_archive_status{value="ready"} 1.5\n',
      ),
    /invalid/,
  );
});

test("archive progress accepts real fractional scientific epoch samples and rejects ambiguous or future measurements", () => {
  const now = Date.parse("2026-10-04T04:36:00Z");
  const time = now / 1000 - 1893.679;
  const text = `cnpg_pg_stat_archiver_archived_count{pod="primary"} 8\ncnpg_pg_stat_archiver_last_archived_time ${time.toExponential()}\n`;
  assert.deepEqual(parseArchiveProgress(text, now), {
    archivedCount: 8,
    lastArchivedTime: time,
  });
  assert.throws(() => parseArchiveProgress("", now), /missing/);
  assert.throws(
    () => parseArchiveProgress(text + text, now),
    /missing|invalid/,
  );
  assert.throws(
    () => parseArchiveProgress(text.replace("} 8", "} 8.5"), now),
    /invalid/,
  );
  assert.throws(
    () => parseArchiveProgress(text.replace(time.toExponential(), "NaN"), now),
    /invalid/,
  );
  assert.throws(
    () =>
      parseArchiveProgress(
        text.replace(time.toExponential(), String(now / 1000 + 1)),
        now,
      ),
    /invalid/,
  );
});

test("CNPG never-archived sentinel is accepted only with the exact zero archived count pair", () => {
  const now = Date.parse("2026-10-04T04:36:00Z");
  const sample =
    "cnpg_pg_stat_archiver_archived_count 0\ncnpg_pg_stat_archiver_last_archived_time -1\n";
  assert.deepEqual(parseArchiveProgress(sample, now), {
    archivedCount: 0,
    lastArchivedTime: -1,
  });
  assert.throws(
    () => parseArchiveProgress(sample.replace("count 0", "count 1"), now),
    /invalid/,
  );
  assert.throws(
    () => parseArchiveProgress(sample.replace("time -1", "time -2"), now),
    /invalid/,
  );
  assert.throws(
    () => parseArchiveProgress(sample.replace("count 0", "count -1"), now),
    /invalid/,
  );
  assert.throws(
    () => parseArchiveProgress(sample.replace("time -1", "time -0.5"), now),
    /invalid/,
  );
});

test("inventory rejects repeated continuation tokens and changing snapshots instead of returning partial data", async () => {
  let page = 0;
  const value = {
    metadata: { resourceVersion: "1", continue: "same" },
    items: [],
  };
  await assert.rejects(
    inventoryPages(async () => value, "Node", "v1"),
    /cursor/,
  );
  await assert.rejects(
    inventoryPages(
      async () => ({
        ...value,
        metadata: { resourceVersion: String(++page), continue: String(page) },
      }),
      "Node",
      "v1",
    ),
    /snapshot/,
  );
});
