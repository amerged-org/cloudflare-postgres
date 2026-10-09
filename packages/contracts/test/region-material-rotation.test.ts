// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import {
  RegionMaterialRotationAuthority,
  RegionMaterialRotationStage,
  RegionMaterialRotationVerification,
} from "../src/region-material-rotation.ts";
const topology = () => ({
  observed_at: new Date().toISOString(),
  kube_system_uid: crypto.randomUUID(),
  talos_version: "1.14.2",
  kubernetes_version: "1.36.5",
  nodes: [
    {
      node_id: `nod_${"a".repeat(20)}`,
      node_uid: crypto.randomUUID(),
      k8s_node_name: "retained",
      provider_instance_id: "12345",
    },
  ],
});
it("requires complete explicit retirement evidence rather than completion booleans", () => {
  const verified = {
    ...topology(),
    source: "trusted_admin",
    seed_sha256: "a".repeat(64),
    join_sha256: "b".repeat(64),
    transcript_sha256: "c".repeat(64),
    retired_authorities: RegionMaterialRotationAuthority.options.map(
      (authority) => ({
        authority,
        prior_sha256: "a".repeat(64),
        replacement_sha256: "b".repeat(64),
        new_access_sha256: "c".repeat(64),
        retired_access_sha256: "d".repeat(64),
        result:
          authority === "discovery_secret" || authority === "secret_at_rest_key"
            ? "retired_from_live_configuration"
            : "rejected",
      }),
    ),
  };
  expect(RegionMaterialRotationVerification.safeParse(verified).success).toBe(
    true,
  );
  expect(
    RegionMaterialRotationVerification.safeParse({
      ...verified,
      retired_authorities: [],
    }).success,
  ).toBe(false);
  expect(
    RegionMaterialRotationVerification.safeParse({
      ...verified,
      retired_authorities: verified.retired_authorities.map((row) => ({
        ...row,
        result: true,
      })),
    }).success,
  ).toBe(false);
  expect(
    RegionMaterialRotationVerification.safeParse({
      ...verified,
      attested: true,
    }).success,
  ).toBe(false);
});
it("bounds complete private stage payloads and accepts the unchanged actual Talos version", () => {
  const observed = topology(),
    seed = {
      version: 1,
      cluster_name: "retained",
      cluster_endpoint: "https://192.0.2.10:6443",
      talos_version: "1.14.2",
      kubernetes_version: "1.36.5",
      talos_machine_secrets_yaml: "private test material",
      talos_admin_config: "private test config",
    };
  const stage = {
    expected_revision: 1,
    expected_seed_sha256: "a".repeat(64),
    expected_join_sha256: "b".repeat(64),
    seed_sha256: "c".repeat(64),
    join_sha256: "d".repeat(64),
    seed,
    join: {
      ...seed,
      kube_system_uid: observed.kube_system_uid,
      kubeconfig: "private test kubeconfig",
    },
    observed,
  };
  expect(RegionMaterialRotationStage.safeParse(stage).success).toBe(true);
  expect(
    RegionMaterialRotationStage.safeParse({
      ...stage,
      seed: { ...seed, talos_machine_secrets_yaml: "x".repeat(256 * 1024 + 1) },
    }).success,
  ).toBe(false);
});
