// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  DatabaseWithOperation,
  DesiredResponse,
  DatabaseStorageVolumeReceipt,
  DesiredDatabaseStorage,
  newOperationId,
} from "@pgcf/contracts";
import {
  DatabaseRuntimeAttestationV2,
  reclaimConfigurationFingerprint,
} from "@pgcf/contracts/reclaim";
import { expect } from "vitest";
import { fixture, request } from "./fixtures.ts";

export const admissionFixtureReleases: string[] = [];
/** Controlled local D1 metadata, never a regional runtime or Dev acceptance receipt. */
export async function admissionSnapshotFixture(
  declaresSnapshot = true,
  options: { thin?: boolean; receipt?: boolean; actualRam?: boolean } = {},
) {
  const f = await fixture(options.thin ? 0 : 4096);
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  const id = created.database.id;
  if (options.thin) expect(created.database.node_id).toBeNull();
  if (options.actualRam) {
    const { configureNodeRegionPolicy } =
      await import("../../src/domain/node-state.ts");
    await configureNodeRegionPolicy(env.DB, {
      region_id: f.region,
      max_nodes: 2,
      purchases_enabled: false,
      order: null,
      placement_mode: "actual_ram",
      maximum_database_memory_mib: 4096,
      postgres_memory_request_mib: 512,
    });
  }
  expect(
    (
      await request(`/v1/databases/${id}/roles`, f.integrator, "POST", {
        name: "reader",
      })
    ).status,
  ).toBe(201);
  const releaseId = `admission-${crypto.randomUUID()}`;
  const imageHash = "d".repeat(64);
  const names = [
    "api",
    "edge",
    "node-bootstrap",
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
    "native-gateway",
    "native-controller",
  ];
  const role = {
    talos_version: "1.14.1",
    talos_installer: `registry.example/talos@sha256:${"a".repeat(64)}`,
    talos_schematic_sha256: "b".repeat(64),
    talos_extensions: [],
    kubernetes_version: "1.36.5",
    components: names.slice(3),
  };
  const response = await request(
    `/v1/fleet/releases/${releaseId}`,
    f.admin,
    "PUT",
    {
      version: 1,
      versions_lock_sha256: "c".repeat(64),
      configuration_schema_revision: 1,
      route_token_version: 4,
      runtime_attestation_version: 2,
      ...(declaresSnapshot ? { admission_snapshot_version: 1 } : {}),
      components: names.map((name) => ({
        name,
        kind: name === "api" || name === "edge" ? "worker_bundle" : "image",
        version: name === "postgres" ? "18.7" : "1.0.0",
        reference: `registry.example/${name}@sha256:${imageHash}`,
        sha256: imageHash,
      })),
      roles: { control_relay: role, customer: structuredClone(role) },
    },
  );
  expect(response.status).toBe(200);
  admissionFixtureReleases.push(releaseId);
  const release = (await response.json()) as { spec_sha256: string };
  const nodeUid = await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
    .bind(f.node)
    .first<string>("node_uid");
  if (!nodeUid) throw new Error("fixture node identity missing");
  const storage = options.thin
    ? DesiredDatabaseStorage.parse({
        backend: "lvm-thin-v1",
        profile_revision: 1,
        profile_sha256: "a".repeat(64),
        storage_class: `pgcf-lvm-thin-v1-${"a".repeat(16)}`,
        volume_attributes_class: `pgcf-lvm-thin-v1-${"a".repeat(16)}`,
        node_uid: nodeUid,
        volume_group_uuid: "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef",
        pool_uuid: "bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg",
        startup_reserve_bytes: 1024 ** 2,
        write_bytes_per_second: 1024 ** 2,
        write_iops_per_second: 100,
        guard_seconds: 30,
        drain_seconds: 10,
      })
    : undefined;
  const patchId = newOperationId();
  const clusterUid = crypto.randomUUID();
  const at = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE nodes SET allocatable_memory_mib=4096 WHERE id=?",
    ).bind(f.node),
    env.DB.prepare(
      "INSERT INTO fleet_region_releases(region_id,release_id,revision,updated_at) VALUES(?,?,1,?)",
    ).bind(f.region, releaseId, at),
    env.DB.prepare(
      "INSERT INTO fleet_node_releases(node_id,node_uid,release_id,role,revision,updated_at) VALUES(?,?,?,'customer',1,?)",
    ).bind(f.node, nodeUid, releaseId, at),
    env.DB.prepare(
      `INSERT INTO fleet_patch_operations(operation_id,node_id,region_id,node_uid,cluster_uid,release_id,spec_sha256,assignment_revision,region_revision,material_revision,address,cluster_nodes_json,revision,stage,state,created_at,updated_at,deadline_at)
      VALUES(?,?,?,?,?,?,?,1,1,1,'192.0.2.18','[]',1,'complete','confirmed',?,?,?)`,
    ).bind(
      patchId,
      f.node,
      f.region,
      nodeUid,
      clusterUid,
      releaseId,
      release.spec_sha256,
      at,
      at,
      at,
    ),
    env.DB.prepare(
      "UPDATE databases SET node_id=?,storage_profile_json=?,observed_state='ready',observed_power='awake',observed_generation=generation,power_operation=NULL,desired_postgres_release_id=?,desired_postgres_image=?,desired_postgres_version='18.7',desired_postgres_schema_revision=1 WHERE id=?",
    ).bind(
      f.node,
      storage ? JSON.stringify(storage) : null,
      releaseId,
      `registry.example/postgres@sha256:${imageHash}`,
      id,
    ),
  ]);
  const desiredResponse = await request("/agent/v1/desired", f.agent);
  expect(desiredResponse.status).toBe(200);
  const desired = DesiredResponse.parse(
    await desiredResponse.json(),
  ).databases.find((database) => database.id === id);
  if (!desired) throw new Error("fixture desired database missing");
  const epoch = await env.DB.prepare(
    "SELECT admission_revision,route_revision FROM database_admission_epochs WHERE database_id=?",
  )
    .bind(id)
    .first<{ admission_revision: number; route_revision: number }>();
  if (!epoch) throw new Error("fixture admission epoch missing");
  const now = Date.now();
  const proof = DatabaseRuntimeAttestationV2.parse({
    v: 2,
    database_id: id,
    region_id: f.region,
    generation: desired.generation,
    storage_generation: desired.storage_generation ?? 1,
    node_uid: nodeUid,
    boot_id: crypto.randomUUID(),
    cluster_uid: clusterUid,
    namespace_uid: crypto.randomUUID(),
    cnpg_cluster_uid: crypto.randomUUID(),
    storage_uid: crypto.randomUUID(),
    pvc_uid: crypto.randomUUID(),
    pv_uid: crypto.randomUUID(),
    pod_uid: crypto.randomUUID(),
    container_id: "e".repeat(64),
    postgres_image_sha256: imageHash,
    memory_request_bytes:
      (desired.size.memory_request_mib ?? desired.size.memory_mib) * 1024 ** 2,
    memory_limit_bytes: desired.size.memory_mib * 1024 ** 2,
    observed_at: now,
    configuration_fingerprint: await reclaimConfigurationFingerprint(
      desired,
      desired.postgres!.image,
    ),
    route_revision: epoch.route_revision,
    admission_epoch: epoch.admission_revision,
    applied_role_revisions: desired.roles.map(({ name, revision }) => ({
      name,
      revision,
    })),
    tls_server_name: `database-rw.pgcf-db-${id}.svc`,
    ca_secret_uid: crypto.randomUUID(),
    ca_secret_resource_version: "81",
    ca_sha256: "f".repeat(64),
    pod_ip: "10.0.0.7",
    postgres_port: 5432,
    observation: {
      v: 1,
      controller_epoch: "a".repeat(64),
      watch_epoch: 1,
      coverage: "complete",
      verified_at: now,
      expires_at: now + 60000,
      resource_versions: {
        namespace: "1",
        cluster: "2",
        pod: "3",
        ca_secret: "81",
        storage: "5",
        pvc: "6",
        pv: "7",
        node: "8",
      },
    },
  });
  const volume = DatabaseStorageVolumeReceipt.parse({
    storage_generation: proof.storage_generation,
    storage_uid: proof.storage_uid,
    namespace_uid: proof.namespace_uid,
    cluster_uid: proof.cnpg_cluster_uid,
    node_uid: nodeUid,
    volume_group_uuid: "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef",
    pool_uuid: "bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg",
    volume_handle: `pvc-${proof.pvc_uid}`,
    lv_uuid: "cdefgh-cdef-cdef-cdef-cdef-cdef-cdefgh",
    pvc_uid: proof.pvc_uid,
    pv_uid: proof.pv_uid,
  });
  await env.DB.prepare(
    "UPDATE databases SET runtime_attestation_json=?,storage_volume_json=? WHERE id=?",
  )
    .bind(
      JSON.stringify(proof),
      options.receipt === false ? null : JSON.stringify(volume),
      id,
    )
    .run();
  return { ...f, id, releaseId, patchId, nodeUid, proof, volume, now, desired };
}
