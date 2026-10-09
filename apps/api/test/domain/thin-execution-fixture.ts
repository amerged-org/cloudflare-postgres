// SPDX-License-Identifier: Apache-2.0
// Real D1 and AEAD custody setup for control-plane regressions; never a live qualification receipt.
import { env } from "cloudflare:workers";
import {
  ThinStorageProfile,
  NodeThinStorageAuthority,
  thinStorageClass,
} from "@pgcf/contracts";
import generated from "../../../../packages/contracts/native/compute-pool.generated.json" with { type: "json" };
import { fixture } from "./fixtures.ts";
import { installThinQualifiedFixture } from "./thin-qualified-fixture.ts";
import { configureNodeRegionPolicy } from "../../src/domain/node-state.ts";
import { storageAuthorityPublicKeys } from "../../src/domain/storage-authority.ts";
import {
  importRegionAgentKey,
  storeRegionJoinBundle,
  joinBundleReference,
} from "../../src/crypto/bootstrap-credentials.ts";
import { ensureNodeHostConfiguration } from "../../src/domain/node-host-configuration.ts";
import type { Env } from "../../src/env.ts";
export async function thinExecutionFixture(releases: string[]) {
  const local = {
    ...env,
    NODE_BOOTSTRAP_CALLBACK_URL: "https://api.invalid/",
  } as Env;
  const f = await fixture(8192, 95),
    now = Date.now(),
    at = new Date(now).toISOString();
  const uid = (await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
    .bind(f.node)
    .first<string>("node_uid"))!;
  const profile = ThinStorageProfile.parse({
    version: 1,
    driver_image: `registry.invalid/driver@sha256:${"a".repeat(64)}`,
    initial_data_bytes: 2 * 1024 ** 3,
    growth_bytes: 1024 ** 3,
    maximum_data_bytes: 32 * 1024 ** 3,
    metadata_bytes: 128 * 1024 ** 2,
    vg_reserve_bytes: 512 * 1024 ** 2,
    data_reserve_bytes: 256 * 1024 ** 2,
    metadata_reserve_bytes: 32 * 1024 ** 2,
    startup_reserve_bytes: 128 * 1024 ** 2,
    write_bytes_per_second: 1024 ** 2,
    write_iops_per_second: 10,
    guard_seconds: 120,
    drain_seconds: 10,
    maximum_volumes: 128,
    maximum_quota_gib: 16,
  });
  const authority = NodeThinStorageAuthority.parse({
    node_id: f.node,
    name: f.nodeName,
    node_uid: uid,
    cluster_uid: crypto.randomUUID(),
    revision: 1,
    profile_revision: 1,
    profile_sha256: "b".repeat(64),
    storage_class: thinStorageClass("b".repeat(64)),
    volume_group_uuid: "ABCDEF-1234-1234-1234-1234-1234-ABCDEF",
    pool_uuid: "POOLXX-1234-1234-1234-1234-1234-ABCDEF",
    driver_pod_uid: crypto.randomUUID(),
    driver_image: profile.driver_image,
    observed_at: at,
    captured_at: at,
    expires_at: new Date(now + 120000).toISOString(),
    write_allowed: true,
    physical: {
      volume_group_uuid: "ABCDEF-1234-1234-1234-1234-1234-ABCDEF",
      total_bytes: 100 * 1024 ** 3,
      free_bytes: 97 * 1024 ** 3,
      thick_allocated_bytes: 0,
      thin_pool: {
        name: "pgcf_thinpool",
        data_total_bytes: 2 * 1024 ** 3,
        data_used_bytes_upper_bound: 0,
        metadata_total_bytes: 128 * 1024 ** 2,
        metadata_used_bytes_upper_bound: 0,
      },
    },
    physical_lvs: [],
    active_lv_uuids: [],
    data_accounting_complete: true,
    protections: [],
    volumes: [],
  });
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 2,
    purchases_enabled: false,
    order: null,
    placement_mode: "actual_ram",
    maximum_database_memory_mib: 4096,
    postgres_memory_request_mib: 128,
  });
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE nodes SET provider_instance_id='fixture-retained-instance' WHERE id=?",
    ).bind(f.node),
    env.DB.prepare(
      "INSERT INTO node_memory_samples(node_id,node_uid,minute,observed_at,working_set_bytes,capacity_memory_bytes,available_bytes,memory_pressure) VALUES(?,?,?,?,?,?,?,0)",
    ).bind(
      f.node,
      uid,
      Math.floor(now / 60000),
      at,
      1024 ** 3,
      8 * 1024 ** 3,
      7 * 1024 ** 3,
    ),
    env.DB.prepare(
      "INSERT INTO node_thin_storage(node_id,node_uid,cluster_uid,address,volume_group_uuid,profile_revision,profile_sha256,profile_json,allow_new_databases,authority_revision,authority_json,authority_received_at,material_revision,qualified_driver_image,status,created_at,updated_at) VALUES(?,?,?,'192.0.2.18',?,1,?,?,1,1,?,?,1,?,'ready',?,?)",
    ).bind(
      f.node,
      uid,
      authority.cluster_uid,
      authority.volume_group_uuid,
      authority.profile_sha256,
      JSON.stringify(profile),
      JSON.stringify(authority),
      at,
      profile.driver_image,
      at,
      at,
    ),
  ]);
  const qualified = await installThinQualifiedFixture(
    env.DB,
    f.node,
    profile,
    authority.cluster_uid,
    { storageKeysSha256: (await storageAuthorityPublicKeys(local)).sha256 },
  );
  releases.push(qualified.releaseId);
  const policy = {
    ...generated.lease.policy,
    profile: {
      ...generated.lease.policy.profile,
      release_id: qualified.releaseId,
    },
  };
  await env.DB.prepare(
    "INSERT INTO node_compute_pool_policies VALUES(?,?,1,?,?,?)",
  )
    .bind(f.node, uid, qualified.releaseId, JSON.stringify(policy), at)
    .run();
  await importRegionAgentKey(env.DB, local, f.region, f.agent);
  const bundle = {
    version: 1 as const,
    cluster_name: "thin-fixture",
    cluster_endpoint: "https://192.0.2.18:6443/",
    talos_version: "1.14.1",
    kubernetes_version: "1.36.5",
    talos_machine_secrets_yaml: "test-only-machine",
    talos_admin_config: "test-only-admin",
    kube_system_uid: authority.cluster_uid,
    kubeconfig: "test-only-kube",
  };
  await storeRegionJoinBundle(
    env.DB,
    local.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 1),
    bundle,
  );
  // Replace the structural fixture with genuine sealed current host custody.
  await env.DB.prepare("DELETE FROM node_host_configurations WHERE node_id=?")
    .bind(f.node)
    .run();
  const host = await ensureNodeHostConfiguration(local, {
    node_id: f.node,
    node_uid: uid,
  });
  qualified.qualification.software.host_configuration_sha256 = host.sha256;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE fleet_patch_operations SET host_configuration_revision=?,host_configuration_sha256=?,observed_json=json_set(observed_json,'$.host_configuration_sha256',?,'$.runtime_admission_sha256',?) WHERE node_id=?",
    ).bind(
      host.revision,
      host.sha256,
      host.sha256,
      host.profile_sha256,
      f.node,
    ),
    env.DB.prepare(
      "UPDATE node_thin_storage SET qualification_json=? WHERE node_id=?",
    ).bind(JSON.stringify(qualified.qualification), f.node),
  ]);
  return { ...f, local, uid, profile, authority, qualified, bundle, host };
}
