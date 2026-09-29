// SPDX-License-Identifier: Apache-2.0
import { RUN_EPOCH_ANNOTATION, validRunEpoch } from "./run-epoch.ts";
import type { Kubernetes, Resource } from "./types.ts";

export interface ComputeEffectiveBinding {
  environmentId: string;
  regionId: string;
  namespaceUid: string;
  clusterUid: string;
  baseSpecHash: string;
  runEpoch: string;
  target: { cpuMilli: number; memoryMiB: number };
  instances: number;
  oldPodUids: string[];
}

export interface ComputeEffectiveObservation {
  namespaceUid: string;
  clusterUid: string;
  clusterGeneration: number;
  runEpoch: string;
  cpuMilli: number;
  memoryMiB: number;
  primaryPodUid: string;
  podUids: string[];
}

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const hash = /^[a-f0-9]{64}$/;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validBinding(binding: ComputeEffectiveBinding): boolean {
  return (
    [
      binding.environmentId,
      binding.regionId,
      binding.namespaceUid,
      binding.clusterUid,
    ].every((value) => typeof value === "string" && uuid.test(value)) &&
    typeof binding.baseSpecHash === "string" &&
    hash.test(binding.baseSpecHash) &&
    validRunEpoch(binding.runEpoch) &&
    Number.isSafeInteger(binding.instances) &&
    binding.instances >= 1 &&
    binding.instances <= 9 &&
    Number.isSafeInteger(binding.target?.cpuMilli) &&
    binding.target.cpuMilli > 0 &&
    binding.target.cpuMilli <= 1_000_000 &&
    Number.isSafeInteger(binding.target?.memoryMiB) &&
    binding.target.memoryMiB > 0 &&
    binding.target.memoryMiB <= 1_048_576 &&
    Array.isArray(binding.oldPodUids) &&
    binding.oldPodUids.length === binding.instances &&
    binding.oldPodUids.every(
      (value) => typeof value === "string" && uuid.test(value),
    ) &&
    new Set(binding.oldPodUids).size === binding.instances
  );
}

function owned(
  resource: Resource,
  kind: "Namespace" | "Cluster",
  namespace: string,
  binding: ComputeEffectiveBinding,
): boolean {
  const metadata = resource.metadata;
  return (
    resource.kind === kind &&
    resource.apiVersion ===
      (kind === "Namespace" ? "v1" : "postgresql.cnpg.io/v1") &&
    metadata.name === (kind === "Namespace" ? namespace : "database") &&
    (kind === "Namespace" || metadata.namespace === namespace) &&
    metadata.uid ===
      (kind === "Namespace" ? binding.namespaceUid : binding.clusterUid) &&
    metadata.deletionTimestamp === undefined &&
    metadata.labels?.["app.kubernetes.io/managed-by"] ===
      "cloudflare-postgres" &&
    metadata.labels["pgcf.io/environment-id"] === binding.environmentId &&
    metadata.labels["pgcf.io/region-id"] === binding.regionId &&
    metadata.annotations?.["pgcf.io/spec-hash"] === binding.baseSpecHash &&
    metadata.annotations[RUN_EPOCH_ANNOTATION] === binding.runEpoch
  );
}

function cpuMilli(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,9}m?$/.test(value))
    return null;
  const milli = value.endsWith("m");
  return BigInt(milli ? value.slice(0, -1) : value) * (milli ? 1n : 1000n);
}

function memoryMiB(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  const match = /^([1-9][0-9]{0,9})(Mi|Gi|Ti)$/.exec(value);
  if (!match) return null;
  const factor = match[2] === "Mi" ? 1n : match[2] === "Gi" ? 1024n : 1048576n;
  return BigInt(match[1]!) * factor;
}

function resourcesMatch(
  value: unknown,
  target: ComputeEffectiveBinding["target"],
): boolean {
  if (!object(value) || !object(value.requests) || !object(value.limits))
    return false;
  return [value.requests, value.limits].every(
    (resources) =>
      cpuMilli(resources.cpu) === BigInt(target.cpuMilli) &&
      memoryMiB(resources.memory) === BigInt(target.memoryMiB),
  );
}

function ready(resource: Resource): boolean {
  return (
    resource.status?.conditions?.some(
      (condition) =>
        condition.type === "Ready" &&
        condition.status === "True" &&
        (resource.kind !== "Cluster" ||
          condition.observedGeneration === undefined ||
          condition.observedGeneration === resource.metadata.generation),
    ) === true
  );
}

