// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { inventoryPages } from "../../src/agent/kubernetes.ts";
import {
  nodeObservations,
  parseArchiveProgress,
  parseReadyWalFiles,
  podMemoryRequest,
  quantity,
} from "../../src/agent/observe.ts";
import { fixture, MemoryKubernetes } from "./fixtures.ts";

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
    storage_gib_total: 96,
  });
  node.metadata.annotations = {};
  assert.equal(
    nodeObservations([node], [pod], [namespace])[0]?.storage_gib_total,
    null,
  );
  assert.equal(quantity("500m"), 0.5);
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
