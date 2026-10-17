// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { FleetReleaseId } from "./releases.ts";
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const COMPUTE_POOL_LIMITS = {
  max_slots: 16,
  max_age_seconds: 300,
  lease_ms: 30000,
  observation_max_age_ms: 120000,
  node_max_age_ms: 180000,
  clock_skew_ms: 5000,
} as const;
export const ComputeRuntimeProfile = z.strictObject({
  release_id: FleetReleaseId,
  image: z
    .string()
    .max(512)
    .regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/),
  holder_sha256: Hash,
  controller_sha256: Hash,
  containerd_version: z.literal("2.3.6"),
  runc_version: z.literal("1.5.2"),
  architecture: z.enum(["amd64", "arm64"]),
});
export const ComputePoolPolicy = z
  .strictObject({
    version: z.literal(1),
    target_slots: z.number().int().min(0).max(COMPUTE_POOL_LIMITS.max_slots),
    max_idle_cpu_millicores: z.number().int().min(1).max(2000),
    max_idle_memory_mib: z.number().int().min(16).max(2048),
    per_slot_cpu_millicores: z.number().int().min(1).max(500),
    per_slot_memory_mib: z.number().int().min(16).max(512),
    max_age_seconds: z
      .number()
      .int()
      .min(1)
      .max(COMPUTE_POOL_LIMITS.max_age_seconds),
    profile: ComputeRuntimeProfile,
  })
  .superRefine((value, context) => {
    if (
      value.target_slots * value.per_slot_cpu_millicores >
        value.max_idle_cpu_millicores ||
      value.target_slots * value.per_slot_memory_mib > value.max_idle_memory_mib
    )
      context.addIssue({
        code: "custom",
        message: "Desired idle target exceeds its configured CPU or RAM bound",
      });
  });
export type ComputePoolPolicy = z.infer<typeof ComputePoolPolicy>;
/** Assigned holder/shim allowance; absence preserves the legacy runtime. Idle pools are real node usage. */
export function computePoolOverhead(
  policy:
    | Pick<ComputePoolPolicy, "per_slot_cpu_millicores" | "per_slot_memory_mib">
    | null
    | undefined,
) {
  return {
    cpu_millicores: policy?.per_slot_cpu_millicores ?? 0,
    memory_mib: policy?.per_slot_memory_mib ?? 0,
  };
}
