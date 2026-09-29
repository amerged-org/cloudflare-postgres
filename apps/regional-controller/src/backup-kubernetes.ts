// SPDX-License-Identifier: Apache-2.0
import {
  ApiException,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  Observable,
} from "@kubernetes/client-node";
import type { ConfigurationOptions } from "@kubernetes/client-node";
import type { BackupRuntime } from "./backup-types.ts";
import type { Resource } from "./types.ts";

const types = {
  Cluster: { group: "postgresql.cnpg.io", version: "v1", plural: "clusters" },
  ObjectStore: {
    group: "barmancloud.cnpg.io",
    version: "v1",
    plural: "objectstores",
  },
  Backup: { group: "postgresql.cnpg.io", version: "v1", plural: "backups" },
};
export function backupKubernetesFromConfig(file?: string): BackupRuntime {
  const config = new KubeConfig();
  if (file) config.loadFromFile(file);
  else if (process.env.KUBERNETES_SERVICE_HOST) config.loadFromCluster();
  else throw new Error("backup_explicit_kubeconfig_required");
  const core = config.makeApiClient(CoreV1Api),
    custom = config.makeApiClient(CustomObjectsApi);
  const options: ConfigurationOptions = {
    middlewareMergeStrategy: "append",
    middleware: [
      {
        pre(request) {
          request.setSignal(AbortSignal.timeout(20_000));
          return new Observable(Promise.resolve(request));
        },
        post(response) {
          return new Observable(Promise.resolve(response));
        },
      },
    ],
  };
  return {
    async read(kind, namespace, name) {
      if (
        kind === "Namespace"
          ? namespace !== "" || !/^pgcf-[a-f0-9]{32}$/.test(name)
          : !/^pgcf-[a-f0-9]{32}$/.test(namespace) ||
            (kind === "Cluster"
              ? name !== "database"
              : kind === "ObjectStore"
                ? name !== "archive"
                : !/^backup-[a-f0-9]{32}$/.test(name))
      )
        throw new Error("backup_read_scope_invalid");
      try {
        if (kind === "Namespace")
          return (await core.readNamespace(
            { name },
            options,
          )) as unknown as Resource;
        return (await custom.getNamespacedCustomObject(
          { ...types[kind], namespace, name },
          options,
        )) as Resource;
      } catch (error) {
        if (error instanceof ApiException && error.code === 404) return null;
        throw new Error("backup_kubernetes_read_failed");
      }
    },
    async create(resource) {
      if (
        resource.apiVersion !== "postgresql.cnpg.io/v1" ||
        resource.kind !== "Backup" ||
        !/^pgcf-[a-f0-9]{32}$/.test(resource.metadata.namespace ?? "") ||
        !/^backup-[a-f0-9]{32}$/.test(resource.metadata.name)
      )
        throw new Error("backup_create_scope_invalid");
      try {
        return (await custom.createNamespacedCustomObject(
          {
            ...types.Backup,
            namespace: resource.metadata.namespace!,
            body: resource,
            fieldValidation: "Strict",
          },
          options,
        )) as Resource;
      } catch {
        throw new Error("backup_create_unconfirmed");
      }
    },
  };
}
