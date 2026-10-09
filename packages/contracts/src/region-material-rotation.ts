// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { RegionId } from "./ids.ts";
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
