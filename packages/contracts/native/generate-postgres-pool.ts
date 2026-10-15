// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from "node:fs/promises";
import { format } from "prettier";
import { z } from "zod";
import {
  PoolCleanupClaims,
  signPoolCleanupAuthority,
  POOL_CLEANUP_PREFIX,
  POOL_CLEANUP_DOMAIN,
  POOL_CLEANUP_MAX_LENGTH,
  POOL_CLEANUP_MAX_MS,
} from "../src/pool-cleanup-authority.ts";
import { createPrivateKey, createPublicKey } from "node:crypto";
import type { StorageAuthorityCryptoKey } from "../src/storage-write-authority.ts";
import {
  StorageWriteClaims,
  signStorageWriteAuthority,
} from "../src/storage-write-authority.ts";
import { bytesToBase64url, bytesToHex } from "../src/encoding.ts";
import {
  PoolWorkloadIsolationProbe,
  POOL_WORKLOAD_PROBE_RESULTS,
  POOL_WORKLOAD_PROBE_MODE,
} from "../src/pool-workload-probe.ts";
import * as pool from "../src/postgres-pool.ts";
import { DatabasePoolRuntimeAttestationV2 } from "../src/reclaim.ts";
const names = [
  "PostgresPoolClass",
  "PostgresPoolPolicy",
  "PostgresPoolPolicyState",
  "PoolThickPhysicalStorage",
  "PoolThinPhysicalStorage",
  "PoolPhysicalStorage",
  "PoolBindingScope",
  "PoolBinding",
  "DesiredPoolBinding",
  "PoolCreatorFence",
  "PoolMountpointProof",
  "PoolWorkloadIsolation",
  "PoolKernelProof",
  "PoolPodAttestation",
  "PoolPodInventory",
  "PoolBindClaims",
  "PoolMountSignal",
  "PoolArchiveConfiguration",
  "PoolTenantBundle",
  "PoolBundlePending",
  "PoolBundleReply",
  "PoolSupervisorReport",
  "PoolServingReport",
  "PoolIoCgroup",
  "PoolIoDevice",
  "PoolSharedPodIo",
  "PoolIoAttestation",
  "PoolCleanupIoAttestation",
  "PoolHostCustody",
  "PoolPodPreparationContext",
  "PoolStorageReadSignal",
  "PoolStorageReadRequest",
  "PoolStorageReadReport",
  "PoolThinGuardProof",
  "PoolNodeReport",
  "PoolReferenceDestruction",
  "PoolStorageObservation",
  "PoolSleepRecord",
  "PoolArchiverCommand",
  "PoolBackupReport",
  "PoolControlRequest",
  "PoolBackupRequest",
  "PoolBindingSnapshot",
  "PoolBindingDetails",
] as const;
const schemas = Object.fromEntries(
  names.map((name) => [name, z.toJSONSchema(pool[name])]),
);
const uid = "01234567-89ab-4def-8123-0123456789ab",
  hash = "a".repeat(64);
