// SPDX-License-Identifier: Apache-2.0
import {
  ApiException,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  Observable,
  PatchStrategy,
  setHeaderOptions,
} from "@kubernetes/client-node";
import type { ConfigurationOptions, V1Secret } from "@kubernetes/client-node";
import type { RoleRuntime } from "./role-types.ts";
import type { Resource } from "./types.ts";

const resources = {
  Cluster: { group: "postgresql.cnpg.io", version: "v1", plural: "clusters" },
  DatabaseRole: {
    group: "postgresql.cnpg.io",
    version: "v1",
    plural: "databaseroles",
  },
  CiliumNetworkPolicy: {
    group: "cilium.io",
    version: "v2",
    plural: "ciliumnetworkpolicies",
  },
};
export function roleKubernetesFromConfig(file?: string): RoleRuntime {
  const config = new KubeConfig();
  if (file) config.loadFromFile(file);
  else if (process.env.KUBERNETES_SERVICE_HOST) config.loadFromCluster();
  else throw new Error("role_explicit_kubeconfig_required");
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
  const patchOptions = setHeaderOptions(
    "Content-Type",
    PatchStrategy.JsonPatch,
    options,
  );
  return {
    async read(kind, namespace, name) {
      try {
        if (kind === "Namespace")
          return (await core.readNamespace(
            { name },
            options,
          )) as unknown as Resource;
        if (kind === "Secret") {
          const secret = await core.readNamespacedSecret(
            { namespace, name },
            options,
          );
          // CA Secrets can also contain ca.key. Only the public certificate is
          // exposed to the caller; credential revisions expose their two fields.
          const data = /^pgcf-role-[a-f0-9]{32}-v[1-9][0-9]*$/.test(name)
            ? {
                username: secret.data?.username ?? "",
                password: secret.data?.password ?? "",
              }
            : { "ca.crt": secret.data?.["ca.crt"] ?? "" };
          return { ...secret, data } as unknown as Resource;
        }
        return (await custom.getNamespacedCustomObject(
          { ...resources[kind], namespace, name },
          options,
        )) as Resource;
      } catch (error) {
        if (error instanceof ApiException && error.code === 404) return null;
        throw error;
      }
    },
    async create(resource) {
      const namespace = resource.metadata.namespace;
      if (!namespace || !/^pgcf-[a-f0-9]{32}$/.test(namespace))
        throw new Error("role_create_scope_invalid");
      if (resource.kind === "Secret")
        return (await core.createNamespacedSecret(
          {
            namespace,
            body: resource as unknown as V1Secret,
            fieldValidation: "Strict",
          },
          options,
        )) as unknown as Resource;
      if (
        resource.kind !== "DatabaseRole" &&
        resource.kind !== "CiliumNetworkPolicy"
      )
        throw new Error("role_create_scope_invalid");
      return (await custom.createNamespacedCustomObject(
        {
          ...resources[resource.kind],
          namespace,
          body: resource,
          fieldValidation: "Strict",
        },
        options,
      )) as Resource;
    },
    async patchRole(namespace, name, operations) {
      if (
        !/^pgcf-[a-f0-9]{32}$/.test(namespace) ||
        !/^pgcf-role-[a-f0-9]{32}$/.test(name) ||
        operations.length !== 4 ||
        operations[0]?.op !== "test" ||
        operations[0].path !== "/metadata/uid" ||
        operations[1]?.op !== "test" ||
        operations[1].path !== "/metadata/resourceVersion" ||
        operations[2]?.op !== "replace" ||
        operations[2].path !== "/spec/passwordSecret/name" ||
        operations[3]?.op !== "replace" ||
        operations[3].path !==
          "/metadata/annotations/pgcf.io~1credential-revision"
      )
        throw new Error("role_patch_scope_invalid");
      await custom.patchNamespacedCustomObject(
        {
          ...resources.DatabaseRole,
          namespace,
          name,
          body: operations,
          fieldValidation: "Strict",
        },
        patchOptions,
      );
    },
  };
}
