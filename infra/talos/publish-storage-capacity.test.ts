// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
  const readback = (secondsBefore: number, version: string, free: string) => ({
    observed_at: new Date(now - secondsBefore * 1000).toISOString(),
    node_uid: binding.node_uid,
    lvmnode_uid: binding.lvmnode_uid,
    resource_version: version,
    vg_uuid: binding.vg_uuid,
    size: "96Gi",
    free,
  });
  const smoke = {
    before: readback(50, "16", "64Gi"),
    allocated: readback(40, "17", "63Gi"),
    after: readback(20, "18", "64Gi"),
  };
  const config: PublisherConfig = {
    clusterUid: randomUUID(),
    storageNamespaceUid: randomUUID(),
    context: `context-${randomUUID().slice(0, 8)}`,
    proofNotBefore: now - 60_000,
    proofCompletedAt: now - 10_000,
    bindings: { [name]: { ...binding, smoke } },
  };
  const node = {
    apiVersion: "v1",
    kind: "Node",
    spec: { unschedulable: false },
    status: { conditions: [{ type: "Ready", status: "True" }] },
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

test("fresh annotation metadata does not replace an observed smoke free-space change", () => {
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
  f.config.bindings[f.name]!.smoke.allocated.free = "64Gi";
  assert.throws(
    () => capacityPlan(f.config, f.name, f.node, lvm, now),
    /invalid_smoke_transition/,
  );
});

test("authentic smoke readbacks can publish an older object without trusting managedFields", () => {
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

test("metadata-only updates retaining VG ownership do not prove a fresh storage measurement", () => {
  const f = fixture();
  const lvm = structuredClone(f.lvm) as Record<string, unknown>;
  lvm.metadata = {
    ...f.lvm.metadata,
    creationTimestamp: new Date(now - 3_600_000).toISOString(),
    managedFields: [
      {
        time: new Date(now - 20_000).toISOString(),
        fieldsV1: { "f:volumeGroups": {}, "f:metadata": {} },
      },
    ],
  };
  const config = {
    ...f.config,
    bindings: { [f.name]: { ...f.config.bindings[f.name], smoke: undefined } },
  } as unknown as PublisherConfig;
  assert.throws(
    () => capacityPlan(config, f.name, f.node, lvm, now),
    /missing_smoke_proof/,
  );
});

test("a Node that is not Ready refuses storage publication", () => {
  const f = fixture();
  f.node.status.conditions[0]!.status = "False";
  assert.throws(
    () => capacityPlan(f.config, f.name, f.node, f.lvm, now),
    /storage_node_not_ready/,
  );
});

test("a cordoned Node refuses storage publication", () => {
  const f = fixture();
  f.node.spec.unschedulable = true;
  assert.throws(
    () => capacityPlan(f.config, f.name, f.node, f.lvm, now),
    /storage_node_not_ready/,
  );
});

test("explicit kubelet reservations preserve Talos PID and ephemeral storage defaults", () => {
  const patch = readFileSync(
    new URL("./single-node-lab-scheduling.patch.yaml", import.meta.url),
    "utf8",
  ).split("\n---\n")[0]!;
  assert.match(patch, /systemReserved:[\s\S]*pid: "100"/);
  assert.match(patch, /systemReserved:[\s\S]*ephemeral-storage: 256Mi/);
});

test("approved smoke readbacks require free space to decrease and return to the baseline", () => {
  const f = fixture();
  f.config.bindings[f.name]!.smoke.allocated.free = "64Gi";
  assert.throws(
    () => capacityPlan(f.config, f.name, f.node, f.lvm, now),
    /invalid_smoke_transition/,
  );
  const g = fixture();
  g.config.bindings[g.name]!.smoke.after.free = "63Gi";
  assert.throws(
    () => capacityPlan(g.config, g.name, g.node, g.lvm, now),
    /invalid_smoke_transition/,
  );
});

test("all smoke observations bind the same approved Node and LVMNode incarnation", () => {
  const f = fixture();
  f.config.bindings[f.name]!.smoke.allocated.lvmnode_uid = randomUUID();
  assert.throws(
    () => capacityPlan(f.config, f.name, f.node, f.lvm, now),
    /foreign_smoke_readback/,
  );
});

test("the current VG measurement must match the final approved readback", () => {
  const f = fixture();
  f.lvm.volumeGroups[0]!.free = "62Gi";
  assert.throws(
    () => capacityPlan(f.config, f.name, f.node, f.lvm, now),
    /invalid_smoke_transition/,
  );
});

test("out-of-window smoke capture times and reused revisions refuse publication", () => {
  const f = fixture();
  f.config.bindings[f.name]!.smoke.before.observed_at = new Date(
    now - 90_000,
  ).toISOString();
  assert.throws(
    () => capacityPlan(f.config, f.name, f.node, f.lvm, now),
    /invalid_smoke_window/,
  );
  const g = fixture();
  g.config.bindings[g.name]!.smoke.allocated.resource_version = "16";
  assert.throws(
    () => capacityPlan(g.config, g.name, g.node, g.lvm, now),
    /invalid_smoke_revisions/,
  );
});


function nativeWindowFixture(startAge = 600_000, completionAge = 20_000) {
  const f = fixture();
  f.config.context = "native-bootstrap";
  f.config.executionWindow = "native-bootstrap";
  f.config.proofNotBefore = now - startAge;
  f.config.proofCompletedAt = now - completionAge;
  const smoke = f.config.bindings[f.name]!.smoke;
  smoke.before.observed_at = new Date(f.config.proofNotBefore).toISOString();
  smoke.allocated.observed_at = new Date((f.config.proofNotBefore + f.config.proofCompletedAt) / 2).toISOString();
  smoke.after.observed_at = new Date(f.config.proofCompletedAt).toISOString();
  return f;
}

test("Native bounded work accepts historical start only with fresh completion and unchanged physical identities", () => {
  const f = nativeWindowFixture();
  assert.equal(capacityPlan(f.config, f.name, f.node, f.lvm, now).storageGiB, 96);
  f.node.metadata.uid = randomUUID();
  assert.throws(() => capacityPlan(f.config, f.name, f.node, f.lvm, now), /foreign_node/);
  const legacy = nativeWindowFixture();
  delete legacy.config.executionWindow;
  assert.throws(() => capacityPlan(legacy.config, legacy.name, legacy.node, legacy.lvm, now), /stale_storage_proof/);
});

test("Native proof work refuses stale completion, future completion and a historical span beyond its bound", () => {
  const stale = nativeWindowFixture(800_000, 300_001);
  assert.throws(() => capacityPlan(stale.config, stale.name, stale.node, stale.lvm, now), /stale_storage_proof/);
  const future = nativeWindowFixture(600_000, -1);
  assert.throws(() => capacityPlan(future.config, future.name, future.node, future.lvm, now), /stale_storage_proof/);
  const tooLong = nativeWindowFixture(901_001, 1000);
  assert.throws(() => capacityPlan(tooLong.config, tooLong.name, tooLong.node, tooLong.lvm, now), /stale_storage_proof/);
});
