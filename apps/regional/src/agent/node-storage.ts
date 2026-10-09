// SPDX-License-Identifier: Apache-2.0
import { NodePhysicalStorage, NodeStorageSample } from "@pgcf/contracts";
import lock from "../../../../infra/platform/versions.lock.json" with { type: "json" };
import { openEbsDriverImage } from "../../../../infra/platform/openebs-image.ts";
import { condition } from "./observe.ts";
import { record, string, type Kubernetes, type Resource } from "./types.ts";

interface Metric {
  name: string;
  labels: Record<string, string>;
  value: number;
}
export interface StorageMetricsKubernetes extends Kubernetes {
  openEbsMetrics?(podName: string): Promise<string>;
}
const driverImage = openEbsDriverImage(lock);
const image = (value: string) => value.replace(/^docker\.io\//, "");
const digest = (value: unknown) =>
  typeof value === "string"
    ? /(?:@sha256:|^sha256:)([0-9a-f]{64})$/.exec(value)?.[1]
    : undefined;

function metrics(text: string): Metric[] {
  if (Buffer.byteLength(text) > 2 * 1024 * 1024)
    throw new Error("storage_metrics_too_large");
  return text
    .split("\n")
    .filter((line) => line.startsWith("lvm_"))
    .map((line) => {
      const match =
        /^(lvm_[a-z0-9_]+)\{(.*)\}\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*$/.exec(
          line,
        );
      if (!match) throw new Error("storage_metrics_invalid");
      const labels: Record<string, string> = {};
      let offset = 0;
      for (const label of match[2]!.matchAll(
        /([a-z_][a-z0-9_]*)="((?:[^"\\]|\\[\\"n])*)"(?:,|$)/g,
      )) {
        if (label.index !== offset || labels[label[1]!] !== undefined)
          throw new Error("storage_metrics_invalid");
        labels[label[1]!] = label[2]!.replace(
          /\\([\\"n])/g,
          (_, value: string) => (value === "n" ? "\n" : value),
        );
        offset += label[0].length;
      }
      const value = Number(match[3]);
      if (offset !== match[2]!.length || !Number.isFinite(value))
        throw new Error("storage_metrics_invalid");
      return { name: match[1]!, labels, value };
    });
}

/** OpenEBS 1.10.1 collects vgs/lvs on each scrape. LVMNode metadata time is not freshness. */
export function physicalStorageMetrics(
  text: string,
  vgUuid: string,
): NodePhysicalStorage | null {
  try {
    const values = metrics(text);
    const one = (name: string, labels: Record<string, string>) => {
      const found = values.filter(
        (metric) =>
          metric.name === name &&
          Object.keys(metric.labels).length === Object.keys(labels).length &&
          Object.entries(labels).every(
            ([key, value]) => metric.labels[key] === value,
          ),
      );
      if (found.length !== 1) throw new Error("storage_metric_missing");
      return found[0]!.value;
    };
    const group = { name: "pgcf" },
      total = one("lvm_vg_total_size_bytes", group),
      free = one("lvm_vg_free_size_bytes", group);
    if (
      one("lvm_vg_permission", group) !== 0 ||
      one("lvm_vg_missing_pv_count", group) !== 0 ||
      one("lvm_vg_pv_count", group) !== 1
    )
      return null;
    const volumes = values.filter(
        (metric) =>
          metric.name === "lvm_lv_total_size_bytes" &&
          metric.labels.vg === "pgcf",
      ),
      names = new Set<string>();
    let thick = 0,
      pool: NodePhysicalStorage["thin_pool"] = null;
    for (const volume of volumes) {
      const labels = volume.labels;
      if (
        !labels.name ||
        names.has(labels.name) ||
        labels.active_status !== "active" ||
        labels.path !== `/dev/pgcf/${labels.name}` ||
        one("lvm_lv_health_status", labels) !== 0 ||
        one("lvm_lv_permission", labels) !== 1 ||
        !Number.isSafeInteger(volume.value) ||
        volume.value <= 0
      )
        return null;
      names.add(labels.name);
      if (labels.segtype === "linear" && labels.pool === "")
        thick += volume.value;
      else if (
        labels.segtype === "thin-pool" &&
        labels.name === "pgcf_thinpool" &&
        labels.pool === "" &&
        pool === null
      ) {
        const metadata = one("lvm_lv_mda_total_size_bytes", labels);
        const upperUsed = (metric: string, size: number) => {
          const percent = one(metric, labels);
          if (percent < 0 || percent > 100)
            throw new Error("storage_percent_invalid");
          // lvs reports percentages rounded to two decimals. Charge the next hundredth conservatively.
          return Math.min(size, Math.ceil((size * (percent + 0.01)) / 100));
        };
        if (one("lvm_lv_when_full", labels) !== 0) return null;
        pool = {
          name: "pgcf_thinpool",
          data_total_bytes: volume.value,
          data_used_bytes_upper_bound: upperUsed(
            "lvm_lv_used_percent",
            volume.value,
          ),
          metadata_total_bytes: metadata,
          metadata_used_bytes_upper_bound: upperUsed(
            "lvm_lv_mda_used_percent",
            metadata,
          ),
        };
      } else if (!(
        labels.segtype === "thin" && labels.pool === "pgcf_thinpool"
      ))
        return null;
    }
    if (!pool && volumes.some((volume) => volume.labels.segtype === "thin"))
      return null;
    return NodePhysicalStorage.parse({
      volume_group_uuid: vgUuid,
      total_bytes: total,
      free_bytes: free,
      thick_allocated_bytes: thick,
      thin_pool: pool,
    });
  } catch {
    return null;
  }
}

function stableNode(node: Resource, expectedUid: string) {
  return (
    node.kind === "Node" &&
    node.metadata.uid === expectedUid &&
    !node.metadata.deletionTimestamp &&
    condition(node, "Ready")?.status === "True"
  );
}
function driverIdentity(pod: Resource, node: Resource) {
  const owners = record(pod.metadata).ownerReferences,
    containers = record(pod.spec).containers,
    statuses = record(pod.status).containerStatuses;
  if (
    !Array.isArray(owners) ||
    !Array.isArray(containers) ||
    !Array.isArray(statuses) ||
    !driverImage ||
    pod.metadata.namespace !== "openebs" ||
    pod.metadata.deletionTimestamp ||
    record(pod.spec).nodeName !== node.metadata.name ||
    condition(pod, "Ready")?.status !== "True"
  )
    return null;
  const controllers = owners
    .map(record)
    .filter((owner) => owner.controller === true);
  const drivers = containers
    .map(record)
    .filter(
      (container) =>
        typeof container.image === "string" &&
        image(container.image) === image(driverImage),
    );
  if (
    controllers.length !== 1 ||
    controllers[0]!.kind !== "DaemonSet" ||
    drivers.length !== 1
  )
    return null;
  const driver = drivers[0]!,
    status = statuses.map(record).find((value) => value.name === driver.name);
  const started = record(record(status?.state).running).startedAt;
  if (
    !pod.metadata.uid ||
    !string(controllers[0]!.uid) ||
    !string(controllers[0]!.name) ||
    status?.ready !== true ||
    !digest(status.imageID) ||
    !Number.isFinite(
      started instanceof Date
        ? started.getTime()
        : typeof started === "string"
          ? Date.parse(started)
          : NaN,
    )
  )
    return null;
  return {
    podUid: pod.metadata.uid,
    ownerUid: string(controllers[0]!.uid)!,
    ownerName: string(controllers[0]!.name)!,
    image: driver.image,
    name: driver.name,
    imageId: digest(status.imageID),
    restarts: status.restartCount,
  };
}

/** Existing authenticated Pod-proxy transport; no pods/exec, host writer, new daemon or provider call. */
export async function nodeStorageSample(
  k8s: StorageMetricsKubernetes,
  node: Resource,
  now = Date.now,
): Promise<NodeStorageSample | undefined> {
  const started = now();
  const expectedUid = node.metadata.uid;
  if (
    !expectedUid ||
    !NodeStorageSample.shape.node_uid.safeParse(expectedUid).success ||
    !k8s.openEbsMetrics
  )
    return undefined;
  const unknown = (): NodeStorageSample => ({
    node_uid: expectedUid,
    observed_at: new Date(now()).toISOString(),
    physical: null,
  });
  try {
    if (!stableNode(node, expectedUid)) return unknown();
    const [cluster, namespace, lvmnode, pods] = await Promise.all([
      k8s.read("Namespace", undefined, "kube-system"),
      k8s.read("Namespace", undefined, "openebs"),
      k8s.read("LVMNode", "openebs", node.metadata.name),
      k8s.list("Pod", "openebs"),
    ]);
    if (
      !cluster?.metadata.uid ||
      !namespace?.metadata.uid ||
      cluster.metadata.deletionTimestamp ||
      namespace.metadata.deletionTimestamp ||
      !lvmnode?.metadata.uid ||
      lvmnode.metadata.deletionTimestamp
    )
      return unknown();
    const owners = record(lvmnode.metadata).ownerReferences;
    if (
      !Array.isArray(owners) ||
      owners.length !== 1 ||
      record(owners[0]).uid !== expectedUid ||
      record(owners[0]).kind !== "Node" ||
      record(owners[0]).name !== node.metadata.name ||
      record(owners[0]).controller !== true
    )
      return unknown();
    const groups = record(lvmnode).volumeGroups;
    if (!Array.isArray(groups)) return unknown();
    const group = groups.map(record).filter((value) => value.name === "pgcf");
    if (group.length !== 1 || !string(group[0]!.uuid)) return unknown();
    const candidates = pods
      .map((pod) => ({ pod, identity: driverIdentity(pod, node) }))
      .filter((value) => value.identity !== null);
    if (candidates.length !== 1) return unknown();
    const { pod, identity } = candidates[0]!,
      owner = await k8s.read("DaemonSet", "openebs", identity!.ownerName);
    if (
      !owner ||
      owner.metadata.uid !== identity!.ownerUid ||
      owner.metadata.deletionTimestamp
    )
      return unknown();
    const desiredContainers = record(
      record(record(owner.spec).template).spec,
    ).containers;
    if (
      !Array.isArray(desiredContainers) ||
      !desiredContainers
        .map(record)
        .some(
          (value) =>
            value.name === identity!.name && value.image === identity!.image,
        )
    )
      return unknown();
    const physical = physicalStorageMetrics(
      await k8s.openEbsMetrics(pod.metadata.name),
      String(group[0]!.uuid),
    );
    const [
      freshNode,
      freshPod,
      freshOwner,
      freshLvm,
      freshNamespace,
      freshCluster,
    ] = await Promise.all([
      k8s.read("Node", undefined, node.metadata.name),
      k8s.read("Pod", "openebs", pod.metadata.name),
      k8s.read("DaemonSet", "openebs", identity!.ownerName),
      k8s.read("LVMNode", "openebs", node.metadata.name),
      k8s.read("Namespace", undefined, "openebs"),
      k8s.read("Namespace", undefined, "kube-system"),
    ]);
    const freshGroups = record(freshLvm).volumeGroups,
      freshOwners = record(freshLvm?.metadata).ownerReferences;
    if (
      !freshNode ||
      !stableNode(freshNode, expectedUid) ||
      !freshPod ||
      JSON.stringify(driverIdentity(freshPod, freshNode)) !==
        JSON.stringify(identity) ||
      freshOwner?.metadata.uid !== owner.metadata.uid ||
      freshOwner.metadata.deletionTimestamp ||
      freshOwner.metadata.resourceVersion !== owner.metadata.resourceVersion ||
      freshLvm?.metadata.uid !== lvmnode.metadata.uid ||
      freshLvm.metadata.deletionTimestamp ||
      !Array.isArray(freshGroups) ||
      freshGroups
        .map(record)
        .filter(
          (value) => value.name === "pgcf" && value.uuid === group[0]!.uuid,
        ).length !== 1 ||
      !Array.isArray(freshOwners) ||
      freshOwners.length !== 1 ||
      record(freshOwners[0]).uid !== expectedUid ||
      record(freshOwners[0]).controller !== true ||
      freshNamespace?.metadata.uid !== namespace.metadata.uid ||
      freshNamespace.metadata.deletionTimestamp ||
      freshCluster?.metadata.uid !== cluster.metadata.uid ||
      freshCluster.metadata.deletionTimestamp ||
      now() - started > 20_000
    )
      return unknown();
    return NodeStorageSample.parse({
      node_uid: expectedUid,
      observed_at: new Date(now()).toISOString(),
      physical,
    });
  } catch {
    return unknown();
  }
}
