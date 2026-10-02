// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  capacityPlan,
  parseQuantityBytes,
  run,
  type ClusterClient,
  type PublisherConfig,
} from "./publish-storage-capacity.ts";

const now = Date.parse("2026-10-02T12:00:00Z");
function fixture() {
  const name = `node-${randomUUID().slice(0, 8)}`;
  const binding = {
    node_uid: randomUUID(),
    lvmnode_uid: randomUUID(),
    lvmnode_resource_version: "18",
    vg_uuid: randomUUID(),
  };
  const config: PublisherConfig = {
    clusterUid: randomUUID(),
    storageNamespaceUid: randomUUID(),
    context: `context-${randomUUID().slice(0, 8)}`,
    proofNotBefore: now - 60_000,
    proofCompletedAt: now - 10_000,
    bindings: { [name]: binding },
  };
  const node = {
    apiVersion: "v1",
    kind: "Node",
    metadata: { name, uid: binding.node_uid, resourceVersion: "17" },
  };
  const lvm = {
    apiVersion: "local.openebs.io/v1alpha1",
    kind: "LVMNode",
    metadata: {
      name,
      namespace: "openebs",
      uid: binding.lvmnode_uid,
      resourceVersion: "18",
      creationTimestamp: new Date(now - 30_000).toISOString(),
      ownerReferences: [
        {
          apiVersion: "v1",
          kind: "Node",
          name,
          uid: binding.node_uid,
          controller: true,
        },
      ],
    },
    volumeGroups: [
      {
        name: "pgcf",
        uuid: binding.vg_uuid,
        size: "96Gi",
        free: "64Gi",
        permissions: 0,
        missingPvCount: 0,
        thinPools: [],
      },
    ],
  };
  return { config, name, node, lvm };
}

test("default invocation prints usage without invoking kubectl or reading configuration", async () => {
  let calls = 0;
  const client: ClusterClient = {
    get: async () => {
      calls++;
      throw new Error("unexpected_network");
    },
    patchNode: async () => {
      calls++;
      throw new Error("unexpected_mutation");
    },
  };
  const result = await run([], {}, client, () => now);
  assert.equal(result.status, "usage");
  assert.equal(calls, 0);
});

test("capacity comes from VG total even when logical volumes have consumed free space", () => {
  const f = fixture();
  const plan = capacityPlan(f.config, f.name, f.node, f.lvm, now);
  assert.equal(plan.storageGiB, 96);
  assert.equal(plan.freeBytes, 64 * 2 ** 30);
  assert.deepEqual(plan.patch.slice(0, 2), [
    { op: "test", path: "/metadata/uid", value: f.node.metadata.uid },
    { op: "test", path: "/metadata/resourceVersion", value: "17" },
  ]);
});

test("a missing total is not replaced with free or ephemeral storage", () => {
  const f = fixture();
  const lvm = structuredClone(f.lvm) as Record<string, unknown>;
  lvm.volumeGroups = [
    {
      name: "pgcf",
      uuid: f.config.bindings[f.name]!.vg_uuid,
      free: "96Gi",
      permissions: 0,
      missingPvCount: 0,
    },
  ];
  assert.throws(
    () => capacityPlan(f.config, f.name, f.node, lvm, now),
    /invalid_vg_quantity/,
  );
});

test("foreign Node ownership and replaced LVMNode identities refuse publication", () => {
  const f = fixture();
  f.lvm.metadata.ownerReferences[0]!.uid = randomUUID();
  assert.throws(
    () => capacityPlan(f.config, f.name, f.node, f.lvm, now),
    /foreign_lvmnode_owner/,
  );
  const g = fixture();
  g.lvm.metadata.uid = randomUUID();
  assert.throws(
    () => capacityPlan(g.config, g.name, g.node, g.lvm, now),
    /foreign_lvmnode/,
  );
});

test("fresh annotation metadata does not refresh an old volumeGroups measurement", () => {
  const f = fixture();
  const lvm = structuredClone(f.lvm) as Record<string, unknown>;
  lvm.metadata = {
    ...f.lvm.metadata,
    creationTimestamp: new Date(now - 600_000).toISOString(),
    managedFields: [
      {
        time: new Date(now).toISOString(),
        fieldsV1: { "f:metadata": { "f:annotations": {} } },
      },
    ],
  };
  assert.throws(
    () => capacityPlan(f.config, f.name, f.node, lvm, now),
    /stale_vg_measurement/,
  );
});

test("an actual recent volumeGroups update can publish an older object", () => {
  const f = fixture();
  const lvm = structuredClone(f.lvm) as Record<string, unknown>;
  lvm.metadata = {
    ...f.lvm.metadata,
    creationTimestamp: new Date(now - 600_000).toISOString(),
    managedFields: [
      {
        time: new Date(now - 20_000).toISOString(),
        fieldsV1: { "f:volumeGroups": {} },
      },
    ],
  };
  assert.equal(capacityPlan(f.config, f.name, f.node, lvm, now).storageGiB, 96);
});

test("Kubernetes quantities are parsed exactly and unsafe or malformed values fail", () => {
  assert.equal(parseQuantityBytes("1.5Gi"), 1610612736);
  assert.equal(parseQuantityBytes("2e9"), 2000000000);
  assert.equal(parseQuantityBytes(4294967296), 4294967296);
  assert.equal(parseQuantityBytes("4G"), 4000000000);
  assert.throws(() => parseQuantityBytes("1E"), /invalid_vg_quantity/);
  assert.throws(() => parseQuantityBytes("1.1"), /invalid_vg_quantity/);
  assert.throws(() => parseQuantityBytes("-1Gi"), /invalid_vg_quantity/);
  assert.throws(() => parseQuantityBytes("9Ei"), /invalid_vg_quantity/);
});