function stable(before: Resource, after: Resource): boolean {
  return (
    before.metadata.uid === after.metadata.uid &&
    before.metadata.generation === after.metadata.generation &&
    before.metadata.resourceVersion === after.metadata.resourceVersion &&
    before.status?.currentPrimary === after.status?.currentPrimary &&
    before.status?.readyInstances === after.status?.readyInstances
  );
}

function completedInitdbPod(
  pod: Resource,
  owner:
    NonNullable<Resource["metadata"]["ownerReferences"]>[number] | undefined,
): boolean {
  const labels = pod.metadata.labels;
  const instanceName = labels?.["cnpg.io/instanceName"];
  if (!instanceName || !/^database-[1-9][0-9]{0,2}$/.test(instanceName))
    return false;
  const jobName = `${instanceName}-initdb`;
  return (
    pod.status?.phase === "Succeeded" &&
    labels?.["cnpg.io/cluster"] === "database" &&
    labels["cnpg.io/podRole"] === undefined &&
    labels["cnpg.io/jobRole"] === "initdb" &&
    labels["batch.kubernetes.io/job-name"] === jobName &&
    labels["batch.kubernetes.io/controller-uid"] === owner?.uid &&
    (labels["job-name"] === undefined || labels["job-name"] === jobName) &&
    (labels["controller-uid"] === undefined ||
      labels["controller-uid"] === owner?.uid) &&
    pod.metadata.name.startsWith(`${jobName}-`) &&
    /^[a-z0-9]{5}$/.test(pod.metadata.name.slice(jobName.length + 1)) &&
    owner?.kind === "Job" &&
    owner.name === jobName &&
    typeof owner.uid === "string" &&
    uuid.test(owner.uid) &&
    owner.apiVersion === "batch/v1"
  );
}

