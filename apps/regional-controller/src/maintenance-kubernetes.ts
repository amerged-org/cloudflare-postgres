// SPDX-License-Identifier: Apache-2.0
import {
  ApiException,
  BatchV1Api,
  CoordinationV1Api,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  Observable,
  PolicyV1Api,
} from "@kubernetes/client-node";
import type { ConfigurationOptions, V1Job } from "@kubernetes/client-node";
import { inventoryPages } from "./kubernetes.ts";
import type { InventoryBudget } from "./kubernetes.ts";
import type {
  MaintenanceClaim,
  MaintenanceEvidence,
  MaintenanceJobs,
  MaintenanceSnapshot,
} from "./maintenance-types.ts";
import type { Resource } from "./types.ts";

export interface MaintenanceOperatorConfiguration {
  schemaVersion: 1;
  kubeconfigFile: string;
  kubeconfigContext: string;
  namespace: string;
  talosconfigSecret: string;
  endpoints: string[];
  targetNodeUid: string;
  evidence: {
    machineIdentity: MaintenanceEvidence | null;
    etcd:
      (NonNullable<MaintenanceSnapshot["etcd"]> & { planHash: string }) | null;
    recovery: MaintenanceEvidence | null;
    staging: MaintenanceEvidence | null;
    capacity: MaintenanceSnapshot["capacity"];
    databases: {
      uid: string;
      switchover: MaintenanceEvidence | null;
      volumes: MaintenanceEvidence | null;
    }[];
  };
}
export interface MaintenanceKubernetes extends MaintenanceJobs {
  snapshot(
    claim: MaintenanceClaim,
    operator: MaintenanceOperatorConfiguration,
  ): Promise<MaintenanceSnapshot>;
}
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const condition = (resource: Resource, type: string, status: string) =>
  resource.status?.conditions?.some(
    (value) => value.type === type && value.status === status,
  ) === true;

function verified(
  evidence: MaintenanceEvidence | null,
  claim: MaintenanceClaim,
  now: number,
): boolean {
  return (
    evidence !== null &&
    evidence.status === "verified" &&
    evidence.planHash === claim.planHash &&
    /^[a-f0-9]{64}$/.test(evidence.evidenceHash) &&
    Number.isSafeInteger(evidence.observedAt) &&
    Number.isSafeInteger(evidence.expiresAt) &&
    evidence.observedAt <= now &&
    now - evidence.observedAt <= 60_000 &&
    evidence.expiresAt > now
  );
}
function selectorMatches(
  selector: unknown,
  labels: Record<string, string>,
): boolean {
  const value = object(selector);
  if (!value.matchLabels && !value.matchExpressions) return false;
  if (
    !Object.entries(object(value.matchLabels)).every(
      ([key, expected]) => labels[key] === expected,
    )
  )
    return false;
  return array(value.matchExpressions).every((item) => {
    const rule = object(item);
    if (typeof rule.key !== "string") return false;
    const present = Object.hasOwn(labels, rule.key);
    const values = array(rule.values);
    switch (rule.operator) {
      case "In":
        return present && values.includes(labels[rule.key]);
      case "NotIn":
        return !present || !values.includes(labels[rule.key]);
      case "Exists":
        return present;
      case "DoesNotExist":
        return !present;
      default:
        return false;
    }
  });
}

