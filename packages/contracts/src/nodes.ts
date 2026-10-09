// SPDX-License-Identifier: Apache-2.0
import { ThinStorageProfile } from "./database-storage.ts";
import { z } from "zod";
import { Timestamp } from "./api.ts";
import { NodeId, OperationId, RegionId } from "./ids.ts";
import {
  MonthlyInfrastructureAmount,
  InfrastructureCurrency,
} from "./costs.ts";
import { ComputePoolPolicy } from "./compute-pool.ts";

export const ProviderInstanceId = z
  .string()
  .regex(/^[1-9]\d{0,19}$/)
  .refine(
    (value) =>
      /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n,
  );
export const NodeMarkLost = z.strictObject({
  expected_node_uid: z.uuid(),
  reason: z.string().trim().min(1).max(500),
});
export type NodeMarkLost = z.infer<typeof NodeMarkLost>;
export const NodeLoss = z.strictObject({
  node_id: NodeId,
  region_id: RegionId,
  node_uid: z.uuid(),
  provider_instance_id: z.string().min(1).max(128).nullable(),
  lost_at: Timestamp,
  reason: z.string().min(1).max(500),
});
export type NodeLoss = z.infer<typeof NodeLoss>;
const Selector = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Reference = z.string().min(1).max(512);
export const NodeOrderConfiguration = z.strictObject({
  product_id: Selector,
  provider_region: Selector,
  image_id: Selector,
  term_months: z.union([z.literal(1), z.literal(12), z.literal(24)]),
  location: z.string().trim().min(1).max(128),
  add_ons: z
    .array(
      z.strictObject({
        id: z
          .string()
          .regex(/^[1-9][0-9]{0,18}$/)
          .refine((value) => BigInt(value) <= 9223372036854775807n),
        quantity: z.number().int().safe().positive(),
      }),
    )
    .min(1)
    .max(100)
    .optional(),
});
export type NodeOrderConfiguration = z.infer<typeof NodeOrderConfiguration>;
export const NodeAdditionRequest = z.discriminatedUnion("mode", [
  z.strictObject({
    region_id: RegionId,
    mode: z.literal("adopt"),
    provider_instance_id: ProviderInstanceId,
  }),
  z.strictObject({
    region_id: RegionId,
    mode: z.literal("recover"),
    provider_instance_id: ProviderInstanceId,
    predecessor_node_id: NodeId,
    expected_node_uid: z.uuid(),
  }),
  z.strictObject({
    region_id: RegionId,
    mode: z.literal("order"),
    order: NodeOrderConfiguration,
  }),
]);
export type NodeAdditionRequest = z.infer<typeof NodeAdditionRequest>;
export function nodeAdditionHostname(id: string): string {
  return `pgcf-node-${NodeId.parse(id).slice(4)}`;
}
export const NodeAdditionIntent = z
  .strictObject({
    node_id: NodeId,
    operation_id: OperationId,
    requested_hostname: z.string().regex(/^pgcf-node-[a-z0-9]{20}$/),
    request: NodeAdditionRequest,
  })
  .superRefine((intent, context) => {
    if (intent.requested_hostname !== nodeAdditionHostname(intent.node_id))
      context.addIssue({
        code: "custom",
        message: "Requested hostname must match reserved node identity",
      });
  });
