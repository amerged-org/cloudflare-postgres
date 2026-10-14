// SPDX-License-Identifier: Apache-2.0
import {
  PoolWorkloadIsolationProbe,
  poolWorkloadProbeSafe,
} from "./pool-workload-probe.ts";
import { z } from "zod";
import { DatabaseId, NodeId, RegionId, OperationId } from "./ids.ts";
import { StorageLvmUuid, DesiredDatabaseStorage } from "./database-storage.ts";
import { DatabasePoolRuntimeAttestationV2 } from "./reclaim.ts";
import { FleetReleaseId } from "./releases.ts";
import { base64urlToBytes, bytesToBase64url, bytesToHex } from "./encoding.ts";
import {
  STORAGE_AUTHORITY_KEY_ID_PATTERN,
  type StorageAuthorityCryptoKey,
} from "./storage-write-authority.ts";

const Safe = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Revision = Safe.positive();
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Image = z
  .string()
  .max(512)
  .regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/);
const Name = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
const Ip = z.union([z.ipv4(), z.ipv6()]);
export const POSTGRES_POOL = {
  version: 1,
  namespace: "pgcf-pool",
  supervisor_port: 18443,
  postgres_port: 5432,
  bind_prefix: "pb1",
  bind_domain: "pgcf-pool-bind/v1\n",
  bind_max_length: 8192,
  permission_ms: 30000,
  observation_max_age_ms: 60000,
  clock_skew_ms: 5000,
  thin_max_id: 16777215,
  max_slots: 16,
  archiver_cpu_request_millicores: 100,
  archiver_memory_request_mib: 128,
  max_inventory: 256,
  binding_record_key: "pool-binding.json",
  agent_socket: "/pgcf/control/agent.sock",
  attestation_file: "/pgcf/control/attestation.json",
  archiver_socket: "/controller/run/pgcf-archiver.sock",
  pgdata: "/var/lib/postgresql/data/pgdata",
} as const;
export const PostgresPoolClass = z
  .strictObject({
    postgres_image_sha256: Hash,
    cpu_request_millicores: Revision.max(256000),
    cpu_limit_millicores: Revision.max(256000),
    memory_request_bytes: Revision,
    memory_limit_bytes: Revision,
    configuration_profile_sha256: Hash,
  })
  .superRefine((value, ctx) => {
    if (
      value.cpu_request_millicores > value.cpu_limit_millicores ||
      value.memory_request_bytes > value.memory_limit_bytes
    )
      ctx.addIssue({
        code: "custom",
        message: "Pool class requests exceed limits",
      });
  });
export type PostgresPoolClass = z.infer<typeof PostgresPoolClass>;
/** Distinct canonical compute policy kind; never conflated with the existing CRI shim pool. */
export const PostgresPoolPolicy = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal("postgres_pods"),
    target_slots: Safe.max(POSTGRES_POOL.max_slots),
    max_idle_cpu_millicores: Revision.max(256000),
    max_idle_memory_mib: Revision.max(1048576),
    idle_cpu_millicores: Revision.max(2000),
    idle_memory_mib: Revision.max(2048),
    release_id: FleetReleaseId,
    class: PostgresPoolClass,
    driver_image: Image,
    driver_sha256: Hash,
    supervisor_image: Image,
    supervisor_sha256: Hash,
    host_controller_sha256: Hash,
    archiver_image: Image,
    archiver_sha256: Hash,
  })
  .superRefine((value, ctx) => {
    if (
      value.idle_cpu_millicores <
        value.class.cpu_request_millicores +
          POSTGRES_POOL.archiver_cpu_request_millicores ||
      value.idle_memory_mib <
        Math.ceil(value.class.memory_request_bytes / 1024 ** 2) +
          POSTGRES_POOL.archiver_memory_request_mib
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Pool node charge must cover actual PostgreSQL and archiver Pod requests",
      });
    if (
      value.target_slots * value.idle_cpu_millicores >
        value.max_idle_cpu_millicores ||
      value.target_slots * value.idle_memory_mib > value.max_idle_memory_mib
    )
      ctx.addIssue({
        code: "custom",
        message: "Pool target exceeds its hard idle budget",
      });
    if (!value.archiver_image.endsWith("@sha256:" + value.archiver_sha256))
      ctx.addIssue({
        code: "custom",
        message: "Archiver digest differs from pinned image",
      });
  });
