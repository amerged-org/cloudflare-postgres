// SPDX-License-Identifier: Apache-2.0
import {
  ApiException,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  NetworkingV1Api,
  Observable,
} from "@kubernetes/client-node";
import type { ConfigurationOptions } from "@kubernetes/client-node";
import type { K8sObject } from "@pgcf/contracts";
import { record, string } from "./types.ts";
import type { Kubernetes, Resource } from "./types.ts";

const CUSTOM: Record<
  string,
  { group: string; version: string; plural: string }
> = {
  Cluster: { group: "postgresql.cnpg.io", version: "v1", plural: "clusters" },
  ScheduledBackup: {
    group: "postgresql.cnpg.io",
    version: "v1",
    plural: "scheduledbackups",
  },
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
  LVMVolume: {
    group: "local.openebs.io",
    version: "v1alpha1",
    plural: "lvmvolumes",
  },
};

export function requestOptions(
  signal: AbortSignal,
  contentType?: string,
): ConfigurationOptions {
  return {
    middlewareMergeStrategy: "append",
    middleware: [
      {
        pre(context) {
          context.setSignal(
            AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
          );
          if (contentType) context.setHeaderParam("Content-Type", contentType);
          return new Observable(Promise.resolve(context));
        },
        post(context) {
          return new Observable(Promise.resolve(context));
        },
      },
    ],
  };
}

export async function inventoryPages(
  fetchPage: (token?: string) => Promise<unknown>,
  kind: string,
  apiVersion: string,
): Promise<Resource[]> {
  const values: Resource[] = [];
  const tokens = new Set<string>();
  const identities = new Set<string>();
  let token: string | undefined;
  let revision: string | undefined;
  const deadline = Date.now() + 60_000;
  for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
    if (Date.now() >= deadline) throw new Error("inventory_deadline_exceeded");
    const page = record(await fetchPage(token));
    const metadata = record(page.metadata);
    if (
      !Array.isArray(page.items) ||
      page.items.length > 100 ||
      !string(metadata.resourceVersion)
    )
      throw new Error("inventory_page_invalid");
    const current = string(metadata.resourceVersion)!;
    if (revision !== undefined && revision !== current)
      throw new Error("inventory_snapshot_changed");
    revision = current;
    for (const value of page.items) {
      const item = record(value);
      const itemMeta = record(item.metadata);
      const id = string(itemMeta.uid);
      if (
        !id ||
        !string(itemMeta.name) ||
        identities.has(id) ||
        (item.kind !== undefined && item.kind !== kind) ||
        (item.apiVersion !== undefined && item.apiVersion !== apiVersion)
      )
        throw new Error("inventory_identity_invalid");
      identities.add(id);
      values.push({ ...item, kind, apiVersion } as Resource);
    }
    const next = metadata._continue ?? metadata.continue;
    if (next === undefined || next === "") return values;
    if (typeof next !== "string" || next.length > 8192 || tokens.has(next))
      throw new Error("inventory_cursor_invalid");
    tokens.add(next);
    token = next;
  }
  throw new Error("inventory_bound_exceeded");
}

