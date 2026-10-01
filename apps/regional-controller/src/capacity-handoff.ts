// SPDX-License-Identifier: Apache-2.0
import { canonicalCohort } from "./node-cohort.ts";
import { quantity } from "./owned-stop.ts";
import type { CapacityJournal } from "./capacity-journal.ts";
import type {
  CapacityConfiguration,
  CapacityRef,
  CapacityRuntime,
  CapacitySnapshot,
  CapacitySlotState,
  CapacityPatch,
} from "./capacity-types.ts";
import type { Resource } from "./types.ts";

type Authority = { check: () => void; expiresAt: () => number };
export interface CapacityFundingFence extends Authority {
  refresh: () => void | Promise<void>;
}
const fail = () => new Error("capacity_handoff_unproven");
const equal = (a: unknown, b: unknown) =>
  canonicalCohort(a) === canonicalCohort(b);
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw fail();
  return v as Record<string, unknown>;
}
function reference(r: Resource): CapacityRef {
  if (
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
      r.metadata.uid ?? "",
    ) ||
    !/^[1-9][0-9]{0,18}$/.test(r.metadata.resourceVersion ?? "") ||
    r.metadata.deletionTimestamp
  )
    throw fail();
  return {
    name: r.metadata.name,
    namespace: r.metadata.namespace ?? "",
    uid: r.metadata.uid!,
    resourceVersion: r.metadata.resourceVersion!,
  };
}
function required(
  r: Resource | null,
  kind: string,
  name: string,
  namespace = "",
): Resource {
  if (
    !r ||
    r.kind !== kind ||
    r.metadata.name !== name ||
    (r.metadata.namespace ?? "") !== namespace
  )
    throw fail();
  reference(r);
  return r;
}
function sameRef(a: CapacityRef, b: CapacityRef): boolean {
  return a.name === b.name && a.namespace === b.namespace && a.uid === b.uid;
}
function claimIdentity(v: unknown, pvc: CapacityRef): boolean {
  const r = object(v);
  return (
    r.apiVersion === "v1" &&
    r.kind === "PersistentVolumeClaim" &&
    r.name === pvc.name &&
    r.namespace === pvc.namespace &&
    r.uid === pvc.uid
  );
}
function owned(r: Resource, s: CapacitySnapshot): boolean {
  return (
    r.metadata.labels?.["app.kubernetes.io/managed-by"] ===
      "cloudflare-postgres" &&
    r.metadata.labels?.["pgcf.io/environment-id"] ===
      s.plan.binding.environmentId &&
    r.metadata.labels?.["pgcf.io/region-id"] === s.plan.binding.regionId &&
    r.metadata.annotations?.["pgcf.io/spec-hash"] === s.plan.binding.specHash
  );
}
function pvcIdentity(
  r: Resource,
  s: CapacitySnapshot,
  slot: CapacitySlotState,
): void {
  const p = object(r.spec),
    owner = r.metadata.ownerReferences;
  const serial = Number(slot.plan.id.replace("database-", "")) + 1;
  if (
    r.metadata.name !== "database-" + serial ||
    !s.clusterUid ||
    owner?.length !== 1 ||
    owner[0]?.apiVersion !== "postgresql.cnpg.io/v1" ||
    owner[0].kind !== "Cluster" ||
    owner[0].name !== "database" ||
    owner[0].uid !== s.clusterUid ||
    owner[0].controller !== true ||
    r.metadata.labels?.["cnpg.io/cluster"] !== "database" ||
    r.metadata.labels?.["cnpg.io/pvcRole"] !== "PG_DATA" ||
    r.metadata.annotations?.["cnpg.io/nodeSerial"] !== String(serial) ||
    (slot.handoffPhase !== "rebound" &&
      r.metadata.annotations?.["cnpg.io/pvcStatus"] !== "initializing") ||
    p.storageClassName !== s.plan.customerStorageClass ||
    !equal(p.accessModes, ["ReadWriteOnce"]) ||
    (p.volumeMode ?? "Filesystem") !== "Filesystem" ||
    p.selector != null ||
    p.dataSource != null ||
    p.dataSourceRef != null ||
    quantity(object(object(p.resources).requests).storage, 1n) !==
      BigInt(slot.plan.volumeBytes!) ||
    r.metadata.annotations?.["volume.kubernetes.io/selected-node"] !== undefined
  )
    throw fail();
}
function physicalPv(pv: Resource, slot: CapacitySlotState): void {
  const p = object(pv.spec),
    csi = object(p.csi),
    terms = object(object(p.nodeAffinity).required).nodeSelectorTerms;
  if (
    !slot.storage ||
    !slot.node ||
    pv.metadata.uid !== slot.storage.pv.uid ||
    p.persistentVolumeReclaimPolicy !== "Retain" ||
    !equal(p.accessModes, ["ReadWriteOnce"]) ||
    (p.volumeMode ?? "Filesystem") !== "Filesystem" ||
    quantity(object(p.capacity).storage, 1n) !== BigInt(slot.storage.bytes) ||
    csi.driver !== "local.csi.openebs.io" ||
    csi.volumeHandle !== slot.storage.csiHandle ||
    !equal(terms, [
      {
        matchExpressions: [
          {
            key: slot.node.topologyKey,
            operator: "In",
            values: [slot.node.name],
          },
        ],
      },
    ])
  )
    throw fail();
}
function tests(r: Resource): CapacityPatch[] {
  return [
    { op: "test", path: "/metadata/uid", value: r.metadata.uid },
    {
      op: "test",
      path: "/metadata/resourceVersion",
      value: r.metadata.resourceVersion,
    },
    { op: "test", path: "/spec", value: r.spec },
  ];
}