export type PostgresPoolPolicy = z.infer<typeof PostgresPoolPolicy>;
export const PostgresPoolPolicyState = z.strictObject({
  node_id: NodeId,
  node_uid: z.uuid(),
  region_id: RegionId,
  revision: Revision,
  policy: PostgresPoolPolicy,
  updated_at: z.iso.datetime(),
});
export type PostgresPoolPolicyState = z.infer<typeof PostgresPoolPolicyState>;
export const PostgresPoolPolicyUpdate = z.strictObject({
  expected_revision: Safe.max(2147483646),
  node_uid: z.uuid(),
  policy: PostgresPoolPolicy,
});
export const PoolThickPhysicalStorage = z.strictObject({
  backend: z.literal("lvm-thick-v1"),
  storage_generation: Revision,
  storage_uid: z.uuid(),
  namespace_uid: z.uuid(),
  cnpg_cluster_uid: z.uuid(),
  pvc_uid: z.uuid(),
  pv_uid: z.uuid(),
  volume_handle: z.string().regex(/^pvc-[a-f0-9-]{36}$/),
  volume_group_uuid: StorageLvmUuid,
  lv_uuid: StorageLvmUuid,
});
export const PoolThinPhysicalStorage = PoolThickPhysicalStorage.omit({
  backend: true,
}).extend({
  backend: z.literal("lvm-thin-v1"),
  thin_id: Safe.max(POSTGRES_POOL.thin_max_id),
  profile: DesiredDatabaseStorage,
});
export const PoolPhysicalStorage = z.discriminatedUnion("backend", [
  PoolThickPhysicalStorage,
  PoolThinPhysicalStorage,
]);
export type PoolPhysicalStorage = z.infer<typeof PoolPhysicalStorage>;
/** Cloudflare-assigned immutable singleton holder scope; inventory labels have no authority. */
export const PoolBindingScope = z
  .strictObject({
    v: z.literal(1),
    binding_id: z.uuid(),
    database_id: DatabaseId,
    generation: Revision,
    route_revision: Revision,
    admission_epoch: Revision,
    configuration_fingerprint: Hash,
    region_id: RegionId,
    node_id: NodeId,
    node_uid: z.uuid(),
    boot_id: z.uuid(),
    pool_namespace: z.literal("pgcf-pool"),
    pool_namespace_uid: z.uuid(),
    container_ids: z.array(Hash).min(1).max(8),
    pool_pod_uid: z.uuid(),
    pool_pod_name: Name,
    pool_pod_ip: Ip,
    container_id: Hash,
    supervisor_key_sha256: Hash,
    supervisor_sha256: Hash,
    driver_image: Image,
    driver_sha256: Hash,
    class: PostgresPoolClass,
    host_controller_sha256: Hash,
    storage: PoolPhysicalStorage,
    system_identifier: z.string().regex(/^[1-9][0-9]{0,19}$/),
    timeline: Revision.max(4294967295),
    bundle_nonce: z.uuid(),
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.container_ids).size !== value.container_ids.length ||
      !value.container_ids.includes(value.container_id)
    )
      ctx.addIssue({
        code: "custom",
        message: "Pool writer container custody must be complete and unique",
      });
    if (
      value.storage.backend === "lvm-thin-v1" &&
      (value.storage.profile.node_uid !== value.node_uid ||
        value.storage.profile.volume_group_uuid !==
          value.storage.volume_group_uuid)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Thin profile must bind the same physical node and volume group",
      });
  });
export type PoolBindingScope = z.infer<typeof PoolBindingScope>;
export const PoolBindingState = z.enum([
  "claimed",
  "mounted",
  "serving",
  "detaching",
  "failed",
  "released",
  "refused",
  "lost",
]);
export const PoolBinding = z.strictObject({
  v: z.literal(1),
  scope: PoolBindingScope,
  scope_sha256: Hash,
  holder_revision: Revision,
  state: PoolBindingState,
  created_at: Safe,
  updated_at: Safe,
});
export type PoolBinding = z.infer<typeof PoolBinding>;
export const DesiredPoolBinding = z.strictObject({
  binding: PoolBinding,
  authority: z.enum(["current", "revoked"]),
  storage_authority: z.string().max(4096).nullable(),
  permission: z.string().max(POSTGRES_POOL.bind_max_length).nullable(),
});
export type DesiredPoolBinding = z.infer<typeof DesiredPoolBinding>;
export const PoolCreatorFence = z.strictObject({
  v: z.literal(1),
  scope_sha256: Hash,
  storage_uid: z.uuid(),
  volume_handle: z.string().regex(/^pvc-[a-f0-9-]{36}$/),
  volume_group_uuid: StorageLvmUuid,
  lv_uuid: StorageLvmUuid,
  driver_gate_protocol: z.literal(1),
  driver_image: Image,
  driver_sha256: Hash,
  deny_record_durable: z.literal(true),
  csi_node_publish_serialized: z.literal(true),
  csi_node_expand_serialized: z.literal(true),
  creation_fds_closed: z.literal(true),
});
/** The retained descriptor proves the pre-mount tmpfs anchor; mounted ext4 PGDATA may belong to UID26. */
export const PoolMountpointProof = z.strictObject({
  pool_pod_uid: z.uuid(),
  root_uid: z.literal(0),
  mode: z.literal(493),
  tmpfs: z.literal(true),
  opened_beneath: z.literal(true),
  symlink_free: z.literal(true),
});
export const PoolWorkloadIsolation = z.strictObject({
  uid: z.literal(26),
  cap_sys_admin: z.literal(false),
  seccomp_runtime_default: z.literal(true),
  namespace_creation_denied: z.literal(true),
  mount_api_denied: z.literal(true),
});
export const PoolKernelProof = z.strictObject({
  device_major: Safe.max(4294967295),
  device_minor: Safe.max(4294967295),
  mount_id: Revision.nullable(),
  dm_open_count: Safe,
  foreign_mounts: Safe,
  complete_namespace_scan: z.boolean(),
  named_namespace_scan_complete: z.boolean(),
  zero_before_bind: z.boolean(),
  exclusive_superblock_creation: z.boolean(),
  nonlazy_unmount_verified: z.boolean(),
  never_attached_verified: z.boolean(),
  creator_fence: PoolCreatorFence.nullable(),
  mountpoint: PoolMountpointProof.nullable(),
});
export const PoolPodAttestation = z
  .strictObject({
    v: z.literal(1),
    node_id: NodeId,
    node_uid: z.uuid(),
    boot_id: z.uuid(),
    pool_namespace: z.literal("pgcf-pool"),
    pool_namespace_uid: z.uuid(),
    container_ids: z.array(Hash).min(1).max(8),
    pool_pod_uid: z.uuid(),
    pool_pod_name: Name,
    pool_pod_ip: Ip,
    container_id: Hash,
    supervisor_sha256: Hash,
    supervisor_key_sha256: Hash,
    supervisor_public_key_pem: z.string().min(1).max(8192),
    supervisor_certificate_pem: z.string().min(1).max(32768),
    class: PostgresPoolClass,
    propagation_verified: z.literal(true),
    workload_isolation: PoolWorkloadIsolation,
    workload_probes: z
      .array(
        z.strictObject({
          container_id: Hash,
          probe: PoolWorkloadIsolationProbe,
        }),
      )
      .min(1)
      .max(8),
    observed_at: Safe,
  })
  .superRefine((value, ctx) => {
    const ids = new Set(value.container_ids),
      probes = new Map(
        value.workload_probes.map((p) => [p.container_id, p.probe]),
      );
    if (
      ids.size !== value.container_ids.length ||
      !ids.has(value.container_id) ||
      probes.size !== value.workload_probes.length ||
      probes.size !== ids.size ||
      value.container_ids.some(
        (id) => !probes.has(id) || !poolWorkloadProbeSafe(probes.get(id)!),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Every actual writer must have a matching safe workload probe",
      });
  });