export function maintenanceKubernetesFromConfig(
  file: string,
  context: string,
  namespace: string,
): MaintenanceKubernetes {
  const config = new KubeConfig();
  config.loadFromFile(file);
  if (!context || !config.getContexts().some((item) => item.name === context))
    throw new Error("maintenance_kubernetes_context_invalid");
  config.setCurrentContext(context);
  const core = config.makeApiClient(CoreV1Api),
    custom = config.makeApiClient(CustomObjectsApi);
  const policy = config.makeApiClient(PolicyV1Api),
    batch = config.makeApiClient(BatchV1Api),
    coordination = config.makeApiClient(CoordinationV1Api);
  let budget: InventoryBudget | null = null;
  const requestOptions: ConfigurationOptions = {
    middlewareMergeStrategy: "append",
    middleware: [
      {
        pre(request) {
          const remaining = budget ? budget.deadline - Date.now() : 20_000;
          if (remaining <= 0) throw new Error("maintenance_inventory_deadline");
          request.setSignal(
            AbortSignal.timeout(Math.max(1, Math.min(20_000, remaining))),
          );
          return new Observable(Promise.resolve(request));
        },
        post(response) {
          return new Observable(Promise.resolve(response));
        },
      },
    ],
  };
  return {
    async readJob(name) {
      try {
        return (await batch.readNamespacedJob(
          { namespace, name },
          requestOptions,
        )) as unknown as Resource;
      } catch (error) {
        if (error instanceof ApiException && error.code === 404) return null;
        throw error;
      }
    },
    async createJob(resource) {
      if (
        resource.kind !== "Job" ||
        resource.apiVersion !== "batch/v1" ||
        resource.metadata.namespace !== namespace
      )
        throw new Error("maintenance_job_scope_invalid");
      return (await batch.createNamespacedJob(
        {
          namespace,
          body: resource as unknown as V1Job,
          fieldValidation: "Strict",
        },
        requestOptions,
      )) as unknown as Resource;
    },
    async snapshot(claim, operator) {
      const currentBudget: InventoryBudget = {
        remainingRequests: 80,
        remainingResources: 4096,
        deadline: Date.now() + 30_000,
      };
      budget = currentBudget;
      try {
        const [namespaces, nodes, clusters, pods, pvcs, pvs, pdbs, leases] =
          await Promise.all([
            inventoryPages(
              (_continue) =>
                core.listNamespace({ limit: 100, _continue }, requestOptions),
              "Namespace",
              "v1",
              currentBudget,
            ),
            inventoryPages(
              (_continue) =>
                core.listNode({ limit: 100, _continue }, requestOptions),
              "Node",
              "v1",
              currentBudget,
            ),
            inventoryPages(
              (_continue) =>
                custom.listCustomObjectForAllNamespaces(
                  {
                    group: "postgresql.cnpg.io",
                    version: "v1",
                    resourcePlural: "clusters",
                    limit: 100,
                    _continue,
                  },
                  requestOptions,
                ),
              "Cluster",
              "postgresql.cnpg.io/v1",
              currentBudget,
            ),
            inventoryPages(
              (_continue) =>
                core.listPodForAllNamespaces(
                  { limit: 100, _continue },
                  requestOptions,
                ),
              "Pod",
              "v1",
              currentBudget,
            ),
            inventoryPages(
              (_continue) =>
                core.listPersistentVolumeClaimForAllNamespaces(
                  { limit: 100, _continue },
                  requestOptions,
                ),
              "PersistentVolumeClaim",
              "v1",
              currentBudget,
            ),
            inventoryPages(
              (_continue) =>
                core.listPersistentVolume(
                  { limit: 100, _continue },
                  requestOptions,
                ),
              "PersistentVolume",
              "v1",
              currentBudget,
            ),
            inventoryPages(
              (_continue) =>
                policy.listPodDisruptionBudgetForAllNamespaces(
                  { limit: 100, _continue },
                  requestOptions,
                ),
              "PodDisruptionBudget",
              "policy/v1",
              currentBudget,
            ),
            inventoryPages(
              (_continue) =>
                coordination.listNamespacedLease(
                  { namespace: "kube-node-lease", limit: 100, _continue },
                  requestOptions,
                ),
              "Lease",
              "coordination.k8s.io/v1",
              currentBudget,
            ),
          ]);
        if (Date.now() > currentBudget.deadline)
          throw new Error("maintenance_inventory_deadline");
        const now = Date.now();
        const nodeByName = new Map(
          nodes.map((node) => [node.metadata.name, node]),
        );
        const nodeUid = (pod: Resource) => {
          const nodeName = object(pod.spec).nodeName;
          return typeof nodeName === "string"
            ? (nodeByName.get(nodeName)?.metadata.uid ?? "")
            : "";
        };
        const nodeSnapshots = nodes.map((node) => {
          const info = object(object(node.status).nodeInfo);
          const lease = leases.find(
            (candidate) =>
              candidate.metadata.name === node.metadata.name &&
              candidate.metadata.ownerReferences?.some(
                (owner) =>
                  owner.kind === "Node" && owner.uid === node.metadata.uid,
              ),
          );
          const renewal = object(lease?.spec).renewTime;
          const heartbeat =
            renewal instanceof Date
              ? renewal.getTime()
              : typeof renewal === "string"
                ? Date.parse(renewal)
                : NaN;
          return {
            uid: node.metadata.uid!,
            kubernetesVersion:
              typeof info.kubeletVersion === "string"
                ? info.kubeletVersion
                : "",
            ready:
              !node.metadata.deletionTimestamp &&
              object(node.spec).unschedulable !== true &&
              condition(node, "Ready", "True") &&
              ["MemoryPressure", "DiskPressure", "PIDPressure"].every((type) =>
                condition(node, type, "False"),
              ) &&
              info.osImage === `Talos (v${claim.plan.talosVersion})` &&
              Number.isFinite(heartbeat) &&
              heartbeat <= now &&
              now - heartbeat <= 60_000,
          };
        });
        const databases = clusters.map((cluster) => {
          const clusterPods = pods.filter(
            (pod) =>
              pod.metadata.namespace === cluster.metadata.namespace &&
              pod.metadata.labels?.["cnpg.io/podRole"] === "instance" &&
              pod.metadata.ownerReferences?.some(
                (owner) =>
                  owner.kind === "Cluster" &&
                  owner.apiVersion === "postgresql.cnpg.io/v1" &&
                  owner.controller === true &&
                  owner.uid === cluster.metadata.uid,
              ),
          );
          const readyPods = clusterPods.filter(
            (pod) =>
              !pod.metadata.deletionTimestamp &&
              pod.status?.phase === "Running" &&
              condition(pod, "Ready", "True"),
          );
          const primary = clusterPods.find(
            (pod) => pod.metadata.name === cluster.status?.currentPrimary,
          );
          const proof = operator.evidence.databases.find(
            (item) => item.uid === cluster.metadata.uid,
          );
          const clusterPolicy = pdbs.filter(
            (pdb) => pdb.metadata.namespace === cluster.metadata.namespace,
          );
          const disruption =
            readyPods.length > 0 &&
            readyPods.every((pod) => {
              const matching = clusterPolicy.filter((pdb) =>
                selectorMatches(
                  object(pdb.spec).selector,
                  pod.metadata.labels ?? {},
                ),
              );
              return (
                matching.length > 0 &&
                matching.every(
                  (pdb) =>
                    !pdb.metadata.deletionTimestamp &&
                    object(pdb.status).observedGeneration ===
                      pdb.metadata.generation &&
                    Number(object(pdb.status).disruptionsAllowed) >= 1,
                )
              );
            });
          const bound =
            clusterPods.length > 0 &&
            clusterPods.every((pod) => {
              const volumes = array(object(pod.spec).volumes).filter(
                (item) => object(item).persistentVolumeClaim !== undefined,
              );
              return (
                volumes.length > 0 &&
                volumes.every((item) => {
                  const claimName = object(
                    object(item).persistentVolumeClaim,
                  ).claimName;
                  const pvc = pvcs.find(
                    (candidate) =>
                      candidate.metadata.namespace === pod.metadata.namespace &&
                      candidate.metadata.name === claimName,
                  );
                  const pv = pvs.find(
                    (candidate) =>
                      candidate.metadata.name === object(pvc?.spec).volumeName,
                  );
                  const ref = object(object(pv?.spec).claimRef);
                  return (
                    !!pvc &&
                    !!pv &&
                    !pvc.metadata.deletionTimestamp &&
                    !pv.metadata.deletionTimestamp &&
                    pvc.status?.phase === "Bound" &&
                    ref.uid === pvc.metadata.uid &&
                    ref.namespace === pvc.metadata.namespace &&
                    ref.name === pvc.metadata.name &&
                    object(pvc.spec).storageClassName ===
                      object(pv.spec).storageClassName
                  );
                })
              );
            });
          return {
            uid: cluster.metadata.uid!,
            primaryNodeUid: primary ? nodeUid(primary) : "",
            readyInstanceNodeUids:
              condition(cluster, "Ready", "True") &&
              !cluster.metadata.deletionTimestamp
                ? [...new Set(readyPods.map(nodeUid))]
                : [],
            switchoverVerified:
              !!proof && verified(proof.switchover, claim, now),
            pdbAllowsDisruption: disruption,
            volumeBindingsStable:
              bound && !!proof && verified(proof.volumes, claim, now),
          };
        });
        const etcd = operator.evidence.etcd;
        return {
          complete: true,
          observedAt: now,
          regionId: claim.regionId,
          clusterUid:
            namespaces.find((item) => item.metadata.name === "kube-system")
              ?.metadata.uid ?? "",
          targetNodeUid: operator.targetNodeUid,
          nodes: nodeSnapshots,
          databases,
          machineIdentity: operator.evidence.machineIdentity,
          recovery: operator.evidence.recovery,
          staging: operator.evidence.staging,
          capacity: operator.evidence.capacity,
          etcd: etcd?.planHash === claim.planHash ? etcd : null,
        };
      } finally {
        budget = null;
      }
    },
  };
}