// Read-only reclaim of an already completed transfer. The returned value is
// the immutable acquisition receipt, never a fabricated fresh holding claim.
export async function inspectCapacityTransfer(
  read: (
    kind: string,
    namespace: string,
    name: string,
  ) => Promise<Resource | null>,
  state: CapacitySnapshot,
  slot: CapacitySlotState,
): Promise<CapacitySlotState["storage"]> {
  if (slot.handoffPhase !== "rebound") return null;
  if (
    !slot.storage ||
    !slot.targetPvc ||
    !slot.node ||
    !state.namespaceUid ||
    !state.clusterUid
  )
    throw fail();
  const ns = required(
    await read("Namespace", "", state.plan.namespace),
    "Namespace",
    state.plan.namespace,
  );
  const cluster = required(
    await read("Cluster", state.plan.namespace, "database"),
    "Cluster",
    "database",
    state.plan.namespace,
  );
  if (
    ns.metadata.uid !== state.namespaceUid ||
    cluster.metadata.uid !== state.clusterUid ||
    !owned(cluster, state)
  )
    throw fail();
  const target = required(
    await read(
      "PersistentVolumeClaim",
      slot.targetPvc.namespace,
      slot.targetPvc.name,
    ),
    "PersistentVolumeClaim",
    slot.targetPvc.name,
    slot.targetPvc.namespace,
  );
  pvcIdentity(target, state, slot);
  if (
    !sameRef(slot.targetPvc, reference(target)) ||
    object(target.spec).volumeName !== slot.storage.pv.name
  )
    throw fail();
  const pv = required(
    await read("PersistentVolume", "", slot.storage.pv.name),
    "PersistentVolume",
    slot.storage.pv.name,
  );
  physicalPv(pv, slot);
  if (
    object(pv.spec).storageClassName !== state.plan.customerStorageClass ||
    !claimIdentity(object(pv.spec).claimRef, slot.targetPvc)
  )
    throw fail();
  if (
    object(pv.status ?? {}).phase !== "Bound" ||
    object(target.status ?? {}).phase !== "Bound"
  )
    return null;
  const lv = required(
    await read(
      "LVMVolume",
      slot.storage.lvmVolume.namespace,
      slot.storage.lvmVolume.name,
    ),
    "LVMVolume",
    slot.storage.lvmVolume.name,
    slot.storage.lvmVolume.namespace,
  );
  const lvmNode = required(
    await read("LVMNode", slot.storage.lvmVolume.namespace, slot.node.name),
    "LVMNode",
    slot.node.name,
    slot.storage.lvmVolume.namespace,
  );
  const groups = object(lvmNode).volumeGroups;
  if (
    !Array.isArray(groups) ||
    groups.length > 128 ||
    lvmNode.metadata.ownerReferences?.filter(
      (o) => o.kind === "Node" && o.uid === slot.node!.uid,
    ).length !== 1
  )
    throw fail();
  const originalGroups = groups.filter(
    (g) => object(g).uuid === slot.node!.vgUuid,
  );
  if (originalGroups.length !== 1) throw fail();
  const group = object(originalGroups[0]),
    l = object(lv.spec);
  if (
    lv.metadata.uid !== slot.storage.lvmVolume.uid ||
    object(lv.status).state !== "Ready" ||
    l.ownerNodeID !== slot.node.name ||
    l.thinProvision !== "no" ||
    quantity(l.capacity, 1n) !== BigInt(slot.storage.bytes) ||
    group.permissions !== 0 ||
    group.missingPvCount !== 0 ||
    l.volGroup !== group.name ||
    l.vgPattern !== "^" + String(group.name) + "$"
  )
    throw fail();
  return structuredClone(slot.storage);
}

