// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type { AllowanceJournal } from "./allowance-journal.ts";
import type {
  AllowanceReceipt,
  AllowanceRuntime,
  AllowanceTransport,
  AllowanceUnits,
  RuntimeBinding,
  RuntimeInventory,
  RuntimePatch,
} from "./allowance-types.ts";
import type { Resource } from "./types.ts";

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
function quantity(value: unknown, scale: bigint): bigint | null {
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
function ownedInventory(
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
    owned(inventory.quota, binding)
  );
}
function ownedPod(pod: Resource, binding: RuntimeBinding): boolean {
  return (
    pod.metadata.namespace === binding.namespace &&
    pod.metadata.ownerReferences?.some(
      (owner) =>
        owner.kind === "Cluster" &&
        owner.apiVersion === "postgresql.cnpg.io/v1" &&
        owner.name === "database" &&
        owner.controller === true &&
        owner.uid === binding.clusterUid,
    ) === true
  );
}
function volumeHash(
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
function rateEnvelope(
  inventory: RuntimeInventory,
  units: AllowanceUnits,
): AllowanceUnits | null {
  const hard = object(object(inventory.quota.spec).hard);
  const rates: AllowanceUnits = {};
  for (const metric of Object.keys(units)) {
    let rate: bigint | null;
    if (metric === "cpu_millicore_ms" || metric === "memory_byte_ms") {
      const field = metric === "cpu_millicore_ms" ? "cpu" : "memory",
        scale = metric === "cpu_millicore_ms" ? 1000n : 1n;
      rate = quantity(hard["requests." + field], scale);
      let allocated = 0n;
      for (const pod of inventory.pods) {
        if (["Succeeded", "Failed"].includes(pod.status?.phase ?? "")) continue;
        const spec = object(pod.spec);
        if (
          spec.overhead !== undefined ||
          spec.resources !== undefined ||
          array(spec.ephemeralContainers).length > 0
        )
          return null;
        const containers = array(spec.containers);
        if (!containers.length) return null;
        let ordinary = 0n;
        for (const container of containers) {
          const requested = quantity(
            object(object(object(container).resources).requests)[field],
            scale,
          );
          if (requested === null) return null;
          ordinary += requested;
        }
        let effective = ordinary;
        for (const init of array(spec.initContainers)) {
          if (object(init).restartPolicy === "Always") return null;
          const requested = quantity(
            object(object(object(init).resources).requests)[field] ?? "0",
            scale,
          );
          if (requested === null) return null;
          if (requested > effective) effective = requested;
        }
        allocated += effective;
      }
      if (rate !== null && allocated > rate) rate = allocated;
    } else if (metric === "data_storage_byte_ms") {
      rate = quantity(hard["requests.storage"], 1n);
      if (rate === null) return null;
      let allocated = 0n;
      for (const pvc of inventory.pvcs) {
        const pv = inventory.pvs.find(
          (candidate) =>
            candidate.metadata.name === object(pvc.spec).volumeName,
        );
        const capacity = quantity(
          object(object(pv?.spec).capacity).storage,
          1n,
        );
        if (capacity === null) return null;
        allocated += capacity;
      }
      if (allocated > rate) rate = allocated;
    } else return null;
    if (rate === null || rate.toString().length > 78) return null;
    rates[metric] = rate.toString();
  }
  return rates;
}
export async function acquireAllowance(
  journal: AllowanceJournal,
  client: AllowanceTransport,
  leaseSeconds: number,
  units: AllowanceUnits,
): Promise<AllowanceReceipt> {
  const request = journal.request(leaseSeconds, units);
  if (journal.receipt) return journal.receipt;
  const receipt = await client.reserve(request);
  journal.recordReceipt(receipt);
  return receipt;
}
const denied = () => ({
  state: "stopping" as const,
  growthAllowed: false,
  validUntil: null,
});
function patchGuards(resource: Resource): RuntimePatch[] {
  if (!resource.metadata.uid || !resource.metadata.resourceVersion)
    throw new Error("allowance_patch_identity_unproven");
  return [
    { op: "test", path: "/metadata/uid", value: resource.metadata.uid },
    {
      op: "test",
      path: "/metadata/resourceVersion",
      value: resource.metadata.resourceVersion,
    },
  ];
}
export async function reconcileAllowance(
  journal: AllowanceJournal,
  client: AllowanceTransport,
  runtime: AllowanceRuntime,
  now: number,
  completionClock: () => number = () => now,
): Promise<{
  state: "authorized" | "stopping" | "stopped";
  growthAllowed: boolean;
  validUntil: string | null;
}> {
  const clockValid = journal.observeClock(now);
  let inventory: RuntimeInventory;
  try {
    inventory = await runtime.inventory();
  } catch {
    return denied();
  }
  if (!ownedInventory(inventory, journal.binding)) return denied();
  let volumes: string;
  try {
    volumes = volumeHash(inventory, journal.binding);
  } catch {
    return denied();
  }
  const receipt = journal.receipt;
  let authorityInvalid = false;
  if (receipt) {
    let observed;
    try {
      observed = await client.authority(receipt.id);
    } catch (error) {
      observed = null;
      if (error instanceof Error && error.name === "AllowanceProtocolError")
        authorityInvalid = true;
    }
    if (observed)
      try {
        journal.recordAuthority(observed);
      } catch {
        authorityInvalid = true;
      }
  }
  const authority = journal.authority;
  const completedAt = completionClock();
  const completionValid = journal.observeClock(completedAt);
  let validUntil: number | null = null;
  if (
    clockValid &&
    completionValid &&
    !authorityInvalid &&
    journal.stopState === null &&
    /^[1-9][0-9]{0,18}$/.test(
      String(object(object(inventory.quota.spec).hard).pods),
    ) &&
    inventory.cluster.metadata.annotations?.["cnpg.io/hibernation"] !== "on" &&
    receipt &&
    authority &&
    receipt.status === "issued" &&
    receipt.gapCount === "0" &&
    receipt.stoppedAt === null &&
    authority.decision === "allow" &&
    authority.reason === "authorized" &&
    Date.parse(receipt.issuedAt) <= completedAt &&
    Date.parse(receipt.expiresAt) > completedAt &&
    Date.parse(authority.observedAt) <= completedAt &&
    Date.parse(authority.validUntil) > completedAt &&
    completedAt - Date.parse(authority.observedAt) <= 15_000 &&
    authority.bindings.every(
      (binding) =>
        binding.requestedState === "running" &&
        Date.parse(binding.periodStart) <= completedAt &&
        Date.parse(binding.periodEnd) > completedAt,
    )
  ) {
    const fundedUnits: AllowanceUnits = { ...receipt.units };
    for (const metric of authority.limitedMetrics) {
      if (!Object.hasOwn(fundedUnits, metric)) fundedUnits[metric] = "0";
    }
    const envelope = rateEnvelope(inventory, fundedUnits);
    if (envelope) {
      const rates = journal.recordRates(envelope);
      let horizon = BigInt(
        Math.min(
          Date.parse(receipt.expiresAt),
          Date.parse(authority.validUntil),
        ),
      );
      for (const [metric, amount] of Object.entries(fundedUnits)) {
        const rate = BigInt(rates[metric]!);
        if (rate > 0n) {
          const funded =
            BigInt(Date.parse(receipt.issuedAt)) + BigInt(amount) / rate;
          if (funded < horizon) horizon = funded;
        }
      }
      if (
        horizon > BigInt(completedAt) &&
        horizon <= BigInt(Number.MAX_SAFE_INTEGER)
      )
        validUntil = Number(horizon);
    }
  }
  if (validUntil !== null)
    return {
      state: "authorized",
      growthAllowed: true,
      validUntil: new Date(validUntil).toISOString(),
    };
  try {
    journal.beginStop("authority_unavailable_or_exhausted", volumes);
  } catch {
    return denied();
  }
  const verify = async () => {
    const current = await runtime.inventory();
    if (
      !ownedInventory(current, journal.binding) ||
      volumeHash(current, journal.binding) !== volumes
    )
      throw new Error("allowance_stop_identity_changed");
    return current;
  };
  try {
    if (object(object(inventory.quota.spec).hard).pods !== "0") {
      const operations = [
        ...patchGuards(inventory.quota),
        {
          op: Object.hasOwn(object(object(inventory.quota.spec).hard), "pods")
            ? ("replace" as const)
            : ("add" as const),
          path: "/spec/hard/pods",
          value: "0",
        },
      ];
      try {
        await runtime.patch(
          "ResourceQuota",
          inventory.quota.metadata.name,
          operations,
        );
      } catch {
        /* Resolve the same uncertain mutation by authenticated readback. */
      }
      inventory = await verify();
      if (object(object(inventory.quota.spec).hard).pods !== "0")
        return denied();
    }
    if (
      inventory.cluster.metadata.annotations?.["cnpg.io/hibernation"] !== "on"
    ) {
      const operations = [
        ...patchGuards(inventory.cluster),
        {
          op: "add" as const,
          path: "/metadata/annotations/cnpg.io~1hibernation",
          value: "on",
        },
      ];
      try {
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
        return denied();
    }
    inventory = await verify();
    if (inventory.pods.some((pod) => ownedPod(pod, journal.binding)))
      return denied();
    if (
      object(object(inventory.quota.spec).hard).pods !== "0" ||
      inventory.cluster.metadata.annotations?.["cnpg.io/hibernation"] !== "on"
    )
      return denied();
    journal.recordStopped(completionClock(), volumes);
    return { state: "stopped", growthAllowed: false, validUntil: null };
  } catch {
    return denied();
  }
}