export function kubernetesFromConfig(
  signal: AbortSignal,
  explicitFile?: string,
): Kubernetes {
  const config = new KubeConfig();
  if (explicitFile) config.loadFromFile(explicitFile);
  else if (process.env.KUBERNETES_SERVICE_HOST) config.loadFromCluster();
  else throw new Error("explicit_kubeconfig_required");
  const core = config.makeApiClient(CoreV1Api);
  const network = config.makeApiClient(NetworkingV1Api);
  const custom = config.makeApiClient(CustomObjectsApi);
  const options = requestOptions(signal);
  const applyOptions = requestOptions(signal, "application/apply-patch+yaml");
  const patchOptions = requestOptions(signal, "application/json-patch+json");
  const customKind = (kind: string) => {
    const type = CUSTOM[kind];
    if (!type) throw new Error("unsupported_resource_kind");
    return type;
  };
  return {
    async read(kind, namespace, name) {
      const namespaced = { namespace: namespace ?? "", name };
      try {
        let value: unknown;
        switch (kind) {
          case "Namespace":
            value = await core.readNamespace({ name }, options);
            break;
          case "Secret":
            value = await core.readNamespacedSecret(namespaced, options);
            break;
          case "ConfigMap":
            value = await core.readNamespacedConfigMap(namespaced, options);
            break;
          case "Pod":
            value = await core.readNamespacedPod(namespaced, options);
            break;
          case "PersistentVolume":
            value = await core.readPersistentVolume({ name }, options);
            break;
          default:
            value = await custom.getNamespacedCustomObject(
              { ...customKind(kind), ...namespaced },
              options,
            );
        }
        return {
          ...record(value),
          apiVersion:
            kind === "Cluster"
              ? "postgresql.cnpg.io/v1"
              : kind === "LVMVolume"
                ? "local.openebs.io/v1alpha1"
                : "v1",
          kind,
        } as Resource;
      } catch (error) {
        if (error instanceof ApiException && error.code === 404) return null;
        throw error;
      }
    },
    async list(kind, namespace, labelSelector) {
      const page = { limit: 100, ...(labelSelector ? { labelSelector } : {}) };
      switch (kind) {
        case "Namespace":
          return inventoryPages(
            (_continue) => core.listNamespace({ ...page, _continue }, options),
            kind,
            "v1",
          );
        case "Node":
          return inventoryPages(
            (_continue) => core.listNode({ ...page, _continue }, options),
            kind,
            "v1",
          );
        case "Pod":
          return inventoryPages(
            (_continue) =>
              namespace
                ? core.listNamespacedPod(
                    { ...page, namespace, _continue },
                    options,
                  )
                : core.listPodForAllNamespaces({ ...page, _continue }, options),
            kind,
            "v1",
          );
        case "PersistentVolume":
          return inventoryPages(
            (_continue) =>
              core.listPersistentVolume({ ...page, _continue }, options),
            kind,
            "v1",
          );
        default: {
          const type = customKind(kind);
          return inventoryPages(
            (_continue) =>
              namespace
                ? custom.listNamespacedCustomObject(
                    { ...type, ...page, namespace, _continue },
                    options,
                  )
                : custom.listClusterCustomObject(
                    { ...type, ...page, _continue },
                    options,
                  ),
            kind,
            `${type.group}/${type.version}`,
          );
        }
      }
    },
    async apply(body: K8sObject) {
      const args = {
        name: body.metadata.name,
        namespace: body.metadata.namespace ?? "",
        body,
        fieldManager: "pgcf-agent",
        force: true,
        fieldValidation: "Strict",
      };
      switch (body.kind) {
        case "Namespace":
          await core.patchNamespace(args, applyOptions);
          break;
        case "Secret":
          await core.patchNamespacedSecret(args, applyOptions);
          break;
        case "ConfigMap":
          await core.patchNamespacedConfigMap(args, applyOptions);
          break;
        case "ResourceQuota":
          await core.patchNamespacedResourceQuota(args, applyOptions);
          break;
        case "LimitRange":
          await core.patchNamespacedLimitRange(args, applyOptions);
          break;
        case "NetworkPolicy":
          await network.patchNamespacedNetworkPolicy(args, applyOptions);
          break;
        default:
          await custom.patchNamespacedCustomObject(
            { ...customKind(body.kind), ...args },
            applyOptions,
          );
      }
    },
    async patch(kind, namespace, name, body) {
      const args = {
        name,
        namespace: namespace ?? "",
        body,
        fieldManager: "pgcf-agent",
        fieldValidation: "Strict",
      };
      switch (kind) {
        case "Namespace":
          await core.patchNamespace(args, patchOptions);
          break;
        case "PersistentVolume":
          await core.patchPersistentVolume(args, patchOptions);
          break;
        default:
          throw new Error("unsupported_patch_kind");
      }
    },
    async delete(kind, namespace, name, uid) {
      const args = {
        name,
        namespace: namespace ?? "",
        body: { preconditions: { uid }, propagationPolicy: "Foreground" },
      };
      try {
        if (kind === "Namespace") await core.deleteNamespace(args, options);
        else if (kind === "ConfigMap")
          await core.deleteNamespacedConfigMap(args, options);
        else throw new Error("unsupported_delete_kind");
      } catch (error) {
        if (!(error instanceof ApiException && error.code === 404)) throw error;
      }
    },
  };
}
