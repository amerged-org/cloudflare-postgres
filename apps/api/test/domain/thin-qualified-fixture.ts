// SPDX-License-Identifier: Apache-2.0
// Controlled D1 metadata for authority logic tests; this is never a live qualification receipt.
import { newOperationId, type ThinStorageProfile } from "@pgcf/contracts";
import {
  FleetReleaseSpec,
  type FleetReleaseComponent,
} from "@pgcf/contracts/releases";
import { installationHash } from "../../src/domain/node-installation.ts";
export async function installThinQualifiedFixture(
  db: D1Database,
  nodeId: string,
  profile: ThinStorageProfile,
  clusterUid: string,
  options: {
    extraComponents?: FleetReleaseComponent[];
    facts?: Record<string, unknown>;
    storageKeysSha256?: string;
  } = {},
) {
  const row = await db
    .prepare(
      "SELECT n.node_uid,n.region_id,r.agent_key_hash,r.bootstrap_material_revision FROM nodes n JOIN regions r ON r.id=n.region_id WHERE n.id=?",
    )
    .bind(nodeId)
    .first<{
      node_uid: string;
      region_id: string;
      agent_key_hash: string;
      bootstrap_material_revision: number;
    }>();
  if (!row) throw new Error("Missing qualified fixture node");
  const at = new Date().toISOString(),
    releaseId = `qualified-${crypto.randomUUID()}`,
    bootId = crypto.randomUUID(),
    hostSha = "a".repeat(64),
    runtimeSha = "b".repeat(64),
    fullProfileSha = await installationHash(profile),
    material = Math.max(1, row.bootstrap_material_revision);
  const hostImage = `ghcr.io/amerged-org/pgcf-regional:sandbox-extension-sha-${"c".repeat(40)}@sha256:${"c".repeat(64)}`;
  const names = [
    "api",
    "edge",
    "node-bootstrap",
    "regional",
    "postgres",
    "barman",
    "cloudflared",
    "cilium",
    "flux-source",
    "flux-kustomize",
    "flux-helm",
    "flux-notification",
    "cert-manager",
    "cloudnative-pg",
    "openebs-lvm",
    "sandbox-controller",
    "pgcf-sandbox-controller",
    "schematic",
  ];
  const components: FleetReleaseComponent[] = names.map((name) => ({
    name,
    kind: ["api", "edge"].includes(name) ? "worker_bundle" : "image",
    version:
      name === "postgres"
        ? "18.6"
        : name === "schematic"
          ? "d".repeat(64)
          : "1.0.0",
    reference:
      name === "openebs-lvm"
        ? profile.driver_image
        : name === "pgcf-sandbox-controller"
          ? hostImage
          : `registry.example/${name}@sha256:${"d".repeat(64)}`,
    sha256:
      name === "openebs-lvm"
        ? profile.driver_image.split("@sha256:")[1]!
        : name === "pgcf-sandbox-controller"
          ? "c".repeat(64)
          : "d".repeat(64),
  }));
  components.push(...(options.extraComponents ?? []));
  const role = {
    host_configuration_required: true,
    talos_version: "1.14.1",
    talos_installer: `registry.example/talos@sha256:${"d".repeat(64)}`,
    talos_schematic_sha256: "d".repeat(64),
    talos_extensions: ["pgcf-sandbox-controller", "schematic"],
    kubernetes_version: "1.36.5",
    components: components
      .map((c) => c.name)
      .filter(
        (name) =>
          ![
            "api",
            "edge",
            "node-bootstrap",
            "postgres",
            "barman",
            "sandbox-controller",
            "pgcf-sandbox-controller",
            "schematic",
          ].includes(name),
      ),
  };
  const qualification = {
    profile_sha256: fullProfileSha,
    driver_image: profile.driver_image,
    host_extension_image: hostImage,
    kernel_version: "6.18.51",
    receipt_sha256: "e".repeat(64),
    qualified_at: at,
    gates: {
      data_full: true,
      metadata_full: true,
      noflush_quiescence: true,
      resume_marker: true,
      startup_bound: true,
      trim_delete_recreate: true,
      retained_thick_preservation: true,
    },
  };
  const spec = FleetReleaseSpec.parse({
      version: 1,
      versions_lock_sha256: "f".repeat(64),
      configuration_schema_revision: 1,
      storage_authority_keys_sha256:
        options.storageKeysSha256 ?? "0".repeat(64),
      thin_storage_qualification: qualification,
      components,
      roles: { control_relay: role, customer: structuredClone(role) },
    }),
    specSha = await installationHash(spec);
  const profileRevision =
    (await db
      .prepare("SELECT profile_revision FROM node_thin_storage WHERE node_id=?")
      .bind(nodeId)
      .first<number>("profile_revision")) ?? 1;
  const receipt = {
    profile_revision: profileRevision,
    profile_sha256: fullProfileSha,
    release_id: releaseId,
    spec_sha256: specSha,
    assignment_revision: 1,
    region_revision: 1,
    boot_id: bootId,
    system_uuid: crypto.randomUUID(),
    software: {
      kernel_version: qualification.kernel_version,
      host_extension_image: hostImage,
      host_configuration_sha256: hostSha,
    },
  };
  await db.batch([
    db
      .prepare("UPDATE regions SET bootstrap_material_revision=? WHERE id=?")
      .bind(material, row.region_id),
    db
      .prepare(
        "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES(?,?,?,?)",
      )
      .bind(releaseId, JSON.stringify(spec), specSha, at),
    db
      .prepare(
        "INSERT INTO fleet_region_releases(region_id,release_id,revision,updated_at) VALUES(?,?,1,?) ON CONFLICT(region_id) DO UPDATE SET release_id=excluded.release_id,revision=1,updated_at=excluded.updated_at",
      )
      .bind(row.region_id, releaseId, at),
    db
      .prepare(
        "INSERT INTO fleet_node_releases(node_id,node_uid,release_id,role,revision,updated_at) VALUES(?,?,?,'customer',1,?) ON CONFLICT(node_id) DO UPDATE SET node_uid=excluded.node_uid,release_id=excluded.release_id,role=excluded.role,revision=1,updated_at=excluded.updated_at",
      )
      .bind(nodeId, row.node_uid, releaseId, at),
    db
      .prepare(
        "INSERT INTO node_host_configurations(node_id,node_uid,region_id,cluster_uid,material_revision,revision,sha256,release_id,pool_policy_revision,profile_sha256,kid,iv,ciphertext,created_at) VALUES(?,?,?,?,?,1,?,?,1,?,'fixture','fixture','fixture',?)",
      )
      .bind(
        nodeId,
        row.node_uid,
        row.region_id,
        clusterUid,
        material,
        hostSha,
        releaseId,
        runtimeSha,
        at,
      ),
    db
      .prepare(
        `INSERT INTO fleet_patch_operations(operation_id,node_id,region_id,node_uid,cluster_uid,release_id,spec_sha256,assignment_revision,region_revision,material_revision,address,cluster_nodes_json,revision,stage,state,observed_json,host_configuration_revision,host_configuration_sha256,created_at,updated_at,deadline_at) VALUES(?,?,?,?,?,?,?,1,1,?,'192.0.2.18','[]',1,'complete','confirmed',?,1,?,?,?,?)`,
      )
      .bind(
        newOperationId(),
        nodeId,
        row.region_id,
        row.node_uid,
        clusterUid,
        releaseId,
        specSha,
        material,
        JSON.stringify({
          boot_id: bootId,
          host_configuration_sha256: hostSha,
          runtime_admission_sha256: runtimeSha,
          node_ready: true,
          kubernetes_control_plane: false,
          ...options.facts,
        }),
        hostSha,
        at,
        at,
        at,
      ),
    db
      .prepare(
        "INSERT INTO fleet_node_release_observations(node_id,node_uid,assignment_revision,agent_key_hash,facts_json,observed_at,received_at) VALUES(?,?,1,?,?,?,?)",
      )
      .bind(
        nodeId,
        row.node_uid,
        row.agent_key_hash,
        JSON.stringify({
          boot_id: bootId,
          kubernetes_control_plane: false,
          ...options.facts,
        }),
        at,
        at,
      ),
    db
      .prepare(
        "UPDATE node_thin_storage SET qualification_json=? WHERE node_id=?",
      )
      .bind(JSON.stringify(receipt), nodeId),
  ]);
  return {
    releaseId,
    spec,
    specSha,
    qualification: receipt,
    bootId,
    hostSha,
    runtimeSha,
    at,
  };
}
