// SPDX-License-Identifier: Apache-2.0
import { ReconcileError } from "./types.ts";
import type {
  Kubernetes,
  Observation,
  PoolingPolicy,
  Resource,
} from "./types.ts";

function fields(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function integer(value: unknown, maximum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= maximum
  );
}
export function validPoolingPolicy(value: unknown): value is PoolingPolicy {
  if (
    !fields(value, [
      "version",
      "image",
      "mode",
      "compute",
      "connections",
      "timeouts",
    ]) ||
    value.version !== 1 ||
    value.mode !== "session" ||
    typeof value.image !== "string" ||
    !/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(value.image) ||
    !fields(value.compute, ["requests", "limits"]) ||
    !fields(value.compute.requests, ["cpuMilli", "memoryMiB"]) ||
    !fields(value.compute.limits, ["cpuMilli", "memoryMiB"]) ||
    !integer(value.compute.requests.cpuMilli, 1_000_000) ||
    !integer(value.compute.requests.memoryMiB, 1_048_576) ||
    !integer(value.compute.limits.cpuMilli, 1_000_000) ||
    !integer(value.compute.limits.memoryMiB, 1_048_576) ||
    value.compute.requests.cpuMilli > value.compute.limits.cpuMilli ||
    value.compute.requests.memoryMiB > value.compute.limits.memoryMiB ||
    !fields(value.connections, [
      "maxClients",
      "poolSize",
      "maxDatabaseConnections",
      "maxUserConnections",
    ]) ||
    !integer(value.connections.maxClients, 10_000) ||
    !integer(value.connections.poolSize, 1000) ||
    !integer(value.connections.maxDatabaseConnections, 1000) ||
    !integer(value.connections.maxUserConnections, 1000) ||
    value.connections.poolSize > value.connections.maxClients ||
    value.connections.poolSize > value.connections.maxDatabaseConnections ||
    value.connections.poolSize > value.connections.maxUserConnections ||
    !fields(value.timeouts, [
      "queryWaitSeconds",
      "connectSeconds",
      "cancelWaitSeconds",
    ]) ||
    !integer(value.timeouts.queryWaitSeconds, 300) ||
    !integer(value.timeouts.connectSeconds, 300) ||
    !integer(value.timeouts.cancelWaitSeconds, 300)
  )
    return false;
  return true;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function controllerOwner(
  resource: Resource,
  kind: string,
  name: string,
  uid: string,
  apiVersion: string,
): boolean {
  const owners = resource.metadata.ownerReferences?.filter(
    (owner) => owner.controller === true,
  );
  return (
    owners?.length === 1 &&
    owners[0]?.kind === kind &&
    owners[0]?.name === name &&
    owners[0]?.uid === uid &&
    owners[0]?.apiVersion === apiVersion
  );
}
function sameObservation(before: Resource, after: Resource | null): boolean {
  return (
    after !== null &&
    !after.metadata.deletionTimestamp &&
    before.kind === after.kind &&
    before.metadata.name === after.metadata.name &&
    before.metadata.namespace === after.metadata.namespace &&
    before.metadata.uid === after.metadata.uid &&
    before.metadata.generation === after.metadata.generation &&
    before.metadata.resourceVersion === after.metadata.resourceVersion
  );
}
function image(resource: Resource, pod = false): string | null {
  const spec = pod
    ? record(resource.spec)
    : record(record(record(resource.spec).template).spec);
  const containers = Array.isArray(spec.containers)
    ? spec.containers
        .map(record)
        .filter((container) => container.name === "pgbouncer")
    : [];
  return containers.length === 1 && typeof containers[0]!.image === "string"
    ? (containers[0]!.image as string)
    : null;
}
function childLabels(resource: Resource, poolerName: string): boolean {
  const labels = resource.metadata.labels;
  return (
    (labels?.["cnpg.io/cluster"] === undefined ||
      labels["cnpg.io/cluster"] === "database") &&
    (labels?.["cnpg.io/poolerName"] === undefined ||
      labels["cnpg.io/poolerName"] === poolerName)
  );
}
function deploymentReady(deployment: Resource): boolean {
  const status = deployment.status;
  if (!status) return false;
  return (
    Number.isSafeInteger(deployment.metadata.generation) &&
    deployment.metadata.generation! > 0 &&
    record(deployment.spec).replicas === 1 &&
    status.observedGeneration === deployment.metadata.generation &&
    status.replicas === 1 &&
    status.readyReplicas === 1 &&
    status.availableReplicas === 1 &&
    status.updatedReplicas === 1
  );
}
function podReady(pod: Resource): boolean {
  return (
    !pod.metadata.deletionTimestamp &&
    pod.status?.phase === "Running" &&
    pod.status.conditions?.some(
      (condition) => condition.type === "Ready" && condition.status === "True",
    ) === true
  );
}

// Observe CNPG's derived resources through their controller UID chain. CNPG,
// rather than this platform, owns their generated labels and rollout fields.
export async function observePooler(
  api: Kubernetes,
  pooler: Resource,
  cluster: Resource,
  policy: PoolingPolicy,
  pods: Resource[],
  authorized: () => void,
): Promise<Observation["pooler"] | null> {
  const namespace = pooler.metadata.namespace;
  const poolerUid = pooler.metadata.uid;
  if (
    !namespace ||
    !poolerUid ||
    !cluster.metadata.uid ||
    !pooler.metadata.resourceVersion ||
    !Number.isSafeInteger(pooler.metadata.generation) ||
    pooler.metadata.generation! < 1 ||
    pooler.status?.phase !== "active" ||
    pooler.status.image !== policy.image
  )
    return null;
  const read = async (kind: string, name: string) => {
    authorized();
    const result = await api.read(kind, namespace, name);
    authorized();
    return result;
  };
  try {
    const deployment = await read("Deployment", pooler.metadata.name);
    if (!deployment) return null;
    if (
      deployment.kind !== "Deployment" ||
      deployment.apiVersion !== "apps/v1" ||
      deployment.metadata.name !== pooler.metadata.name ||
      deployment.metadata.namespace !== namespace ||
      !controllerOwner(
        deployment,
        "Pooler",
        pooler.metadata.name,
        poolerUid,
        "postgresql.cnpg.io/v1",
      ) ||
      !childLabels(deployment, pooler.metadata.name)
    )
      throw new ReconcileError("ownership_mismatch");
    if (
      !deployment.metadata.uid ||
      !deployment.metadata.resourceVersion ||
      deployment.metadata.deletionTimestamp ||
      !deploymentReady(deployment) ||
      image(deployment) !== policy.image
    )
      return null;
    const candidates = pods.filter(
      (pod) =>
        pod.metadata.namespace === namespace &&
        pod.metadata.labels?.["cnpg.io/cluster"] === "database" &&
        pod.metadata.labels?.["cnpg.io/poolerName"] === pooler.metadata.name &&
        pod.metadata.labels?.["cnpg.io/podRole"] === "pooler" &&
        (!["Succeeded", "Failed"].includes(pod.status?.phase ?? "") ||
          pod.metadata.deletionTimestamp),
    );
    if (candidates.length !== 1 || !podReady(candidates[0]!)) return null;
    const pod = candidates[0]!;
    if (
      !pod.metadata.uid ||
      !pod.metadata.resourceVersion ||
      image(pod, true) !== policy.image
    )
      return null;
    const owners = pod.metadata.ownerReferences?.filter(
      (owner) => owner.controller === true,
    );
    const owner = owners?.[0];
    if (!owner || typeof owner.uid !== "string" || owner.uid.length === 0)
      return null;
    if (
      owners?.length !== 1 ||
      owner.kind !== "ReplicaSet" ||
      owner.apiVersion !== "apps/v1" ||
      !owner.name
    )
      throw new ReconcileError("ownership_mismatch");
    const replicaSet = await read("ReplicaSet", owner.name);
    if (!replicaSet) return null;
    if (
      typeof replicaSet.metadata.uid !== "string" ||
      replicaSet.metadata.uid.length === 0
    )
      return null;
    if (
      replicaSet.kind !== "ReplicaSet" ||
      replicaSet.apiVersion !== "apps/v1" ||
      replicaSet.metadata.namespace !== namespace ||
      replicaSet.metadata.name !== owner.name ||
      replicaSet.metadata.uid !== owner.uid ||
      !controllerOwner(
        replicaSet,
        "Deployment",
        deployment.metadata.name,
        deployment.metadata.uid,
        "apps/v1",
      ) ||
      !childLabels(replicaSet, pooler.metadata.name)
    )
      throw new ReconcileError("ownership_mismatch");
    if (
      !replicaSet.metadata.resourceVersion ||
      replicaSet.metadata.deletionTimestamp
    )
      return null;
    const latestPooler = await read("Pooler", pooler.metadata.name);
    const latestDeployment = await read("Deployment", deployment.metadata.name);
    const latestReplicaSet = await read("ReplicaSet", replicaSet.metadata.name);
    authorized();
    const latestPods = await api.listPods(namespace, "database");
    authorized();
    const latestCandidates = latestPods.filter(
      (candidate) =>
        candidate.metadata.namespace === namespace &&
        candidate.metadata.labels?.["cnpg.io/cluster"] === "database" &&
        candidate.metadata.labels?.["cnpg.io/poolerName"] ===
          pooler.metadata.name &&
        candidate.metadata.labels?.["cnpg.io/podRole"] === "pooler" &&
        (!["Succeeded", "Failed"].includes(candidate.status?.phase ?? "") ||
          candidate.metadata.deletionTimestamp),
    );
    if (
      !sameObservation(pooler, latestPooler) ||
      !sameObservation(deployment, latestDeployment) ||
      !sameObservation(replicaSet, latestReplicaSet) ||
      latestCandidates.length !== 1 ||
      !sameObservation(pod, latestCandidates[0]!) ||
      !podReady(latestCandidates[0]!) ||
      !deploymentReady(latestDeployment!) ||
      latestPooler!.status?.image !== policy.image ||
      latestPooler!.status?.phase !== "active" ||
      image(latestDeployment!) !== policy.image ||
      image(latestCandidates[0]!, true) !== policy.image ||
      !controllerOwner(
        latestPooler!,
        "Cluster",
        "database",
        cluster.metadata.uid,
        "postgresql.cnpg.io/v1",
      )
    )
      return null;
    return {
      uid: poolerUid,
      generation: pooler.metadata.generation!,
      deploymentUid: deployment.metadata.uid,
      readyInstances: 1,
    };
  } catch (failure) {
    if (failure instanceof ReconcileError) throw failure;
    return null;
  }
}