test("existing unrelated Node annotations are preserved by an escaped field patch", () => {
  const f = fixture();
  const node = {
    ...f.node,
    metadata: {
      ...f.node.metadata,
      annotations: { [`note-${randomUUID()}`]: "keep" },
    },
  };
  const plan = capacityPlan(f.config, f.name, node, f.lvm, now);
  assert.deepEqual(plan.patch[2], {
    op: "add",
    path: "/metadata/annotations/pgcf.io~1storage-gib-total",
    value: "96",
  });
});

test("a mismatched cluster identity refuses all node mutations", async () => {
  const f = fixture();
  let patches = 0;
  const client: ClusterClient = {
    get: async () => ({ metadata: { uid: randomUUID() } }),
    patchNode: async () => {
      patches++;
      return {};
    },
  };
  await assert.rejects(
    run(["--apply"], environment(f.config), client, () => now),
    /foreign_cluster/,
  );
  assert.equal(patches, 0);
});

function environment(config: PublisherConfig): Record<string, string> {
  return {
    PGCF_STORAGE_EXPECTED_CLUSTER_UID: config.clusterUid,
    PGCF_STORAGE_EXPECTED_NAMESPACE_UID: config.storageNamespaceUid,
    PGCF_STORAGE_KUBE_CONTEXT: config.context,
    PGCF_STORAGE_PROOF_NOT_BEFORE: new Date(
      config.proofNotBefore,
    ).toISOString(),
    PGCF_STORAGE_PROOF_COMPLETED_AT: new Date(
      config.proofCompletedAt,
    ).toISOString(),
    PGCF_STORAGE_BINDINGS_JSON: JSON.stringify(config.bindings),
  };
}

test("cluster identity is rechecked before every atomic node patch", async () => {
  const f = fixture();
  let clusterReads = 0;
  let patches = 0;
  const client: ClusterClient = {
    get: async (path) => {
      if (path === "/api/v1/namespaces/kube-system") {
        clusterReads++;
        return {
          metadata: {
            uid: clusterReads === 1 ? f.config.clusterUid : randomUUID(),
          },
        };
      }
      if (path === "/api/v1/namespaces/openebs")
        return { metadata: { uid: f.config.storageNamespaceUid } };
      if (path.startsWith("/api/v1/nodes/")) return f.node;
      return f.lvm;
    },
    patchNode: async () => {
      patches++;
      return {};
    },
  };
  await assert.rejects(
    run(["--apply"], environment(f.config), client, () => now),
    /foreign_cluster/,
  );
  assert.equal(patches, 0);
  assert.equal(clusterReads, 2);
});

test("apply publishes only the measured annotation and verifies the patched Node identity", async () => {
  const f = fixture();
  let patches = 0;
  const client: ClusterClient = {
    get: async (path) => {
      if (path === "/api/v1/namespaces/kube-system")
        return { metadata: { uid: f.config.clusterUid } };
      if (path === "/api/v1/namespaces/openebs")
        return { metadata: { uid: f.config.storageNamespaceUid } };
      if (path.startsWith("/api/v1/nodes/")) return f.node;
      return f.lvm;
    },
    patchNode: async (name, patch, context) => {
      patches++;
      assert.equal(name, f.name);
      assert.equal(context, f.config.context);
      assert.deepEqual(patch, [
        { op: "test", path: "/metadata/uid", value: f.node.metadata.uid },
        { op: "test", path: "/metadata/resourceVersion", value: "17" },
        {
          op: "add",
          path: "/metadata/annotations",
          value: { "pgcf.io/storage-gib-total": "96" },
        },
      ]);
      return {
        metadata: {
          uid: f.node.metadata.uid,
          annotations: { "pgcf.io/storage-gib-total": "96" },
        },
      };
    },
  };
  const result = await run(
    ["--apply"],
    environment(f.config),
    client,
    () => now,
  );
  assert.deepEqual(result, {
    status: "published",
    nodes: 1,
    storage_gib_total: [96],
  });
  assert.equal(patches, 1);
});

test("the proved LVMNode revision and dedicated VG identity cannot drift", () => {
  const f = fixture();
  f.lvm.metadata.resourceVersion = "19";
  assert.throws(
    () => capacityPlan(f.config, f.name, f.node, f.lvm, now),
    /unexpected_lvmnode_revision/,
  );
  const g = fixture();
  g.lvm.volumeGroups[0]!.uuid = randomUUID();
  assert.throws(
    () => capacityPlan(g.config, g.name, g.node, g.lvm, now),
    /invalid_dedicated_vg/,
  );
});

test("impossible free capacity and duplicated dedicated VGs refuse publication", () => {
  const f = fixture();
  f.lvm.volumeGroups[0]!.free = "97Gi";
  assert.throws(
    () => capacityPlan(f.config, f.name, f.node, f.lvm, now),
    /invalid_vg_capacity/,
  );
  const g = fixture();
  g.lvm.volumeGroups.push(structuredClone(g.lvm.volumeGroups[0]!));
  assert.throws(
    () => capacityPlan(g.config, g.name, g.node, g.lvm, now),
    /missing_vg_measurement/,
  );
});