const classValue = {
  postgres_image_sha256: hash,
  cpu_request_millicores: 100,
  cpu_limit_millicores: 250,
  memory_request_bytes: 268435456,
  memory_limit_bytes: 268435456,
  configuration_profile_sha256: hash,
};
const driver = "registry.example/openebs-lvm@sha256:" + hash;
const scope = pool.PoolBindingScope.parse({
  v: 1,
  binding_id: uid,
  database_id: "a".repeat(20),
  generation: 7,
  route_revision: 19,
  admission_epoch: 23,
  configuration_fingerprint: hash,
  region_id: "eu-test",
  node_id: "nod_" + "a".repeat(20),
  node_uid: uid,
  boot_id: uid,
  pool_namespace: "pgcf-pool",
  pool_namespace_uid: uid,
  container_ids: [hash],
  pool_pod_uid: uid,
  pool_pod_name: "pgcf-pool-test",
  pool_pod_ip: "10.1.2.3",
  container_id: hash,
  supervisor_key_sha256: hash,
  supervisor_sha256: hash,
  driver_image: driver,
  driver_sha256: hash,
  host_controller_sha256: hash,
  class: classValue,
  storage: {
    backend: "lvm-thick-v1",
    storage_generation: 1,
    storage_uid: uid,
    namespace_uid: uid,
    cnpg_cluster_uid: uid,
    pvc_uid: uid,
    pv_uid: uid,
    volume_handle: "pvc-" + uid,
    volume_group_uuid: "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef",
    lv_uuid: "bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg",
  },
  system_identifier: "7459021837620377423",
  timeline: 1,
  bundle_nonce: uid,
});
const scope_sha256 = await pool.poolBindingScopeHash(scope);
const thinScope = pool.PoolBindingScope.parse({
  ...scope,
  storage: {
    ...scope.storage,
    backend: "lvm-thin-v1",
    thin_id: 42,
    profile: {
      backend: "lvm-thin-v1",
      profile_revision: 1,
      profile_sha256: hash,
      storage_class: "pgcf-lvm-thin-v1-" + hash.slice(0, 16),
      volume_attributes_class: "pgcf-lvm-thin-v1-" + hash.slice(0, 16),
      node_uid: uid,
      volume_group_uuid: scope.storage.volume_group_uuid,
      pool_uuid: "cdefgh-cdef-cdef-cdef-cdef-cdef-cdefgh",
      startup_reserve_bytes: 1048576,
      write_bytes_per_second: 1048576,
      write_iops_per_second: 100,
      guard_seconds: 30,
      drain_seconds: 10,
    },
  },
});
// Public deterministic test key, never a deployed credential.
const cleanupDer = Buffer.from(
  "302e020100300506032b657004220420" + "42".repeat(32),
  "hex",
);
const cleanupKey = await crypto.subtle.importKey(
  "pkcs8",
  cleanupDer,
  { name: "Ed25519" },
  false,
  ["sign"],
);
const cleanupClaims = PoolCleanupClaims.parse({
  v: 1,
  kid: "fixture",
  binding_id: uid,
  scope_sha256: await pool.poolBindingScopeHash(thinScope),
  holder_revision: 3,
  operation_id: "op_" + "a".repeat(20),
  cleanup_io_sha256: hash,
  holder_generation: 7,
  database_generation: 8,
  operation_target_generation: 8,
  authority_revision: 9,
  database_id: scope.database_id,
  node_uid: uid,
  boot_id: uid,
  storage: thinScope.storage,
  device_major: 253,
  device_minor: 1,
  // Unit fixture's full logical LV exposure, independent of cumulative BIO traffic.
  allocation_reserve_bytes: 32 * 1024 ** 2,
  cleanup_mode: "drain_unmount",
  write_bytes_per_second: 1048576,
  write_iops_per_second: 100,
  iat: 1000,
  exp: 11000,
});
const cleanup = {
  kid: "fixture",
  claims: cleanupClaims,
  public_key: [
    ...createPublicKey(
      createPrivateKey({ key: cleanupDer, format: "der", type: "pkcs8" }),
    )
      .export({ format: "der", type: "spki" })
      .subarray(-32),
  ],
  token: await signPoolCleanupAuthority(
    cleanupClaims,
    cleanupKey as unknown as StorageAuthorityCryptoKey,
    1000,
  ),
};
if (thinScope.storage.backend !== "lvm-thin-v1")
  throw new Error("Thin vector missing");
