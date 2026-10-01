// SPDX-License-Identifier: Apache-2.0
import {
  AdmissionregistrationV1Api,
  ApiException,
  AppsV1Api,
  BatchV1Api,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  Observable,
  PatchStrategy,
  StorageV1Api,
  setHeaderOptions,
} from "@kubernetes/client-node";
import type {
  ConfigurationOptions,
  V1PersistentVolumeClaim,
  V1StorageClass,
} from "@kubernetes/client-node";
import { inventoryPages } from "./kubernetes.ts";
import type { CapacityRuntime } from "./capacity-types.ts";
import type { Resource } from "./types.ts";

type Dispatch = { check: () => void; expiresAt: () => number };
const failure = () => new Error("capacity_kubernetes_unproven");
const customKinds: Record<
  string,
  { group: string; version: string; plural: string; namespaced: boolean }
> = {
  Cluster: {
    group: "postgresql.cnpg.io",
    version: "v1",
    plural: "clusters",
    namespaced: true,
  },
  Pooler: {
    group: "postgresql.cnpg.io",
    version: "v1",
    plural: "poolers",
    namespaced: true,
  },
  Reservation: {
    group: "scheduling.koordinator.sh",
    version: "v1alpha1",
    plural: "reservations",
    namespaced: false,
  },
  LVMNode: {
    group: "local.openebs.io",
    version: "v1alpha1",
    plural: "lvmnodes",
    namespaced: true,
  },
  LVMVolume: {
    group: "local.openebs.io",
    version: "v1alpha1",
    plural: "lvmvolumes",
    namespaced: true,
  },
};
const versions: Record<string, string> = {
  Node: "v1",
  Pod: "v1",
  PersistentVolume: "v1",
  PersistentVolumeClaim: "v1",
  ResourceQuota: "v1",
  Namespace: "v1",
  Service: "v1",
  Deployment: "apps/v1",
  ReplicaSet: "apps/v1",
  Job: "batch/v1",
  StorageClass: "storage.k8s.io/v1",
  CSINode: "storage.k8s.io/v1",
  MutatingWebhookConfiguration: "admissionregistration.k8s.io/v1",
  ValidatingWebhookConfiguration: "admissionregistration.k8s.io/v1",
  ...Object.fromEntries(
    Object.entries(customKinds).map(([k, v]) => [k, v.group + "/" + v.version]),
  ),
};
function scope(kind: string, ns: string, name?: string): void {
  const namespaced =
    customKinds[kind]?.namespaced ||
    [
      "Pod",
      "PersistentVolumeClaim",
      "Deployment",
      "Service",
      "ResourceQuota",
      "Job",
      "ReplicaSet",
    ].includes(kind);
  if (
    !versions[kind] ||
    (namespaced
      ? !/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(ns)
      : ns !== "") ||
    (name !== undefined &&
      !/^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/.test(name))
  )
    throw failure();
}
function typed(value: unknown, kind: string): Resource {
  // Normalize official model Dates/undefined fields without manufacturing any
  // identity or status. Endpoint TypeMeta may be omitted, never foreign.
  const v = JSON.parse(JSON.stringify(value)) as Resource;
  if (
    !v ||
    typeof v !== "object" ||
    !v.metadata ||
    typeof v.metadata.name !== "string" ||
    (v.kind !== undefined && v.kind !== kind) ||
    (v.apiVersion !== undefined && v.apiVersion !== versions[kind])
  )
    throw failure();
  return { ...v, kind, apiVersion: versions[kind]! };
}
export function capacityKubernetesFromConfig(
  file?: string,
  authorized: () => void = () => {},
  signal?: AbortSignal,
): CapacityRuntime {
  const config = new KubeConfig();
  if (file) config.loadFromFile(file);
  else if (process.env.KUBERNETES_SERVICE_HOST) config.loadFromCluster();
  else throw failure();
  return capacityKubernetesFromClientConfig(config, authorized, signal);
}
export function capacityKubernetesFromClientConfig(
  config: KubeConfig,
  authorized: () => void = () => {},
  signal?: AbortSignal,
): CapacityRuntime {
  const core = config.makeApiClient(CoreV1Api),
    batch = config.makeApiClient(BatchV1Api),
    apps = config.makeApiClient(AppsV1Api),
    storage = config.makeApiClient(StorageV1Api),
    admission = config.makeApiClient(AdmissionregistrationV1Api),
    custom = config.makeApiClient(CustomObjectsApi);
  function options(dispatch?: Dispatch, patch = false): ConfigurationOptions {
    const base: ConfigurationOptions = {
      middlewareMergeStrategy: "append",
      middleware: [
        {
          pre(request) {
            // This runs after the generated SDK request's asynchronous auth.
            authorized();
            dispatch?.check();
            const remaining = dispatch
              ? dispatch.expiresAt() - Date.now()
              : 20_000;
            if (!Number.isSafeInteger(remaining) || remaining <= 0)
              throw failure();
            const timed = AbortSignal.timeout(Math.min(20_000, remaining));
            request.setSignal(
              signal ? AbortSignal.any([timed, signal]) : timed,
            );
            return new Observable(Promise.resolve(request));
          },
          post(response) {
            return new Observable(Promise.resolve(response));
          },
        },
      ],
    };
    return patch
      ? setHeaderOptions("Content-Type", PatchStrategy.JsonPatch, base)
      : base;
  }
  function write(dispatch?: Dispatch): ConfigurationOptions {
    if (!dispatch) throw failure();
    return options(dispatch);
  }
  return {
    async read(kind, namespace, name) {
      scope(kind, namespace, name);
      const opts = options();
      try {
        let value: unknown;
        const c = customKinds[kind];
        if (c) {
          const { group, version, plural } = c;
          value = c.namespaced
            ? await custom.getNamespacedCustomObject(
                { group, version, plural, namespace, name },
                opts,
              )
            : await custom.getClusterCustomObject(
                { group, version, plural, name },
                opts,
              );
        } else
          switch (kind) {
            case "Node":
              value = await core.readNode({ name }, opts);
              break;
            case "Pod":
              value = await core.readNamespacedPod({ namespace, name }, opts);
              break;
            case "Namespace":
              value = await core.readNamespace({ name }, opts);
              break;
            case "Service":
              value = await core.readNamespacedService(
                { namespace, name },
                opts,
              );
              break;
            case "PersistentVolume":
              value = await core.readPersistentVolume({ name }, opts);
              break;
            case "PersistentVolumeClaim":
              value = await core.readNamespacedPersistentVolumeClaim(
                { namespace, name },
                opts,
              );
              break;
            case "ResourceQuota":
              value = await core.readNamespacedResourceQuota(
                { namespace, name },
                opts,
              );
              break;
            case "Deployment":
              value = await apps.readNamespacedDeployment(
                { namespace, name },
                opts,
              );
              break;
            case "Job":
              value = await batch.readNamespacedJob({ namespace, name }, opts);
              break;
            case "ReplicaSet":
              value = await apps.readNamespacedReplicaSet(
                { namespace, name },
                opts,
              );
              break;
            case "StorageClass":
              value = await storage.readStorageClass({ name }, opts);
              break;
            case "CSINode":
              value = await storage.readCSINode({ name }, opts);
              break;
            case "MutatingWebhookConfiguration":
              value = await admission.readMutatingWebhookConfiguration(
                { name },
                opts,
              );
              break;
            case "ValidatingWebhookConfiguration":
              value = await admission.readValidatingWebhookConfiguration(
                { name },
                opts,
              );
              break;
            default:
              throw failure();
          }
        return typed(value, kind);
      } catch (error) {
        if (error instanceof ApiException && error.code === 404) return null;
        throw error;
      }
    },
    async list(kind, namespace) {
      const ns = namespace ?? "";
      scope(kind, ns);
      const budget = {
        remainingRequests: 10,
        remainingResources: 1000,
        deadline: Date.now() + 20_000,
      };
      const opts = options({
        check: authorized,
        expiresAt: () => budget.deadline,
      });
      return inventoryPages(
        async (_continue) => {
          const c = customKinds[kind];
          if (c) {
            const { group, version, plural } = c;
            return c.namespaced
              ? custom.listNamespacedCustomObject(
                  {
                    group,
                    version,
                    plural,
                    namespace: ns,
                    limit: 100,
                    _continue,
                  },
                  opts,
                )
              : custom.listClusterCustomObject(
                  { group, version, plural, limit: 100, _continue },
                  opts,
                );
          }
          switch (kind) {
            case "Node":
              return core.listNode({ limit: 100, _continue }, opts);
            case "Pod":
              return core.listNamespacedPod(
                { namespace: ns, limit: 100, _continue },
                opts,
              );
            case "PersistentVolume":
              return core.listPersistentVolume({ limit: 100, _continue }, opts);
            case "PersistentVolumeClaim":
              return core.listNamespacedPersistentVolumeClaim(
                { namespace: ns, limit: 100, _continue },
                opts,
              );
            default:
              throw failure();
          }
        },
        kind,
        versions[kind]!,
        budget,
      );
    },
    async create(r, dispatch) {
      const namespace = r.metadata.namespace ?? "";
      scope(r.kind, namespace, r.metadata.name);
      if (r.apiVersion !== versions[r.kind]) throw failure();
      const opts = write(dispatch),
        fieldValidation = "Strict";
      let result: unknown;
      switch (r.kind) {
        case "Reservation":
          result = await custom.createClusterCustomObject(
            {
              group: "scheduling.koordinator.sh",
              version: "v1alpha1",
              plural: "reservations",
              body: r,
              fieldValidation,
            },
            opts,
          );
          break;
        case "PersistentVolumeClaim":
          result = await core.createNamespacedPersistentVolumeClaim(
            {
              namespace,
              body: r as unknown as V1PersistentVolumeClaim,
              fieldValidation,
            },
            opts,
          );
          break;
        case "StorageClass":
          result = await storage.createStorageClass(
            { body: r as unknown as V1StorageClass, fieldValidation },
            opts,
          );
          break;
        default:
          throw failure();
      }
      return typed(result, r.kind);
    },
    async patch(kind, namespace, name, operations, dispatch) {
      scope(kind, namespace, name);
      if (
        !dispatch ||
        operations.length < 3 ||
        operations.length > 16 ||
        !operations.some(
          (p) =>
            p.op === "test" &&
            p.path === "/metadata/uid" &&
            typeof p.value === "string",
        ) ||
        !operations.some(
          (p) =>
            p.op === "test" &&
            p.path === "/metadata/resourceVersion" &&
            typeof p.value === "string",
        ) ||
        !operations.some((p) => p.op === "test" && p.path === "/spec")
      )
        throw failure();
      const allowed =
        kind === "PersistentVolume"
          ? ["/spec/claimRef", "/spec/storageClassName"]
          : kind === "PersistentVolumeClaim"
            ? ["/spec/volumeName"]
            : kind === "ResourceQuota"
              ? ["/spec/hard/pods"]
              : [];
      if (
        operations.some(
          (p) =>
            p.op !== "test" &&
            (!["replace", "add"].includes(p.op) || !allowed.includes(p.path)),
        )
      )
        throw failure();
      if (kind === "ResourceQuota") {
        const changes = operations.filter((p) => p.op !== "test");
        if (
          name !== "database-resources" ||
          changes.length !== 1 ||
          changes[0]?.op !== "replace" ||
          changes[0].path !== "/spec/hard/pods" ||
          typeof changes[0].value !== "string" ||
          !/^[1-9][0-9]?$/.test(changes[0].value)
        )
          throw failure();
      }
      const opts = options(dispatch, true),
        fieldValidation = "Strict";
      const result =
        kind === "PersistentVolume"
          ? await core.patchPersistentVolume(
              { name, body: operations, fieldValidation },
              opts,
            )
          : kind === "PersistentVolumeClaim"
            ? await core.patchNamespacedPersistentVolumeClaim(
                { namespace, name, body: operations, fieldValidation },
                opts,
              )
            : kind === "ResourceQuota"
              ? await core.patchNamespacedResourceQuota(
                  { namespace, name, body: operations, fieldValidation },
                  opts,
                )
              : (() => {
                  throw failure();
                })();
      return typed(result, kind);
    },
    async remove(kind, namespace, name, uid, resourceVersion, dispatch) {
      scope(kind, namespace, name);
      if (
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(uid) ||
        !/^[1-9][0-9]{0,18}$/.test(resourceVersion) ||
        !dispatch
      )
        throw failure();
      const opts = write(dispatch),
        body = { preconditions: { uid, resourceVersion } };
      if (kind === "PersistentVolumeClaim")
        await core.deleteNamespacedPersistentVolumeClaim(
          { namespace, name, body },
          opts,
        );
      else if (kind === "Reservation")
        await custom.deleteClusterCustomObject(
          {
            group: "scheduling.koordinator.sh",
            version: "v1alpha1",
            plural: "reservations",
            name,
            body,
          },
          opts,
        );
      else throw failure();
      // DELETE acknowledgement is not absence; the caller performs scoped
      // readback and retains its original journal identity through uncertainty.
    },
  };
}