export type PoolPodAttestation = z.infer<typeof PoolPodAttestation>;
export const PoolPodInventory = z
  .strictObject({
    v: z.literal(1),
    node_id: NodeId,
    node_uid: z.uuid(),
    boot_id: z.uuid(),
    policy_revision: Revision,
    qualification_run_id: z.uuid().optional(),
    qualification_scope_sha256: Hash.optional(),
    observed_at: Safe,
    pods: z.array(PoolPodAttestation).max(POSTGRES_POOL.max_inventory),
    idle_memory_current_bytes: Safe,
    idle_cpu_usage_usec: Safe,
  })
  .refine(
    (value) =>
      new Set(value.pods.map((pod) => pod.pool_pod_uid)).size ===
      value.pods.length,
    { message: "Duplicate pool Pod identity" },
  )
  .refine(
    (v) =>
      (v.qualification_run_id === undefined) ===
      (v.qualification_scope_sha256 === undefined),
    { message: "Qualification inventory requires its exact active run scope" },
  );
export type PoolPodInventory = z.infer<typeof PoolPodInventory>;
export const PoolBindClaims = z.strictObject({
  v: z.literal(1),
  kid: z.string().regex(STORAGE_AUTHORITY_KEY_ID_PATTERN),
  scope: PoolBindingScope,
  scope_sha256: Hash,
  holder_revision: Revision,
  iat: Safe,
  exp: Safe,
});
export type PoolBindClaims = z.infer<typeof PoolBindClaims>;
export const PoolMountSignal = z.strictObject({
  storage_authority: z.string().max(4096).nullable(),
  v: z.literal(1),
  scope_sha256: Hash,
  binding_id: z.uuid(),
  bundle_nonce: z.uuid(),
  node_uid: z.uuid(),
  boot_id: z.uuid(),
  pool_pod_uid: z.uuid(),
  permission: z.string().max(POSTGRES_POOL.bind_max_length),
  mount_id: Revision,
  device_major: Safe,
  device_minor: Safe,
  observed_at: Safe,
});
export const PoolArchiveConfiguration = z.strictObject({
  destination_path: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^s3:\/\/[^\s]+$/),
  server_name: z.literal("database"),
  endpoint_url: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .regex(/^https:\/\/[^\s]+$/),
  retention_days: Revision.max(36500),
});
export const PoolTenantBundle = z.strictObject({
  storage_authority: z.string().max(4096).nullable(),
  v: z.literal(1),
  scope: PoolBindingScope,
  scope_sha256: Hash,
  holder_revision: Revision,
  permission: z.string().max(POSTGRES_POOL.bind_max_length).nullable(),
  server_certificate_pem: z.string().min(1).max(32768),
  server_private_key_pem: z.string().min(1).max(32768),
  server_ca_pem: z.string().min(1).max(32768),
  client_ca_pem: z.string().min(1).max(32768),
  /** These three existing fields identify the SERVER CA, independently of client authentication. */
  ca_secret_uid: z.uuid(),
  ca_secret_resource_version: z.string().min(1).max(128),
  ca_sha256: Hash,
  client_ca_secret_uid: z.uuid(),
  client_ca_secret_resource_version: z.string().min(1).max(128),
  tls_server_name: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9.-]+$/),
  archive: PoolArchiveConfiguration,
});
export const PoolSupervisorReport = z
  .strictObject({
    v: z.literal(1),
    binding_id: z.uuid(),
    scope_sha256: Hash,
    bundle_nonce: z.uuid(),
    state: z.enum(["ready", "stopped", "failed", "refused"]),
    system_identifier: z.string().regex(/^[1-9][0-9]{0,19}$/),
    timeline: Revision,
    control_state: z.enum(["in production", "shut down", "unclean"]),
    postmaster_pid: Revision.nullable(),
    postgres_started_at: Safe.nullable(),
    readiness_at: Safe.nullable(),
    observed_at: Safe,
    error: z.string().min(1).max(512).nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      value.state === "ready" &&
      (value.postmaster_pid === null ||
        value.control_state !== "in production" ||
        value.postgres_started_at === null ||
        value.readiness_at === null)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Ready report requires a real postmaster and readiness timestamps",
      });
    if (
      value.state === "stopped" &&
      (value.postmaster_pid !== null || value.control_state !== "shut down")
    )
      ctx.addIssue({
        code: "custom",
        message: "Clean stop requires stopped PostgreSQL control state",
      });
  });
