// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { NodeId, RegionId } from "./ids.ts";
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
export const ComputePoolPolicyUpdate = z.strictObject({
  expected_revision: z.number().int().min(0).max(2147483646),
  node_uid: z.uuid(),
  policy: ComputePoolPolicy,
});
export type ComputePoolPolicyUpdate = z.infer<typeof ComputePoolPolicyUpdate>;
export const ComputePoolPolicyState = z.strictObject({
  node_id: NodeId,
  node_uid: z.uuid(),
  region_id: RegionId,
  revision: z.number().int().positive(),
  policy: ComputePoolPolicy,
  updated_at: z.iso.datetime(),
});
export type ComputePoolPolicyState = z.infer<typeof ComputePoolPolicyState>;
export const ComputePoolLease = ComputePoolPolicyState.safeExtend({
  purpose: z.literal("pgcf-compute-pool/v1"),
  material_revision: z.number().int().positive(),
  assignment_revision: z.number().int().positive(),
  region_revision: z.number().int().positive(),
  node_observed_at: z.iso.datetime(),
  issued_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
});
export const ComputePoolObservation = z
  .strictObject({
    node_id: NodeId,
    node_uid: z.uuid(),
    policy_revision: z.number().int().positive(),
    material_revision: z.number().int().positive(),
    observed_at: z.iso.datetime(),
    profile: ComputeRuntimeProfile,
    idle_memory_current_bytes: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    idle_cpu_usage_usec: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    slots: z
      .array(
        z.strictObject({
          slot_id: z.string().regex(/^[a-f0-9]{32}$/),
          holder_pid: z.number().int().positive(),
          shim_pid: z.number().int().positive(),
          live: z.boolean(),
          sandbox_id: z.string().min(1).max(128).nullable(),
          pod_uid: z.string().min(1).max(128).nullable(),
          runtime_release_id: FleetReleaseId.nullable(),
          assignment_mode: z.enum(["prestarted", "on_demand"]).nullable(),
        }),
      )
      .max(256),
  })
  .superRefine((value, context) => {
    if (
      new Set(value.slots.map((slot) => slot.slot_id)).size !==
      value.slots.length
    )
      context.addIssue({
        code: "custom",
        message: "Duplicate runtime identity",
      });
    if (
      value.slots.some(
        (slot) => (slot.sandbox_id === null) !== (slot.pod_uid === null),
      )
    )
      context.addIssue({
        code: "custom",
        message: "Partial tenant assignment is invalid",
      });
  });
export type ComputePoolObservation = z.infer<typeof ComputePoolObservation>;
