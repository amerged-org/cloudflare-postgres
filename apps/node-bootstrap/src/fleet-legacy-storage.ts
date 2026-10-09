// SPDX-License-Identifier: Apache-2.0
import { ARCHIVE_DESTINATION_PATTERN } from "@pgcf/contracts";
import type { FleetPatchInput } from "@pgcf/contracts/fleet-patches";
import {
  LegacyStorageBinding,
  LegacyStorageBindings,
} from "@pgcf/contracts/storage-write-authority";
import { BootstrapError, canonical } from "./bootstrap.ts";
import {
  patchObject as object,
  patchObjects as objects,
} from "./fleet-patch-observations.ts";
function owned(
  value: unknown,
  kind: string,
  name: string,
  database: string,
  namespace?: string,
) {
  const resource = object(value),
    metadata = object(resource.metadata);
  if (
    resource.kind !== kind ||
    metadata.name !== name ||
    metadata.namespace !== namespace ||
    typeof metadata.uid !== "string" ||
    metadata.deletionTimestamp ||
    object(metadata.labels)["pgcf.io/database-id"] !== database
  )
    throw new BootstrapError("patch_legacy_storage_identity_changed");
  return resource;
}
const parsed = (raw: unknown) =>
  typeof raw === "string" ? object(JSON.parse(raw)) : object(raw);