export type PoolSupervisorReport = z.infer<typeof PoolSupervisorReport>;
export const PoolBundlePending = z.strictObject({
  accepted: z.literal(true),
  waiting: z.literal(true),
});
export const PoolBundleReply = z.union([
  PoolBundlePending,
  PoolSupervisorReport,
]);
export const PoolServingReport = z.strictObject({
  v: z.literal(1),
  runtime: DatabasePoolRuntimeAttestationV2,
  supervisor: PoolSupervisorReport,
});
export const PoolIoCgroup = z.strictObject({
  container_id: Hash,
  cgroup_inode: Revision,
  pid: Revision.max(2147483647),
  start_ticks: Revision,
  pid_namespace: Revision,
  device_major: Safe,
  device_minor: Safe,
  write_bytes_per_second: Revision,
  write_iops_per_second: Revision,
  io_max_verified: z.literal(true),
});
/** Actual DM mapping read by the host, before any writer grant. */
export const PoolIoDevice = z.strictObject({
  volume_group_uuid: StorageLvmUuid,
  lv_uuid: StorageLvmUuid,
  thin_id: Safe.max(16777215),
  device_major: Safe.max(4294967295),
  device_minor: Safe.max(4294967295),
});
export const PoolSharedPodIo = z.strictObject({
  pod_cgroup_inode: Revision,
  device_major: Safe.max(4294967295),
  device_minor: Safe.max(4294967295),
  write_bytes_per_second: Revision,
  write_iops_per_second: Revision,
  io_max_verified: z.literal(true),
  all_writer_cgroups_descendants: z.literal(true),
});
export const PoolIoAttestation = z
  .strictObject({
    v: z.literal(1),
    binding_id: z.uuid(),
    scope_sha256: Hash,
    node_uid: z.uuid(),
    boot_id: z.uuid(),
    pool_namespace_uid: z.uuid(),
    pool_pod_uid: z.uuid(),
    observed_at: Safe,
    device: PoolIoDevice,
    shared_pod_io: PoolSharedPodIo,
    cgroups: z.array(PoolIoCgroup).min(1).max(8),
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.cgroups.map((c) => c.container_id)).size !==
        value.cgroups.length ||
      value.shared_pod_io.device_major !== value.device.device_major ||
      value.shared_pod_io.device_minor !== value.device.device_minor ||
      value.cgroups.some(
        (c) =>
          c.device_major !== value.device.device_major ||
          c.device_minor !== value.device.device_minor,
      )
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Every unique writer cgroup must be measured on the attested thin device",
      });
  });
export type PoolIoAttestation = z.infer<typeof PoolIoAttestation>;
/** Fresh actual cleanup-worker custody. This report is not a write, resume or mount grant. */
export const PoolCleanupIoAttestation = z
  .strictObject({
    v: z.literal(1),
    binding_id: z.uuid(),
    scope_sha256: Hash,
    holder_revision: Revision,
    operation_id: OperationId,
    holder_generation: Revision,
    database_generation: Revision,
    node_uid: z.uuid(),
    boot_id: z.uuid(),
    observed_at: Safe,
    device: PoolIoDevice,
    shared_pod_io: PoolSharedPodIo,
    worker: PoolIoCgroup.extend({
      pool_pod_uid: z.uuid(),
      executable_sha256: Hash,
    }),
    stopped_writers: z
      .array(
        z.strictObject({
          container_id: Hash,
          cgroup_inode: Revision,
          tenant_tasks_remaining: z.literal(0),
        }),
      )
      .min(1)
      .max(8),
    cleanup_worker_only_verified: z.literal(true),
  })
  .superRefine((v, ctx) => {
    if (
      new Set(v.stopped_writers.map((w) => w.container_id)).size !==
        v.stopped_writers.length ||
      v.worker.device_major !== v.device.device_major ||
      v.worker.device_minor !== v.device.device_minor ||
      v.shared_pod_io.device_major !== v.device.device_major ||
      v.shared_pod_io.device_minor !== v.device.device_minor ||
      v.worker.write_bytes_per_second !==
        v.shared_pod_io.write_bytes_per_second ||
      v.worker.write_iops_per_second !== v.shared_pod_io.write_iops_per_second
    )
      ctx.addIssue({
        code: "custom",
        message: "Cleanup worker must inherit the actual shared device budget",
      });
  });
