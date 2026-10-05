// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Timestamp } from "./api.ts";
import { NodeId, OperationId, RegionId } from "./ids.ts";
import {
  MonthlyInfrastructureAmount,
  InfrastructureCurrency,
} from "./costs.ts";

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
export const NodeRegionPolicy = z
  .strictObject({
    region_id: RegionId,
    max_nodes: z.number().int().min(1).max(10000),
    purchases_enabled: z.boolean().default(false),
    order: NodeOrderConfiguration.nullable().default(null),
  })
  .superRefine((policy, context) => {
    if (policy.purchases_enabled && policy.order === null)
      context.addIssue({
        code: "custom",
        message: "Enabled purchases require an explicit configured order",
      });
  });
export type NodeRegionPolicy = z.infer<typeof NodeRegionPolicy>;
export const CostedNodeApproval = z
  .strictObject({
    intent_hash: Hash,
    owner_reference: Reference,
    approved_at: Timestamp,
    expires_at: Timestamp,
    monthly_amount: MonthlyInfrastructureAmount,
    setup_amount: MonthlyInfrastructureAmount,
    currency: InfrastructureCurrency,
    term_months: z.union([z.literal(1), z.literal(12), z.literal(24)]),
    location: z.string().trim().min(1).max(128),
  })
  .superRefine((approval, context) => {
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
