// SPDX-License-Identifier: Apache-2.0
import { isIP } from "node:net";
import {
  NodeBootstrapSpec,
  type NodeBootstrapInput,
} from "@pgcf/contracts/node-bootstrap";
import { parseQuantityBytes } from "../../../infra/talos/publish-storage-capacity.ts";
import {
  BootstrapError,
  TALOS_VERSION,
  canonical,
  jsonRecords,
  type CommandResult,
} from "./bootstrap.ts";

type Json = Record<string, unknown>;
const uidPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const lvmUuidPattern = /^[A-Za-z0-9]{6}-(?:[A-Za-z0-9]{4}-){5}[A-Za-z0-9]{6}$/;
const outputLimit = 512 * 1024;

export interface StorageReadCommands {
  authorize(): Promise<string>;
  kube(
    args: string[],
    permitFailure?: boolean,
    stdin?: string,
  ): Promise<CommandResult>;
  talos(args: string[]): Promise<CommandResult>;
}
export interface StorageLogicalVolume {
  name: string;
  uuid: string;
  path: string;
  size_bytes: number;
  active: boolean;
}
export interface StorageFacts {
  cluster_uid: string;
  storage_namespace_uid: string;
  node_uid: string;
  node_resource_version: string;
  lvmnode_uid: string;
  lvmnode_resource_version: string;
  vg_uuid: string;
  pv_uuid: string;
  total_bytes: number;
  free_bytes: number;
  extent_size_bytes: number;
  raw_partition: {
    device: string;
    parent_device: string;
    partition_uuid: string;
    partition_index: number;
    size_bytes: number;
  };
  logical_volumes: StorageLogicalVolume[];
  observed_at: string;
  node: Json;
  lvmnode: Json;
}

