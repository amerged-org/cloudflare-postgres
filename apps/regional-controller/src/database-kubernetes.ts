// SPDX-License-Identifier: Apache-2.0
import {
  ApiException,
  CustomObjectsApi,
  KubeConfig,
  Observable,
} from "@kubernetes/client-node";
import type { ConfigurationOptions } from "@kubernetes/client-node";
import { roleKubernetesFromConfig } from "./role-kubernetes.ts";
import { inventoryPages } from "./kubernetes.ts";
import type { InventoryBudget } from "./kubernetes.ts";
import type { DatabaseRuntime } from "./database-types.ts";
import type { Resource } from "./types.ts";

export function databaseKubernetesFromConfig(file?: string): DatabaseRuntime {
  const roles = roleKubernetesFromConfig(file);
  const config = new KubeConfig();
  if (file) config.loadFromFile(file);
  else if (process.env.KUBERNETES_SERVICE_HOST) config.loadFromCluster();
  else throw new Error("database_explicit_kubeconfig_required");
  const custom = config.makeApiClient(CustomObjectsApi);
  let budget: InventoryBudget | null = null;
  const options: ConfigurationOptions = {
    middlewareMergeStrategy: "append",
    middleware: [
      {
        pre(request) {
          const remaining = budget ? budget.deadline - Date.now() : 20_000;
          if (remaining <= 0) throw new Error("database_inventory_deadline");
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
  const identity = {
    group: "postgresql.cnpg.io",
    version: "v1",
    plural: "databases",
  };
  return {
    async read(kind, namespace, name) {
      if (kind !== "Database") return roles.read(kind, namespace, name);
      try {
        return (await custom.getNamespacedCustomObject(
          { ...identity, namespace, name },
          options,
        )) as Resource;
      } catch (error) {
        if (error instanceof ApiException && error.code === 404) return null;
        throw error;
      }
    },
    async listDatabases(namespace) {
      const current: InventoryBudget = {
        remainingRequests: 10,
        remainingResources: 1000,
        deadline: Date.now() + 30_000,
      };
      budget = current;
      try {
        const result = await inventoryPages(
          (_continue) =>
            custom.listNamespacedCustomObject(
              { ...identity, namespace, limit: 100, _continue },
              options,
            ),
          "Database",
          "postgresql.cnpg.io/v1",
          current,
        );
        if (Date.now() >= current.deadline)
          throw new Error("database_inventory_deadline");
        return result;
      } finally {
        budget = null;
      }
    },
    async create(resource) {
      if (
        resource.kind !== "Database" ||
        resource.apiVersion !== "postgresql.cnpg.io/v1" ||
        !/^pgcf-[a-f0-9]{32}$/.test(resource.metadata.namespace ?? "") ||
        !/^pgcf-database-[a-f0-9]{32}$/.test(resource.metadata.name)
      )
        throw new Error("database_create_scope_invalid");
      return (await custom.createNamespacedCustomObject(
        {
          ...identity,
          namespace: resource.metadata.namespace!,
          body: resource,
          fieldValidation: "Strict",
        },
        options,
      )) as Resource;
    },
  };
}