export type PoolCleanupIoAttestation = z.infer<typeof PoolCleanupIoAttestation>;
/** CF host delivery names ordinary pool Pods explicitly; DB namespace inference is forbidden. */
export const PoolHostCustody = z
  .strictObject({
    v: z.literal(1),
    binding_id: z.uuid(),
    scope_sha256: Hash,
    holder_revision: Revision,
    holder_generation: Revision,
    holder_boot_id: z.uuid(),
    state: z.enum([
      "claimed",
      "mounted",
      "serving",
      "detaching",
      "failed",
      "released",
      "refused",
      "lost",
    ]),
    pool_namespace: z.literal("pgcf-pool"),
    pool_namespace_uid: z.uuid(),
    pool_pod_uid: z.uuid(),
    container_ids: z.array(Hash).min(1).max(8),
    device: PoolIoDevice.nullable(),
    cleanup_authority: z.string().startsWith("pc1.").max(8192).nullable(),
    cleanup_intent: z
      .strictObject({
        operation_id: OperationId,
        database_generation: Revision,
        operation_target_generation: Revision,
      })
      .optional(),
  })
  .refine(
    (value) => new Set(value.container_ids).size === value.container_ids.length,
    { message: "Duplicate pool writer custody" },
  );
export type PoolHostCustody = z.infer<typeof PoolHostCustody>;
export const PoolPodPreparationContext = z
  .strictObject({
    v: z.literal(1),
    node_id: NodeId,
    node_uid: z.uuid(),
    boot_id: z.uuid(),
    pool_namespace: z.literal("pgcf-pool"),
    pool_namespace_uid: z.uuid(),
    policy_revision: Revision,
    policy: PostgresPoolPolicy,
    observed_at: Safe,
    expires_at: Safe,
    qualification_run_id: z.uuid().optional(),
    qualification_scope_sha256: Hash.optional(),
    pods: z
      .array(
        z.strictObject({
          pod_uid: z.uuid(),
          pod_name: Name,
          pod_ip: Ip,
          container_ids: z.array(Hash).min(1).max(8),
        }),
      )
      .max(POSTGRES_POOL.max_inventory),
  })
  .superRefine((value, ctx) => {
    if (
      value.expires_at <= value.observed_at ||
      value.expires_at >
        value.observed_at + POSTGRES_POOL.observation_max_age_ms ||
      new Set(value.pods.map((p) => p.pod_uid)).size !== value.pods.length ||
      value.pods.some(
        (p) => new Set(p.container_ids).size !== p.container_ids.length,
      ) ||
      (value.qualification_run_id === undefined) !==
        (value.qualification_scope_sha256 === undefined)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Preparation must retain finite unique ready and bound inventory under one authoritative policy",
      });
  });
export type PoolPodPreparationContext = z.infer<
  typeof PoolPodPreparationContext
>;

/** Exactly one readonly+noload PGDATA descriptor for fixed pg_controldata under pq1.
 * This signal grants no DM resume, mount writer, arbitrary command or tenant start. */
export const PoolStorageReadSignal = z
  .strictObject({
    v: z.literal(1),
    command: z.literal("inspect_readonly"),
    permission: z.string().startsWith("pq1.").max(16384),
    qualification_run_id: z.uuid(),
    qualification_scope_sha256: Hash,
    preparation_sha256: Hash,
    nonce: z.string().regex(/^[a-f0-9]{32}$/),
    database_id: DatabaseId,
    source_generation: Revision,
    configuration_fingerprint: Hash,
    node_uid: z.uuid(),
    boot_id: z.uuid(),
    storage: PoolThinPhysicalStorage,
    pool_namespace: z.literal("pgcf-pool"),
    pool_namespace_uid: z.uuid(),
    pool_pod_uid: z.uuid(),
    container_ids: z.array(Hash).min(1).max(8),
    postgres_image_sha256: Hash,
    supervisor_sha256: Hash,
    issued_at: Safe,
    expires_at: Safe,
    readonly: z.literal(true),
    noload: z.literal(true),
  })
  .superRefine((v, ctx) => {
    if (
      v.expires_at <= v.issued_at ||
      v.expires_at > v.issued_at + 30000 ||
      new Set(v.container_ids).size !== v.container_ids.length ||
      v.storage.profile.node_uid !== v.node_uid
    )
      ctx.addIssue({
        code: "custom",
        message: "Readonly inspection requires finite exact node/Pod custody",
      });
  });
export type PoolStorageReadSignal = z.infer<typeof PoolStorageReadSignal>;
/** The full context is hashed to signed pq1 preparation_sha256, then selected custody is matched. */
export const PoolStorageReadRequest = z
  .strictObject({
    signal: PoolStorageReadSignal,
    preparation: PoolPodPreparationContext,
  })
  .superRefine((request, ctx) => {
    const v = request.signal,
      p = request.preparation,
      pod = p.pods.find((pod) => pod.pod_uid === v.pool_pod_uid);
    if (
      !pod ||
      p.node_uid !== v.node_uid ||
      p.boot_id !== v.boot_id ||
      p.pool_namespace_uid !== v.pool_namespace_uid ||
      p.qualification_run_id !== v.qualification_run_id ||
      p.qualification_scope_sha256 !== v.qualification_scope_sha256 ||
      p.policy.class.postgres_image_sha256 !== v.postgres_image_sha256 ||
      p.policy.supervisor_sha256 !== v.supervisor_sha256 ||
      v.expires_at > p.expires_at ||
      JSON.stringify([...pod.container_ids].sort()) !==
        JSON.stringify([...v.container_ids].sort())
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Selected inspector must belong to the signed full preparation context",
      });
  });