function fail(code: string): never {
  throw new BootstrapError(code);
}
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("storage_readback_invalid");
  return value as Json;
}
function array(value: unknown): Json[] {
  if (!Array.isArray(value)) return fail("storage_readback_invalid");
  return value.map(object);
}
function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    /[\r\n\0]/.test(value)
  )
    return fail("storage_readback_invalid");
  return value;
}
function uid(value: unknown): string {
  const result = text(value);
  if (!uidPattern.test(result)) return fail("storage_readback_invalid");
  return result;
}
function lvmUuid(value: unknown): string {
  const result = text(value);
  if (!lvmUuidPattern.test(result)) return fail("storage_physical_lvm_invalid");
  return result;
}
function physicalBytes(value: unknown, positive = false): number {
  try {
    const bytes = parseQuantityBytes(value);
    if (positive && bytes <= 0) return fail("storage_physical_lvm_invalid");
    return bytes;
  } catch {
    return fail("storage_physical_lvm_invalid");
  }
}
function count(value: unknown): number {
  if (typeof value !== "string" || !/^\d+$/.test(value))
    return fail("storage_physical_lvm_invalid");
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    return fail("storage_physical_lvm_invalid");
  return result;
}
function body(result: CommandResult): string {
  if (result.exit_code !== 0) return fail("storage_command_failed");
  if (Buffer.byteLength(result.stdout) > outputLimit)
    return fail("storage_readback_limit");
  return result.stdout;
}
function parsed(result: CommandResult): Json {
  try {
    return object(JSON.parse(body(result)));
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    return fail("storage_readback_invalid");
  }
}
function talosRecords(
  result: CommandResult,
  type: string,
  namespace: string,
  ipv4: string,
  empty = false,
): Json[] {
  const stdout = body(result);
  if (empty && !stdout.trim()) return [];
  const records = jsonRecords(stdout);
  for (const record of records) {
    const metadata = object(record.metadata);
    if (
      record.node !== ipv4 ||
      metadata.type !== type ||
      metadata.namespace !== namespace ||
      metadata.phase !== "running"
    )
      return fail("storage_talos_identity_mismatch");
  }
  return records;
}
function namespace(value: Json, name: string): string {
  const metadata = object(value.metadata);
  if (
    value.apiVersion !== "v1" ||
    value.kind !== "Namespace" ||
    metadata.name !== name ||
    metadata.deletionTimestamp ||
    object(value.status).phase !== "Active"
  )
    return fail("storage_namespace_identity_mismatch");
  return uid(metadata.uid);
}
function nodeIdentity(value: Json, spec: NodeBootstrapSpec) {
  const metadata = object(value.metadata),
    labels = object(metadata.labels),
    nodeSpec = object(value.spec),
    status = object(value.status);
  const ready = array(status.conditions).filter(
    (condition) => condition.type === "Ready",
  );
  const ipv4 = array(status.addresses).filter(
    (address) =>
      address.type === "InternalIP" &&
      typeof address.address === "string" &&
      isIP(address.address) === 4,
  );
  const quarantine = array(nodeSpec.taints).filter(
    (taint) => taint.key === "pgcf.io/quarantine",
  );
  if (
    value.apiVersion !== "v1" ||
    value.kind !== "Node" ||
    metadata.name !== spec.hostname ||
    metadata.deletionTimestamp ||
    labels["pgcf.io/node-id"] !== spec.node_id ||
    labels["pgcf.io/provider-instance-id"] !== spec.provider_instance_id ||
    labels["pgcf.io/region"] !== spec.region_id ||
    (nodeSpec.unschedulable !== undefined &&
      nodeSpec.unschedulable !== false) ||
    ready.length !== 1 ||
    ready[0]!.status !== "True" ||
    ipv4.length !== 1 ||
    ipv4[0]!.address !== spec.hardware.ipv4 ||
    quarantine.length !== 1 ||
    quarantine[0]!.value !== "bootstrap" ||
    quarantine[0]!.effect !== "NoSchedule"
  )
    return fail("storage_node_identity_mismatch");
  return { uid: uid(metadata.uid), version: text(metadata.resourceVersion) };
}
function lvmnodeIdentity(value: Json, name: string, nodeUid: string) {
  const metadata = object(value.metadata);
  if (
    value.apiVersion !== "local.openebs.io/v1alpha1" ||
    value.kind !== "LVMNode" ||
    metadata.namespace !== "openebs" ||
    metadata.name !== name ||
    metadata.deletionTimestamp
  )
    return fail("storage_lvmnode_identity_mismatch");
  const owners = array(metadata.ownerReferences),
    owner = owners[0];
  if (
    owners.length !== 1 ||
    !owner ||
    owner.apiVersion !== "v1" ||
    owner.kind !== "Node" ||
    owner.name !== name ||
    owner.uid !== nodeUid ||
    owner.controller !== true
  )
    return fail("storage_lvmnode_owner_mismatch");
  const groups = array(value.volumeGroups).filter(
      (group) => group.name === "pgcf",
    ),
    group = groups[0];
  if (
    groups.length !== 1 ||
    !group ||
    group.permissions !== 0 ||
    group.missingPvCount !== 0 ||
    (group.thinPools !== undefined &&
      (!Array.isArray(group.thinPools) || group.thinPools.length !== 0))
  )
    return fail("storage_capacity_unsettled");
  return {
    uid: uid(metadata.uid),
    version: text(metadata.resourceVersion),
    vg_uuid: lvmUuid(group.uuid),
    total: physicalBytes(group.size, true),
    free: physicalBytes(group.free),
  };
}
function physicalGroup(records: Json[]) {
  const groups = records.filter(
      (record) =>
        object(record.metadata).id === "pgcf" &&
        object(record.spec).name === "pgcf",
    ),
    record = groups[0];
  if (groups.length !== 1 || !record) return fail("storage_capacity_unsettled");
  const group = object(record.spec);
  if (
    group.format !== "lvm2" ||
    group.permissions !== "writeable" ||
    group.exported !== "" ||
    group.partial !== "" ||
    count(group.pvCount) !== 1 ||
    count(group.missingPVCount) !== 0 ||
    count(group.snapCount) !== 0
  )
    return fail("storage_physical_lvm_invalid");
  const total = physicalBytes(group.size, true),
    free = physicalBytes(group.free),
    extent = physicalBytes(group.extentSize, true),
    extents = count(group.extentCount),
    freeExtents = count(group.freeExtentCount);
  if (
    free > total ||
    extent % 512 !== 0 ||
    BigInt(extent) * BigInt(extents) !== BigInt(total) ||
    BigInt(extent) * BigInt(freeExtents) !== BigInt(free)
  )
    return fail("storage_capacity_unsettled");
  return {
    uuid: lvmUuid(group.uuid),
    total,
    free,
    extent,
    extents,
    freeExtents,
    lvCount: count(group.lvCount),
    seqNo: count(group.seqNo),
  };
}

/** Pinned Talos v1.14.1 PV/VG/LV status mirrors authenticated native pvs/vgs/lvs observations.
 * Definitions: siderolabs/talos@2f86b9d2a29b413deddd7122a8420b8913813615,
 * pkg/machinery/resources/storage/lvm_{physical_volume,volume_group,logical_volume}_status.go.
 * Block events refresh these resources; a mixed CSI/physical read remains unknown for caller polling. */
