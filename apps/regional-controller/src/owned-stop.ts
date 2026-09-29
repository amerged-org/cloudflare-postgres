// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { RUN_EPOCH_PATCH_PATH, runtimeEpochMatches } from "./run-epoch.ts";
import {
  COHORT_HASH_PATCH_PATH,
  COHORT_UID_PATCH_PATH,
  runtimeNodeCohortMatches,
} from "./node-cohort.ts";
import type {
  AllowanceRuntime,
  RuntimeBinding,
  RuntimeInventory,
  RuntimePatch,
} from "./allowance-types.ts";
import type { Resource } from "./types.ts";

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function quantity(value: unknown, scale: bigint): bigint | null {
  if (typeof value !== "string" || value.length > 128) return null;
  const match = /^(\d+)(?:\.(\d*))?(m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/.exec(
    value,
  );
  if (!match) return null;
  const fraction = match[2] ?? "",
    suffix = match[3] ?? "";
  let numerator = BigInt(match[1]! + fraction) * scale,
    denominator = 10n ** BigInt(fraction.length);
  const binary: Record<string, number> = {
    Ki: 10,
    Mi: 20,
    Gi: 30,
    Ti: 40,
    Pi: 50,
    Ei: 60,
  };
  const decimal: Record<string, number> = {
    "": 0,
    m: -3,
    k: 3,
    M: 6,
    G: 9,
    T: 12,
    P: 15,
    E: 18,
  };
  if (binary[suffix] !== undefined) numerator *= 2n ** BigInt(binary[suffix]!);
  else if (decimal[suffix]! >= 0) numerator *= 10n ** BigInt(decimal[suffix]!);
  else denominator *= 10n ** BigInt(-decimal[suffix]!);
  const result = (numerator + denominator - 1n) / denominator;
  return result.toString().length <= 78 ? result : null;
}

function owned(resource: Resource, binding: RuntimeBinding): boolean {
  return (
    resource.metadata.labels?.["app.kubernetes.io/managed-by"] ===
      "cloudflare-postgres" &&
    resource.metadata.labels?.["pgcf.io/environment-id"] ===
      binding.environmentId &&
    resource.metadata.labels?.["pgcf.io/region-id"] === binding.regionId &&
    resource.metadata.annotations?.["pgcf.io/spec-hash"] === binding.specHash &&
    !resource.metadata.deletionTimestamp
  );
}
export function ownedInventory(
  inventory: RuntimeInventory,
  binding: RuntimeBinding,
): boolean {
  return (
    inventory.namespace.kind === "Namespace" &&
    inventory.namespace.metadata.name === binding.namespace &&
    inventory.namespace.metadata.uid === binding.namespaceUid &&
    owned(inventory.namespace, binding) &&
    inventory.cluster.kind === "Cluster" &&
    inventory.cluster.metadata.name === "database" &&
    inventory.cluster.metadata.namespace === binding.namespace &&
    inventory.cluster.metadata.uid === binding.clusterUid &&
    owned(inventory.cluster, binding) &&
    inventory.quota.kind === "ResourceQuota" &&
    inventory.quota.metadata.name === "database-resources" &&
    inventory.quota.metadata.namespace === binding.namespace &&
    inventory.quota.metadata.uid === binding.quotaUid &&
    owned(inventory.quota, binding) &&
    ownedPoolerInventory(inventory, binding) &&
    runtimeNodeCohortMatches(inventory, binding) &&
    runtimeEpochMatches(
      [
        inventory.namespace,
        inventory.cluster,
        inventory.quota,
        ...(binding.pooler ? (inventory.poolers ?? []) : []),
      ],
      binding,
    )
  );
}
function controllerOwner(
  resource: Resource,
  kind: string,
  name: string,
  uid: string,
  apiVersion: string,
): boolean {
  const owners = resource.metadata.ownerReferences?.filter(
    (owner) => owner.controller === true,
  );
  return (
    owners?.length === 1 &&
    owners[0]?.kind === kind &&
    owners[0]?.apiVersion === apiVersion &&
    owners[0]?.name === name &&
    owners[0]?.uid === uid
  );
}
function ownedPoolerInventory(
  inventory: RuntimeInventory,
  binding: RuntimeBinding,
): boolean {
  const poolers = inventory.poolers ?? [];
  const deployments = inventory.deployments ?? [];
  if (!binding.pooler) return poolers.length === 0 && deployments.length === 0;
  const pooler = poolers[0];
  const deployment = deployments[0];
  return (
    poolers.length === 1 &&
    deployments.length === 1 &&
    pooler !== undefined &&
    deployment !== undefined &&
    pooler.kind === "Pooler" &&
    pooler.apiVersion === "postgresql.cnpg.io/v1" &&
    pooler.metadata.namespace === binding.namespace &&
    pooler.metadata.name === "database-pool-rw" &&
    pooler.metadata.uid === binding.pooler.uid &&
    owned(pooler, binding) &&
    object(pooler.spec?.cluster).name === "database" &&
    controllerOwner(
      pooler,
      "Cluster",
      "database",
      binding.clusterUid,
      "postgresql.cnpg.io/v1",
    ) &&
    deployment.kind === "Deployment" &&
    deployment.apiVersion === "apps/v1" &&
    deployment.metadata.namespace === binding.namespace &&
    deployment.metadata.name === "database-pool-rw" &&
    deployment.metadata.uid === binding.pooler.deploymentUid &&
    !deployment.metadata.deletionTimestamp &&
    controllerOwner(
      deployment,
      "Pooler",
      "database-pool-rw",
      binding.pooler.uid,
      "postgresql.cnpg.io/v1",
    )
  );
}
function poolerStopped(
  inventory: RuntimeInventory,
  binding: RuntimeBinding,
): boolean {
  if (!binding.pooler) return true;
  const pooler = inventory.poolers?.[0];
  const deployment = inventory.deployments?.[0];
  if (
    !pooler ||
    !deployment ||
    !deployment.status ||
    pooler.spec?.instances !== 0 ||
    deployment.spec?.replicas !== 0 ||
    !Number.isSafeInteger(deployment.metadata.generation) ||
    deployment.metadata.generation! <= 0 ||
    deployment.status?.observedGeneration !== deployment.metadata.generation
  )
    return false;
  return [
    "replicas",
    "readyReplicas",
    "availableReplicas",
    "updatedReplicas",
  ].every((field) => {
    const value = (deployment.status as Record<string, unknown> | undefined)?.[
      field
    ];
    // Kubernetes omits optional counters when their effective value is zero.
    return value === undefined || value === 0;
  });
}
export function volumeHash(
  inventory: RuntimeInventory,
  binding: RuntimeBinding,
): string {
  const volumes = inventory.pvcs
    .map((pvc) => {
      const spec = object(pvc.spec);
      const pv = inventory.pvs.find(
        (candidate) => candidate.metadata.name === spec.volumeName,
      );
      const pvSpec = object(pv?.spec),
        claim = object(pvSpec.claimRef);
      if (
        pvc.metadata.namespace !== binding.namespace ||
        !pvc.metadata.uid ||
        !pv?.metadata.uid ||
        pvc.metadata.deletionTimestamp ||
        pv.metadata.deletionTimestamp ||
        pvc.status?.phase !== "Bound" ||
        pv.status?.phase !== "Bound" ||
        claim.uid !== pvc.metadata.uid ||
        claim.name !== pvc.metadata.name ||
        claim.namespace !== binding.namespace ||
        spec.storageClassName !== pvSpec.storageClassName ||
        pvSpec.persistentVolumeReclaimPolicy !== "Retain"
      )
        throw new Error("allowance_volume_binding_unproven");
      const capacity = quantity(object(pvSpec.capacity).storage, 1n);
      if (capacity === null)
        throw new Error("allowance_volume_capacity_unproven");
      return {
        pvc: pvc.metadata.uid,
        pvcName: pvc.metadata.name,
        pv: pv.metadata.uid,
        pvName: pv.metadata.name,
        storageClass: spec.storageClassName,
        bytes: capacity.toString(),
      };
    })
    .sort((a, b) => a.pvc.localeCompare(b.pvc));
  if (
    new Set(volumes.map((volume) => volume.pvc)).size !== volumes.length ||
    new Set(volumes.map((volume) => volume.pv)).size !== volumes.length
  )
    throw new Error("allowance_volume_binding_conflict");
  return createHash("sha256")
    .update(
      JSON.stringify({
        namespaceUid: binding.namespaceUid,
        clusterUid: binding.clusterUid,
        volumes,
      }),
    )
    .digest("hex");
}

function patchGuards(
  resource: Resource,
  binding: RuntimeBinding,
): RuntimePatch[] {
  if (
    !resource.metadata.uid ||
    !resource.metadata.resourceVersion ||
    !runtimeEpochMatches([resource], binding)
  )
    throw new Error("allowance_patch_identity_unproven");
  return [
    { op: "test", path: "/metadata/uid", value: resource.metadata.uid },
    {
      op: "test",
      path: "/metadata/resourceVersion",
      value: resource.metadata.resourceVersion,
    },
    ...(binding.runEpoch === undefined
      ? []
      : [
          {
            op: "test" as const,
            path: RUN_EPOCH_PATCH_PATH,
            value: binding.runEpoch,
          },
        ]),
    ...(binding.nodeCohort &&
    (resource.kind === "Cluster" || resource.kind === "Pooler")
      ? [
          {
            op: "test" as const,
            path: COHORT_UID_PATCH_PATH,
            value: binding.nodeCohort.uid,
          },
          {
            op: "test" as const,
            path: COHORT_HASH_PATCH_PATH,
            value: binding.nodeCohort.hash,
          },
        ]
      : []),
  ];
}

// This helper changes only the sealed owned compute. It does not settle usage,
// grant execution, restore replicas, or reset any caller's durable journal.
// Success is Kubernetes convergence only: API Pod absence cannot prove that
// node processes ended. Durable node-backed stop qualification remains required.
export async function stopOwnedRuntime(
  runtime: AllowanceRuntime,
  binding: RuntimeBinding,
  expectedVolumesHash: string,
  authorized: () => void = () => {},
  initialInventory?: RuntimeInventory,
): Promise<boolean> {
  let inventory: RuntimeInventory;
  try {
    authorized();
    inventory = initialInventory ?? (await runtime.inventory());
    authorized();
    if (
      !ownedInventory(inventory, binding) ||
      volumeHash(inventory, binding) !== expectedVolumesHash
    )
      return false;
  } catch {
    return false;
  }
  const verify = async () => {
    authorized();
    const current = await runtime.inventory();
    authorized();
    if (
      !ownedInventory(current, binding) ||
      volumeHash(current, binding) !== expectedVolumesHash
    )
      throw new Error("allowance_stop_identity_changed");
    return current;
  };
  try {
    if (object(object(inventory.quota.spec).hard).pods !== "0") {
      const operations = [
        ...patchGuards(inventory.quota, binding),
        {
          op: Object.hasOwn(object(object(inventory.quota.spec).hard), "pods")
            ? ("replace" as const)
            : ("add" as const),
          path: "/spec/hard/pods",
          value: "0",
        },
      ];
      try {
        authorized();
        await runtime.patch(
          "ResourceQuota",
          inventory.quota.metadata.name,
          operations,
        );
      } catch {
        /* Resolve the same uncertain mutation by authenticated readback. */
      }
      inventory = await verify();
      if (object(object(inventory.quota.spec).hard).pods !== "0") return false;
    }
    if (binding.pooler) {
      const pooler = inventory.poolers![0]!;
      if (pooler.spec?.instances !== 0) {
        const operations: RuntimePatch[] = [
          ...patchGuards(pooler, binding),
          { op: "replace", path: "/spec/instances", value: 0 },
        ];
        try {
          authorized();
          await runtime.patch("Pooler", "database-pool-rw", operations);
        } catch {
          /* Resolve a lost patch reply by owned readback, never blind retry. */
        }
        inventory = await verify();
        if (inventory.poolers?.[0]?.spec?.instances !== 0) return false;
      }
    }
    if (
      inventory.cluster.metadata.annotations?.["cnpg.io/hibernation"] !== "on"
    ) {
      const operations = [
        ...patchGuards(inventory.cluster, binding),
        {
          op: "add" as const,
          path: "/metadata/annotations/cnpg.io~1hibernation",
          value: "on",
        },
      ];
      try {
        authorized();
        await runtime.patch(
          "Cluster",
          inventory.cluster.metadata.name,
          operations,
        );
      } catch {
        /* No blind retry, resume or volume deletion. */
      }
      inventory = await verify();
      if (
        inventory.cluster.metadata.annotations?.["cnpg.io/hibernation"] !== "on"
      )
        return false;
    }
    inventory = await verify();
    if (
      inventory.pods.some(
        (pod) =>
          pod.metadata.namespace !== binding.namespace ||
          pod.metadata.deletionTimestamp !== undefined ||
          !["Succeeded", "Failed"].includes(pod.status?.phase ?? ""),
      )
    )
      return false;
    if (
      object(object(inventory.quota.spec).hard).pods !== "0" ||
      inventory.cluster.metadata.annotations?.["cnpg.io/hibernation"] !==
        "on" ||
      !poolerStopped(inventory, binding)
    )
      return false;
    authorized();
    return true;
  } catch {
    return false;
  }
}
