// SPDX-License-Identifier: Apache-2.0
import {
  ApiException,
  AppsV1Api,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  NetworkingV1Api,
  Observable,
} from "@kubernetes/client-node";
import type {
  ConfigurationOptions,
  V1LimitRange,
  V1Namespace,
  V1NetworkPolicy,
  V1ResourceQuota,
  V1Secret,
} from "@kubernetes/client-node";
import type { Kubernetes, Resource } from "./types.ts";
import type { MeteringInventory } from "./metering-types.ts";

const customResources: Record<
  string,
  { group: string; version: string; plural: string }
> = {
  Cluster: { group: "postgresql.cnpg.io", version: "v1", plural: "clusters" },
  Pooler: { group: "postgresql.cnpg.io", version: "v1", plural: "poolers" },
  ObjectStore: {
    group: "barmancloud.cnpg.io",
    version: "v1",
    plural: "objectstores",
  },
  CiliumNetworkPolicy: {
    group: "cilium.io",
    version: "v2",
    plural: "ciliumnetworkpolicies",
  },
};

// Use the official client's TLS/authentication and model conversion. A timeout
// leaves creates uncertain; the reconciler resolves them by owned readback.
const requestOptions: ConfigurationOptions = {
  middlewareMergeStrategy: "append",
  middleware: [
    {
      pre(context) {
        context.setSignal(AbortSignal.timeout(20_000));
        return new Observable(Promise.resolve(context));
      },
      post(context) {
        return new Observable(Promise.resolve(context));
      },
    },
  ],
};

export interface InventoryBudget {
  remainingRequests: number;
  remainingResources: number;
  deadline: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function inventoryPages(
  fetchPage: (continuation?: string) => Promise<unknown>,
  kind: string,
  apiVersion: string,
  budget: InventoryBudget,
): Promise<Resource[]> {
  const resources: Resource[] = [];
  const tokens = new Set<string>();
  const uids = new Set<string>();
  let continuation: string | undefined;
  let resourceVersion: string | undefined;
  for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
    if (budget.remainingRequests <= 0 || Date.now() >= budget.deadline)
      throw new Error("metering_inventory_bound_exceeded");
    budget.remainingRequests -= 1;
    const page = await fetchPage(continuation);
    if (
      !object(page) ||
      !Array.isArray(page.items) ||
      !object(page.metadata) ||
      typeof page.metadata.resourceVersion !== "string" ||
      page.items.length > 100
    )
      throw new Error("metering_inventory_page_invalid");
    if (
      resourceVersion !== undefined &&
      resourceVersion !== page.metadata.resourceVersion
    )
      throw new Error("metering_inventory_snapshot_changed");
    resourceVersion = page.metadata.resourceVersion;
    budget.remainingResources -= page.items.length;
    if (budget.remainingResources < 0)
      throw new Error("metering_inventory_bound_exceeded");
    for (const item of page.items) {
      if (
        !object(item) ||
        !object(item.metadata) ||
        typeof item.metadata.name !== "string" ||
        typeof item.metadata.uid !== "string" ||
        !item.metadata.uid ||
        uids.has(item.metadata.uid) ||
        (item.kind !== undefined && item.kind !== kind) ||
        (item.apiVersion !== undefined && item.apiVersion !== apiVersion)
      )
        throw new Error("metering_inventory_identity_invalid");
      uids.add(item.metadata.uid);
      resources.push({ ...item, kind, apiVersion } as unknown as Resource);
    }
    const next = page.metadata._continue ?? page.metadata.continue;
    if (next === undefined || next === "") return resources;
    if (typeof next !== "string" || next.length > 8192 || tokens.has(next))
      throw new Error("metering_inventory_continuation_invalid");
    tokens.add(next);
    continuation = next;
  }
  throw new Error("metering_inventory_bound_exceeded");
}