export type PoolStorageReadRequest = z.infer<typeof PoolStorageReadRequest>;
/** Measured fixed-tool output; read alone does not certify clean shutdown or a release. */
export const PoolStorageReadReport = z
  .strictObject({
    v: z.literal(1),
    command: z.literal("inspect_readonly"),
    qualification_run_id: z.uuid(),
    qualification_scope_sha256: Hash,
    preparation_sha256: Hash,
    nonce: z.string().regex(/^[a-f0-9]{32}$/),
    database_id: DatabaseId,
    source_generation: Revision,
    node_uid: z.uuid(),
    boot_id: z.uuid(),
    pool_pod_uid: z.uuid(),
    postgres_image_sha256: Hash,
    device_major: Safe.nullable(),
    device_minor: Safe.nullable(),
    state: z.enum(["read", "refused", "failed"]),
    system_identifier: z
      .string()
      .regex(/^[0-9]{1,20}$/)
      .nullable(),
    timeline: Revision.nullable(),
    control_state: z.string().min(1).max(128).nullable(),
    observed_at: Safe,
    error: z.string().min(1).max(512).nullable(),
  })
  .refine(
    (v) =>
      v.state !== "read" ||
      (v.system_identifier !== null &&
        v.timeline !== null &&
        v.control_state !== null &&
        v.device_major !== null &&
        v.device_minor !== null &&
        v.error === null),
    {
      message:
        "Successful fixed inspection must carry actual pg_control and device measurements",
    },
  );
export type PoolStorageReadReport = z.infer<typeof PoolStorageReadReport>;
export const PoolThinGuardProof = z.strictObject({
  authority_token: z.string().min(1).max(4096),
  authority_revision: Revision,
  expires_at: Safe,
  protect_on_expiry_armed: z.literal(true),
  shared_pod_io: PoolSharedPodIo,
  cgroups: z.array(PoolIoCgroup).min(1).max(8),
});
/** Historical pregrant custody, independently joined to the exact retained CF grant.
 * Reaped references and global absence prove release, never a clean PostgreSQL shutdown. */
export const PoolReferenceDestruction = z.strictObject({
  v: z.literal(1),
  operation_id: OperationId,
  authority_revision: Revision,
  cleanup_io_sha256: Hash,
  cleanup_mode: z.literal("drain_unmount"),
  dispatch_persisted: z.literal(true),
  worker: PoolCleanupIoAttestation.shape.worker,
  worker_reaped: z.literal(true),
  stopped_writers: PoolCleanupIoAttestation.shape.stopped_writers,
});
export type PoolReferenceDestruction = z.infer<typeof PoolReferenceDestruction>;
export const PoolNodeReport = z
  .strictObject({
    v: z.literal(1),
    binding_id: z.uuid(),
    scope_sha256: Hash,
    node_uid: z.uuid(),
    boot_id: z.uuid(),
    pool_pod_uid: z.uuid(),
    state: z.enum([
      "accepted",
      "mounted",
      "failed",
      "released",
      "refused",
      "lost",
    ]),
    observed_at: Safe,
    storage_backend: z.enum(["lvm-thick-v1", "lvm-thin-v1"]),
    thin_guard: PoolThinGuardProof.nullable(),
    boot_loss: z
      .strictObject({ holder_boot_id: z.uuid(), storage: PoolPhysicalStorage })
      .optional(),
    reference_destruction: PoolReferenceDestruction.optional(),
    kernel_proof: PoolKernelProof,
    clean_stop: z.boolean().nullable(),
    error: z.string().min(1).max(512).nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      value.reference_destruction &&
      (value.boot_loss !== undefined ||
        value.state !== "released" ||
        value.storage_backend !== "lvm-thin-v1" ||
        value.clean_stop !== false ||
        value.thin_guard !== null ||
        value.kernel_proof.nonlazy_unmount_verified ||
        value.kernel_proof.creator_fence === null ||
        value.kernel_proof.creator_fence.scope_sha256 !== value.scope_sha256 ||
        value.reference_destruction.worker.pool_pod_uid !==
          value.pool_pod_uid ||
        value.reference_destruction.worker.device_major !==
          value.kernel_proof.device_major ||
        value.reference_destruction.worker.device_minor !==
          value.kernel_proof.device_minor ||
        new Set(
          value.reference_destruction.stopped_writers.map(
            (w) => w.container_id,
          ),
        ).size !== value.reference_destruction.stopped_writers.length ||
        !value.reference_destruction.stopped_writers.some(
          (w) =>
            w.container_id ===
              value.reference_destruction!.worker.container_id &&
            w.cgroup_inode === value.reference_destruction!.worker.cgroup_inode,
        ))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Reference destruction requires exact reaped cleanup custody and same-boot protected absence, never clean sleep",
      });
    if (
      value.boot_loss &&
      (value.state !== "released" ||
        value.clean_stop !== false ||
        value.thin_guard !== null ||
        value.boot_loss.holder_boot_id === value.boot_id ||
        value.kernel_proof.creator_fence === null ||
        value.kernel_proof.creator_fence.scope_sha256 !== value.scope_sha256)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Post-boot loss permits only protected physical absence, never clean sleep",
      });
    if (
      value.state === "mounted" &&
      value.storage_backend === "lvm-thin-v1" &&
      (value.thin_guard === null ||
        value.thin_guard.expires_at <= value.observed_at)
    )
      ctx.addIssue({
        code: "custom",
        message: "Thin mounts require a fresh bounded write guard",
      });
    if (
      value.thin_guard &&
      new Set(value.thin_guard.cgroups.map((c) => c.container_id)).size !==
        value.thin_guard.cgroups.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate thin writer cgroup" });
    if (
      value.state === "mounted" &&
      (value.kernel_proof.mount_id === null ||
        value.kernel_proof.foreign_mounts !== 0 ||
        !value.kernel_proof.named_namespace_scan_complete ||
        !value.kernel_proof.zero_before_bind ||
        !value.kernel_proof.exclusive_superblock_creation ||
        value.kernel_proof.creator_fence === null ||
        value.kernel_proof.mountpoint === null ||
        value.kernel_proof.creator_fence.scope_sha256 !== value.scope_sha256 ||
        value.kernel_proof.mountpoint.pool_pod_uid !== value.pool_pod_uid)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Mounted proof requires the actual mount and no foreign mounts",
      });
    if (
      ["released", "refused"].includes(value.state) &&
      (value.kernel_proof.mount_id !== null ||
        value.kernel_proof.dm_open_count !== 0 ||
        value.kernel_proof.foreign_mounts !== 0 ||
        !value.kernel_proof.named_namespace_scan_complete ||
        (value.kernel_proof.creator_fence !== null &&
          !value.kernel_proof.creator_fence.creation_fds_closed) ||
        (value.state === "released" &&
          value.boot_loss === undefined &&
          value.reference_destruction === undefined &&
          !value.kernel_proof.nonlazy_unmount_verified) ||
        (value.state === "refused" &&
          !value.kernel_proof.nonlazy_unmount_verified &&
          !value.kernel_proof.never_attached_verified))
    )
      ctx.addIssue({
        code: "custom",
        message: "Terminal proof must prove no surviving volume holder",
      });
  });