const storageClaims = StorageWriteClaims.parse({
  v: 1,
  kid: "fixture",
  database_id: thinScope.database_id,
  generation: thinScope.generation,
  authority_revision: 8,
  storage_uid: thinScope.storage.storage_uid,
  node_uid: thinScope.node_uid,
  volume_group_uuid: thinScope.storage.volume_group_uuid,
  pool_uuid: thinScope.storage.profile.pool_uuid,
  profile_sha256: thinScope.storage.profile.profile_sha256,
  volume_handle: thinScope.storage.volume_handle,
  lv_uuid: thinScope.storage.lv_uuid,
  pvc_uid: thinScope.storage.pvc_uid,
  pv_uid: thinScope.storage.pv_uid,
  pod_uid: thinScope.pool_pod_uid,
  observed_at: 1000,
  iat: 1000,
  exp: 11000,
  guard_seconds: 30,
  drain_seconds: 10,
  write_allowed: true,
});
const storageKeys = JSON.stringify({
  fixture: bytesToBase64url(new Uint8Array(cleanup.public_key)),
});
const storage = {
  claims: storageClaims,
  keys_json: storageKeys,
  trust_sha256: bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(storageKeys),
      ),
    ),
  ),
  token: await signStorageWriteAuthority(
    storageClaims,
    cleanupKey as unknown as StorageAuthorityCryptoKey,
    1000,
  ),
};
const policy = pool.PostgresPoolPolicy.parse({
  version: 1,
  kind: "postgres_pods",
  target_slots: 1,
  max_idle_cpu_millicores: 200,
  max_idle_memory_mib: 384,
  idle_cpu_millicores: 200,
  idle_memory_mib: 384,
  release_id: "test-release",
  class: classValue,
  driver_image: driver,
  driver_sha256: hash,
  supervisor_image: "registry.example/supervisor@sha256:" + hash,
  supervisor_sha256: hash,
  host_controller_sha256: hash,
  archiver_image: "registry.example/barman@sha256:" + hash,
  archiver_sha256: hash,
});
const mounted = {
  v: 1,
  binding_id: uid,
  scope_sha256,
  node_uid: uid,
  boot_id: uid,
  pool_pod_uid: uid,
  state: "mounted",
  observed_at: 1000,
  clean_stop: null,
  error: null,
  storage_backend: "lvm-thick-v1",
  thin_guard: null,
  kernel_proof: {
    device_major: 253,
    device_minor: 1,
    mount_id: 42,
    dm_open_count: 1,
    foreign_mounts: 0,
    complete_namespace_scan: false,
    named_namespace_scan_complete: true,
    zero_before_bind: true,
    exclusive_superblock_creation: true,
    nonlazy_unmount_verified: false,
    never_attached_verified: false,
    creator_fence: {
      v: 1,
      scope_sha256,
      storage_uid: uid,
      volume_handle: "pvc-" + uid,
      volume_group_uuid: scope.storage.volume_group_uuid,
      lv_uuid: scope.storage.lv_uuid,
      driver_gate_protocol: 1,
      driver_image: driver,
      driver_sha256: hash,
      deny_record_durable: true,
      csi_node_publish_serialized: true,
      csi_node_expand_serialized: true,
      creation_fds_closed: true,
    },
    mountpoint: {
      pool_pod_uid: uid,
      root_uid: 0,
      mode: 493,
      tmpfs: true,
      opened_beneath: true,
      symlink_free: true,
    },
  },
};
const archive = {
  destination_path:
    "s3://test-archive/eu-test/" + "a".repeat(20) + "/g1-op_" + "a".repeat(20),
  server_name: "database",
  endpoint_url: "https://r2.example.test",
  retention_days: 7,
};
const control = { v: 1, binding_id: uid, scope_sha256, bundle_nonce: uid };
const ioDevice = {
  volume_group_uuid: thinScope.storage.volume_group_uuid,
  lv_uuid: thinScope.storage.lv_uuid,
  thin_id: 42,
  device_major: 253,
  device_minor: 1,
};
const io = pool.PoolIoAttestation.parse({
  v: 1,
  binding_id: uid,
  scope_sha256: cleanupClaims.scope_sha256,
  node_uid: uid,
  boot_id: uid,
  pool_namespace_uid: uid,
  pool_pod_uid: uid,
  observed_at: 1000,
  device: ioDevice,
  shared_pod_io: {
    pod_cgroup_inode: 11,
    device_major: 253,
    device_minor: 1,
    write_bytes_per_second: 1048576,
    write_iops_per_second: 100,
    io_max_verified: true,
    all_writer_cgroups_descendants: true as const,
  },
  cgroups: [
    {
      container_id: hash,
      cgroup_inode: 12,
      pid: 26,
      start_ticks: 42,
      pid_namespace: 13,
      device_major: 253,
      device_minor: 1,
      write_bytes_per_second: 1048576,
      write_iops_per_second: 100,
      io_max_verified: true,
    },
  ],
});
const preparation = pool.PoolPodPreparationContext.parse({
  v: 1,
  node_id: scope.node_id,
  node_uid: uid,
  boot_id: uid,
  pool_namespace: "pgcf-pool",
  pool_namespace_uid: uid,
  policy_revision: 1,
  policy,
  observed_at: 1000,
  expires_at: 61000,
  qualification_run_id: uid,
  qualification_scope_sha256: hash,
  pods: [
    {
      pod_uid: uid,
      pod_name: scope.pool_pod_name,
      pod_ip: scope.pool_pod_ip,
      container_ids: scope.container_ids,
    },
  ],
});
const preparation_sha256 = await pool.poolPreparationContextHash(preparation);
const referenceWorker = {
  ...io.cgroups[0]!,
  pool_pod_uid: thinScope.pool_pod_uid,
  executable_sha256: thinScope.host_controller_sha256,
};
const referenceDestruction = {
  ...mounted,
  state: "released",
  storage_backend: "lvm-thin-v1",
  thin_guard: null,
  clean_stop: false,
  kernel_proof: {
    ...mounted.kernel_proof,
    mount_id: null,
    dm_open_count: 0,
    nonlazy_unmount_verified: false,
    device_major: referenceWorker.device_major,
    device_minor: referenceWorker.device_minor,
  },
  reference_destruction: {
    v: 1,
    operation_id: cleanupClaims.operation_id,
    authority_revision: cleanupClaims.authority_revision,
    cleanup_io_sha256: cleanupClaims.cleanup_io_sha256,
    cleanup_mode: "drain_unmount",
    dispatch_persisted: true,
    worker: referenceWorker,
    worker_reaped: true,
    stopped_writers: thinScope.container_ids.map((container_id) => ({
      container_id,
      cgroup_inode:
        container_id === referenceWorker.container_id
          ? referenceWorker.cgroup_inode
          : 31,
      tenant_tasks_remaining: 0,
    })),
  },
};
const inspection = pool.PoolStorageReadSignal.parse({
  v: 1,
  command: "inspect_readonly",
  permission: "pq1.fixture.signature",
  qualification_run_id: uid,
  qualification_scope_sha256: hash,
  preparation_sha256,
  nonce: "a".repeat(32),
  database_id: scope.database_id,
  source_generation: 6,
  configuration_fingerprint: hash,
  node_uid: uid,
  boot_id: uid,
  storage: thinScope.storage,
  pool_namespace: "pgcf-pool",
  pool_namespace_uid: uid,
  pool_pod_uid: uid,
  container_ids: scope.container_ids,
  postgres_image_sha256: hash,
  supervisor_sha256: hash,
  issued_at: 1000,
  expires_at: 31000,
  readonly: true,
  noload: true,
});
const vectors = [
  {
    name: "distinct-server-and-client-ca",
    schema: "PoolTenantBundle",
    value: {
      v: 1,
      scope: thinScope,
      scope_sha256: await pool.poolBindingScopeHash(thinScope),
      holder_revision: 3,
      permission: null,
      storage_authority: null,
      server_certificate_pem: "leaf\n",
      server_private_key_pem: "fixture\n",
      server_ca_pem: "\nserver\n",
      client_ca_pem: "client\n",
      ca_secret_uid: "11111111-1111-4111-8111-111111111111",
      ca_secret_resource_version: "server-31",
      ca_sha256: hash,
      client_ca_secret_uid: "22222222-2222-4222-8222-222222222222",
      client_ca_secret_resource_version: "client-47",
      tls_server_name: "database-rw.pgcf-db-" + scope.database_id + ".svc",
      archive: {
        destination_path: "s3://fixture/archive",
        server_name: "database",
        endpoint_url: "https://archive.invalid",
        retention_days: 7,
      },
    },
  },
  {
    name: "bound-pod-plus-ready-refill",
    schema: "PoolPodPreparationContext",
    value: {
      ...preparation,
      pods: [
        ...preparation.pods,
        {
          ...preparation.pods[0]!,
          pod_uid: "11111111-1111-4111-8111-111111111111",
          pod_name: "ready-refill",
        },
      ],
    },
  },
  {
    name: "same-boot-reference-destruction",
    schema: "PoolNodeReport",
    value: referenceDestruction,
  },
  {
    name: "reference-destruction-is-never-clean-sleep",
    schema: "PoolNodeReport",
    value: { ...referenceDestruction, clean_stop: true },
  },
  {
    name: "unreaped-cleanup-worker",
    schema: "PoolNodeReport",
    value: {
      ...referenceDestruction,
      reference_destruction: {
        ...referenceDestruction.reference_destruction,
        worker_reaped: false,
      },
    },
  },
  {
    name: "cleanup-worker-outside-retained-leaf",
    schema: "PoolNodeReport",
    value: {
      ...referenceDestruction,
      reference_destruction: {
        ...referenceDestruction.reference_destruction,
        worker: {
          ...referenceWorker,
          cgroup_inode: referenceWorker.cgroup_inode + 1,
        },
      },
    },
  },
  {
    name: "mixed-boot-loss-and-reference-destruction",
    schema: "PoolNodeReport",
    value: {
      ...referenceDestruction,
      boot_loss: {
        holder_boot_id: "11111111-1111-4111-8111-111111111111",
        storage: thinScope.storage,
      },
    },
  },
  {
    name: "unaccounted-archiver-request",
    schema: "PostgresPoolPolicy",
    value: {
      ...policy,
      idle_cpu_millicores: classValue.cpu_request_millicores,
      idle_memory_mib: Math.ceil(classValue.memory_request_bytes / 1024 ** 2),
    },
  },
  {
    name: "readonly-bound-preparation",
    schema: "PoolStorageReadRequest",
    value: { signal: inspection, preparation },
  },
  {
    name: "readonly-unprepared-pod",
    schema: "PoolStorageReadRequest",
    value: {
      signal: {
        ...inspection,
        pool_pod_uid: "11111111-1111-4111-8111-111111111111",
      },
      preparation,
    },
  },
  { name: "thin-scope", schema: "PoolBindingScope", value: thinScope },
  {
    name: "thin-wrong-node",
    schema: "PoolBindingScope",
    value: {
      ...thinScope,
      storage: {
        ...thinScope.storage,
        profile: {
          ...(thinScope.storage.backend === "lvm-thin-v1"
            ? thinScope.storage.profile
            : {}),
          node_uid: "11111111-1111-4111-8111-111111111111",
        },
      },
    },
  },
  { name: "measured-thin-device", schema: "PoolIoAttestation", value: io },
  {
    name: "wrong-shared-ancestor-device",
    schema: "PoolIoAttestation",
    value: { ...io, shared_pod_io: { ...io.shared_pod_io, device_minor: 2 } },
  },
  {
    name: "truthful-bundle-waiting",
    schema: "PoolBundleReply",
    value: { accepted: true, waiting: true },
  },
  {
    name: "invented-bundle-ready",
    schema: "PoolBundleReply",
    value: {
      v: 1,
      binding_id: uid,
      scope_sha256,
      bundle_nonce: uid,
      state: "ready",
      postmaster_pid: null,
      system_identifier: scope.system_identifier,
      timeline: scope.timeline,
      control_state: "in production",
      postgres_started_at: 1000,
      readiness_at: 1000,
      observed_at: 1000,
      error: null,
    },
  },
  {
    name: "lost-boot-protected-absence",
    schema: "PoolNodeReport",
    value: {
      ...mounted,
      state: "released",
      boot_id: "11111111-1111-4111-8111-111111111111",
      clean_stop: false,
      boot_loss: { holder_boot_id: uid, storage: scope.storage },
      kernel_proof: {
        ...mounted.kernel_proof,
        mount_id: null,
        dm_open_count: 0,
      },
    },
  },
  {
    name: "invented-same-boot-absence",
    schema: "PoolNodeReport",
    value: {
      ...mounted,
      state: "released",
      clean_stop: false,
      boot_loss: { holder_boot_id: uid, storage: scope.storage },
      kernel_proof: {
        ...mounted.kernel_proof,
        mount_id: null,
        dm_open_count: 0,
      },
    },
  },
  {
    name: "different-cgroup-device",
    schema: "PoolIoAttestation",
    value: { ...io, cgroups: [{ ...io.cgroups[0], device_minor: 2 }] },
  },
  {
    name: "nested-valid-idle-budget",
    schema: "PostgresPoolPolicyState",
    value: {
      node_id: scope.node_id,
      region_id: scope.region_id,
      node_uid: uid,
      revision: 1,
      updated_at: "2026-10-14T00:00:00.000Z",
      policy,
    },
  },
  {
    name: "nested-unsafe-idle-budget",
    schema: "PostgresPoolPolicyState",
    value: {
      node_id: scope.node_id,
      region_id: scope.region_id,
      node_uid: uid,
      revision: 1,
      updated_at: "2026-10-14T00:00:00.000Z",
      policy: { ...policy, target_slots: 16 },
    },
  },
  {
    name: "archiver-configure",
    schema: "PoolArchiverCommand",
    value: { ...control, command: "configure", archive },
  },
  {
    name: "archiver-http-endpoint",
    schema: "PoolArchiverCommand",
    value: {
      ...control,
      command: "configure",
      archive: { ...archive, endpoint_url: "http://r2.example.test" },
    },
  },
  {
    name: "archiver-history",
    schema: "PoolArchiverCommand",
    value: { ...control, command: "wal_archive", wal_name: "00000001.history" },
  },
  {
    name: "archiver-backup",
    schema: "PoolArchiverCommand",
    value: { ...control, command: "backup", backup_name: "backup-20261013" },
  },
  { name: "finite-creator-fence", schema: "PoolNodeReport", value: mounted },
  {
    name: "missing-creator-fence",
    schema: "PoolNodeReport",
    value: {
      ...mounted,
      storage_backend: "lvm-thick-v1",
      thin_guard: null,
      kernel_proof: { ...mounted.kernel_proof, creator_fence: null },
    },
  },
  {
    name: "unsafe-class",
    schema: "PostgresPoolClass",
    value: {
      ...classValue,
      memory_request_bytes: classValue.memory_limit_bytes + 1,
    },
  },
  {
    name: "pool-idle-budget",
    schema: "PostgresPoolPolicy",
    value: { ...policy, target_slots: 16 },
  },
].map((v) => ({
  ...v,
  accepted: (pool[v.schema as (typeof names)[number]] as z.ZodType).safeParse(
    v.value,
  ).success,
}));
const bytes = await format(
  JSON.stringify({
    version: 1,
    constants: {
      ...pool.POSTGRES_POOL,
      cleanup_prefix: POOL_CLEANUP_PREFIX,
      cleanup_domain: POOL_CLEANUP_DOMAIN,
      cleanup_max_length: POOL_CLEANUP_MAX_LENGTH,
      cleanup_max_ms: POOL_CLEANUP_MAX_MS,
      workload_probe_mode: POOL_WORKLOAD_PROBE_MODE,
      workload_probe_results: POOL_WORKLOAD_PROBE_RESULTS,
    },
    vectors,
    cleanup,
    storage,
    thin_scope: thinScope,
    preparation,
    preparation_sha256,
    scope,
    scope_sha256,
    schemas: {
      ...schemas,
      PoolCleanupClaims: z.toJSONSchema(PoolCleanupClaims),
      PoolWorkloadIsolationProbe: z.toJSONSchema(PoolWorkloadIsolationProbe),
      DatabasePoolRuntimeAttestationV2: z.toJSONSchema(
        DatabasePoolRuntimeAttestationV2,
      ),
    },
  }),
  { parser: "json" },
);
const path = new URL("postgres-pool.generated.json", import.meta.url);
if (process.argv.includes("--check")) {
  if ((await readFile(path, "utf8")) !== bytes)
    throw new Error("Regenerate postgres-pool.generated.json");
} else await writeFile(path, bytes);