export type NodeAdditionIntent = z.infer<typeof NodeAdditionIntent>;
const NodePurchaseTrigger = z.enum(["regional_actual_ram", "ram_76_percent"]);
const RamThresholdPpm = z.number().int().min(1).max(1_000_000);
/** Owner infrastructure authority; null ceilings require the explicit approved RAM trigger. */
export const StandingNodeCostProfile = z
  .strictObject({
    id: Selector,
    order: NodeOrderConfiguration,
    owner_reference: Reference,
    approved_at: Timestamp,
    expires_at: Timestamp.nullable(),
    currency: InfrastructureCurrency.nullable(),
    monthly_amount: MonthlyInfrastructureAmount.nullable(),
    setup_amount: MonthlyInfrastructureAmount.nullable(),
    max_orders: z.number().int().min(1).max(10000).nullable(),
    max_total_monthly_amount: MonthlyInfrastructureAmount.nullable(),
    max_total_setup_amount: MonthlyInfrastructureAmount.nullable(),
    trigger: NodePurchaseTrigger.optional(),
  })
  .superRefine((profile, context) => {
    const units = (amount: string) => BigInt(amount.replace(".", ""));
    if (
      (profile.expires_at !== null &&
        Date.parse(profile.expires_at) <= Date.parse(profile.approved_at)) ||
      (profile.max_total_monthly_amount !== null &&
        (profile.monthly_amount === null ||
          units(profile.monthly_amount) >
            units(profile.max_total_monthly_amount))) ||
      (profile.max_total_setup_amount !== null &&
        (profile.setup_amount === null ||
          units(profile.setup_amount) >
            units(profile.max_total_setup_amount))) ||
      (profile.currency === null &&
        (profile.monthly_amount !== null || profile.setup_amount !== null)) ||
      (profile.trigger === undefined &&
        [
          profile.expires_at,
          profile.currency,
          profile.monthly_amount,
          profile.setup_amount,
          profile.max_orders,
          profile.max_total_monthly_amount,
          profile.max_total_setup_amount,
        ].some((value) => value === null))
    )
      context.addIssue({
        code: "custom",
        message:
          "Finite monetary caps need known prices; profiles without a RAM trigger need expiry and ceilings",
      });
  });
export type StandingNodeCostProfile = z.infer<typeof StandingNodeCostProfile>;
export const NodeRegionPolicy = z
  .strictObject({
    region_id: RegionId,
    max_nodes: z.number().int().min(1).max(10000).nullable().optional(),
    purchases_enabled: z.boolean().default(false),
    autoscale_enabled: z.boolean().optional(),
    ram_expansion_threshold_ppm: RamThresholdPpm.nullable().optional(),
    ram_warning_threshold_ppm: RamThresholdPpm.nullable().optional(),
    cap_warning_enabled: z.boolean().optional(),
    adopt_instance_ids: z.array(ProviderInstanceId).max(100).optional(),
    order: NodeOrderConfiguration.nullable().default(null),
    placement_mode: z.enum(["reserved", "actual_ram"]).default("reserved"),
    maximum_database_memory_mib: z
      .number()
      .int()
      .positive()
      .max(1048576)
      .multipleOf(256)
      .nullable()
      .default(null),
    postgres_memory_request_mib: z
      .number()
      .int()
      .positive()
      .max(1048576)
      .nullable()
      .default(null),
    standing_cost_profile: StandingNodeCostProfile.nullable().default(null),
    compute_pool: ComputePoolPolicy.nullable().optional(),
    thin_storage: ThinStorageProfile.nullable().optional(),
  })
  .superRefine((policy, context) => {
    if (policy.purchases_enabled && policy.order === null)
      context.addIssue({
        code: "custom",
        message: "Enabled purchases require an explicit configured order",
      });
    if (
      policy.placement_mode === "actual_ram" &&
      (policy.maximum_database_memory_mib === null ||
        policy.postgres_memory_request_mib === null ||
        policy.postgres_memory_request_mib > policy.maximum_database_memory_mib)
    )
      context.addIssue({
        code: "custom",
        message:
          "Actual RAM placement requires an explicit per-database maximum and PostgreSQL request within it",
      });
    if (
      policy.standing_cost_profile !== null &&
      JSON.stringify(policy.standing_cost_profile.order) !==
        JSON.stringify(policy.order)
    )
      context.addIssue({
        code: "custom",
        message: "Standing cost profile must bind the exact configured order",
      });
  });
export type NodeRegionPolicy = z.infer<typeof NodeRegionPolicy>;
export const CostedNodeApproval = z
  .strictObject({
    intent_hash: Hash,
    owner_reference: Reference,
    approved_at: Timestamp,
    expires_at: Timestamp,
    monthly_amount: MonthlyInfrastructureAmount.nullable(),
    setup_amount: MonthlyInfrastructureAmount.nullable(),
    currency: InfrastructureCurrency.nullable(),
    term_months: z.union([z.literal(1), z.literal(12), z.literal(24)]),
    location: z.string().trim().min(1).max(128),
    standing_profile_id: Selector.optional(),
    trigger: NodePurchaseTrigger.optional(),
  })
  .superRefine((approval, context) => {
    if (
      [approval.monthly_amount, approval.setup_amount, approval.currency].some(
        (value) => value === null,
      ) &&
      (approval.trigger === undefined ||
        approval.standing_profile_id === undefined)
    )
      context.addIssue({
        code: "custom",
        message:
          "Unknown cost is permitted only for derived RAM-trigger authority",
      });
    if (Date.parse(approval.expires_at) <= Date.parse(approval.approved_at))
      context.addIssue({
        code: "custom",
        message: "Cost approval needs a finite future expiry",
      });
  });