export type PoolNodeReport = z.infer<typeof PoolNodeReport>;
export const PoolStorageObservation = z.strictObject({
  v: z.literal(1),
  database_id: DatabaseId,
  generation: Revision,
  node_uid: z.uuid(),
  boot_id: z.uuid(),
  storage: PoolPhysicalStorage,
  kernel_proof: PoolKernelProof,
  observed_at: Safe,
});
export type PoolStorageObservation = z.infer<typeof PoolStorageObservation>;
export const PoolSleepRecord = z.strictObject({
  v: z.literal(1),
  database_id: DatabaseId,
  generation: Revision,
  node_uid: z.uuid(),
  boot_id: z.uuid(),
  configuration_fingerprint: Hash,
  class: PostgresPoolClass,
  storage: PoolPhysicalStorage,
  system_identifier: z.string().regex(/^[1-9][0-9]{0,19}$/),
  timeline: Revision.max(4294967295),
  clean_stop: z.literal(true),
  hibernation_on: z.literal(true),
  instance_pods_absent: z.literal(true),
  primary_lease_empty: z.literal(true),
  observed_at: Safe,
});
export type PoolSleepRecord = z.infer<typeof PoolSleepRecord>;
export const PoolArchiverCommand = z.discriminatedUnion("command", [
  z.strictObject({
    v: z.literal(1),
    command: z.literal("configure"),
    binding_id: z.uuid(),
    scope_sha256: Hash,
    bundle_nonce: z.uuid(),
    archive: PoolArchiveConfiguration,
  }),
  z.strictObject({
    v: z.literal(1),
    command: z.literal("wal_archive"),
    binding_id: z.uuid(),
    scope_sha256: Hash,
    bundle_nonce: z.uuid(),
    wal_name: z
      .string()
      .regex(
        /^(?:[0-9A-F]{24}(?:\.partial|\.[0-9A-F]{8}\.backup)?|[0-9A-F]{8}\.history)$/,
      ),
  }),
  z.strictObject({
    v: z.literal(1),
    command: z.literal("backup"),
    binding_id: z.uuid(),
    scope_sha256: Hash,
    bundle_nonce: z.uuid(),
    backup_name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/),
  }),
]);
export const PoolBackupReport = z.strictObject({
  v: z.literal(1),
  binding_id: z.uuid(),
  scope_sha256: Hash,
  bundle_nonce: z.uuid(),
  backup_name: z.string().min(1).max(128),
  state: z.literal("DONE"),
  completed_at: z.iso.datetime(),
  catalog_sha256: Hash,
  bytes: Safe.nullable(),
});
export const PoolControlRequest = z.strictObject({
  v: z.literal(1),
  binding_id: z.uuid(),
  scope_sha256: Hash,
  bundle_nonce: z.uuid(),
});
export const PoolBackupRequest = PoolControlRequest.extend({
  backup_name: PoolArchiverCommand.options[2].shape.backup_name,
});
export const PoolBindingSnapshot = z.strictObject({
  v: z.literal(1),
  revision: Safe,
  node_id: NodeId,
  node_uid: z.uuid(),
  boot_id: z.uuid(),
  issued_at: Safe,
  expires_at: Safe,
  bindings: z.array(DesiredPoolBinding).max(POSTGRES_POOL.max_inventory),
});
export const PoolBindingDetails = z.strictObject({
  binding: DesiredPoolBinding,
  pod_attestation: PoolPodAttestation,
  node_report: PoolNodeReport.nullable(),
  io_attestation: PoolIoAttestation.nullable(),
  supervisor_report: PoolSupervisorReport.nullable(),
});
export type PoolBindingDetails = z.infer<typeof PoolBindingDetails>;