export async function handoffCapacity(
  runtime: CapacityRuntime,
  journal: CapacityJournal,
  slotId: string,
  targetName: string,
  config: CapacityConfiguration,
  authority: Authority,
  funding: CapacityFundingFence,
): Promise<boolean> {
  const deadline = Math.min(Date.now() + 20000, authority.expiresAt());
  let requests = 0;
  const check = () => {
    authority.check();
    if (
      !Number.isSafeInteger(deadline) ||
      Date.now() >= deadline ||
      ++requests > 128
    )
      throw fail();
  };
  const dispatch: Authority = {
    check: () => {
      check();
      funding.check();
    },
    expiresAt: () =>
      Math.min(deadline, authority.expiresAt(), funding.expiresAt()),
  };
  const read = async (kind: string, namespace: string, name: string) => {
    check();
    const r = await runtime.read(kind, namespace, name);
    check();
    return r;
  };
  const list = async (namespace: string) => {
    check();
    const rows = await runtime.list("Pod", namespace);
    check();
    return rows;
  };
  const write = async (work: () => Promise<unknown>) => {
    await funding.refresh();
    funding.check();
    check();
    await work();
    check();
  };
  let state = journal.snapshot();
  const slot = state.slots.find((v) => v.plan.id === slotId);
  if (
    !slot ||
    slot.plan.kind !== "database" ||
    !slot.storage ||
    !slot.node ||
    !state.namespaceUid ||
    !state.clusterUid ||
    !["materializing", "active"].includes(state.phase) ||
    config.installationId !== state.plan.binding.installationId ||
    config.namespace !== state.plan.holdNamespace ||
    config.storageNamespace !== slot.storage.lvmVolume.namespace
  )
    throw fail();
  const inspect = async () => {
    const ns = required(
      await read("Namespace", "", state.plan.namespace),
      "Namespace",
      state.plan.namespace,
    );
    if (ns.metadata.uid !== state.namespaceUid) throw fail();
    const cluster = required(
      await read("Cluster", state.plan.namespace, "database"),
      "Cluster",
      "database",
      state.plan.namespace,
    );
    const storage = object(object(cluster.spec).storage);
    if (
      cluster.metadata.uid !== state.clusterUid ||
      !owned(cluster, state) ||
      storage.storageClass !== state.plan.customerStorageClass ||
      quantity(storage.size, 1n) !== BigInt(slot.storage!.bytes)
    )
      throw fail();
    const quota = required(
      await read("ResourceQuota", state.plan.namespace, "database-resources"),
      "ResourceQuota",
      "database-resources",
      state.plan.namespace,
    );
    if (
      !owned(quota, state) ||
      object(object(quota.spec).hard).pods !== "0" ||
      object(object(quota.status).hard).pods !== "0" ||
      object(object(quota.status).used).pods !== "0" ||
      (await list(state.plan.namespace)).length !== 0
    )
      throw fail();
    const node = required(
      await read("Node", "", slot.node!.name),
      "Node",
      slot.node!.name,
    );
    if (
      node.metadata.uid !== slot.node!.uid ||
      object(object(node.status).nodeInfo).bootID !== slot.node!.bootId ||
      node.metadata.labels?.["openebs.io/nodename"] !== slot.node!.name
    )
      throw fail();
    const lv = required(
      await read(
        "LVMVolume",
        config.storageNamespace,
        slot.storage!.lvmVolume.name,
      ),
      "LVMVolume",
      slot.storage!.lvmVolume.name,
      config.storageNamespace,
    );
    const l = object(lv.spec);
    const lvmNode = required(
      await read("LVMNode", config.storageNamespace, slot.node!.name),
      "LVMNode",
      slot.node!.name,
      config.storageNamespace,
    );
    const groups = object(lvmNode).volumeGroups;
    if (
      !Array.isArray(groups) ||
      groups.length > 128 ||
      lvmNode.metadata.ownerReferences?.filter(
        (o) => o.kind === "Node" && o.uid === slot.node!.uid,
      ).length !== 1
    )
      throw fail();
    const originalGroups = groups.filter(
      (g) => object(g).uuid === slot.node!.vgUuid,
    );
    if (originalGroups.length !== 1) throw fail();
    const group = object(originalGroups[0]);
    if (
      lv.metadata.uid !== slot.storage!.lvmVolume.uid ||
      object(lv.status).state !== "Ready" ||
      l.ownerNodeID !== slot.node!.name ||
      group.permissions !== 0 ||
      group.missingPvCount !== 0 ||
      l.volGroup !== group.name ||
      l.vgPattern !== "^" + String(group.name) + "$" ||
      l.thinProvision !== "no" ||
      quantity(l.capacity, 1n) !== BigInt(slot.storage!.bytes)
    )
      throw fail();
  };
  await inspect();
  let target = required(
    await read("PersistentVolumeClaim", state.plan.namespace, targetName),
    "PersistentVolumeClaim",
    targetName,
    state.plan.namespace,
  );
  pvcIdentity(target, state, slot);
  if (slot.targetPvc && !sameRef(slot.targetPvc, reference(target)))
    throw fail();
  let pv = required(
    await read("PersistentVolume", "", slot.storage.pv.name),
    "PersistentVolume",
    slot.storage.pv.name,
  );
  physicalPv(pv, slot);
  const initialPvSpec = object(pv.spec);
  const originalBinding =
    claimIdentity(initialPvSpec.claimRef, slot.storage.holdPvc) &&
    initialPvSpec.storageClassName === slot.storage.storageClassName;
  const targetBinding =
    claimIdentity(initialPvSpec.claimRef, reference(target)) &&
    initialPvSpec.storageClassName === state.plan.customerStorageClass;
  if (!originalBinding && !targetBinding) throw fail();
  if (slot.handoffPhase === "rebound" && !targetBinding) throw fail();
  const oldRef = slot.handoff?.oldClaimRef ?? object(object(pv.spec).claimRef);
  if (!claimIdentity(oldRef, slot.storage.holdPvc)) throw fail();
  const newRef = slot.handoff?.newClaimRef ?? {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    name: target.metadata.name,
    namespace: state.plan.namespace,
    uid: target.metadata.uid,
  };
  if (!claimIdentity(newRef, reference(target))) throw fail();
  journal.handoff(
    slotId,
    slot.handoff ?? {
      operator: config.admission.operatorUsername,
      targetPvc: reference(target),
      oldClaimRef: oldRef,
      newClaimRef: newRef,
    },
  );
  state = journal.snapshot();
  // First pin the target to this exact PV. It cannot independently provision a
  // replacement while the retained PV is still bound to its holding claim.
  if (!object(target.spec).volumeName) {
    if (object(target.status ?? {}).phase !== "Pending") return false;
    const operations: CapacityPatch[] = [
      ...tests(target),
      { op: "add", path: "/spec/volumeName", value: pv.metadata.name },
    ];
    try {
      await write(() =>
        runtime.patch(
          "PersistentVolumeClaim",
          state.plan.namespace,
          targetName,
          operations,
          dispatch,
        ),
      );
    } catch {
      check();
    }
    target = required(
      await read("PersistentVolumeClaim", state.plan.namespace, targetName),
      "PersistentVolumeClaim",
      targetName,
      state.plan.namespace,
    );
    pvcIdentity(target, state, slot);
    if (
      !sameRef(
        state.slots.find((v) => v.plan.id === slotId)!.targetPvc!,
        reference(target),
      )
    )
      throw fail();
    if (object(target.spec).volumeName !== pv.metadata.name) return false;
  } else if (object(target.spec).volumeName !== pv.metadata.name) throw fail();
  const hold = await read(
    "PersistentVolumeClaim",
    state.plan.holdNamespace,
    slot.storage.holdPvc.name,
  );
  if (hold) {
    if (!originalBinding) throw fail();
    if (
      ["hold_released", "rebound"].includes(
        state.slots.find((v) => v.plan.id === slotId)!.handoffPhase,
      )
    )
      throw fail();
    if (
      !sameRef(slot.storage.holdPvc, reference(hold)) ||
      object(hold.spec).volumeName !== pv.metadata.name
    )
      throw fail();
    const pods = await list(state.plan.holdNamespace);
    if (
      pods.some(
        (pod) =>
          Array.isArray(pod.spec?.volumes) &&
          pod.spec.volumes.some((v) => {
            const c = object(v).persistentVolumeClaim;
            return c && object(c).claimName === hold.metadata.name;
          }),
      )
    )
      throw fail();
    await inspect();
    try {
      await write(() =>
        runtime.remove(
          "PersistentVolumeClaim",
          state.plan.holdNamespace,
          hold.metadata.name,
          hold.metadata.uid!,
          hold.metadata.resourceVersion!,
          dispatch,
        ),
      );
    } catch {
      check();
    }
    if (
      await read(
        "PersistentVolumeClaim",
        state.plan.holdNamespace,
        hold.metadata.name,
      )
    )
      return false;
  } else if (
    state.slots.find((v) => v.plan.id === slotId)!.handoffPhase === "none"
  )
    throw fail();
  if (
    journal.snapshot().slots.find((v) => v.plan.id === slotId)!.handoffPhase !==
    "rebound"
  )
    journal.handoffProgress(slotId, "hold_released");
  pv = required(
    await read("PersistentVolume", "", pv.metadata.name),
    "PersistentVolume",
    pv.metadata.name,
  );
  physicalPv(pv, slot);
  const current = object(pv.spec);
  if (
    claimIdentity(current.claimRef, slot.storage.holdPvc) &&
    current.storageClassName === slot.storage.storageClassName
  ) {
    const operations: CapacityPatch[] = [
      ...tests(pv),
      { op: "replace", path: "/spec/claimRef", value: newRef },
      {
        op: "replace",
        path: "/spec/storageClassName",
        value: state.plan.customerStorageClass,
      },
    ];
    await inspect();
    try {
      await write(() =>
        runtime.patch(
          "PersistentVolume",
          "",
          pv.metadata.name,
          operations,
          dispatch,
        ),
      );
    } catch {
      check();
    }
    pv = required(
      await read("PersistentVolume", "", pv.metadata.name),
      "PersistentVolume",
      pv.metadata.name,
    );
    physicalPv(pv, slot);
    if (!claimIdentity(object(pv.spec).claimRef, reference(target)))
      return false;
  } else if (
    !claimIdentity(current.claimRef, reference(target)) ||
    current.storageClassName !== state.plan.customerStorageClass
  )
    throw fail();
  target = required(
    await read("PersistentVolumeClaim", state.plan.namespace, targetName),
    "PersistentVolumeClaim",
    targetName,
    state.plan.namespace,
  );
  pvcIdentity(target, state, slot);
  if (
    !sameRef(
      journal.snapshot().slots.find((v) => v.plan.id === slotId)!.targetPvc!,
      reference(target),
    ) ||
    object(target.spec).volumeName !== pv.metadata.name ||
    object(pv.spec).storageClassName !== state.plan.customerStorageClass ||
    !claimIdentity(object(pv.spec).claimRef, reference(target))
  )
    throw fail();
  if (
    object(target.status ?? {}).phase !== "Bound" ||
    object(pv.status ?? {}).phase !== "Bound"
  )
    return false;
  await inspect();
  check();
  journal.handoffProgress(slotId, "rebound");
  return true;
}
