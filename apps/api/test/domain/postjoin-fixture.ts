// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  NodeThinStorageAuthority,
  thinStorageClass,
  newOperationId,
} from "@pgcf/contracts";
import { FleetPatchFacts } from "@pgcf/contracts/fleet-patches";
import { thinVolumeProfile } from "../../src/domain/node-thin-storage-selection.ts";
import { ComputePoolObservation } from "@pgcf/contracts/compute-pool";
import { FleetReleaseSpec } from "@pgcf/contracts/releases";
import type { NodeJoinBundle } from "@pgcf/contracts/node-bootstrap";
import generated from "../../../../packages/contracts/native/compute-pool.generated.json" with { type: "json" };
import {
  canonicalInstallation,
  installationHash,
} from "../../src/domain/node-installation.ts";
import {
  joinBundleReference,
  regionSeedReference,
  loadRegionJoinBundle,
  storeRegionJoinBundle,
  storeRegionSeed,
} from "../../src/crypto/bootstrap-credentials.ts";
export async function standingPostjoinFixture(
  region: string,
  materialOverride?: NodeJoinBundle,
) {
  const id = "postjoin-" + crypto.randomUUID(),
    digest = "d".repeat(64),
    recipe = "b".repeat(64),
    names = [
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
    ],
    policy = {
      ...generated.lease.policy,
      profile: {
        ...generated.lease.policy.profile,
        release_id: id,
        image: `registry.example/sandbox-controller@sha256:${digest}`,
      },
    },
    storage = {
      version: 1 as const,
      driver_image: `registry.example/openebs-lvm@sha256:${digest}`,
      initial_data_bytes: 1024 ** 3,
      growth_bytes: 1024 ** 3,
      maximum_data_bytes: 8 * 1024 ** 3,
      metadata_bytes: 128 * 1024 ** 2,
      vg_reserve_bytes: 512 * 1024 ** 2,
      data_reserve_bytes: 256 * 1024 ** 2,
      metadata_reserve_bytes: 32 * 1024 ** 2,
      startup_reserve_bytes: 128 * 1024 ** 2,
      write_bytes_per_second: 1024 ** 2,
      write_iops_per_second: 100,
      guard_seconds: 10,
      drain_seconds: 10,
      maximum_volumes: 128,
      maximum_quota_gib: 7,
    },
    role = {
      host_configuration_required: true,
      talos_version: "1.14.1",
      talos_installer: `registry.example/talos@sha256:${digest}`,
      talos_schematic_sha256: recipe,
      talos_extensions: ["pgcf-sandbox-controller", "schematic"],
      kubernetes_version: "1.36.5",
      components: names
        .slice(3)
        .filter(
          (name) =>
            ![
              "pgcf-sandbox-controller",
              "schematic",
              "sandbox-controller",
              "postgres",
              "barman",
            ].includes(name),
        ),
    },
    spec = FleetReleaseSpec.parse({
      version: 1,
      versions_lock_sha256: "c".repeat(64),
      configuration_schema_revision: 1,
      components: names.map((name) => ({
        name,
        kind: ["api", "edge"].includes(name) ? "worker_bundle" : "image",
        version:
          name === "schematic"
            ? recipe
            : name === "pgcf-sandbox-controller"
              ? "0.1.0-" + "a".repeat(40)
              : "1.0.0",
        reference: `registry.example/${name}@sha256:${digest}`,
        sha256: digest,
      })),
      roles: { control_relay: role, customer: role },
      thin_storage_qualification: {
        profile_sha256: await installationHash(storage),
        driver_image: storage.driver_image,
        host_extension_image: `registry.example/pgcf-sandbox-controller@sha256:${digest}`,
        kernel_version: "6.18.51",
        receipt_sha256: "e".repeat(64),
        qualified_at: new Date().toISOString(),
        gates: {
          data_full: true,
          metadata_full: true,
          noflush_quiescence: true,
          resume_marker: true,
          startup_bound: true,
          trim_delete_recreate: true,
          retained_thick_preservation: true,
        },
      },
    }),
    now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO fleet_releases VALUES(?,?,?,?)").bind(
      id,
      canonicalInstallation(spec),
      await installationHash(spec),
      now,
    ),
    env.DB.prepare(
      "INSERT INTO fleet_region_releases VALUES(?,?,1,?) ON CONFLICT(region_id) DO UPDATE SET release_id=excluded.release_id,revision=1,updated_at=excluded.updated_at",
    ).bind(region, id, now),
    env.DB.prepare(
      "UPDATE node_region_policies SET compute_pool_json=?,thin_storage_json=? WHERE region_id=?",
    ).bind(
      canonicalInstallation(policy),
      canonicalInstallation(storage),
      region,
    ),
  ]);
  const old = await loadRegionJoinBundle(
      env.DB,
      env.CREDENTIAL_KEYS,
      joinBundleReference(region, 1),
    ).catch(() => materialOverride ?? null),
    material = {
      version: 1 as const,
      cluster_name: old?.cluster_name ?? "test-common",
      cluster_endpoint: old?.cluster_endpoint ?? "https://127.0.0.1:6443/",
      talos_version: "1.14.1",
      kubernetes_version: "1.36.5",
      talos_machine_secrets_yaml:
        old?.talos_machine_secrets_yaml ?? "test-material",
      talos_admin_config: old?.talos_admin_config ?? "test-admin",
    };
  const clusterUid = old?.kube_system_uid ?? crypto.randomUUID();
  await storeRegionSeed(
    env.DB,
    env.CREDENTIAL_KEYS,
    regionSeedReference(region, 2),
    material,
  );
  await storeRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(region, 2),
    {
      ...material,
      kube_system_uid: clusterUid,
      kubeconfig: old?.kubeconfig ?? "test-kube",
    },
  );
  await env.DB.prepare(
    "UPDATE regions SET bootstrap_material_revision=2 WHERE id=?",
  )
    .bind(region)
    .run();
  const members = await env.DB.prepare(
    "SELECT n.id,n.node_uid,n.k8s_node_name,r.agent_key_hash FROM nodes n JOIN regions r ON r.id=n.region_id WHERE n.region_id=? AND n.lost_at IS NULL",
  )
    .bind(region)
    .all<{
      id: string;
      node_uid: string | null;
      k8s_node_name: string;
      agent_key_hash: string;
    }>();
  const facts = {
    configuration_schema_revision: 1,
    talos_version: role.talos_version,
    talos_installer: role.talos_installer,
    talos_schematic_sha256: role.talos_schematic_sha256,
    kubernetes_version: role.kubernetes_version,
    components: spec.components
      .filter(
        (value) =>
          role.components.includes(value.name) ||
          role.talos_extensions.includes(value.name),
      )
      .map(({ name, version, sha256 }) => ({ name, version, sha256 })),
  };
  // Controlled authority metadata only: these fixtures are never live runtime/CI qualification evidence.
  const resolved = members.results.map((member) => ({
      ...member,
      node_uid: member.node_uid ?? crypto.randomUUID(),
    })),
    profileSha = await installationHash(policy.profile),
    specSha = await installationHash(spec),
    hostSha = "a".repeat(64);
  for (const member of resolved) {
    const uid = member.node_uid,
      boot = crypto.randomUUID(),
      system = crypto.randomUUID(),
      op = newOperationId();
    const observed = {
      ...facts,
      boot_id: boot,
      talos_provenance: {
        method: "deploymentreceipt",
        installer: role.talos_installer,
        node_uid: uid,
        cluster_uid: clusterUid,
        boot_id: boot,
      },
    };
    const patchFacts = FleetPatchFacts.parse({
      node_uid: uid,
      cluster_uid: clusterUid,
      system_uuid: system,
      boot_id: boot,
      talos_version: role.talos_version,
      talos_schematic_sha256: role.talos_schematic_sha256,
      kubernetes_version: role.kubernetes_version,
      kubelet_version: role.kubernetes_version,
      node_ready: true,
      databases_ready: true,
      host_configuration_sha256: hostSha,
      runtime_admission_sha256: profileSha,
      runtime_admission_policy_revision: 1,
      sandbox_service_running: true,
      cluster_nodes: resolved.map((node) => ({
        node_uid: node.node_uid,
        kubelet_version: role.kubernetes_version,
        node_ready: true,
      })),
      release_facts: observed,
      observed_at: now,
    });
    const pool = ComputePoolObservation.parse({
      node_id: member.id,
      node_uid: uid,
      policy_revision: 1,
      material_revision: 2,
      observed_at: now,
      profile: policy.profile,
      idle_memory_current_bytes: 0,
      idle_cpu_usage_usec: 0,
      slots: Array.from({ length: policy.target_slots }, (_, i) => ({
        slot_id: crypto.randomUUID().replaceAll("-", ""),
        holder_pid: i + 1,
        shim_pid: i + 100,
        live: true,
        sandbox_id: null,
        pod_uid: null,
        runtime_release_id: null,
        assignment_mode: null,
      })),
    });
    const volumeSha = await installationHash(thinVolumeProfile(storage)),
      vg = "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef",
      poolUuid = "bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg";
    const authority = NodeThinStorageAuthority.parse({
      node_id: member.id,
      name: member.k8s_node_name,
      node_uid: uid,
      cluster_uid: clusterUid,
      revision: 1,
      profile_revision: 1,
      profile_sha256: volumeSha,
      storage_class: thinStorageClass(volumeSha),
      volume_group_uuid: vg,
      pool_uuid: poolUuid,
      driver_pod_uid: crypto.randomUUID(),
      driver_image: storage.driver_image,
      observed_at: now,
      captured_at: now,
      expires_at: new Date(
        Date.parse(now) + storage.guard_seconds * 1000,
      ).toISOString(),
      write_allowed: true,
      physical: {
        volume_group_uuid: vg,
        total_bytes: 10 * 1024 ** 3,
        free_bytes: 8 * 1024 ** 3,
        thick_allocated_bytes: 0,
        thin_pool: {
          name: "pgcf_thinpool",
          data_total_bytes: storage.initial_data_bytes,
          data_used_bytes_upper_bound: 0,
          metadata_total_bytes: storage.metadata_bytes,
          metadata_used_bytes_upper_bound: 0,
        },
      },
      physical_lvs: [],
      active_lv_uuids: [],
      data_accounting_complete: true,
      protections: [],
      volumes: [],
    });
    const qualified = {
      profile_revision: 1,
      profile_sha256: spec.thin_storage_qualification!.profile_sha256,
      release_id: id,
      spec_sha256: specSha,
      assignment_revision: 1,
      region_revision: 1,
      boot_id: boot,
      system_uuid: system,
      software: {
        host_extension_image:
          spec.thin_storage_qualification!.host_extension_image,
        kernel_version: spec.thin_storage_qualification!.kernel_version,
        host_configuration_sha256: hostSha,
      },
    };
    await env.DB.batch([
      env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?").bind(
        uid,
        member.id,
      ),
      env.DB.prepare(
        "INSERT INTO fleet_node_releases VALUES(?,?,?,'customer',1,?)",
      ).bind(member.id, uid, id, now),
      env.DB.prepare(
        "INSERT INTO fleet_node_release_observations VALUES(?,?,1,?,?,?,?)",
      ).bind(
        member.id,
        uid,
        member.agent_key_hash,
        JSON.stringify(observed),
        now,
        now,
      ),
      env.DB.prepare(
        "INSERT INTO node_compute_pool_policies VALUES(?,?,1,?,?,?)",
      ).bind(member.id, uid, id, JSON.stringify(policy), now),
      env.DB.prepare(
        "INSERT INTO node_compute_pool_observations VALUES(?,?,1,2,?,?,?)",
      ).bind(member.id, uid, JSON.stringify(pool), now, now),
      env.DB.prepare(
        "INSERT INTO node_host_configurations(node_id,node_uid,region_id,cluster_uid,material_revision,revision,sha256,release_id,pool_policy_revision,profile_sha256,kid,iv,ciphertext,created_at) VALUES(?,?,?,?,2,1,?,?,1,?,'fixture','fixture','fixture',?)",
      ).bind(member.id, uid, region, clusterUid, hostSha, id, profileSha, now),
      env.DB.prepare(
        "INSERT INTO node_thin_storage(node_id,node_uid,cluster_uid,address,volume_group_uuid,profile_revision,profile_sha256,profile_json,allow_new_databases,authority_revision,authority_json,authority_received_at,material_revision,qualified_driver_image,qualification_json,status,created_at,updated_at) VALUES(?,?,?,'127.0.0.1',?,1,?,?,1,1,?,?,2,?,?,'ready',?,?)",
      ).bind(
        member.id,
        uid,
        clusterUid,
        vg,
        volumeSha,
        JSON.stringify(storage),
        JSON.stringify(authority),
        now,
        storage.driver_image,
        JSON.stringify(qualified),
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO fleet_patch_operations(operation_id,node_id,region_id,node_uid,cluster_uid,release_id,spec_sha256,assignment_revision,region_revision,material_revision,address,cluster_nodes_json,stage,state,baseline_json,observed_json,talos_upgrade_receipt_json,host_configuration_revision,host_configuration_sha256,created_at,updated_at,deadline_at) VALUES(?,?,?,?,?,?,?,1,1,2,'127.0.0.1',?,'complete','confirmed',?,?,?,1,?,?,?,?)`,
      ).bind(
        op,
        member.id,
        region,
        uid,
        clusterUid,
        id,
        specSha,
        JSON.stringify(
          resolved.map((node) => ({
            node_id: node.id,
            node_uid: node.node_uid,
            k8s_node_name: node.k8s_node_name,
            assignment_revision: 1,
          })),
        ),
        JSON.stringify(patchFacts),
        JSON.stringify(patchFacts),
        JSON.stringify({
          method: "deploymentreceipt",
          installer: role.talos_installer,
          node_uid: uid,
          cluster_uid: clusterUid,
          system_uuid: system,
          pre_reboot_boot_id: crypto.randomUUID(),
          completed_at: now,
          source: "cli_exit_0",
        }),
        hostSha,
        now,
        now,
        new Date(Date.now() + 3600000).toISOString(),
      ),
    ]);
  }

  return { id, policy, storage, spec };
}
