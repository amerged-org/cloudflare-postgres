// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { NodeId, OperationId, RegionId } from "./ids.ts";
import {
  NodeBootstrapMaintenanceObservation,
  NodeBootstrapMaintenanceBinding,
} from "./node-bootstrap.ts";

export const NODE_PROOF_SESSION_DOMAIN = "pgcf-node-proof-session/v1\n";
export const NODE_PROOF_MEASUREMENT_DOMAIN = "pgcf-node-measurement/v1\n";
export const NODE_PROOF_CONTROL_DOMAIN = "pgcf-node-https-source-control/v1\n";
export const NodeProofSessionBearer = z
  .string()
  .regex(/^np1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  .max(4096);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const At = z.iso.datetime({ precision: 3 });
export const NodeProofMode = z.enum(["preparation", "postjoin"]);
export type NodeProofMode = z.infer<typeof NodeProofMode>;
export const NodeProofCleanupOperation = z.enum([
  "cluster_identity",
  "node_identity",
  "owned_pod_read",
  "owned_namespace_read",
  "namespace_inventory",
  "owned_pod_delete",
  "owned_namespace_delete",
  "owned_pod_readback",
  "owned_namespace_readback",
]);
export type NodeProofCleanupOperation = z.infer<
  typeof NodeProofCleanupOperation
>;
export const NodeProofCleanupAbortOrigin = z.enum([
  "command_deadline",
  "aggregate_deadline",
  "external_abort",
]);
export type NodeProofCleanupAbortOrigin = z.infer<
  typeof NodeProofCleanupAbortOrigin
>;
export const NODE_PROOF_CLEANUP_ERROR_CODES = [
  "proof_source_cleanup_cluster_identity_command_deadline",
  "proof_source_cleanup_cluster_identity_aggregate_deadline",
  "proof_source_cleanup_cluster_identity_external_abort",
  "proof_source_cleanup_node_identity_command_deadline",
  "proof_source_cleanup_node_identity_aggregate_deadline",
  "proof_source_cleanup_node_identity_external_abort",
  "proof_source_cleanup_owned_pod_read_command_deadline",
  "proof_source_cleanup_owned_pod_read_aggregate_deadline",
  "proof_source_cleanup_owned_pod_read_external_abort",
  "proof_source_cleanup_owned_namespace_read_command_deadline",
  "proof_source_cleanup_owned_namespace_read_aggregate_deadline",
  "proof_source_cleanup_owned_namespace_read_external_abort",
  "proof_source_cleanup_namespace_inventory_command_deadline",
  "proof_source_cleanup_namespace_inventory_aggregate_deadline",
  "proof_source_cleanup_namespace_inventory_external_abort",
  "proof_source_cleanup_owned_pod_delete_command_deadline",
  "proof_source_cleanup_owned_pod_delete_aggregate_deadline",
  "proof_source_cleanup_owned_pod_delete_external_abort",
  "proof_source_cleanup_owned_namespace_delete_command_deadline",
  "proof_source_cleanup_owned_namespace_delete_aggregate_deadline",
  "proof_source_cleanup_owned_namespace_delete_external_abort",
  "proof_source_cleanup_owned_pod_readback_command_deadline",
  "proof_source_cleanup_owned_pod_readback_aggregate_deadline",
  "proof_source_cleanup_owned_pod_readback_external_abort",
  "proof_source_cleanup_owned_namespace_readback_command_deadline",
  "proof_source_cleanup_owned_namespace_readback_aggregate_deadline",
  "proof_source_cleanup_owned_namespace_readback_external_abort",
] as const;
export const NodeProofCleanupErrorCode = z.enum(NODE_PROOF_CLEANUP_ERROR_CODES);
export type NodeProofCleanupErrorCode = z.infer<
  typeof NodeProofCleanupErrorCode
>;
/** Cleanup diagnostics identify a finite operation and abort source, never a command or resource name. */
export function nodeProofCleanupErrorCode(
  operation: NodeProofCleanupOperation,
  origin: NodeProofCleanupAbortOrigin,
): NodeProofCleanupErrorCode {
  return NodeProofCleanupErrorCode.parse(
    `proof_source_cleanup_${NodeProofCleanupOperation.parse(operation)}_${NodeProofCleanupAbortOrigin.parse(origin)}`,
  );
}
/** Known proof diagnostics only; native messages and private proof inputs stay outside status. */
export const NodeProofErrorCode = z.union([
  NodeProofCleanupErrorCode,
  z.enum([
    "node_proof_access_binding_changed",
    "node_proof_authority_refused",
    "node_proof_capability_gap_ipv4",
    "node_proof_capability_gap_ipv6",
    "node_proof_capture_bound_invalid",
    "node_proof_capture_cancelled",
    "node_proof_capture_failed",
    "node_proof_capture_output_limit",
    "node_proof_capture_timeout",
    "node_proof_capture_unavailable",
    "node_proof_cluster_bundle_missing",
    "node_proof_command_failed",
    "node_proof_command_output_limit",
    "node_proof_deadline",
    "node_proof_expired_source_authority_changed",
    "node_proof_failed",
    "node_proof_kubeconfig_identity_changed",
    "node_proof_kubeconfig_invalid",
    "node_proof_maintenance_authentication_failed",
    "node_proof_maintenance_disk_changed",
    "node_proof_maintenance_version_changed",
    "node_proof_ownership_callbacks_invalid",
    "node_proof_ownership_invalid",
    "node_proof_ownership_unconfirmed",
    "node_proof_readback_invalid",
    "node_proof_request_limit",
    "node_proof_response_invalid",
    "node_proof_scan_failed",
    "node_proof_ssh_client_invalid",
    "node_proof_ssh_host_identity_changed",
    "node_proof_talos_custody_invalid",
    "node_proof_talos_custody_missing",
    "node_proof_target_identity_changed",
    "command_bound_invalid",
    "command_output_limit",
    "command_timeout",
    "command_unavailable",
    "job_cancelled",
    "postjoin_binding_invalid",
    "postjoin_cancelled",
    "postjoin_capacity_changed",
    "postjoin_capacity_unavailable",
    "postjoin_capture_ended_before_traffic",
    "postjoin_capture_failed",
    "postjoin_capture_not_ready",
    "postjoin_capture_output_limit",
    "postjoin_cilium_agent_changed",
    "postjoin_cilium_agent_identity",
    "postjoin_cilium_node_missing",
    "postjoin_cilium_public_key_binding",
    "postjoin_cleanup_inventory_unproven",
    "postjoin_cluster_identity_changed",
    "postjoin_command_failed",
    "postjoin_deadline",
    "postjoin_deadline_invalid",
    "postjoin_foreign_namespace_child",
    "postjoin_input_invalid",
    "postjoin_journal_required",
    "postjoin_namespace_already_present",
    "postjoin_namespace_create_unconfirmed",
    "postjoin_namespace_identity_changed",
    "postjoin_node_identity_changed",
    "postjoin_nonce_invalid",
    "postjoin_observation_failed",
    "postjoin_output_limit",
    "postjoin_ownership_invalid",
    "postjoin_ownership_missing",
    "postjoin_ownership_unconfirmed",
    "postjoin_peer_address_coverage",
    "postjoin_pod_address_invalid",
    "postjoin_pod_address_limit",
    "postjoin_pod_address_missing",
    "postjoin_pod_create_unconfirmed",
    "postjoin_pod_disappeared",
    "postjoin_pod_identity_changed",
    "postjoin_quarantine_missing",
    "postjoin_readback_invalid",
    "postjoin_resource_identity_invalid",
    "postjoin_traffic_failed",
    "postjoin_traffic_nonce_mismatch",
    "postjoin_traffic_pod_failed",
    "postjoin_wan_address_unproven",
    "postjoin_wan_route_unproven",
    "postjoin_wireguard_handshake_invalid",
    "postjoin_wireguard_handshake_stale",
    "postjoin_wireguard_mode",
    "postjoin_wireguard_peer_set",
    "postjoin_wireguard_public_key_binding",
    "postjoin_wireguard_readback_invalid",
    "proof_source_assets_invalid",
    "proof_source_cancelled",
    "proof_source_chunk_invalid",
    "proof_source_chunk_unconfirmed",
    "proof_source_cleanup_unconfirmed",
    "proof_source_cli_asset_changed",
    "proof_source_cli_asset_invalid",
    "proof_source_command_failed",
    "proof_source_create_unconfirmed",
    "proof_source_deadline",
    "proof_source_deadline_invalid",
    "proof_source_descriptor_invalid",
    "proof_source_direct_source_mismatch",
    "proof_source_input_limit",
    "proof_source_input_stage_unconfirmed",
    "proof_source_journal_invalid",
    "proof_source_journal_required",
    "proof_source_kube_adapter_required",
    "proof_source_linux_runtime_required",
    "proof_source_namespace_children_unknown",
    "proof_source_node_asset_changed",
    "proof_source_node_asset_invalid",
    "proof_source_output_limit",
    "proof_source_ownership_changed",
    "proof_source_ownership_invalid",
    "proof_source_ownership_missing",
    "proof_source_ownership_unconfirmed",
    "proof_source_pod_failed",
    "proof_source_pod_identity_changed",
    "proof_source_pod_image_changed",
    "proof_source_previous_run_cleaned",
    "proof_source_readback_failed",
    "proof_source_readback_invalid",
    "proof_source_receipt_invalid",
    "proof_source_receipt_limit",
    "proof_source_receipt_stale",
    "proof_source_resource_disappeared",
    "proof_source_resource_identity_invalid",
    "proof_source_resource_not_owned",
    "proof_source_runtime_unconfirmed",
    "proof_source_scratch_unconfirmed",
    "proof_source_source_identity_changed",
    "proof_source_ssh_adapter_required",
    "readback_invalid",
    "proof_status_invalid",
    "proof_status_unavailable",
    "proof_input_required",
    "proof_server_identity_changed",
    "proof_authority_closed",
  ]),
  z
    .string()
    .regex(
      /^native_command_failed_(?:ssh|ssh_keygen|talosctl|kubectl|helm)_[1-9][0-9]{0,2}$/,
    )
    .refine((value) => Number(value.slice(value.lastIndexOf("_") + 1)) <= 255),
]);
export type NodeProofErrorCode = z.infer<typeof NodeProofErrorCode>;
export const NodeProofStatus = z.strictObject({
  operation_id: OperationId,
  mode: NodeProofMode,
  session_id: z.uuid().nullable(),
  binding_sha256: Hash,
  plan_sha256: Hash.nullable(),
  input_hash: Hash.nullable(),
  status: z.enum(["unavailable", "running", "reported", "failed"]),
  error_code: NodeProofErrorCode.nullable(),
});
export type NodeProofStatus = z.infer<typeof NodeProofStatus>;
export const NodeProofJournalErrorCode = z.enum([
  "proof_status_invalid",
  "proof_status_unavailable",
  "proof_input_required",
  "proof_server_identity_changed",
  "proof_authority_closed",
  "proof_journal_limit",
]);
export const NodeProofJournalEntry = z.strictObject({
  key_sha256: Hash,
  stage: z.enum([
    "intent",
    "ready",
    "running",
    "measured",
    "cleanup",
    "cleaned",
  ]),
  namespace_uid_sha256: Hash.nullable(),
  pod_uid_sha256: Hash.nullable(),
  matches_current_session: z.boolean(),
});
export type NodeProofJournalEntry = z.infer<typeof NodeProofJournalEntry>;
/** A read-only ownership projection; observing a journal grants no proof or cleanup authority. */
export const NodeProofJournalStatus = z.strictObject({
  operation_id: OperationId,
  mode: z.literal("preparation"),
  session_id: z.uuid().nullable(),
  binding_sha256: Hash,
  plan_sha256: Hash.nullable(),
  input_hash: Hash.nullable(),
  issued_at: At.nullable(),
  expires_at: At.nullable(),
  status: z.enum(["observed", "unavailable"]),
  error_code: NodeProofJournalErrorCode.nullable(),
  journals: z.array(NodeProofJournalEntry).max(64),
});
export type NodeProofJournalStatus = z.infer<typeof NodeProofJournalStatus>;
export const NodeProofClaims = z.strictObject({
  version: z.literal(1),
  kid: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/),
  mode: NodeProofMode,
  session_id: z.uuid(),
  operation_id: OperationId,
  node_id: NodeId,
  region_id: RegionId,
  provider_instance_id: z.string().regex(/^[1-9][0-9]*$/),
  binding_sha256: Hash,
  inspection_generation: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  plan_sha256: Hash,
  input_hash: Hash.nullable(),
  checkpoint_reference: z.string().min(1).max(256).nullable(),
  origin: z.url().refine((value) => {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      u.origin === value &&
      !u.username &&
      !u.password
    );
  }),
  issued_at: At,
  expires_at: At,
});
export type NodeProofClaims = z.infer<typeof NodeProofClaims>;
export const NodeProofNonce = z.strictObject({
  nonce: z.string().regex(/^[a-f0-9]{64}$/),
});
export const NodeProofControl = z.strictObject({
  nonce: NodeProofNonce.shape.nonce,
  origin: NodeProofClaims.shape.origin,
  source: z.union([z.ipv4(), z.ipv6()]),
  observed_at: At,
});
export type NodeProofControl = z.infer<typeof NodeProofControl>;
const IP = z.union([z.ipv4(), z.ipv6()]);
export const NodeProofControlObservation = z.strictObject({
  address: IP,
  port: z.number().int().min(1).max(65535),
  source: IP,
  observed_at: At,
  nonce: z.string().regex(/^[a-f0-9]{64}$/),
});
export const NodeProofAccessObservation = z.strictObject({
  provider_instance_id: NodeProofClaims.shape.provider_instance_id,
  address: IP,
  relay_source: IP,
  observed_at: At,
  checks: z
    .array(
      z.strictObject({
        port: z.union([z.literal(22), z.literal(50000), z.literal(6443)]),
        outcome: z.enum(["connected", "refused", "timed_out"]),
      }),
    )
    .length(3),
  talos_maintenance: NodeBootstrapMaintenanceObservation.optional(),
});
export const NodeProofScanObservation = z.strictObject({
  provider_instance_id: NodeProofClaims.shape.provider_instance_id,
  address: IP,
  protocol: z.literal("tcp"),
  first_port: z.literal(1),
  last_port: z.literal(65535),
  scanned_ports: z.literal(65535),
  open_ports: z.array(z.number().int().min(1).max(65535)).max(65535),
  started_at: At,
  observed_at: At,
  before: NodeProofControlObservation,
  after: NodeProofControlObservation,
});
const measurement = {
  purpose: z.literal("pgcf-node-measurement/v1"),
  binding_sha256: Hash,
  observed_at: At,
};
export const NodeProofMeasurement = z.discriminatedUnion("kind", [
  z.strictObject({
    ...measurement,
    kind: z.literal("access"),
    access: z.array(NodeProofAccessObservation).min(1).max(16),
  }),
  z.strictObject({
    ...measurement,
    kind: z.literal("scan"),
    family: z.enum(["ipv4", "ipv6"]),
    source: IP,
    scans: z.array(NodeProofScanObservation).min(1).max(64),
  }),
]);
export type NodeProofMeasurement = z.infer<typeof NodeProofMeasurement>;
export const NodeProofBinding = z.strictObject({
  plan_sha256: Hash,
  readback_at: At,
  verification: z
    .strictObject({
      input_hash: Hash,
      checkpoint_reference: z.string().min(1).max(256),
      cluster_uid: z.uuid(),
      node_uid: z.uuid(),
      node_resource_version: z.string().regex(/^[0-9]+$/),
      hostname: z.string().min(1).max(253),
    })
    .nullable(),
  maintenance: NodeBootstrapMaintenanceBinding.optional(),
});
export type NodeProofBinding = z.infer<typeof NodeProofBinding>;
const Peer = z.strictObject({
  node_id: NodeId,
  provider_instance_id: NodeProofClaims.shape.provider_instance_id,
  address: IP,
  public_key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  last_handshake_at: At,
});
const Packet = z.strictObject({
  source_node_id: NodeId,
  destination_node_id: NodeId,
  captured_at: At,
  encrypted_packets: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  plaintext_pod_packets: z.literal(0),
});
export const NodeProofPostjoin = z.strictObject({
  kube_system: z.record(z.string(), z.unknown()),
  node: z.record(z.string(), z.unknown()),
  kube_system_after: z.record(z.string(), z.unknown()),
  node_after: z.record(z.string(), z.unknown()),
  wireguard: z.strictObject({
    mode: z.literal("wireguard"),
    peers: z.array(Peer).max(16),
    packet_observations: z.array(Packet).max(64),
  }),
});
export const NodeProofReport = z.strictObject({
  binding: NodeProofBinding,
  measurements: z.array(NodeProofMeasurement).min(1).max(3),
  postjoin: NodeProofPostjoin.nullable(),
});
export type NodeProofReport = z.infer<typeof NodeProofReport>;
export const NodeProofMeasurementRequest = z.strictObject({
  measurement: NodeProofMeasurement,
});
export function canonicalNodeProof(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalNodeProof).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonicalNodeProof(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

// Private execution DTOs are separate from the public signed receipt/session.
import {
  NodeBootstrapInput as ExecutionBootstrapInput,
  NodeJoinBundle as ExecutionJoinBundle,
  NodePlatformSpec as ExecutionPlatformSpec,
} from "./node-bootstrap.ts";
import { NodeInspectionInput as ExecutionInspectionInput } from "./node-installation.ts";

const ProofAddresses = z.strictObject({
  ipv4: z.array(z.ipv4()).max(64),
  ipv6: z.array(z.ipv6()).max(64),
});
const ProofCidr = (family: 4 | 6) =>
  z
    .string()
    .max(64)
    .refine((value) => {
      const [address, prefix, extra] = value.split("/");
      return (
        !!address &&
        extra === undefined &&
        prefix !== undefined &&
        /^(?:0|[1-9][0-9]{0,2})$/.test(prefix) &&
        Number(prefix) <= (family === 4 ? 32 : 128) &&
        (family === 4 ? z.ipv4() : z.ipv6()).safeParse(address).success
      );
    });
const ProofFirewallRule = z.strictObject({
  protocol: z.enum(["tcp", "udp", "icmp"]),
  destPorts: z
    .array(z.string().regex(/^[1-9][0-9]{0,4}(?:-[1-9][0-9]{0,4})?$/))
    .max(15),
  srcCidr: z.strictObject({
    ipv4: z.array(ProofCidr(4)).max(64).optional(),
    ipv6: z.array(ProofCidr(6)).max(64).optional(),
  }),
  action: z.literal("accept"),
  status: z.literal("active"),
  displayName: z.string().min(1).max(255),
});
export const NodeProofNetworkPlan = z.strictObject({
  version: z.literal(1),
  operation_id: OperationId,
  node_id: NodeId,
  region_id: RegionId,
  provider_instance_id: NodeProofClaims.shape.provider_instance_id,
  intent_hash: Hash,
  operators: z.strictObject({
    ipv4: z.array(ProofCidr(4)).max(256),
    ipv6: z.array(ProofCidr(6)).max(256),
  }),
  relay: z.strictObject({
    provider_instance_id: NodeProofClaims.shape.provider_instance_id,
    addresses: ProofAddresses,
  }),
  scan_control: z.strictObject({
    ipv4: z.ipv4(),
    ipv6: z.ipv6(),
    port: z.number().int().min(1).max(65535),
  }),
  members: z
    .array(
      z.strictObject({
        node_id: NodeId,
        provider_instance_id: NodeProofClaims.shape.provider_instance_id,
        firewall_id: z.uuid(),
        addresses: ProofAddresses,
        primary: ProofAddresses,
        ownership_sha256: Hash,
        rules: z.strictObject({
          rules: z.strictObject({
            inbound: z.array(ProofFirewallRule).max(100),
          }),
        }),
        rules_sha256: Hash,
      }),
    )
    .min(1)
    .max(16),
});
export type NodeProofNetworkPlan = z.infer<typeof NodeProofNetworkPlan>;
export const NodeProofSource = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("rescue"),
    operation_id: OperationId,
    node_id: NodeId,
    region_id: RegionId,
    provider_instance_id: NodeProofClaims.shape.provider_instance_id,
    ipv4: z.ipv4(),
    ipv6: z.ipv6().optional(),
    access: z.strictObject({
      rescue: ExecutionBootstrapInput.shape.rescue,
      expected_network: ExecutionInspectionInput.shape.expected_network,
      binding_sha256: Hash,
      inspection_generation: NodeProofClaims.shape.inspection_generation,
      profile_sha256: Hash,
    }),
  }),
  z.strictObject({
    kind: z.literal("pod"),
    cluster_uid: z.uuid(),
    node_uid: z.uuid(),
    node_name: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,252}$/),
    region_id: RegionId,
    node_id: NodeId,
    provider_instance_id: NodeProofClaims.shape.provider_instance_id,
    ipv4: z.ipv4(),
    ipv6: z.ipv6().optional(),
    image: ExecutionPlatformSpec.shape.regional_image,
    access: z.strictObject({ join_bundle: ExecutionJoinBundle }),
  }),
]);
export type NodeProofSource = z.infer<typeof NodeProofSource>;
export const NodeProofExecutionInput = z
  .strictObject({
    claims: NodeProofClaims,
    session_bearer: NodeProofSessionBearer,
    bootstrap: ExecutionBootstrapInput,
    cluster_bundle: ExecutionJoinBundle.nullable(),
    talos_admin_config: ExecutionJoinBundle.shape.talos_admin_config.optional(),
    plan: NodeProofNetworkPlan,
    binding: NodeProofBinding.extend({ verification: z.null() }),
    source: NodeProofSource,
    control_keys: z
      .record(
        z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/),
        z.string().min(32).max(4096),
      )
      .refine(
        (keys) =>
          Object.keys(keys).length >= 1 && Object.keys(keys).length <= 16,
      ),
    api_base_url: NodeProofClaims.shape.origin,
  })
  .superRefine((value, context) => {
    const claims = value.claims,
      spec = value.bootstrap.spec;
    if (
      value.api_base_url !== claims.origin ||
      value.binding.plan_sha256 !== claims.plan_sha256 ||
      !value.control_keys[claims.kid] ||
      [value.plan, spec].some(
        (item) =>
          item.operation_id !== claims.operation_id ||
          item.node_id !== claims.node_id ||
          item.region_id !== claims.region_id ||
          item.provider_instance_id !== claims.provider_instance_id,
      ) ||
      (claims.input_hash !== null &&
        claims.input_hash !== value.bootstrap.input_hash) ||
      value.source.region_id === claims.region_id ||
      value.plan.members.some(
        (member) =>
          member.provider_instance_id === value.source.provider_instance_id,
      )
    )
      context.addIssue({
        code: "custom",
        message: "proof execution identity mismatch",
      });
    if (
      claims.mode === "postjoin" &&
      (!claims.input_hash ||
        !claims.checkpoint_reference ||
        !value.cluster_bundle)
    )
      context.addIssue({
        code: "custom",
        message: "postjoin proof requires sealed custody and checkpoint",
      });
    if (
      value.cluster_bundle &&
      (value.cluster_bundle.cluster_name !== spec.cluster_name ||
        value.cluster_bundle.cluster_endpoint !== spec.cluster_endpoint ||
        (spec.cluster_uid !== null &&
          value.cluster_bundle.kube_system_uid !== spec.cluster_uid))
    )
      context.addIssue({
        code: "custom",
        message: "target cluster custody mismatch",
      });
    if (
      value.source.kind === "rescue" &&
      (value.source.access.expected_network.ipv4 !== value.source.ipv4 ||
        value.source.access.expected_network.ipv6?.address !==
          value.source.ipv6)
    )
      context.addIssue({
        code: "custom",
        message: "rescue source network mismatch",
      });
    if (
      value.source.kind === "pod" &&
      value.source.access.join_bundle.kube_system_uid !==
        value.source.cluster_uid
    )
      context.addIssue({
        code: "custom",
        message: "source cluster custody mismatch",
      });
  });
export type NodeProofExecutionInput = z.infer<typeof NodeProofExecutionInput>;