/** Lexicographic recursive key order, shared with serde_json's ordered map representation. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export async function poolPreparationContextHash(
  context: PoolPodPreparationContext,
): Promise<string> {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify(canonical(PoolPodPreparationContext.parse(context))),
        ),
      ),
    ),
  );
}
export async function poolCleanupIoAttestationHash(
  value: PoolCleanupIoAttestation,
): Promise<string> {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify(canonical(PoolCleanupIoAttestation.parse(value))),
        ),
      ),
    ),
  );
}
export function canonicalPoolBindingScope(scope: PoolBindingScope): string {
  return JSON.stringify(canonical(PoolBindingScope.parse(scope)));
}
export async function poolBindingScopeHash(
  scope: PoolBindingScope,
): Promise<string> {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonicalPoolBindingScope(scope)),
      ),
    ),
  );
}
export function poolBindClaimsValidAt(
  value: PoolBindClaims,
  now: number,
): boolean {
  return (
    Number.isSafeInteger(now) &&
    now >= 0 &&
    value.iat <= now + POSTGRES_POOL.clock_skew_ms &&
    value.exp > now &&
    value.exp > value.iat &&
    value.exp <= value.iat + POSTGRES_POOL.permission_ms
  );
}
export async function signPoolBindPermission(
  value: PoolBindClaims,
  key: StorageAuthorityCryptoKey,
  now = Date.now(),
): Promise<string> {
  const claims = PoolBindClaims.parse(value);
  if (
    key.type !== "private" ||
    key.algorithm.name !== "Ed25519" ||
    !poolBindClaimsValidAt(claims, now) ||
    claims.scope_sha256 !== (await poolBindingScopeHash(claims.scope))
  )
    throw new Error("invalid_pool_bind_permission");
  const payload = bytesToBase64url(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      key,
      new TextEncoder().encode(POSTGRES_POOL.bind_domain + payload),
    ),
  );
  const token = `${POSTGRES_POOL.bind_prefix}.${payload}.${bytesToBase64url(signature)}`;
  if (token.length > POSTGRES_POOL.bind_max_length)
    throw new Error("pool_bind_permission_too_large");
  return token;
}
export async function verifyPoolBindPermission(
  token: string,
  keys: ReadonlyMap<string, StorageAuthorityCryptoKey>,
  now = Date.now(),
): Promise<PoolBindClaims | null> {
  if (token.length > POSTGRES_POOL.bind_max_length) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== POSTGRES_POOL.bind_prefix) return null;
  const body = base64urlToBytes(parts[1]!),
    signature = base64urlToBytes(parts[2]!);
  if (
    !body ||
    !signature ||
    signature.length !== 64 ||
    bytesToBase64url(body) !== parts[1] ||
    bytesToBase64url(signature) !== parts[2]
  )
    return null;
  try {
    const parsed = PoolBindClaims.safeParse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          body,
        ),
      ),
    );
    if (
      !parsed.success ||
      !poolBindClaimsValidAt(parsed.data, now) ||
      parsed.data.scope_sha256 !==
        (await poolBindingScopeHash(parsed.data.scope))
    )
      return null;
    const key = keys.get(parsed.data.kid);
    if (
      !key ||
      key.type !== "public" ||
      key.algorithm.name !== "Ed25519" ||
      !(await crypto.subtle.verify(
        "Ed25519",
        key,
        new Uint8Array(signature).buffer,
        new TextEncoder().encode(POSTGRES_POOL.bind_domain + parts[1]),
      ))
    )
      return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export async function postgresPoolClassFromDesired(input: {
  postgres?: { image: string; configuration_schema_revision?: number };
  size: {
    memory_mib: number;
    memory_request_mib?: number;
    cpu_millicores: number;
    cpu_request_millicores?: number;
    max_connections: number;
    archive_timeout_seconds: number;
    backup_retention_days: number;
  };
}): Promise<PostgresPoolClass> {
  const digest = input.postgres?.image.match(/@sha256:([a-f0-9]{64})$/)?.[1];
  if (!digest) throw new Error("pool_postgres_pin_missing");
  const geometry = {
    postgres_image_sha256: digest,
    cpu_request_millicores:
      input.size.cpu_request_millicores ?? input.size.cpu_millicores,
    cpu_limit_millicores: input.size.cpu_millicores,
    memory_request_bytes:
      (input.size.memory_request_mib ?? input.size.memory_mib) * 1024 ** 2,
    memory_limit_bytes: input.size.memory_mib * 1024 ** 2,
  };
  const profile = {
    ...geometry,
    configuration_schema_revision:
      input.postgres?.configuration_schema_revision ?? 1,
    max_connections: input.size.max_connections,
    archive_timeout_seconds: input.size.archive_timeout_seconds,
    backup_retention_days: input.size.backup_retention_days,
  };
  const configuration_profile_sha256 = bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(canonical(profile))),
      ),
    ),
  );
  return PostgresPoolClass.parse({ ...geometry, configuration_profile_sha256 });
}
