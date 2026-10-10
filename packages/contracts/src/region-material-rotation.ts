// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { NodeId, OperationId, RegionId } from "./ids.ts";
import { RegionBootstrapMaterialUpdate } from "./api.ts";
import {
  NodeRegionSeed,
  NodeJoinBundle,
  NodeTalosVersion,
} from "./node-bootstrap.ts";
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const within = (maximum: number) => (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length <= maximum;
const Seed = z
  .strictObject({ ...NodeRegionSeed.shape, talos_version: NodeTalosVersion })
  .refine(within(256 * 1024));
const Join = z
  .strictObject({
    ...NodeJoinBundle.shape,
    talos_version: NodeTalosVersion,
    kube_system_uid: z.uuid(),
  })
  .refine(within(256 * 1024));
const Topology = z.strictObject({
  ...RegionBootstrapMaterialUpdate.shape.observed.shape,
  talos_version: NodeTalosVersion,
});
const hashes = {
  expected_revision: z.number().int().min(1).max(2147483646),
  expected_seed_sha256: Digest,
  expected_join_sha256: Digest,
  seed_sha256: Digest,
  join_sha256: Digest,
};
export const RegionMaterialRotationStage = z
  .strictObject({ ...hashes, seed: Seed, join: Join, observed: Topology })
  .refine(within(512 * 1024));
export type RegionMaterialRotationStage = z.infer<
  typeof RegionMaterialRotationStage
>;
export const RegionMaterialRotationAuthority = z.enum([
  "talos_api_ca",
  "kubernetes_api_ca",
  "etcd_ca",
  "aggregator_ca",
  "service_account_signer",
  "trustd_token",
  "kubernetes_bootstrap_token",
  "discovery_secret",
  "secret_at_rest_key",
]);
const RetiredAuthority = z
  .strictObject({
    authority: RegionMaterialRotationAuthority,
    prior_sha256: Digest,
    replacement_sha256: Digest,
    new_access_sha256: Digest,
    retired_access_sha256: Digest,
    result: z.enum(["rejected", "retired_from_live_configuration"]),
  })
  .superRefine((value, ctx) => {
    if (value.prior_sha256 === value.replacement_sha256)
      ctx.addIssue({
        code: "custom",
        message: "Replacement authority must differ",
      });
    const configurationOnly =
      value.authority === "discovery_secret" ||
      value.authority === "secret_at_rest_key";
    if (
      value.result !==
      (configurationOnly ? "retired_from_live_configuration" : "rejected")
    )
      ctx.addIssue({
        code: "custom",
        message: "Retirement outcome must match the authority mechanism",
      });
  });
/** Explicit trusted-operator evidence. Hashes bind the private transcript; they are not cryptographic attestation. */
export const RegionMaterialRotationVerification = Topology.extend({
  source: z.enum(["trusted_admin", "trusted_native"]),
  seed_sha256: Digest,
  join_sha256: Digest,
  transcript_sha256: Digest,
  retired_authorities: z
    .array(RetiredAuthority)
    .length(9)
    .refine((rows) => new Set(rows.map((row) => row.authority)).size === 9),
});
export const RegionMaterialRotationActivate = z.strictObject({
  ...hashes,
  verified: RegionMaterialRotationVerification,
  verification_sha256: Digest,
});
export type RegionMaterialRotationActivate = z.infer<
  typeof RegionMaterialRotationActivate
>;
export const RegionMaterialRotationStaged = z.strictObject({
  region_id: RegionId,
  active_revision: z.number().int().positive(),
  staged_revision: z.number().int().positive(),
  seed_sha256: Digest,
  join_sha256: Digest,
  active: z.boolean(),
});

export const REGION_AUTHORITY_PHASES = [
  "talos-trust",
  "talos-issue",
  "talos-retire",
  "kubernetes-trust",
  "kubernetes-issue",
  "kubernetes-retire",
  "aggregator-trust",
  "aggregator-issue",
  "aggregator-retire",
  "service-account-trust",
  "service-account-issue",
  "service-account-retire",
  "trustd-token",
  "bootstrap-token",
  "discovery-secret",
  "etcd-ca",
  "encryption-decrypt",
  "encryption-issue",
  "encryption-retire",
  "encryption-name-decrypt",
  "encryption-name-issue",
  "encryption-name-retire",
] as const;
export type RegionAuthorityPhase = (typeof REGION_AUTHORITY_PHASES)[number];

export function regionAuthorityPhaseMembers<
  T extends { role: "controlplane" | "worker" },
>(phase: RegionAuthorityPhase, nodes: readonly T[]) {
  const controlOnly =
    /^(?:aggregator-|service-account-|encryption-)|^etcd-ca$/.test(phase);
  return nodes
    .filter((node) => !controlOnly || node.role === "controlplane")
    .toSorted((a, b) =>
      phase === "kubernetes-issue"
        ? Number(b.role === "controlplane") - Number(a.role === "controlplane")
        : Number(a.role === "controlplane") - Number(b.role === "controlplane"),
    );
}

/** Resource metadata only; private Secret/token material never enters the fleet cursor. */
export const RotationKubernetesCursor = z.strictObject({
  kind: z.enum(["rewrite_secrets", "renew_consumers", "retire_bootstrap"]),
  index: z.number().int().min(0).max(1000),
  state: z.enum(["pending", "dispatched", "confirmed"]),
  items: z
    .array(
      z.strictObject({
        namespace: z.string().min(1).max(253),
        name: z.string().min(1).max(253),
        uid: z.uuid(),
        resource_version: z.string().min(1).max(128),
        sha256: Digest,
        kind: z
          .enum(["Secret", "Deployment", "DaemonSet", "StatefulSet", "Cluster"])
          .optional(),
        initial_pod_uids: z.array(z.uuid()).max(1000).optional(),
      }),
    )
    .max(1000),
  key_name: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/)
    .optional(),
  annotation_value: z.string().min(1).max(128).optional(),
  restart_at: z.iso.datetime().optional(),
});
export type RotationKubernetesCursor = z.infer<typeof RotationKubernetesCursor>;

