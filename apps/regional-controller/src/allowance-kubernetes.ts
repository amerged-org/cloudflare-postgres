// SPDX-License-Identifier: Apache-2.0
import {
  AppsV1Api,
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
import type {
  AllowanceRuntime,
  RuntimeBinding,
  RuntimeInventory,
} from "./allowance-types.ts";
import { ownedInventory } from "./owned-stop.ts";
import { RUN_EPOCH_PATCH_PATH, validRunEpoch } from "./run-epoch.ts";
import {
  COHORT_HASH_PATCH_PATH,
  COHORT_UID_PATCH_PATH,
  validNodeCohortPointer,
} from "./node-cohort.ts";
import type { Resource } from "./types.ts";

export function allowanceKubernetesFromConfig(
  file: string,
  context: string,
  suppliedBinding: RuntimeBinding,
  authorized: () => void = () => {},
): AllowanceRuntime {
  const binding = Object.freeze({
    ...suppliedBinding,
    ...(suppliedBinding.nodeCohort
      ? { nodeCohort: Object.freeze({ ...suppliedBinding.nodeCohort }) }
      : {}),
    ...(suppliedBinding.pooler
      ? { pooler: Object.freeze({ ...suppliedBinding.pooler }) }
      : {}),
  });
  if (binding.runEpoch !== undefined && !validRunEpoch(binding.runEpoch))
    throw new Error("allowance_run_epoch_invalid");
  if (
    Object.hasOwn(binding, "nodeCohort") &&
    (!validRunEpoch(binding.runEpoch) ||
      !validNodeCohortPointer(binding.nodeCohort))
  )
    throw new Error("allowance_node_cohort_invalid");
  const config = new KubeConfig();
  config.loadFromFile(file);
  if (!context || !config.getContexts().some((value) => value.name === context))
    throw new Error("allowance_kubernetes_context_invalid");
  config.setCurrentContext(context);
  const core = config.makeApiClient(CoreV1Api),
    apps = config.makeApiClient(AppsV1Api),
    custom = config.makeApiClient(CustomObjectsApi);
  let budget: InventoryBudget | null = null;
  const options: ConfigurationOptions = {
    middlewareMergeStrategy: "append",
    middleware: [
      {
        pre(request) {
          authorized();
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
  const poolerIdentity = {
    ...identity,
    plural: "poolers",
    name: "database-pool-rw",
  };
  const cohortEvidence = async (
    current?: InventoryBudget,
  ): Promise<{ nodeCohort?: Resource; nodes?: Resource[] }> => {
    if (!binding.nodeCohort) return {};
    const bounds = current ?? {
      remainingRequests: 10,
      remainingResources: 1000,
      deadline: Date.now() + 30_000,
    };
    const [cohort, nodes] = await Promise.all([
      core.readNamespacedConfigMap(
        { namespace: binding.namespace, name: "execution-nodes" },
        options,
      ),
      inventoryPages(
        (_continue) => core.listNode({ limit: 100, _continue }, options),
        "Node",
        "v1",
        bounds,
      ),
    ]);
    authorized();
    if (Date.now() >= bounds.deadline)
      throw new Error("allowance_inventory_deadline");
    return {
      nodeCohort: {
        ...cohort,
        kind: cohort.kind ?? "ConfigMap",
        apiVersion: cohort.apiVersion ?? "v1",
      } as unknown as Resource,
      nodes,
    };
  };
  const freshOwners = async (): Promise<RuntimeInventory> => {
    authorized();
    const previousBudget = budget;
    const currentBudget: InventoryBudget = previousBudget ?? {
      remainingRequests: 10,
      remainingResources: 1000,
      deadline: Date.now() + 30_000,
    };
    // Named owner reads and every cohort page share one dispatch deadline.
    budget = currentBudget;
    try {
      const [namespace, cluster, quota, pooler, deployment, cohort] =
        await Promise.all([
          core.readNamespace({ name: binding.namespace }, options),
          custom.getNamespacedCustomObject(identity, options),
          core.readNamespacedResourceQuota(
            { namespace: binding.namespace, name: "database-resources" },
            options,
          ),
          binding.pooler
            ? custom.getNamespacedCustomObject(poolerIdentity, options)
            : Promise.resolve(null),
          binding.pooler
            ? apps.readNamespacedDeployment(
                { namespace: binding.namespace, name: "database-pool-rw" },
                options,
              )
            : Promise.resolve(null),
          cohortEvidence(currentBudget),
        ]);
      authorized();
      if (Date.now() >= currentBudget.deadline)
        throw new Error("allowance_inventory_deadline");
      const current: RuntimeInventory = {
        namespace: {
          ...namespace,
          kind: namespace.kind ?? "Namespace",
          apiVersion: namespace.apiVersion ?? "v1",
        } as unknown as Resource,
        cluster: cluster as Resource,
        quota: {
          ...quota,
          kind: quota.kind ?? "ResourceQuota",
          apiVersion: quota.apiVersion ?? "v1",
        } as unknown as Resource,
        poolers: pooler ? [pooler as Resource] : [],
        deployments: deployment
          ? [
              {
                ...deployment,
                kind: deployment.kind ?? "Deployment",
                apiVersion: deployment.apiVersion ?? "apps/v1",
              } as unknown as Resource,
            ]
          : [],
        pods: [],
        pvcs: [],
        pvs: [],
        ...cohort,
      };
      const required = [
        current.namespace,
        current.cluster,
        current.quota,
        ...(current.poolers ?? []),
      ];
      if (
        current.namespace.apiVersion !== "v1" ||
        current.namespace.metadata.namespace !== undefined ||
        current.cluster.apiVersion !== "postgresql.cnpg.io/v1" ||
        current.quota.apiVersion !== "v1" ||
        !ownedInventory(current, binding) ||
        required.some((resource) => !resource.metadata.resourceVersion)
      )
        throw new Error("allowance_patch_owner_set_unproven");
      return current;
    } finally {
      budget = previousBudget;
    }
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
        const [
          namespace,
          cluster,
          quota,
          pods,
          poolers,
          deployments,
          pvcs,
          allPvs,
          cohort,
        ] = await Promise.all([
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
              custom.listNamespacedCustomObject(
                {
                  group: "postgresql.cnpg.io",
                  version: "v1",
                  plural: "poolers",
                  namespace: binding.namespace,
                  limit: 100,
                  _continue,
                },
                options,
              ),
            "Pooler",
            "postgresql.cnpg.io/v1",
            current,
          ),
          inventoryPages(
            (_continue) =>
              apps.listNamespacedDeployment(
                { namespace: binding.namespace, limit: 100, _continue },
                options,
              ),
            "Deployment",
            "apps/v1",
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
          cohortEvidence(current),
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
          poolers,
          deployments,
          ...cohort,
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
      const epochTests = operations.filter(
        (op) => op.path === RUN_EPOCH_PATCH_PATH,
      );
      if (
        binding.runEpoch === undefined
          ? epochTests.length !== 0
          : epochTests.length !== 1 ||
            epochTests[0]?.op !== "test" ||
            epochTests[0]?.value !== binding.runEpoch
      )
        throw new Error("allowance_patch_epoch_unfenced");
      const cohortTests = operations.filter(
        (op) =>
          op.path === COHORT_UID_PATCH_PATH ||
          op.path === COHORT_HASH_PATCH_PATH,
      );
      if (
        binding.nodeCohort && (kind === "Cluster" || kind === "Pooler")
          ? cohortTests.length !== 2 ||
            !cohortTests.some(
              (op) =>
                op.op === "test" &&
                op.path === COHORT_UID_PATCH_PATH &&
                op.value === binding.nodeCohort!.uid,
            ) ||
            !cohortTests.some(
              (op) =>
                op.op === "test" &&
                op.path === COHORT_HASH_PATCH_PATH &&
                op.value === binding.nodeCohort!.hash,
            )
          : cohortTests.length !== 0
      )
        throw new Error("allowance_patch_cohort_unfenced");
      if (!(
        (kind === "ResourceQuota" &&
          name === "database-resources" &&
          edit.path === "/spec/hard/pods" &&
          edit.value === "0") ||
        (kind === "Pooler" &&
          name === "database-pool-rw" &&
          binding.pooler !== undefined &&
          edit.op === "replace" &&
          edit.path === "/spec/instances" &&
          edit.value === 0) ||
        (kind === "Cluster" &&
          name === "database" &&
          edit.path === "/metadata/annotations/cnpg.io~1hibernation" &&
          edit.value === "on")
      ))
        throw new Error("allowance_patch_scope_invalid");
      // Recheck the entire required owner/epoch set, not merely the mutation
      // target. A partially transitioned run must never authorize an old stop.
      const current = await freshOwners();
      const target =
        kind === "ResourceQuota"
          ? current.quota
          : kind === "Cluster"
            ? current.cluster
            : current.poolers?.[0];
      if (
        !target ||
        !operations.some(
          (op) =>
            op.op === "test" &&
            op.path === "/metadata/uid" &&
            op.value === target.metadata.uid,
        ) ||
        !operations.some(
          (op) =>
            op.op === "test" &&
            op.path === "/metadata/resourceVersion" &&
            op.value === target.metadata.resourceVersion,
        )
      )
        throw new Error("allowance_patch_identity_changed");
      authorized();
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
        kind === "Pooler" &&
        name === "database-pool-rw" &&
        binding.pooler !== undefined &&
        edit.op === "replace" &&
        edit.path === "/spec/instances" &&
        edit.value === 0
      ) {
        await custom.patchNamespacedCustomObject(
          { ...poolerIdentity, body: operations, fieldValidation: "Strict" },
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
