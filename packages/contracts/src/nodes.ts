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
export const NodeMaintenanceRequest = z.strictObject({
  expected_node_uid: z.uuid(),
});
export type NodeMaintenanceRequest = z.infer<typeof NodeMaintenanceRequest>;
export const NodeMaintenance = z
  .strictObject({
    operation: OperationId,
    node_id: NodeId,
    status: z
      .enum(["open", "done", "failed"])
      .describe(
        "open: the node has not answered its order yet. done: the node installed the release's packages, rebooted if needed and passed its check; placement is open again unless someone else closed it. failed: see result_reason; placement stays closed.",
      ),
    result_reason: z
      .string()
      .nullable()
      .describe(
        "The class of the failure the node reported, such as check_failed or reboot_failed.",
      ),
    placement_closed_at: Timestamp.nullable().describe(
      "When this cycle closed placement on the node; null if placement was already closed, which the cycle then leaves as it is. A cycle that is done reopens placement only if the node's database_placement_closed_at still has this value.",
    ),
    created_at: Timestamp,
    closed_at: Timestamp.nullable().describe(
      "When the node answered. A done cycle reopens placement at that time only if it closed placement itself and nobody has closed it again since.",
    ),
  })
  .meta({ id: "NodeMaintenance" });
export type NodeMaintenance = z.infer<typeof NodeMaintenance>;
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
/**
 * The labels of a node's two public hostnames. Cloudflare Access guards each family with a
 * wildcard (`pgcf-node-*.<domain>`, `pgcf-shell-*.<domain>`), and the documentation does not say
 * which of two overlapping wildcard applications wins, so neither prefix may start with the other.
 */
export const NODE_GATEWAY_LABEL_PREFIX = "pgcf-node-";
export const NODE_SHELL_LABEL_PREFIX = "pgcf-shell-";
export function nodeAdditionHostname(id: string): string {
  return `${NODE_GATEWAY_LABEL_PREFIX}${NodeId.parse(id).slice(4)}`;
}
/** The label of the node's shell hostname, which exists only while the Worker's `NODE_SHELL_HOSTNAME` is `true`. */
export function nodeShellHostname(id: string): string {
  return `${NODE_SHELL_LABEL_PREFIX}${NodeId.parse(id).slice(4)}`;
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
const ThresholdPpm = z.number().int().min(1).max(1_000_000);
/**
 * Owner infrastructure authority. A profile with a `trigger` approves only the orders the capacity
 * cron reserves on its own (`capacity-headroom-`), at no stated price or ceiling; one without
 * needs an expiry and finite ceilings and also approves manual order additions. The two trigger
 * names are kept as stored: nothing reads a RAM threshold any more.
 */
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
const PPM = "Integer parts per million: 1000000 = 100 %, 800000 = 80 %.";
const KEEP = "Omitted on PUT: keeps the stored value.";
const WARNING = `${PPM} null disables the warning and clears its episode. ${KEEP}`;
export const NodeRegionPolicy = z
  .strictObject({
    region_id: RegionId,
    max_nodes: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .nullable()
      .optional()
      .describe(
        `Regional node ceiling; null means none. Counts the region's nodes (lost ones included) and held node additions, once per provider instance. New additions are refused at the ceiling; recovering a lost node on its own allocation is exempt. ${KEEP}`,
      ),
    purchases_enabled: z
      .boolean()
      .default(false)
      .describe(
        "Permits paid provider orders: the capacity cron reserves an order addition, and it is dispatched, only while this is true and its order equals `order`. Requires `order`.",
      ),
    autoscale_enabled: z.boolean().optional(),
    node_ram_warning_threshold_ppm: ThresholdPpm.nullable()
      .optional()
      .describe(
        `Per-node RAM warning (alert regional_node_ram_warning) when any non-lost node, including one closed to database placement, reaches it: the 30-minute average of the node's active RAM, (MemTotal - MemAvailable) / MemTotal, over its samples, the newest at most 180 s old and the window at least ten minutes long. ${WARNING}`,
      ),
    node_cpu_warning_threshold_ppm: ThresholdPpm.nullable()
      .optional()
      .describe(
        `Per-node CPU warning (alert regional_node_cpu_warning) when any non-lost node reaches it: the 30-minute average of the node's CPU load, busy time over all its cores, over its samples, the newest at most 180 s old and the window at least ten minutes long. ${WARNING}`,
      ),
    node_storage_warning_threshold_ppm: ThresholdPpm.nullable()
      .optional()
      .describe(
        `Per-node storage warning (alert regional_node_storage_warning) when any non-lost node's newest sample (at most 180 s old) reaches it: the fuller of its thin pool's data and metadata. Placement closes a node's pool at 800000 for data and 500000 for metadata, so 500000 warns before it does. ${WARNING}`,
      ),
    cap_warning_enabled: z
      .boolean()
      .optional()
      .describe(
        `Node cap notice (alert regional_node_cap_reached) while the region's provider allocations reach max_nodes: nodes (lost ones included) and held additions already bound to a provider instance; unpaid reservations do not count. Needs a non-null max_nodes; false disables the notice and clears its episode. ${KEEP}`,
      ),
    adopt_instance_ids: z.array(ProviderInstanceId).max(100).optional(),
    order: NodeOrderConfiguration.nullable()
      .default(null)
      .describe(
        "Exact provider order (product, provider region, image, term, location, optional add-ons) for every order addition; manual order requests must equal it. null means no orders.",
      ),
    maximum_database_memory_mib: z
      .number()
      .int()
      .positive()
      .max(1048576)
      .multipleOf(256)
      .nullable()
      .default(null)
      .describe(
        "The most memory one database of this region may have (MiB), for a size class and for a database's own memory; null means 4096.",
      ),
    standing_cost_profile: StandingNodeCostProfile.nullable()
      .default(null)
      .describe(
        "Standing owner approval for order additions of exactly `order`, bounded by its expiry, order count and total monthly and setup amounts; unknown prices stay null. With a trigger (regional_actual_ram or ram_76_percent, kept as stored) it approves only the orders the capacity cron reserves while autoscale_enabled is true; without a trigger it also approves manual order additions and needs expiry and finite limits. null: every order waits for POST /v1/nodes/additions/{id}/approve.",
      ),
  })
  .superRefine((policy, context) => {
    if (policy.purchases_enabled && policy.order === null)
      context.addIssue({
        code: "custom",
        message: "Enabled purchases require an explicit configured order",
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
  failure_code: z
    .enum([
      "provider_rejected",
      "provider_unknown",
      "bootstrap_failed",
      "verification_failed",
    ])
    .nullable(),
  /**
   * Why an audited server has not been sent its installer yet; the next pass asks again. Null
   * outside `audited`. `node_firewall_unconfirmed`: Contabo's firewall does not yet hold the
   * instance behind a deny-all rule set. `release_unverified`: the release of the region is not
   * signed by the release key (the row was edited, or registered by a path that did not check it),
   * so no installer is rendered from its image until a signed release is assigned.
   */
  install_blocker: z
    .enum(["node_firewall_unconfirmed", "release_unverified"])
    .nullable(),
  created_at: Timestamp,
  updated_at: Timestamp,
});
export type NodeAddition = z.infer<typeof NodeAddition>;