export async function readFleetLegacyStorage(
  input: FleetPatchInput,
  kube: (args: string[]) => Promise<string>,
): Promise<LegacyStorageBinding[]> {
  const assignments = input.retained_thick_storage ?? [],
    result: LegacyStorageBinding[] = [];
  for (let offset = 0; offset < assignments.length; offset += 4) {
    const reads = await Promise.allSettled(
      assignments.slice(offset, offset + 4).map(async (db) => {
        const archive = ARCHIVE_DESTINATION_PATTERN.exec(db.archive_path);
        if (
          !archive ||
          archive[2] !== input.status.region_id ||
          archive[3] !== db.database_id ||
          Number(archive[4]) !== db.storage_generation
        )
          throw new BootstrapError("patch_legacy_storage_archive_changed");
        if (
          !input.cluster_nodes.some(
            (node) =>
              node.node_id === db.node_id &&
              node.node_uid === db.node_uid &&
              node.k8s_node_name === db.k8s_node_name,
          )
        )
          throw new BootstrapError("patch_legacy_storage_assignment_changed");
        const namespace = `pgcf-db-${db.database_id}`,
          get = async (args: string[]) =>
            object(JSON.parse(await kube(["get", ...args, "--output=json"])));
        const [nsRaw, clusterRaw, maps] = await Promise.all([
          get(["namespace", namespace]),
          get([
            "clusters.postgresql.cnpg.io",
            "database",
            "--namespace",
            namespace,
          ]),
          get([
            "configmaps",
            `storage-${db.database_id}`,
            `gateway-fence-${db.database_id}`,
            "--namespace",
            "pgcf-system",
          ]),
        ]);
        const ns = owned(nsRaw, "Namespace", namespace, db.database_id),
          cluster = owned(
            clusterRaw,
            "Cluster",
            "database",
            db.database_id,
            namespace,
          ),
          rows = objects(maps.items),
          storage = owned(
            rows.find(
              (value) =>
                object(value.metadata).name === `storage-${db.database_id}`,
            ),
            "ConfigMap",
            `storage-${db.database_id}`,
            db.database_id,
            "pgcf-system",
          ),
          fence = owned(
            rows.find(
              (value) =>
                object(value.metadata).name ===
                `gateway-fence-${db.database_id}`,
            ),
            "ConfigMap",
            `gateway-fence-${db.database_id}`,
            db.database_id,
            "pgcf-system",
          );
        const sm = object(storage.metadata),
          state = parsed(object(storage.data).state),
          identity = parsed(object(sm.annotations)["pgcf.io/volume-identity"]),
          power = parsed(object(fence.data)["power.json"]),
          anchor = object(power.anchor);
        if (
          state.storage != null ||
          anchor.storage != null ||
          state.namespaceUid !== object(ns.metadata).uid ||
          state.clusterUid !== object(cluster.metadata).uid ||
          state.node !== db.k8s_node_name ||
          state.archivePath !== db.archive_path ||
          anchor.storageUid !== sm.uid ||
          anchor.physicalGeneration !== db.storage_generation ||
          canonical(parsed(anchor.storageState)) !== canonical(state) ||
          canonical(parsed(anchor.volumeIdentity)) !== canonical(identity) ||
          object(object(fence.metadata).labels)["pgcf.io/gateway-fence"] !==
            "true" ||
          (object(sm.annotations)["pgcf.io/gateway-fence-uid"] !== undefined &&
            object(sm.annotations)["pgcf.io/gateway-fence-uid"] !==
              object(fence.metadata).uid)
        )
          throw new BootstrapError("patch_legacy_storage_anchor_changed");
        const binding = LegacyStorageBinding.parse({
          database_id: db.database_id,
          storage_uid: sm.uid,
          namespace_uid: object(ns.metadata).uid,
          cluster_uid: object(cluster.metadata).uid,
          physical_generation: db.storage_generation,
          volume_identity: identity,
        });
        const [pv, claims, lvms] = await Promise.all([
          get(["persistentvolume", binding.volume_identity.handle]),
          get(["persistentvolumeclaims", "--namespace", namespace]),
          get([
            "lvmvolumes.local.openebs.io",
            "--all-namespaces",
            "--field-selector",
            `metadata.name=${binding.volume_identity.handle}`,
          ]),
        ]);
        const pvSpec = object(pv.spec),
          ref = object(pvSpec.claimRef),
          claim = objects(claims.items).find(
            (value) => object(value.metadata).uid === identity.claimUid,
          ),
          lvm = objects(lvms.items),
          affinity = object(object(pvSpec.nodeAffinity ?? {}).required ?? {});
        const pinnedNode =
          Array.isArray(affinity.nodeSelectorTerms) &&
          affinity.nodeSelectorTerms.length > 0 &&
          objects(affinity.nodeSelectorTerms).every(
            (term) =>
              Array.isArray(term.matchExpressions) &&
              objects(term.matchExpressions).some(
                (value) =>
                  ["openebs.io/nodename", "kubernetes.io/hostname"].includes(
                    String(value.key),
                  ) &&
                  value.operator === "In" &&
                  Array.isArray(value.values) &&
                  value.values.length === 1 &&
                  value.values[0] === db.k8s_node_name,
              ),
          );
        if (
          object(pv.metadata).uid !== identity.volumeUid ||
          object(pv.metadata).deletionTimestamp ||
          object(pv.status).phase !== "Bound" ||
          pvSpec.storageClassName !== "pgcf-lvm" ||
          object(pvSpec.csi).driver !== "local.csi.openebs.io" ||
          object(pvSpec.csi).volumeHandle !== identity.handle ||
          ref.namespace !== namespace ||
          ref.uid !== identity.claimUid ||
          !pinnedNode ||
          !claim ||
          object(claim.metadata).namespace !== namespace ||
          object(claim.metadata).deletionTimestamp ||
          object(claim.metadata).name !== ref.name ||
          object(claim.spec).volumeName !== object(pv.metadata).name ||
          object(claim.spec).storageClassName !== "pgcf-lvm" ||
          object(claim.status).phase !== "Bound" ||
          lvm.length !== 1 ||
          object(lvm[0]!.metadata).name !== binding.volume_identity.handle ||
          typeof object(lvm[0]!.metadata).uid !== "string" ||
          object(lvm[0]!.metadata).deletionTimestamp
        )
          throw new BootstrapError("patch_legacy_storage_volume_changed");
        return binding;
      }),
    );
    const failed = reads.find((read) => read.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    for (const read of reads)
      if (read.status === "fulfilled") result.push(read.value);
  }
  return LegacyStorageBindings.parse(
    result.sort((a, b) => a.database_id.localeCompare(b.database_id)),
  );
}