export async function readStorageFacts(
  input: NodeBootstrapInput,
  commands: StorageReadCommands,
): Promise<StorageFacts> {
  const spec = NodeBootstrapSpec.parse(input.spec);
  const clusterUid = uid(await commands.authorize());
  if (
    (spec.cluster_uid !== null && spec.cluster_uid !== clusterUid) ||
    (input.join_bundle && input.join_bundle.kube_system_uid !== clusterUid)
  )
    return fail("storage_cluster_identity_mismatch");
  const authorize = async () => {
    if ((await commands.authorize()) !== clusterUid)
      return fail("storage_cluster_identity_mismatch");
  };
  const kube = async (args: string[]) => {
    await authorize();
    return parsed(await commands.kube(args));
  };
  const talos = async (args: string[]) => {
    await authorize();
    return await commands.talos(args);
  };
  const settled = async <T>(reads: Promise<T>[]) => {
    const results = await Promise.allSettled(reads);
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
    return results.map((result) => (result as PromiseFulfilledResult<T>).value);
  };
  const nodeArgs = ["get", `--raw=/api/v1/nodes/${spec.hostname}`],
    lvmArgs = [
      "get",
      `--raw=/apis/local.openebs.io/v1alpha1/namespaces/openebs/lvmnodes/${spec.hostname}`,
    ],
    clusterArgs = ["get", "--raw=/api/v1/namespaces/kube-system"],
    namespaceArgs = ["get", "--raw=/api/v1/namespaces/openebs"];
  const initial = await settled([
    kube(clusterArgs),
    kube(namespaceArgs),
    kube(nodeArgs),
    kube(lvmArgs),
  ]);
  if (namespace(initial[0]!, "kube-system") !== clusterUid)
    return fail("storage_cluster_identity_mismatch");
  const storageNamespaceUid = namespace(initial[1]!, "openebs");
  const firstIdentity = nodeIdentity(initial[2]!, spec),
    firstCsi = lvmnodeIdentity(initial[3]!, spec.hostname, firstIdentity.uid);
  const readTalos = async (
    kind: string,
    type: string,
    namespace: string,
    empty = false,
  ) =>
    talosRecords(
      await talos(["get", kind, "--namespace", namespace, "--output", "json"]),
      type,
      namespace,
      spec.hardware.ipv4,
      empty,
    );
  const initialTalos = await settled([
    talos(["version", "--json"]).then((result) => [parsed(result)]),
    readTalos("disks", "Disks.block.talos.dev", "runtime"),
    readTalos("volumestatus", "VolumeStatuses.block.talos.dev", "runtime"),
    readTalos(
      "lvmvolumegroupstatus",
      "LVMVolumeGroupStatuses.storage.talos.dev",
      "storage",
    ),
  ]);
  if (object(initialTalos[0]![0]!.version).tag !== `v${TALOS_VERSION}`)
    return fail("storage_talos_version_mismatch");
  const disks = initialTalos[1]!;
  const matches = disks.filter(
    (disk) =>
      object(disk.spec).dev_path === spec.hardware.install_disk &&
      physicalBytes(object(disk.spec).size, true) === spec.hardware.disk_bytes,
  );
  if (matches.length !== 1) return fail("storage_install_disk_mismatch");
  const volumes = initialTalos[2]!;
  const raw = volumes.filter(
      (volume) => object(volume.metadata).id === "r-pgcf-lvm",
    ),
    rawVolume = raw[0];
  if (raw.length !== 1 || !rawVolume)
    return fail("storage_raw_partition_mismatch");
  const volume = object(rawVolume.spec),
    index = volume.partitionIndex,
    partitionSize = physicalBytes(volume.size, true),
    device = text(volume.location);
  const prefix =
    spec.hardware.install_disk +
    (/\d$/.test(spec.hardware.install_disk) ? "p" : "");
  if (
    volume.phase !== "ready" ||
    volume.type !== "partition" ||
    volume.parentLocation !== spec.hardware.install_disk ||
    typeof index !== "number" ||
    !Number.isSafeInteger(index) ||
    index < 1 ||
    device !== `${prefix}${index}` ||
    partitionSize > spec.hardware.disk_bytes ||
    partitionSize % 512 !== 0
  )
    return fail("storage_raw_partition_mismatch");
  const rawPartition = {
    device,
    parent_device: spec.hardware.install_disk,
    partition_uuid: uid(volume.partitionUUID),
    partition_index: index,
    size_bytes: partitionSize,
  };
  const readGroup = async () =>
    physicalGroup(
      await readTalos(
        "lvmvolumegroupstatus",
        "LVMVolumeGroupStatuses.storage.talos.dev",
        "storage",
      ),
    );
  const group = physicalGroup(initialTalos[3]!);
  const physicalAndLogical = await settled([
    readTalos(
      "lvmphysicalvolumestatus",
      "LVMPhysicalVolumeStatuses.storage.talos.dev",
      "storage",
    ),
    readTalos(
      "lvmlogicalvolumestatus",
      "LVMLogicalVolumeStatuses.storage.talos.dev",
      "storage",
      true,
    ),
  ]);
  const physicals = physicalAndLogical[0]!.filter(
      (record) => object(record.spec).vgName === "pgcf",
    ),
    physical = physicals[0];
  if (physicals.length !== 1 || !physical)
    return fail("storage_physical_pv_mismatch");
  const pv = object(physical.spec);
  if (
    pv.device !== device ||
    pv.format !== "lvm2" ||
    pv.allocatable !== "allocatable" ||
    pv.exported !== "" ||
    pv.missing !== "" ||
    pv.inUse !== "used"
  )
    return fail("storage_physical_pv_mismatch");
  const pvUuid = lvmUuid(pv.uuid);
  if (
    physicalBytes(pv.deviceSize, true) !== partitionSize ||
    physicalBytes(pv.size, true) !== group.total ||
    physicalBytes(pv.free) !== group.free ||
    physicalBytes(pv.used) !== group.total - group.free ||
    count(pv.peCount) !== group.extents ||
    count(pv.peAllocCount) !== group.extents - group.freeExtents ||
    group.total > partitionSize
  )
    return fail("storage_capacity_unsettled");
  const logical = physicalAndLogical[1]!.filter(
    (record) => object(record.spec).vgName === "pgcf",
  );
  const logicalVolumes: StorageLogicalVolume[] = logical
    .map((record) => {
      const value = object(record.spec),
        name = text(value.name),
        path = text(value.path),
        size = physicalBytes(value.size, true);
      if (
        !/^[A-Za-z0-9_+.-]{1,128}$/.test(name) ||
        path !== `/dev/pgcf/${name}` ||
        value.fullName !== `pgcf/${name}` ||
        value.layout !== "linear" ||
        value.role !== "public" ||
        value.permissions !== "writeable" ||
        !["active", ""].includes(String(value.active)) ||
        value.suspended !== "" ||
        value.origin !== "" ||
        value.poolLV !== "" ||
        size % group.extent !== 0
      )
        return fail("storage_physical_lvm_invalid");
      return {
        name,
        uuid: lvmUuid(value.uuid),
        path,
        size_bytes: size,
        active: value.active === "active",
      };
    })
    .toSorted((a, b) => a.name.localeCompare(b.name));
  if (
    logicalVolumes.length !== group.lvCount ||
    new Set(logicalVolumes.map((value) => value.name)).size !==
      logicalVolumes.length ||
    new Set(logicalVolumes.map((value) => value.uuid)).size !==
      logicalVolumes.length ||
    logicalVolumes.reduce(
      (total, value) => total + BigInt(value.size_bytes),
      0n,
    ) !== BigInt(group.total - group.free)
  )
    return fail("storage_capacity_unsettled");
  if (canonical(await readGroup()) !== canonical(group))
    return fail("storage_capacity_unsettled");
  const final = await settled([
    kube(nodeArgs),
    kube(lvmArgs),
    kube(namespaceArgs),
    kube(clusterArgs),
  ]);
  const node = final[0]!,
    currentNode = nodeIdentity(node, spec);
  if (currentNode.uid !== firstIdentity.uid)
    return fail("storage_node_identity_changed");
  const lvmnode = final[1]!,
    csi = lvmnodeIdentity(lvmnode, spec.hostname, currentNode.uid);
  if (
    csi.uid !== firstCsi.uid ||
    csi.vg_uuid !== firstCsi.vg_uuid ||
    csi.vg_uuid !== group.uuid
  )
    return fail("storage_lvmnode_identity_changed");
  if (
    firstCsi.total !== group.total ||
    firstCsi.free !== group.free ||
    csi.total !== group.total ||
    csi.free !== group.free
  )
    return fail("storage_capacity_unsettled");
  if (namespace(final[2]!, "openebs") !== storageNamespaceUid)
    return fail("storage_namespace_identity_mismatch");
  if (namespace(final[3]!, "kube-system") !== clusterUid)
    return fail("storage_cluster_identity_mismatch");
  await authorize();
  return {
    cluster_uid: clusterUid,
    storage_namespace_uid: storageNamespaceUid,
    node_uid: currentNode.uid,
    node_resource_version: currentNode.version,
    lvmnode_uid: csi.uid,
    lvmnode_resource_version: csi.version,
    vg_uuid: group.uuid,
    pv_uuid: pvUuid,
    total_bytes: group.total,
    free_bytes: group.free,
    extent_size_bytes: group.extent,
    raw_partition: rawPartition,
    logical_volumes: logicalVolumes,
    observed_at: new Date().toISOString(),
    node,
    lvmnode,
  };
}
