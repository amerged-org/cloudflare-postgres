// SPDX-License-Identifier: Apache-2.0
import type { AllowanceJournal } from "./allowance-journal.ts";
import type {
  AllowanceReceipt,
  AllowanceRuntime,
  AllowanceTransport,
  AllowanceUnits,
  RuntimeInventory,
} from "./allowance-types.ts";
import {
  ownedInventory,
  quantity,
  stopOwnedRuntime,
  volumeHash,
} from "./owned-stop.ts";

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
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
  try {
    if (
      !(await stopOwnedRuntime(
        runtime,
        journal.binding,
        volumes,
        () => {},
        inventory,
      ))
    )
      return denied();
    journal.recordStopped(completionClock(), volumes);
    return { state: "stopped", growthAllowed: false, validUntil: null };
  } catch {
    return denied();
  }
}
