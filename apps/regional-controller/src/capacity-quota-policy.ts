// SPDX-License-Identifier: Apache-2.0
import {
  cpuQuantity,
  binaryQuantity,
} from "@cloudflare-postgres/resource-envelope";
import type { CapacityPlan } from "./capacity-types.ts";

// Derived from the sealed acquisition plan, never a caller-selected quota.
export function capacityQuotaSpecs(plan: CapacityPlan): {
  closed: Record<string, unknown>;
  open: Record<string, unknown>;
} {
  const sum = (key: "cpuMilli" | "cpuLimitMilli") =>
    plan.slots.reduce((total, slot) => total + slot[key], 0);
  const bytes = (key: "memoryBytes" | "memoryLimitBytes" | "volumeBytes") => {
    const total = plan.slots.reduce(
      (v, slot) => v + BigInt(slot[key] ?? "0"),
      0n,
    );
    if (total % 1048576n !== 0n || total > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("capacity_quota_policy_unproven");
    return binaryQuantity(Number(total / 1048576n));
  };
  const hard = {
    "requests.cpu": cpuQuantity(sum("cpuMilli")),
    "limits.cpu": cpuQuantity(sum("cpuLimitMilli")),
    "requests.memory": bytes("memoryBytes"),
    "limits.memory": bytes("memoryLimitBytes"),
    "requests.storage": bytes("volumeBytes"),
    persistentvolumeclaims: String(
      plan.slots.filter((s) => s.kind === "database").length,
    ),
    pods: String(plan.slots.length),
  };
  return { closed: { hard: { ...hard, pods: "0" } }, open: { hard } };
}