export function kubernetesFromConfig(kubeconfigFile?: string): Kubernetes {
  const config = new KubeConfig();
  if (kubeconfigFile) config.loadFromFile(kubeconfigFile);
  else if (process.env.KUBERNETES_SERVICE_HOST) config.loadFromCluster();
  else throw new Error("explicit_kubeconfig_required");
  const core = config.makeApiClient(CoreV1Api);
  const apps = config.makeApiClient(AppsV1Api);
  const network = config.makeApiClient(NetworkingV1Api);
  const custom = config.makeApiClient(CustomObjectsApi);
  return {
    async read(kind, namespace, name) {
      try {
        let resource: unknown;
        switch (kind) {
          case "Namespace":
            resource = await core.readNamespace({ name }, requestOptions);
            break;
          case "ResourceQuota":
            resource = await core.readNamespacedResourceQuota(
              { namespace, name },
              requestOptions,
            );
            break;
          case "LimitRange":
            resource = await core.readNamespacedLimitRange(
              { namespace, name },
              requestOptions,
            );
            break;
          case "Secret":
            resource = await core.readNamespacedSecret(
              { namespace, name },
              requestOptions,
            );
            break;
          case "NetworkPolicy":
            resource = await network.readNamespacedNetworkPolicy(
              { namespace, name },
              requestOptions,
            );
            break;
          case "Deployment":
            resource = await apps.readNamespacedDeployment(
              { namespace, name },
              requestOptions,
            );
            break;
          case "ReplicaSet":
            resource = await apps.readNamespacedReplicaSet(
              { namespace, name },
              requestOptions,
            );
            break;
          default: {
            const type = customResources[kind];
            if (!type) throw new Error("unsupported_resource");
            resource = await custom.getNamespacedCustomObject(
              { ...type, namespace, name },
              requestOptions,
            );
          }
        }
        return resource as Resource;
      } catch (error) {
        if (error instanceof ApiException && error.code === 404) return null;
        throw error;
      }
    },
    async create(resource) {
      const namespace = resource.metadata.namespace ?? "";
      const fieldValidation = "Strict";
      let created: unknown;
      switch (resource.kind) {
        case "Namespace":
          created = await core.createNamespace(
            { body: resource as V1Namespace, fieldValidation },
            requestOptions,
          );
          break;
        case "ResourceQuota":
          created = await core.createNamespacedResourceQuota(
            { namespace, body: resource as V1ResourceQuota, fieldValidation },
            requestOptions,
          );
          break;
        case "LimitRange":
          created = await core.createNamespacedLimitRange(
            { namespace, body: resource as V1LimitRange, fieldValidation },
            requestOptions,
          );
          break;
        case "Secret":
          created = await core.createNamespacedSecret(
            { namespace, body: resource as V1Secret, fieldValidation },
            requestOptions,
          );
          break;
        case "NetworkPolicy":
          created = await network.createNamespacedNetworkPolicy(
            { namespace, body: resource as V1NetworkPolicy, fieldValidation },
            requestOptions,
          );
          break;
        default: {
          const type = customResources[resource.kind];
          if (!type) throw new Error("unsupported_resource");
          created = await custom.createNamespacedCustomObject(
            { ...type, namespace, body: resource, fieldValidation },
            requestOptions,
          );
        }
      }
      return created as Resource;
    },
    async readSecret(namespace, name) {
      const secret = await core.readNamespacedSecret(
        { namespace, name },
        requestOptions,
      );
      return secret.data ?? {};
    },
    async listPods(namespace, clusterName) {
      const pods = await core.listNamespacedPod(
        {
          namespace,
          labelSelector: `cnpg.io/cluster=${clusterName}`,
          limit: 100,
        },
        requestOptions,
      );
      // More than this bound is outside the accepted catalog instance limit.
      // Do not turn a truncated observation into a successful readiness report.
      if (pods.metadata?._continue)
        throw new Error("pod_observation_incomplete");
      return pods.items as unknown as Resource[];
    },
    async meteringInventory(regionId): Promise<MeteringInventory> {
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(regionId))
        throw new Error("metering_region_invalid");
      const budget: InventoryBudget = {
        remainingRequests: 128,
        remainingResources: 5000,
        deadline: Date.now() + 60_000,
      };
      const labelSelector = `app.kubernetes.io/managed-by=cloudflare-postgres,pgcf.io/region-id=${regionId}`;
      const namespaces = await inventoryPages(
        (_continue) =>
          core.listNamespace(
            { labelSelector, limit: 100, _continue },
            requestOptions,
          ),
        "Namespace",
        "v1",
        budget,
      );
      if (namespaces.length > 64)
        throw new Error("metering_namespace_bound_exceeded");
      const inventory: MeteringInventory = {
        namespaces,
        clusters: [],
        pods: [],
        poolers: [],
        deployments: [],
        replicaSets: [],
        pvcs: [],
        pvs: [],
      };
      for (const namespace of namespaces) {
        // No partial page/namespace is returned as a complete inventory. An SDK
        // timeout or 410 ends this poll; the durable collector records the gap.
        const [clusters, pods, pvcs, poolers, deployments, replicaSets] =
          await Promise.all([
            inventoryPages(
              (_continue) =>
                custom.listNamespacedCustomObject(
                  {
                    group: "postgresql.cnpg.io",
                    version: "v1",
                    plural: "clusters",
                    namespace: namespace.metadata.name,
                    labelSelector,
                    limit: 100,
                    _continue,
                  },
                  requestOptions,
                ),
              "Cluster",
              "postgresql.cnpg.io/v1",
              budget,
            ),
            inventoryPages(
              (_continue) =>
                core.listNamespacedPod(
                  {
                    namespace: namespace.metadata.name,
                    limit: 100,
                    _continue,
                  },
                  requestOptions,
                ),
              "Pod",
              "v1",
              budget,
            ),
            inventoryPages(
              (_continue) =>
                core.listNamespacedPersistentVolumeClaim(
                  { namespace: namespace.metadata.name, limit: 100, _continue },
                  requestOptions,
                ),
              "PersistentVolumeClaim",
              "v1",
              budget,
            ),
            inventoryPages(
              (_continue) =>
                custom.listNamespacedCustomObject(
                  {
                    group: "postgresql.cnpg.io",
                    version: "v1",
                    plural: "poolers",
                    namespace: namespace.metadata.name,
                    limit: 100,
                    _continue,
                  },
                  requestOptions,
                ),
              "Pooler",
              "postgresql.cnpg.io/v1",
              budget,
            ),
            inventoryPages(
              (_continue) =>
                apps.listNamespacedDeployment(
                  { namespace: namespace.metadata.name, limit: 100, _continue },
                  requestOptions,
                ),
              "Deployment",
              "apps/v1",
              budget,
            ),
            inventoryPages(
              (_continue) =>
                apps.listNamespacedReplicaSet(
                  { namespace: namespace.metadata.name, limit: 100, _continue },
                  requestOptions,
                ),
              "ReplicaSet",
              "apps/v1",
              budget,
            ),
          ]);
        inventory.clusters.push(...clusters);
        inventory.pods.push(...pods);
        inventory.pvcs.push(...pvcs);
        inventory.poolers!.push(...poolers);
        inventory.deployments!.push(...deployments);
        inventory.replicaSets!.push(...replicaSets);
      }
      // Retained volumes can outlive both their PVC and their namespace. The
      // observer attributes these only through a previously proven UID chain.
      inventory.pvs = await inventoryPages(
        (_continue) =>
          core.listPersistentVolume({ limit: 100, _continue }, requestOptions),
        "PersistentVolume",
        "v1",
        budget,
      );
      return inventory;
    },
  };
}