/** Safe execution progress inside the existing fleet intent; never private material. */
export const FleetRegionMaterialRotationCheckpoint = z.strictObject({
  revision: z.number().int().min(0).max(2147483646),
  phase: z.enum([
    "snapshot",
    ...REGION_AUTHORITY_PHASES,
    "verify",
    "activate",
    "complete",
  ]),
  node_index: z.number().int().min(0).max(99),
  state: z.enum(["pending", "dispatched", "confirmed", "halted"]),
  before_sha256: Digest.optional(),
  target_sha256: Digest.optional(),
  prior_boot_id: z.uuid().optional(),
  cursor: RotationKubernetesCursor.optional(),
  error_code: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,127}$/)
    .optional(),
  artifact: z
    .strictObject({
      object_key: z.string().min(1).max(1024),
      kid: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
      plaintext_sha256: Digest,
      encrypted_sha256: Digest,
      plaintext_bytes: z
        .number()
        .int()
        .positive()
        .max(1024 * 1024 * 1024),
      encrypted_bytes: z
        .number()
        .int()
        .positive()
        .max(1024 * 1024 * 1024),
    })
    .optional(),
  verified: RegionMaterialRotationVerification.optional(),
});
export type FleetRegionMaterialRotationCheckpoint = z.infer<
  typeof FleetRegionMaterialRotationCheckpoint
>;

/** Private transient input to the existing Bootstrap container. Custody remains encrypted in D1. */
export const FleetRegionMaterialRotationInput = z
  .strictObject({
    rollout_id: OperationId,
    region_id: RegionId,
    cluster_uid: z.uuid(),
    current_revision: z.number().int().positive(),
    target_revision: z.number().int().min(2),
    checkpoint: FleetRegionMaterialRotationCheckpoint,
    current_seed: Seed,
    current_join: Join,
    target_seed: Seed,
    target_join: Join,
    callback: z.strictObject({
      url: z.url().max(2048),
      bearer: z.string().min(32).max(4096),
      expires_at: z.iso.datetime(),
    }),
    nodes: z
      .array(
        z.strictObject({
          node_id: NodeId,
          node_uid: z.uuid(),
          node_name: z.string().min(1).max(253),
          provider_instance_id: z.string().regex(/^[1-9][0-9]{0,19}$/),
          address: z.ipv4(),
          role: z.enum(["worker", "controlplane"]),
          cilium_image: z.string().regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/),
          cilium_image_id: z.string().regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/),
        }),
      )
      .min(1)
      .max(100),
  })
  .superRefine((value, context) => {
    if (
      value.target_revision !== value.current_revision + 1 ||
      value.current_join.kube_system_uid !== value.cluster_uid ||
      value.target_join.kube_system_uid !== value.cluster_uid ||
      value.current_seed.cluster_endpoint !==
        value.target_seed.cluster_endpoint ||
      value.current_seed.cluster_name !== value.target_seed.cluster_name ||
      new Set(value.nodes.map((n) => n.node_id)).size !== value.nodes.length ||
      new Set(value.nodes.map((n) => n.node_uid)).size !== value.nodes.length ||
      value.nodes.filter((n) => n.role === "controlplane").length !== 1
    )
      context.addIssue({
        code: "custom",
        message:
          "Rotation must retain the current cluster and every distinct physical member",
      });
  });
export type FleetRegionMaterialRotationInput = z.infer<
  typeof FleetRegionMaterialRotationInput
>;
