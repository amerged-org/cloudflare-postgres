// SPDX-License-Identifier: Apache-2.0
import {
  ApiException,
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

const customResources: Record<
  string,
  { group: string; version: string; plural: string }
> = {
  Cluster: { group: "postgresql.cnpg.io", version: "v1", plural: "clusters" },
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

export function kubernetesFromConfig(kubeconfigFile?: string): Kubernetes {
  const config = new KubeConfig();
  if (kubeconfigFile) config.loadFromFile(kubeconfigFile);
  else if (process.env.KUBERNETES_SERVICE_HOST) config.loadFromCluster();
  else throw new Error("explicit_kubeconfig_required");
  const core = config.makeApiClient(CoreV1Api);
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
  };
}
