// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFleetLegacyStorage } from "../src/fleet-legacy-storage.ts";
import { patchFixture } from "./fleet-patch.fixture.ts";
function retained() {
  const { input } = patchFixture(),
    id = "d" + "a".repeat(19),
    namespace = `pgcf-db-${id}`,
    storageUid = randomUUID(),
    namespaceUid = randomUUID(),
    clusterUid = randomUUID(),
    claimUid = randomUUID(),
    volumeUid = randomUUID(),
    fenceUid = randomUUID(),
    handle = `pvc-${claimUid}`,
    archive = `s3://bucket/${input.status.region_id}/${id}/g1-op_abcdefghijklmnopqrst`;
  input.retained_thick_storage = [
    {
      database_id: id,
      node_id: input.status.node_id,
      node_uid: input.status.node_uid,
      k8s_node_name: input.k8s_node_name,
      storage_generation: 1,
      archive_path: archive,
    },
  ];
  const resource = (kind: string, name: string, uid: string, ns?: string) => ({
    kind,
    metadata: {
      name,
      uid,
      ...(ns ? { namespace: ns } : {}),
      labels: { "pgcf.io/database-id": id },
    },
  });
  const state = {
      namespaceUid,
      clusterUid,
      node: input.k8s_node_name,
      archivePath: archive,
    },
    identity = { handle, claimUid, volumeUid },
    anchor = {
      storageUid,
      storageState: JSON.stringify(state),
      volumeIdentity: JSON.stringify(identity),
      physicalGeneration: 1,
    };
  const storage = {
      ...resource("ConfigMap", `storage-${id}`, storageUid, "pgcf-system"),
      metadata: {
        ...resource("ConfigMap", `storage-${id}`, storageUid, "pgcf-system")
          .metadata,
        annotations: {
          "pgcf.io/volume-identity": JSON.stringify(identity),
          "pgcf.io/gateway-fence-uid": fenceUid,
        },
      },
      data: { state: JSON.stringify(state) },
    },
    fence = {
      ...resource("ConfigMap", `gateway-fence-${id}`, fenceUid, "pgcf-system"),
      metadata: {
        ...resource("ConfigMap", `gateway-fence-${id}`, fenceUid, "pgcf-system")
          .metadata,
        labels: { "pgcf.io/database-id": id, "pgcf.io/gateway-fence": "true" },
      },
      data: { "power.json": JSON.stringify({ anchor }) },
    };
  const pv = {
      ...resource("PersistentVolume", handle, volumeUid),
      spec: {
        claimRef: { name: "database-1", namespace, uid: claimUid },
        storageClassName: "pgcf-lvm",
        csi: { driver: "local.csi.openebs.io", volumeHandle: handle },
        nodeAffinity: {
          required: {
            nodeSelectorTerms: [
              {
                matchExpressions: [
                  {
                    key: "openebs.io/nodename",
                    operator: "In",
                    values: [input.k8s_node_name],
                  },
                ],
              },
            ],
          },
        },
      },
      status: { phase: "Bound" },
    },
    claim = {
      ...resource("PersistentVolumeClaim", "database-1", claimUid, namespace),
      spec: { volumeName: handle, storageClassName: "pgcf-lvm" },
      status: { phase: "Bound" },
    },
    lvm = resource("LVMVolume", handle, randomUUID(), "openebs");
  const kube = async (args: string[]) =>
    JSON.stringify(
      args[1] === "namespace"
        ? resource("Namespace", namespace, namespaceUid)
        : args[1] === "clusters.postgresql.cnpg.io"
          ? resource("Cluster", "database", clusterUid, namespace)
          : args[1] === "configmaps"
            ? { items: [storage, fence] }
            : args[1] === "persistentvolume"
              ? pv
              : args[1] === "persistentvolumeclaims"
                ? { items: [claim] }
                : { items: [lvm] },
    );
  return {
    input,
    kube,
    pv,
    storage,
    fence,
    identity,
    expected: {
      database_id: id,
      storage_uid: storageUid,
      namespace_uid: namespaceUid,
      cluster_uid: clusterUid,
      physical_generation: 1,
      volume_identity: identity,
    },
  };
}
test("only the CF-scoped retained thick cohort receives freshly proved exact physical/storage identities", async () => {
  const f = retained();
  assert.deepEqual(await readFleetLegacyStorage(f.input, f.kube), [f.expected]);
  f.pv.metadata.uid = randomUUID();
  await assert.rejects(
    readFleetLegacyStorage(f.input, f.kube),
    /patch_legacy_storage_volume_changed/,
  );
  const changed = retained();
  changed.input.retained_thick_storage![0]!.node_uid = randomUUID();
  await assert.rejects(
    readFleetLegacyStorage(changed.input, changed.kube),
    /patch_legacy_storage_assignment_changed/,
  );
  const forged = retained();
  forged.fence.data["power.json"] = JSON.stringify({
    anchor: { ...forged.expected, physicalGeneration: 2 },
  });
  await assert.rejects(
    readFleetLegacyStorage(forged.input, forged.kube),
    /patch_legacy_storage_anchor_changed/,
  );
});
