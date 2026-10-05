// SPDX-License-Identifier: Apache-2.0
import https from "node:https";
import { isIP } from "node:net";
import { createHash, X509Certificate } from "node:crypto";
import { checkServerIdentity } from "node:tls";
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
import { record, string, uid } from "./types.ts";
import type { Kubernetes, Resource } from "./types.ts";
import { KubeletTrustReader, type KubeletTrust } from "./kubelet-trust.ts";

const CUSTOM: Record<
  string,
  { group: string; version: string; plural: string }
> = {
  Cluster: { group: "postgresql.cnpg.io", version: "v1", plural: "clusters" },
  Backup: { group: "postgresql.cnpg.io", version: "v1", plural: "backups" },
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

export interface VolumeStatsKubernetes extends Kubernetes {
  statsSummary?(node: Resource): Promise<unknown>;
}

export async function kubeletSummary(
  config: KubeConfig,
  node: Resource,
  signal: AbortSignal,
  trust: Pick<
    KubeletTrust,
    "certificatePem" | "leafSha256" | "serverName"
  > | null = null,
): Promise<unknown> {
  const addresses = record(node.status).addresses;
  const internal = Array.isArray(addresses)
    ? addresses.map(record).filter((address) => address.type === "InternalIP")
    : [];
  if (
    node.kind !== "Node" ||
    !uid(node) ||
    node.metadata.deletionTimestamp ||
    !internal.length ||
    internal.length > 2 ||
    internal.some(
      (address) =>
        typeof address.address !== "string" || !isIP(address.address),
    ) ||
    new Set(internal.map((address) => isIP(String(address.address)))).size !==
      internal.length
  )
    throw new Error("kubelet_node_invalid");
  const cluster = config.getCurrentCluster();
  if (!cluster || cluster.skipTLSVerify || (!cluster.caData && !cluster.caFile))
    throw new Error("kubelet_tls_invalid");
  const options: https.RequestOptions = {
    hostname: String(internal[0]!.address),
    port: 10250,
    path: "/stats/summary",
    method: "GET",
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  };
  try {
    await config.applyToHTTPSOptions(options);
  } catch {
    throw new Error("kubelet_tls_invalid");
  }
  if (!options.ca) throw new Error("kubelet_tls_invalid");
  options.rejectUnauthorized = true;
  // The API client's reusable agent may carry the API server's TLS name; the kubelet must authenticate its own IP.
  options.agent = false;
  options.servername = "";
  if (trust) {
    if (trust.serverName !== node.metadata.name)
      throw new Error("kubelet_trust_invalid");
    options.ca = trust.certificatePem;
    options.servername = trust.serverName;
    options.checkServerIdentity = (host, certificate) => {
      if (checkServerIdentity(host, certificate))
        return new Error("kubelet_tls_identity_invalid");
      try {
        if (
          !certificate.raw ||
          new X509Certificate(certificate.raw).checkHost(trust.serverName, {
            subject: "never",
            wildcards: false,
          }) !== trust.serverName
        )
          return new Error("kubelet_tls_identity_invalid");
      } catch {
        return new Error("kubelet_tls_identity_invalid");
      }
      if (
        !certificate.raw ||
        createHash("sha256").update(certificate.raw).digest("hex") !==
          trust.leafSha256
      )
        return new Error("kubelet_pin_mismatch");
      return undefined;
    };
  }
  return new Promise((resolve, reject) => {
    const request = https.request(options, (response) => {
      if (response.statusCode !== 200) {
        response.destroy();
        reject(new Error("kubelet_stats_unavailable"));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("error", reject);
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) {
          response.destroy(new Error("kubelet_stats_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(new Error("kubelet_stats_invalid"));
        }
      });
    });
    request.on("error", (error: Error) =>
      reject(
        new Error(
          ["kubelet_pin_mismatch", "kubelet_tls_identity_invalid"].includes(
            error.message,
          )
            ? error.message
            : "kubelet_tls_failed",
        ),
      ),
    );
    request.end();
  });
}

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
): VolumeStatsKubernetes {
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
  const k8s: VolumeStatsKubernetes = {
    statsSummary: async (node) =>
      kubeletSummary(config, node, signal, await trust.read(node)),
    async read(kind, namespace, name) {
      const namespaced = { namespace: namespace ?? "", name };
      try {
        let value: unknown;
        switch (kind) {
          case "Namespace":
            value = await core.readNamespace({ name }, options);
            break;
          case "Node":
            value = await core.readNode({ name }, options);
            break;
          case "Secret":
            value = await core.readNamespacedSecret(namespaced, options);
            break;
          case "ConfigMap":
            value = await core.readNamespacedConfigMap(namespaced, options);
            break;
          case "ResourceQuota":
            value = await core.readNamespacedResourceQuota(namespaced, options);
            break;
          case "LimitRange":
            value = await core.readNamespacedLimitRange(namespaced, options);
            break;
          case "NetworkPolicy":
            value = await network.readNamespacedNetworkPolicy(
              namespaced,
              options,
            );
            break;
          case "Pod":
            value = await core.readNamespacedPod(namespaced, options);
            break;
          case "PersistentVolumeClaim":
            value = await core.readNamespacedPersistentVolumeClaim(
              namespaced,
              options,
            );
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
          apiVersion: CUSTOM[kind]
            ? `${CUSTOM[kind]!.group}/${CUSTOM[kind]!.version}`
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
        case "PersistentVolumeClaim":
          return inventoryPages(
            (_continue) =>
              namespace
                ? core.listNamespacedPersistentVolumeClaim(
                    { ...page, namespace, _continue },
                    options,
                  )
                : core.listPersistentVolumeClaimForAllNamespaces(
                    { ...page, _continue },
                    options,
                  ),
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
    async create(body: K8sObject) {
      const args = { namespace: body.metadata.namespace ?? "", body };
      switch (body.kind) {
        case "Namespace":
          await core.createNamespace({ body }, options);
          break;
        case "ConfigMap":
          await core.createNamespacedConfigMap(args, options);
          break;
        case "Secret":
          await core.createNamespacedSecret(args, options);
          break;
        case "ResourceQuota":
          await core.createNamespacedResourceQuota(args, options);
          break;
        case "LimitRange":
          await core.createNamespacedLimitRange(args, options);
          break;
        case "NetworkPolicy":
          await network.createNamespacedNetworkPolicy(args, options);
          break;
        default:
          await custom.createNamespacedCustomObject(
            { ...customKind(body.kind), ...args },
            options,
          );
      }
    },
    async apply(body: K8sObject) {
      if (body.kind !== "ConfigMap") throw new Error("unsupported_apply_kind");
      const args = {
        name: body.metadata.name,
        namespace: body.metadata.namespace ?? "",
        body,
        fieldManager: "pgcf-agent",
        force: true,
        fieldValidation: "Strict",
      };
      await core.patchNamespacedConfigMap(args, applyOptions);
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
        case "ConfigMap":
          await core.patchNamespacedConfigMap(args, patchOptions);
          break;
        case "Secret":
          await core.patchNamespacedSecret(args, patchOptions);
          break;
        case "ResourceQuota":
          await core.patchNamespacedResourceQuota(args, patchOptions);
          break;
        case "LimitRange":
          await core.patchNamespacedLimitRange(args, patchOptions);
          break;
        case "NetworkPolicy":
          await network.patchNamespacedNetworkPolicy(args, patchOptions);
          break;
        default:
          await custom.patchNamespacedCustomObject(
            { ...customKind(kind), ...args },
            patchOptions,
          );
          break;
      }
    },
    async delete(kind, namespace, name, uid, resourceVersion) {
      const args = {
        name,
        namespace: namespace ?? "",
        body: {
          preconditions: {
            uid,
            ...(resourceVersion === undefined ? {} : { resourceVersion }),
          },
          propagationPolicy: "Foreground",
        },
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
  const trust = new KubeletTrustReader((...args) => k8s.read(...args));
  return k8s;
}