export type CostedNodeApproval = z.infer<typeof CostedNodeApproval>;
export const NodeProviderReceipt = z.strictObject({
  provider_instance_id: ProviderInstanceId,
  request_id: z.uuid().nullable(),
  reference: Reference,
  received_at: Timestamp,
});
export type NodeProviderReceipt = z.infer<typeof NodeProviderReceipt>;
export const NodeProviderAudit = z.strictObject({
  provider_instance_id: ProviderInstanceId,
  provider_region: Selector,
  product_id: Selector,
  image_id: Selector,
  reference: Reference,
  observed_at: Timestamp,
});
export type NodeProviderAudit = z.infer<typeof NodeProviderAudit>;
export const NodeBootstrapStage = z.enum([
  "prepared",
  "rescue",
  "talos_installed",
  "network_protected",
  "joined",
]);
export const NodeBootstrapCheckpoint = z.strictObject({
  stage: NodeBootstrapStage,
  reference: Reference,
  saved_at: Timestamp,
});
export type NodeBootstrapCheckpoint = z.infer<typeof NodeBootstrapCheckpoint>;
const ProofScope = {
  operation_id: OperationId,
  node_id: NodeId,
  intent_hash: Hash,
  checkpoint_reference: Reference,
  proof_reference: Reference,
};
export const NodeNetworkVerification = z.strictObject({
  ...ProofScope,
  verified_at: Timestamp,
});
export type NodeNetworkVerification = z.infer<typeof NodeNetworkVerification>;
export const NodeCapacityVerification = z
  .strictObject({
    ...ProofScope,
    observed_at: Timestamp,
    allocatable_memory_mib: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    allocatable_cpu_millicores: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    storage_gib_total: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    platform_reserved_memory_mib: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    platform_reserved_cpu_millicores: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
  })
  .superRefine((proof, context) => {
    if (
      proof.platform_reserved_memory_mib >= proof.allocatable_memory_mib ||
      proof.platform_reserved_cpu_millicores >= proof.allocatable_cpu_millicores
    )
      context.addIssue({
        code: "custom",
        message: "Measured platform reservations must leave actual headroom",
      });
  });
export type NodeCapacityVerification = z.infer<typeof NodeCapacityVerification>;
export const NodeAdditionStatus = z.enum([
  "reserved",
  "dispatching",
  "unknown",
  "provider_bound",
  "audited",
  "bootstrapping",
  "ready",
  "failed",
  "cancelled",
]);
export const NodeAddition = z.strictObject({
  intent: NodeAdditionIntent,
  request_key: z.string().regex(/^[A-Za-z0-9._~-]{1,128}$/),
  request_hash: Hash,
  intent_hash: Hash,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: NodeAdditionStatus,
  slot_held: z.boolean(),
  dispatch_request_id: z.uuid().nullable(),
  provider_instance_id: ProviderInstanceId.nullable(),
  approval: CostedNodeApproval.nullable(),
  receipt: NodeProviderReceipt.nullable(),
  audit: NodeProviderAudit.nullable(),
  checkpoint: NodeBootstrapCheckpoint.safeExtend({
    revision: z.number().int().positive(),
  }).nullable(),
  network: NodeNetworkVerification.safeExtend({
    revision: z.number().int().positive(),
  }).nullable(),
  capacity: NodeCapacityVerification.safeExtend({
    revision: z.number().int().positive(),
  }).nullable(),
  failure_code: z
    .enum([
      "provider_rejected",
      "provider_unknown",
      "bootstrap_failed",
      "verification_failed",
    ])
    .nullable(),
  created_at: Timestamp,
  updated_at: Timestamp,
});
export type NodeAddition = z.infer<typeof NodeAddition>;
