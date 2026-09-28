// SPDX-License-Identifier: Apache-2.0
import {
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  Observable,
  PatchStrategy,
  setHeaderOptions,
} from "@kubernetes/client-node";
import type { ConfigurationOptions } from "@kubernetes/client-node";
import { inventoryPages } from "./kubernetes.ts";
import type { InventoryBudget } from "./kubernetes.ts";
import type { AllowanceRuntime, RuntimeBinding } from "./allowance-types.ts";
import type { Resource } from "./types.ts";

export function allowanceKubernetesFromConfig(
  file: string,
  context: string,
  binding: RuntimeBinding,
): AllowanceRuntime {
  const config = new KubeConfig();
  config.loadFromFile(file);
  if (!context || !config.getContexts().some((value) => value.name === context))
    throw new Error("allowance_kubernetes_context_invalid");
  config.setCurrentContext(context);
  const core = config.makeApiClient(CoreV1Api),
    custom = config.makeApiClient(CustomObjectsApi);
  let budget: InventoryBudget | null = null;
  const options: ConfigurationOptions = {
    middlewareMergeStrategy: "append",
    middleware: [
      {
        pre(request) {
          const remaining = budget ? budget.deadline - Date.now() : 20_000;
          if (remaining <= 0) throw new Error("allowance_inventory_deadline");
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
  const patchOptions = setHeaderOptions(
    "Content-Type",
    PatchStrategy.JsonPatch,
    options,
  );
  const identity = {
    group: "postgresql.cnpg.io",
    version: "v1",
    plural: "clusters",
    namespace: binding.namespace,
    name: "database",
  };
  return {
    async inventory() {
      const current: InventoryBudget = {
        remainingRequests: 40,
        remainingResources: 2000,
        deadline: Date.now() + 30_000,
      };
      budget = current;
      try {
        const [namespace, cluster, quota, pods, pvcs, allPvs] =
          await Promise.all([
            core.readNamespace({ name: binding.namespace }, options),
            custom.getNamespacedCustomObject(identity, options),
            core.readNamespacedResourceQuota(
              { namespace: binding.namespace, name: "database-resources" },
              options,
            ),
            inventoryPages(
              (_continue) =>
                core.listNamespacedPod(
                  { namespace: binding.namespace, limit: 100, _continue },
                  options,
                ),
              "Pod",
              "v1",
              current,
            ),
            inventoryPages(
              (_continue) =>
                core.listNamespacedPersistentVolumeClaim(
                  { namespace: binding.namespace, limit: 100, _continue },
                  options,
                ),
              "PersistentVolumeClaim",
              "v1",
              current,
            ),
            inventoryPages(
              (_continue) =>
                core.listPersistentVolume({ limit: 100, _continue }, options),
              "PersistentVolume",
              "v1",
              current,
            ),
          ]);
        if (Date.now() >= current.deadline)
          throw new Error("allowance_inventory_deadline");
        const selectedNames = new Set(pvcs.map((pvc) => pvc.spec?.volumeName));
        const pvs = allPvs.filter((pv) => selectedNames.has(pv.metadata.name));
        return {
          namespace: {
            ...namespace,
            kind: "Namespace",
            apiVersion: "v1",
          } as unknown as Resource,
          cluster: cluster as Resource,
          quota: {
            ...quota,
            kind: "ResourceQuota",
            apiVersion: "v1",
          } as unknown as Resource,
          pods,
          pvcs,
          pvs,
        };
      } finally {
        budget = null;
      }
    },
    async patch(kind, name, operations) {
      if (
        !operations.some(
          (op) => op.op === "test" && op.path === "/metadata/uid",
        ) ||
        !operations.some(
          (op) => op.op === "test" && op.path === "/metadata/resourceVersion",
        ) ||
        operations.filter((op) => op.op !== "test").length !== 1
      )
        throw new Error("allowance_patch_unfenced");
      const edit = operations.find((op) => op.op !== "test")!;
      if (
        kind === "ResourceQuota" &&
        name === "database-resources" &&
        edit.path === "/spec/hard/pods" &&
        edit.value === "0"
      ) {
        await core.patchNamespacedResourceQuota(
          {
            namespace: binding.namespace,
            name,
            body: operations,
            fieldValidation: "Strict",
          },
          patchOptions,
        );
      } else if (
        kind === "Cluster" &&
        name === "database" &&
        edit.path === "/metadata/annotations/cnpg.io~1hibernation" &&
        edit.value === "on"
      ) {
        await custom.patchNamespacedCustomObject(
          { ...identity, body: operations, fieldValidation: "Strict" },
          patchOptions,
        );
      } else throw new Error("allowance_patch_scope_invalid");
    },
  };
}
