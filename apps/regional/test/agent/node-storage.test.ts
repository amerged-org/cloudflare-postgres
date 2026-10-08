// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  nodeStorageSample,
  physicalStorageMetrics,
} from "../../src/agent/node-storage.ts";
import { MemoryKubernetes } from "./fixtures.ts";
import type { Resource } from "../../src/agent/types.ts";

const vg = "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef";
const group = (free = 7000) =>
  `lvm_vg_total_size_bytes{name="pgcf"} 1e4\nlvm_vg_free_size_bytes{name="pgcf"} ${free}\nlvm_vg_permission{name="pgcf"} 0\nlvm_vg_missing_pv_count{name="pgcf"} 0\nlvm_vg_pv_count{name="pgcf"} 1\n`;
const labels = (name: string, segtype: string, pool = "") =>
  `active_status="active",device="dm-0",dm_path="/dev/mapper/pgcf-${name}",host="driver",name="${name}",path="/dev/pgcf/${name}",pool="${pool}",segtype="${segtype}",vg="pgcf"`;
const lv = (name: string, segtype: string, size: number, pool = "") =>
  `lvm_lv_total_size_bytes{${labels(name, segtype, pool)}} ${size}\nlvm_lv_health_status{${labels(name, segtype, pool)}} 0\nlvm_lv_permission{${labels(name, segtype, pool)}} 1\n`;

test("fresh physical metrics count thick extents instead of filesystem used-percent zero", () => {
  const metrics =
    group() +
    lv("pvc-test", "linear", 3000) +
    `lvm_lv_used_percent{${labels("pvc-test", "linear")}} 0\n`;
  assert.deepEqual(physicalStorageMetrics(metrics, vg), {
    volume_group_uuid: vg,
    total_bytes: 10000,
    free_bytes: 7000,
    thick_allocated_bytes: 3000,
    thin_pool: null,
  });
  assert.equal(
    physicalStorageMetrics(
      metrics + 'lvm_vg_total_size_bytes{name="pgcf"} 10000\n',
      vg,
    ),
    null,
  );
  assert.equal(
    physicalStorageMetrics(
      metrics.replace(
        'lvm_vg_permission{name="pgcf"} 0',
        'lvm_vg_permission{name="pgcf"} 1',
      ),
      vg,
    ),
    null,
  );
});

test("thin data and metadata are separately bounded; missing gauges remain unknown", () => {
  const poolLabels = labels("pgcf_thinpool", "thin-pool");
  const metrics =
    group(5990) +
    lv("pgcf_thinpool", "thin-pool", 4000) +
    `lvm_lv_mda_total_size_bytes{${poolLabels}} 10\nlvm_lv_used_percent{${poolLabels}} 25\nlvm_lv_mda_used_percent{${poolLabels}} 20\nlvm_lv_when_full{${poolLabels}} 0\n`;
  assert.deepEqual(physicalStorageMetrics(metrics, vg)?.thin_pool, {
    name: "pgcf_thinpool",
    data_total_bytes: 4000,
    data_used_bytes_upper_bound: 1001,
    metadata_total_bytes: 10,
    metadata_used_bytes_upper_bound: 3,
  });
  assert.equal(
    physicalStorageMetrics(
      metrics.replace(`lvm_lv_mda_used_percent{${poolLabels}} 20\n`, ""),
      vg,
    ),
    null,
  );
  assert.equal(
    physicalStorageMetrics(
      metrics.replace(
        `lvm_lv_used_percent{${poolLabels}} 25`,
        `lvm_lv_used_percent{${poolLabels}} NaN`,
      ),
      vg,
    ),
    null,
  );
});

function driverFixture() {
  const k8s = new MemoryKubernetes();
  for (const name of ["kube-system", "openebs"])
    k8s.put({ apiVersion: "v1", kind: "Namespace", metadata: { name } });
  const node = k8s.put({
    apiVersion: "v1",
    kind: "Node",
    metadata: { name: "pgcf-node" },
    status: { conditions: [{ type: "Ready", status: "True" }] },
  });
  const driverImage = "openebs/lvm-driver:1.10.1";
  const ds = k8s.put({
    apiVersion: "apps/v1",
    kind: "DaemonSet",
    metadata: { name: "openebs-lvm-localpv-node", namespace: "openebs" },
    spec: {
      template: {
        spec: { containers: [{ name: "driver", image: driverImage }] },
      },
    },
  });
  k8s.put({
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "driver-node",
      namespace: "openebs",
      ownerReferences: [
        {
          apiVersion: "apps/v1",
          kind: "DaemonSet",
          name: ds.metadata.name,
          uid: ds.metadata.uid,
          controller: true,
        },
      ],
    } as Resource["metadata"],
    spec: {
      nodeName: node.metadata.name,
      containers: [{ name: "driver", image: driverImage }],
    },
    status: {
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [
        {
          name: "driver",
          ready: true,
          imageID: `docker-pullable://openebs/lvm-driver@sha256:${"a".repeat(64)}`,
          restartCount: 0,
          state: { running: { startedAt: new Date() } },
        },
      ],
    },
  });
  const lvmnode = k8s.put({
    apiVersion: "local.openebs.io/v1alpha1",
    kind: "LVMNode",
    metadata: {
      name: node.metadata.name,
      namespace: "openebs",
      ownerReferences: [
        {
          apiVersion: "v1",
          kind: "Node",
          name: node.metadata.name,
          uid: node.metadata.uid,
          controller: true,
        },
      ],
    } as Resource["metadata"],
    volumeGroups: [{ name: "pgcf", uuid: vg, size: "10000", free: "10000" }],
  });
  const reader = Object.assign(k8s, {
    async openEbsMetrics() {
      return group(10000);
    },
  });
  return { k8s: reader, node, lvmnode };
}

test("collector binds current driver and node while accepting harmless quantity normalization", async () => {
  const { k8s, node, lvmnode } = driverFixture();
  k8s.openEbsMetrics = async () => {
    (lvmnode.volumeGroups as Record<string, unknown>[])[0]!.free = "10k";
    return group(10000);
  };
  assert.equal(
    (await nodeStorageSample(k8s, node))?.physical?.free_bytes,
    10000,
  );
});

test("replacement during a storage scrape produces unknown instead of new capacity", async () => {
  const { k8s, node } = driverFixture();
  k8s.openEbsMetrics = async () => {
    node.metadata.uid = crypto.randomUUID();
    return group(10000);
  };
  assert.equal(
    (await nodeStorageSample(k8s, structuredClone(node)))?.physical,
    null,
  );
});
