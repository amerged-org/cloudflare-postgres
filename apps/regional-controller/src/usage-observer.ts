// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type {
  Allocation,
  Attribution,
  MeteringInventory,
  MeterMetric,
  ObservationResult,
  RetainedVolumeBinding,
} from "./metering-types.ts";
import type { Resource } from "./types.ts";

const managedLabel = "app.kubernetes.io/managed-by";
const environmentLabel = "pgcf.io/environment-id";
const regionLabel = "pgcf.io/region-id";
const specAnnotation = "pgcf.io/spec-hash";
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const specHash = /^[a-f0-9]{64}$/;
const decimalExponents: Record<string, number> = {
  "": 0,
  n: -9,
  u: -6,
  m: -3,
  k: 3,
  M: 6,
  G: 9,
  T: 12,
  P: 15,
  E: 18,
};
const binaryExponents: Record<string, number> = {
  Ki: 10,
  Mi: 20,
  Gi: 30,
  Ti: 40,
  Pi: 50,
  Ei: 60,
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uid(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function ceil(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

// Resource.Quantity is fixed point (decimal SI, binary SI or decimal exponent),
// never IEEE-754. Follow its positive nano rounding and byte/MilliValue rounding.
// A bounded unsupported magnitude produces an issue instead of a guessed rate.
function quantity(value: unknown, scale: 1n | 1000n): string | null {
  if (typeof value !== "string" || value.length > 128) return null;
  const parsed = /^\+?(?:(\d+)(?:\.(\d*))?|\.(\d+))([A-Za-z].*)?$/.exec(value);
  if (!parsed) return null;
  const fraction = parsed[2] ?? parsed[3] ?? "";
  const suffix = parsed[4] ?? "";
  let numerator = BigInt((parsed[1] ?? "0") + fraction);
  let denominator = 10n ** BigInt(fraction.length);
  if (Object.hasOwn(binaryExponents, suffix)) {
    numerator *= 2n ** BigInt(binaryExponents[suffix]!);
    const maximum = 9_223_372_036_854_775_807n;
    if (numerator > maximum * denominator) {
      numerator = maximum;
      denominator = 1n;
    }
  } else {
    let exponent = decimalExponents[suffix];
    if (exponent === undefined) {
      if (!/^[eE][+-]?[0-9]{1,3}$/.test(suffix)) return null;
      exponent = Number(suffix.slice(1));
      if (Math.abs(exponent) > 78) return null;
    }
    if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
    else denominator *= 10n ** BigInt(-exponent);
  }
  const nano = ceil(numerator * 1_000_000_000n, denominator);
  const rate = ceil(nano * scale, 1_000_000_000n).toString();
  return rate.length <= 78 ? rate : null;
}

interface EnvironmentProof {
  environmentId: string;
  namespace: Resource;
  cluster: Resource;
  specHash: string;
}

type AllocationOwnership = Pick<
  RetainedVolumeBinding,
  | "environmentId"
  | "regionId"
  | "specHash"
  | "namespace"
  | "namespaceUid"
  | "clusterUid"
>;
type AllocationResource =
  | {
      kind: "compute";
      podName: string;
      podUid: string;
      container: string;
      nodeName: string;
    }
  | {
      kind: "volume";
      pvcName: string;
      pvcUid: string;
      pvName: string;
      pvUid: string;
      storageClass: string;
    };

function key(
  environmentId: string,
  resourceUid: string,
  metric: MeterMetric,
  attribution: Attribution,
): string {
  return `${environmentId}:${resourceUid}:${metric}:${attribution}`;
}

function allocation(
  ownership: AllocationOwnership,
  resource: AllocationResource,
  metric: MeterMetric,
  attribution: Attribution,
  rate: string,
  evidence: unknown,
): Allocation {
  const resourceUid =
    resource.kind === "compute"
      ? `${resource.podUid}:${resource.container}`
      : resource.pvUid;
  return {
    key: key(ownership.environmentId, resourceUid, metric, attribution),
    environmentId: ownership.environmentId,
    specHash: ownership.specHash,
    resourceUid,
    metric,
    attribution,
    rate,
    continuity: {
      version: 1,
      hash: digest({
        method: "kubernetes-allocation-continuity/v1",
        environmentId: ownership.environmentId,
        regionId: ownership.regionId,
        namespace: ownership.namespace,
        namespaceUid: ownership.namespaceUid,
        clusterUid: ownership.clusterUid,
        specHash: ownership.specHash,
        resourceUid,
        metric,
        attribution,
        rate,
        resource,
      }),
    },
    evidenceHash: digest({
      method: "kubernetes-allocation-observation/v1",
      namespaceUid: ownership.namespaceUid,
      clusterUid: ownership.clusterUid,
      specHash: ownership.specHash,
      metric,
      attribution,
      rate,
      evidence,
    }),
  };
}

function volumeAllocation(
  binding: RetainedVolumeBinding,
  rate: string,
  evidence: unknown,
): Allocation {
  return allocation(
    binding,
    {
      kind: "volume",
      pvcName: binding.pvcName,
      pvcUid: binding.pvcUid,
      pvName: binding.pvName,
      pvUid: binding.pvUid,
      storageClass: binding.storageClass,
    },
    "data_storage_byte_ms",
    binding.attribution,
    rate,
    evidence,
  );
}

function sameOwner(
  resource: Resource,
  environmentId: string,
  regionId: string,
  hash: string,
): boolean {
  return (
    resource.metadata.labels?.[managedLabel] === "cloudflare-postgres" &&
    resource.metadata.labels?.[environmentLabel] === environmentId &&
    resource.metadata.labels?.[regionLabel] === regionId &&
    resource.metadata.annotations?.[specAnnotation] === hash
  );
}

function completedInit(pod: Resource): boolean {
  const init = pod.spec?.initContainers;
  if (init === undefined || (Array.isArray(init) && init.length === 0))
    return true;
  if (!Array.isArray(init) || !Array.isArray(pod.status?.initContainerStatuses))
    return false;
  return init.every((container) => {
    if (
      !object(container) ||
      typeof container.name !== "string" ||
      container.restartPolicy === "Always"
    )
      return false;
    const status = pod.status!.initContainerStatuses!.find(
      (entry) => entry.name === container.name,
    );
    return status?.state?.terminated?.exitCode === 0;
  });
}

export function observeUsage(
  inventory: MeteringInventory,
  regionId: string,
  retainedVolumeBindings: RetainedVolumeBinding[] = [],
): ObservationResult {
  const result: ObservationResult = {
    allocations: [],
    issues: [],
    volumeBindings: [],
  };
  const proofs = new Map<string, EnvironmentProof>();
  const allocations = new Map<string, Allocation>();
  const bindings = new Map<string, RetainedVolumeBinding>();
  const pvByName = new Map(inventory.pvs.map((pv) => [pv.metadata.name, pv]));
  const pvcByName = new Map(
    inventory.pvcs.map((pvc) => [
      `${pvc.metadata.namespace}/${pvc.metadata.name}`,
      pvc,
    ]),
  );

  for (const namespace of inventory.namespaces) {
    if (
      namespace.metadata.labels?.[managedLabel] !== "cloudflare-postgres" ||
      namespace.metadata.labels?.[regionLabel] !== regionId
    )
      continue;
    const environmentId = namespace.metadata.labels[environmentLabel];
    const hash = namespace.metadata.annotations?.[specAnnotation];
    if (
      !environmentId ||
      !uuid.test(environmentId) ||
      !uid(namespace.metadata.uid) ||
      namespace.metadata.name !== `pgcf-${environmentId.replaceAll("-", "")}` ||
      !hash ||
      !specHash.test(hash)
    ) {
      result.issues.push({
        environmentId,
        code: "namespace_identity_unproven",
      });
      continue;
    }
    const clusters = inventory.clusters.filter(
      (cluster) =>
        cluster.metadata.namespace === namespace.metadata.name &&
        cluster.metadata.name === "database",
    );
    const cluster = clusters[0];
    if (
      clusters.length !== 1 ||
      !cluster ||
      !uid(cluster.metadata.uid) ||
      !sameOwner(cluster, environmentId, regionId, hash)
    ) {
      result.issues.push({ environmentId, code: "cluster_identity_unproven" });
      continue;
    }
    proofs.set(namespace.metadata.name, {
      environmentId,
      namespace,
      cluster,
      specHash: hash,
    });
  }

  for (const pod of inventory.pods) {
    const proof = proofs.get(pod.metadata.namespace ?? "");
    if (!proof) continue;
    const owner = pod.metadata.ownerReferences?.filter(
      (reference) =>
        reference.kind === "Cluster" && reference.controller === true,
    );
    if (
      !uid(pod.metadata.uid) ||
      owner?.length !== 1 ||
      owner[0]?.uid !== proof.cluster.metadata.uid ||
      owner[0]?.name !== "database" ||
      owner[0]?.apiVersion !== "postgresql.cnpg.io/v1" ||
      pod.metadata.labels?.["cnpg.io/cluster"] !== "database" ||
      pod.metadata.labels?.["cnpg.io/podRole"] !== "instance"
    ) {
      result.issues.push({
        environmentId: proof.environmentId,
        code: "pod_owner_unproven",
      });
      continue;
    }
    const primary = proof.cluster.status?.currentPrimary;
    const primaryOwned =
      typeof primary === "string" &&
      inventory.pods.some(
        (candidate) =>
          candidate.metadata.namespace === proof.namespace.metadata.name &&
          candidate.metadata.name === primary &&
          uid(candidate.metadata.uid) &&
          candidate.metadata.labels?.["cnpg.io/podRole"] === "instance" &&
          candidate.metadata.ownerReferences?.some(
            (reference) =>
              reference.kind === "Cluster" &&
              reference.controller === true &&
              reference.uid === proof.cluster.metadata.uid,
          ),
      );
    const role = primaryOwned
      ? pod.metadata.name === primary
        ? "primary"
        : "replica"
      : null;
    const storage = proof.cluster.spec?.storage;
    const expectedClass =
      object(storage) && typeof storage.storageClass === "string"
        ? storage.storageClass
        : null;

    // A bound disk remains allocated while the Pod is starting, completed, or
    // suspended. Its capacity comes from the PV, never a request/quota/profile.
    const volumes = pod.spec?.volumes;
    if (Array.isArray(volumes))
      for (const volume of volumes) {
        if (!object(volume) || !object(volume.persistentVolumeClaim)) continue;
        const postgres = Array.isArray(pod.spec?.containers)
          ? pod.spec.containers.find(
              (container) => object(container) && container.name === "postgres",
            )
          : null;
        if (
          volume.name !== "pgdata" ||
          !object(postgres) ||
          !Array.isArray(postgres.volumeMounts) ||
          !postgres.volumeMounts.some(
            (mount) => object(mount) && mount.name === "pgdata",
          )
        ) {
          result.issues.push({
            environmentId: proof.environmentId,
            code: "volume_meter_scope_unsupported",
          });
          continue;
        }
        const claimName = volume.persistentVolumeClaim.claimName;
        const pvc =
          typeof claimName === "string"
            ? pvcByName.get(`${pod.metadata.namespace}/${claimName}`)
            : null;
        const pv =
          typeof pvc?.spec?.volumeName === "string"
            ? pvByName.get(pvc.spec.volumeName)
            : null;
        const claim = pv?.spec?.claimRef;
        const capacity = pv?.spec?.capacity;
        const actualCapacity = object(capacity) ? capacity.storage : undefined;
        const rate = quantity(actualCapacity, 1n);
        if (
          !role ||
          !expectedClass ||
          !pvc ||
          !pv ||
          !uid(pvc.metadata.uid) ||
          !uid(pv.metadata.uid) ||
          pvc.status?.phase !== "Bound" ||
          !object(claim) ||
          claim.uid !== pvc.metadata.uid ||
          claim.namespace !== pod.metadata.namespace ||
          claim.name !== pvc.metadata.name ||
          pvc.spec?.storageClassName !== expectedClass ||
          pv.spec?.storageClassName !== expectedClass ||
          rate === null
        ) {
          result.issues.push({
            environmentId: proof.environmentId,
            metric: "data_storage_byte_ms",
            code: "volume_identity_or_capacity_unproven",
          });
          continue;
        }
        const binding: RetainedVolumeBinding = {
          environmentId: proof.environmentId,
          regionId,
          specHash: proof.specHash,
          namespace: proof.namespace.metadata.name,
          namespaceUid: proof.namespace.metadata.uid!,
          clusterUid: proof.cluster.metadata.uid!,
          pvcName: pvc.metadata.name,
          pvcUid: pvc.metadata.uid,
          pvName: pv.metadata.name,
          pvUid: pv.metadata.uid,
          storageClass: expectedClass,
          attribution: role,
        };
        const prior = bindings.get(pv.metadata.uid);
        if (
          prior &&
          (prior.environmentId !== binding.environmentId ||
            prior.pvcUid !== binding.pvcUid)
        ) {
          result.issues.push({
            environmentId: proof.environmentId,
            metric: "data_storage_byte_ms",
            code: "volume_binding_conflict",
          });
          continue;
        }
        if (!prior || role === "primary") {
          bindings.set(pv.metadata.uid, binding);
          const observed = volumeAllocation(binding, rate, {
            pvUid: pv.metadata.uid,
            pvResourceVersion: pv.metadata.resourceVersion,
            pvcUid: pvc.metadata.uid,
            storageClass: expectedClass,
            capacity: actualCapacity,
          });
          if (prior)
            allocations.delete(
              key(
                proof.environmentId,
                pv.metadata.uid,
                "data_storage_byte_ms",
                prior.attribution,
              ),
            );
          allocations.set(observed.key, observed);
        }
      }

    if (["Succeeded", "Failed"].includes(pod.status?.phase ?? "")) continue;
    const nodeName = pod.spec?.nodeName;
    if (!nodeName && pod.status?.phase === "Pending") continue;
    if (
      !pod.spec ||
      typeof nodeName !== "string" ||
      !["Pending", "Running"].includes(pod.status?.phase ?? "") ||
      !completedInit(pod) ||
      pod.spec.resources !== undefined ||
      pod.spec.overhead !== undefined ||
      (Array.isArray(pod.spec.ephemeralContainers) &&
        pod.spec.ephemeralContainers.length > 0)
    ) {
      result.issues.push({
        environmentId: proof.environmentId,
        code: "pod_allocation_semantics_unsupported",
      });
      continue;
    }
    const containers = pod.spec.containers;
    if (!Array.isArray(containers) || containers.length === 0) {
      result.issues.push({
        environmentId: proof.environmentId,
        code: "container_requests_unobserved",
      });
      continue;
    }
    for (const container of containers) {
      if (!object(container) || typeof container.name !== "string") {
        result.issues.push({
          environmentId: proof.environmentId,
          code: "container_identity_unproven",
        });
        continue;
      }
      const attribution: Attribution | null =
        container.name === "postgres" ? role : "platform";
      const resourceUid = `${pod.metadata.uid}:${container.name}`;
      const requests =
        object(container.resources) && object(container.resources.requests)
          ? container.resources.requests
          : null;
      for (const [metric, requestName, scale] of [
        ["cpu_millicore_ms", "cpu", 1000n],
        ["memory_byte_ms", "memory", 1n],
      ] as const) {
        const rate = requests ? quantity(requests[requestName], scale) : null;
        if (rate === null || attribution === null) {
          result.issues.push({
            key: attribution
              ? key(proof.environmentId, resourceUid, metric, attribution)
              : undefined,
            environmentId: proof.environmentId,
            metric,
            attribution: attribution ?? undefined,
            code: "container_request_or_role_unproven",
          });
          continue;
        }
        const observed = allocation(
          {
            environmentId: proof.environmentId,
            regionId,
            namespace: proof.namespace.metadata.name,
            namespaceUid: proof.namespace.metadata.uid!,
            clusterUid: proof.cluster.metadata.uid!,
            specHash: proof.specHash,
          },
          {
            kind: "compute",
            podName: pod.metadata.name,
            podUid: pod.metadata.uid!,
            container: container.name,
            nodeName,
          },
          metric,
          attribution,
          rate,
          {
            podUid: pod.metadata.uid,
            podResourceVersion: pod.metadata.resourceVersion,
            nodeName,
            phase: pod.status?.phase,
            container: container.name,
            requests,
          },
        );
        allocations.set(observed.key, observed);
      }
    }
  }

  for (const binding of retainedVolumeBindings) {
    if (bindings.has(binding.pvUid)) continue;
    if (
      binding.regionId !== regionId ||
      !uuid.test(binding.environmentId) ||
      !specHash.test(binding.specHash) ||
      binding.namespace !==
        `pgcf-${binding.environmentId.replaceAll("-", "")}` ||
      !uid(binding.namespaceUid) ||
      !uid(binding.clusterUid) ||
      !uid(binding.pvcUid) ||
      !uid(binding.pvUid)
    ) {
      result.issues.push({
        environmentId: binding.environmentId,
        metric: "data_storage_byte_ms",
        code: "retained_volume_provenance_invalid",
      });
      continue;
    }
    const currentPvc = pvcByName.get(`${binding.namespace}/${binding.pvcName}`);
    if (
      inventory.namespaces.some(
        (namespace) =>
          namespace.metadata.name === binding.namespace &&
          (namespace.metadata.uid !== binding.namespaceUid ||
            !sameOwner(
              namespace,
              binding.environmentId,
              binding.regionId,
              binding.specHash,
            )),
      ) ||
      inventory.clusters.some((cluster) => {
        if (
          cluster.metadata.namespace !== binding.namespace ||
          cluster.metadata.name !== "database"
        )
          return false;
        const storage = cluster.spec?.storage;
        return (
          cluster.metadata.uid !== binding.clusterUid ||
          !sameOwner(
            cluster,
            binding.environmentId,
            binding.regionId,
            binding.specHash,
          ) ||
          !object(storage) ||
          storage.storageClass !== binding.storageClass
        );
      }) ||
      (currentPvc &&
        (currentPvc.metadata.uid !== binding.pvcUid ||
          currentPvc.spec?.volumeName !== binding.pvName ||
          currentPvc.spec?.storageClassName !== binding.storageClass ||
          currentPvc.status?.phase !== "Bound"))
    ) {
      result.issues.push({
        key: key(
          binding.environmentId,
          binding.pvUid,
          "data_storage_byte_ms",
          binding.attribution,
        ),
        environmentId: binding.environmentId,
        metric: "data_storage_byte_ms",
        attribution: binding.attribution,
        code: "retained_volume_ownership_changed",
      });
      continue;
    }
    const pv = pvByName.get(binding.pvName);
    const claim = pv?.spec?.claimRef;
    const capacity = pv?.spec?.capacity;
    const actualCapacity = object(capacity) ? capacity.storage : undefined;
    const rate = quantity(actualCapacity, 1n);
    if (
      !pv ||
      pv.metadata.uid !== binding.pvUid ||
      !object(claim) ||
      claim.uid !== binding.pvcUid ||
      claim.name !== binding.pvcName ||
      claim.namespace !== binding.namespace ||
      pv.spec?.storageClassName !== binding.storageClass ||
      rate === null
    ) {
      result.issues.push({
        key: key(
          binding.environmentId,
          binding.pvUid,
          "data_storage_byte_ms",
          binding.attribution,
        ),
        environmentId: binding.environmentId,
        metric: "data_storage_byte_ms",
        attribution: binding.attribution,
        code: "retained_volume_identity_changed",
      });
      continue;
    }
    bindings.set(binding.pvUid, binding);
    const observed = volumeAllocation(binding, rate, {
      method: "kubernetes-retained-volume-observation/v1",
      binding,
      pvResourceVersion: pv.metadata.resourceVersion,
      capacity: actualCapacity,
    });
    allocations.set(observed.key, observed);
  }
  result.allocations = [...allocations.values()].sort((a, b) =>
    a.key.localeCompare(b.key),
  );
  result.volumeBindings = [...bindings.values()].sort((a, b) =>
    a.pvUid.localeCompare(b.pvUid),
  );
  return result;
}