export async function observeEffectiveCompute(
  api: Pick<Kubernetes, "read" | "listPods">,
  binding: ComputeEffectiveBinding,
): Promise<ComputeEffectiveObservation | null> {
  if (!validBinding(binding))
    throw new Error("compute_effective_binding_invalid");
  const namespace = `pgcf-${binding.environmentId.replaceAll("-", "")}`;
  const originalNamespace = await api.read("Namespace", namespace, namespace);
  if (!originalNamespace) return null;
  if (!owned(originalNamespace, "Namespace", namespace, binding))
    throw new Error("compute_effective_ownership_mismatch");
  const cluster = await api.read("Cluster", namespace, "database");
  if (!cluster) return null;
  if (!owned(cluster, "Cluster", namespace, binding))
    throw new Error("compute_effective_ownership_mismatch");
  if (
    !originalNamespace.metadata.resourceVersion ||
    !cluster.metadata.resourceVersion ||
    !Number.isSafeInteger(cluster.metadata.generation) ||
    cluster.metadata.generation! < 1 ||
    !object(cluster.spec) ||
    cluster.spec.instances !== binding.instances ||
    !resourcesMatch(cluster.spec.resources, binding.target) ||
    (cluster.status?.observedGeneration !== undefined &&
      cluster.status.observedGeneration !== cluster.metadata.generation) ||
    cluster.status?.readyInstances !== binding.instances ||
    !cluster.status.currentPrimary ||
    !ready(cluster)
  )
    return null;

  // listPods is the bounded, complete CNPG label-selector inventory supplied
  // by kubernetesFromConfig. A partial/uncertain list throws before this point.
  const inspectCurrentPods = async (): Promise<{
    instancePods: Resource[];
    primary: Resource;
  } | null> => {
    const pods = await api.listPods(namespace, "database");
    if (!Array.isArray(pods) || pods.length > 100)
      throw new Error("compute_effective_inventory_invalid");
    const names = new Set<string>();
    const uids = new Set<string>();
    const instancePods: Resource[] = [];
    for (const pod of pods) {
      if (
        pod.kind !== "Pod" ||
        pod.apiVersion !== "v1" ||
        pod.metadata.namespace !== namespace ||
        !pod.metadata.name ||
        !pod.metadata.uid ||
        !uuid.test(pod.metadata.uid) ||
        names.has(pod.metadata.name) ||
        uids.has(pod.metadata.uid)
      )
        throw new Error("compute_effective_inventory_invalid");
      names.add(pod.metadata.name);
      uids.add(pod.metadata.uid);
      const owners = pod.metadata.ownerReferences?.filter(
        (owner) => owner.controller === true,
      );
      if (owners?.length !== 1)
        throw new Error("compute_effective_ownership_mismatch");
      if (
        pod.metadata.labels?.["cnpg.io/cluster"] !== "database" ||
        (pod.metadata.labels["pgcf.io/environment-id"] !== undefined &&
          pod.metadata.labels["pgcf.io/environment-id"] !==
            binding.environmentId) ||
        (pod.metadata.labels["pgcf.io/region-id"] !== undefined &&
          pod.metadata.labels["pgcf.io/region-id"] !== binding.regionId) ||
        (pod.metadata.annotations?.["pgcf.io/spec-hash"] !== undefined &&
          pod.metadata.annotations["pgcf.io/spec-hash"] !==
            binding.baseSpecHash) ||
        (pod.metadata.annotations?.[RUN_EPOCH_ANNOTATION] !== undefined &&
          pod.metadata.annotations[RUN_EPOCH_ANNOTATION] !== binding.runEpoch)
      )
        throw new Error("compute_effective_ownership_mismatch");
      if (completedInitdbPod(pod, owners[0])) continue;
      if (
        owners[0]?.uid !== binding.clusterUid ||
        owners[0]?.kind !== "Cluster" ||
        owners[0]?.name !== "database" ||
        owners[0]?.apiVersion !== "postgresql.cnpg.io/v1" ||
        pod.metadata.labels["cnpg.io/podRole"] !== "instance"
      )
        throw new Error("compute_effective_ownership_mismatch");
      instancePods.push(pod);
    }
    if (
      instancePods.length !== binding.instances ||
      binding.oldPodUids.some((uid) => uids.has(uid))
    )
      return null;

    const primary = instancePods.filter(
      (pod) => pod.metadata.name === cluster.status?.currentPrimary,
    );
    if (
      primary.length !== 1 ||
      primary[0]?.metadata.labels?.["cnpg.io/instanceRole"] !== "primary"
    )
      return null;
    for (const pod of instancePods) {
      const containers = pod.spec?.containers;
      const postgres = Array.isArray(containers)
        ? containers.filter((item) => object(item) && item.name === "postgres")
        : [];
      const statuses = pod.status?.containerStatuses?.filter(
        (item) => item.name === "postgres",
      );
      if (
        pod.metadata.deletionTimestamp ||
        pod.status?.phase !== "Running" ||
        !ready(pod) ||
        postgres.length !== 1 ||
        statuses?.length !== 1 ||
        !statuses[0]?.ready ||
        !resourcesMatch(
          (postgres[0] as Record<string, unknown>).resources,
          binding.target,
        ) ||
        !resourcesMatch(statuses[0].resources, binding.target)
      )
        return null;
    }
    return { instancePods, primary: primary[0]! };
  };
  const first = await inspectCurrentPods();
  if (!first) return null;
  const finalNamespace = await api.read("Namespace", namespace, namespace);
  const finalCluster = await api.read("Cluster", namespace, "database");
  if (!finalNamespace || !finalCluster) return null;
  if (
    !owned(finalNamespace, "Namespace", namespace, binding) ||
    !owned(finalCluster, "Cluster", namespace, binding)
  )
    throw new Error("compute_effective_ownership_mismatch");
  if (
    !stable(originalNamespace, finalNamespace) ||
    !stable(cluster, finalCluster) ||
    !ready(finalCluster)
  )
    return null;
  // A ready Cluster status does not freeze its Pods. Re-enumerate once after
  // the final owner read and require the same ready instance identities/RVs.
  const last = await inspectCurrentPods();
  if (!last || first.primary.metadata.uid !== last.primary.metadata.uid)
    return null;
  const initialByUid = new Map(
    first.instancePods.map((pod) => [pod.metadata.uid, pod]),
  );
  for (const pod of last.instancePods) {
    const initial = initialByUid.get(pod.metadata.uid);
    if (
      !initial ||
      !initial.metadata.resourceVersion ||
      initial.metadata.name !== pod.metadata.name ||
      initial.metadata.resourceVersion !== pod.metadata.resourceVersion
    )
      return null;
  }
  return {
    namespaceUid: binding.namespaceUid,
    clusterUid: binding.clusterUid,
    clusterGeneration: cluster.metadata.generation!,
    runEpoch: binding.runEpoch,
    cpuMilli: binding.target.cpuMilli,
    memoryMiB: binding.target.memoryMiB,
    primaryPodUid: last.primary.metadata.uid!,
    podUids: last.instancePods.map((pod) => pod.metadata.uid!).sort(),
  };
}
