// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { bytesToHex, bytesToBase64url, base64urlToBytes } from "./encoding.ts";
import {
  STORAGE_AUTHORITY_KEY_ID_PATTERN,
  type StorageAuthorityCryptoKey,
} from "./storage-write-authority.ts";
import { DatabaseId, NodeId, RegionId } from "./ids.ts";
import { FleetReleaseId, PostgresPoolQualification } from "./releases.ts";
import {
  PostgresPoolPolicyState,
  PoolStorageReadReport,
  PoolStorageObservation,
  PoolSleepRecord,
} from "./postgres-pool.ts";
import {
  DatabaseStorageVolumeReceipt,
  DesiredDatabaseStorage,
} from "./database-storage.ts";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Image = z
  .string()
  .max(512)
  .regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/);

/** Derived by Cloudflare from the current physical receipt and immutable candidate.
 * This describes a test boundary, never a completed qualification or write permission. */
export const PostgresPoolQualificationScope = z
  .strictObject({
    version: z.literal(1),
    run_id: z.uuid(),
    region_id: RegionId,
    node_id: NodeId,
    node_uid: z.uuid(),
    boot_id: z.uuid(),
    cluster_uid: z.uuid(),
    database_id: DatabaseId,
    /** The one target wake generation; preparation leaves the sleeping source at this minus one. */
    database_generation: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    configuration_fingerprint: Hash,
    candidate_release_id: FleetReleaseId,
    candidate_spec_sha256: Hash,
    storage: DesiredDatabaseStorage,
    volume: DatabaseStorageVolumeReceipt,
    // Pinned Linux v6.18.54 drivers/md/dm-thin.c: MAX_DEV_ID is 24 bits.
    thin_id: z.number().int().nonnegative().max(16_777_215),
    software: z.strictObject({
      driver_image: Image,
      driver_sha256: Hash,
      supervisor_image: Image,
      supervisor_sha256: Hash,
      postgres_image: Image,
      archiver_image: Image,
      host_extension_image: Image,
      host_controller_sha256: Hash,
      kernel_version: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-zA-Z0-9._+-]+$/),
    }),
  })
  .superRefine((scope, context) => {
    if (
      scope.storage.node_uid !== scope.node_uid ||
      scope.volume.node_uid !== scope.node_uid ||
      scope.storage.volume_group_uuid !== scope.volume.volume_group_uuid ||
      scope.storage.pool_uuid !== scope.volume.pool_uuid ||
      scope.volume.volume_handle !== `pvc-${scope.volume.pvc_uid}`
    )
      context.addIssue({
        code: "custom",
        message: "Qualification must retain one exact thin volume and node",
      });
  });
export type PostgresPoolQualificationScope = z.infer<
  typeof PostgresPoolQualificationScope
>;

/** The request identifies existing objects. It cannot supply claims that a gate passed. */
export const PostgresPoolQualificationRequest = z.strictObject({
  candidate_release_id: FleetReleaseId,
  node_uid: z.uuid(),
  database_id: DatabaseId,
  expected_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type PostgresPoolQualificationRequest = z.infer<
  typeof PostgresPoolQualificationRequest
>;

const Counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Positive = Counter.positive();
/** Fixed, disposable ordinary-data experiment; these limits never bound metadata/swap BIOs. */
export const POOL_QUALIFICATION_ORDINARY_IO = {
  purpose: "ordinary_direct_data_effectiveness",
  scratch_name_prefix: ".pgcf-q-io-",
  maximum_file_bytes: 67_108_864,
  block_bytes: 4096,
  writer_count: 2,
  // Linux v6.18.54 blk-throttle.c DFL_THROTL_SLICE is HZ/10.
  throttle_slice_milliseconds: 100,
  // Chosen experiment thresholds, not a kernel bandwidth or all-BIO guarantee.
  minimum_slices: 20,
  minimum_slowdown_factor: 2,
} as const;
const IoCounters = z.strictObject({ wbytes: Counter, wios: Counter });
const IoLimits = z.strictObject({
  write_bytes_per_second: Positive.nullable(),
  write_iops_per_second: Positive.nullable(),
});
const IoWorker = z.strictObject({
  pid: Positive.max(2147483647),
  start_ticks: Positive,
  pid_namespace: Positive,
  cgroup_inode: Positive,
});
const IoPhase = z.strictObject({
  start_offset_nanoseconds: Counter,
  end_offset_nanoseconds: Positive,
  scratch_file_inode: Positive,
  limits_before: IoLimits,
  limits_after: IoLimits,
  ancestor_before: IoCounters,
  ancestor_after: IoCounters,
  writers: z
    .array(
      z.strictObject({
        ...IoWorker.shape,
        before: IoCounters,
        after: IoCounters,
        completed_bytes: Counter,
        /** Actual pwrite and fsync completion; an unknown/failed completion never passes. */
        completion_errno: Counter.max(4095),
      }),
    )
    .length(POOL_QUALIFICATION_ORDINARY_IO.writer_count),
});
export const PostgresPoolQualificationOrdinaryIo = z.strictObject({
  purpose: z.literal(POOL_QUALIFICATION_ORDINARY_IO.purpose),
  volume_handle: z.string().regex(/^pvc-[a-f0-9-]{36}$/),
  /** Created exclusively at the mounted volume root, outside its pgdata subdirectory. */
  scratch_relative_name: z.string().regex(/^\.pgcf-q-io-[a-f0-9-]{36}\.bin$/),
  scratch_file_inode: Positive,
  scratch_file_bytes: Positive.max(
    POOL_QUALIFICATION_ORDINARY_IO.maximum_file_bytes,
  ),
  device_major: Counter,
  device_minor: Counter,
  dedicated_group_inode: Positive,
  inherited_limits_before: z
    .array(z.strictObject({ cgroup_inode: Positive, ...IoLimits.shape }))
    .min(1)
    .max(32),
  inherited_limits_after: z
    .array(z.strictObject({ cgroup_inode: Positive, ...IoLimits.shape }))
    .min(1)
    .max(32),
  workers: z
    .array(
      z.strictObject({
        ...IoWorker.shape,
        work_bytes: Positive,
        block_bytes: z.literal(POOL_QUALIFICATION_ORDINARY_IO.block_bytes),
      }),
    )
    .length(POOL_QUALIFICATION_ORDINARY_IO.writer_count),
  baseline: IoPhase,
  capped: IoPhase,
  unlink_errno: Counter.max(4095),
  remaining_probe_processes: Counter,
  remaining_probe_descriptors: Counter,
  group_remove_errno: Counter.max(4095),
});
export type PostgresPoolQualificationOrdinaryIo = z.infer<
  typeof PostgresPoolQualificationOrdinaryIo
>;
const { nonce: consumedNonce, ...readFields } = PoolStorageReadReport.shape;
void consumedNonce;
export const PostgresPoolQualificationRead = z
  .strictObject({ ...readFields, nonce_sha256: Hash })
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
        "Successful inspection requires actual control and device measurements",
    },
  );
export const POSTGRES_POOL_QUALIFICATION_GATES = [
  "host_mount_context",
  "finite_creator_fence",
  "single_writer",
  "mount_propagation",
  "thin_write_authority",
  "thin_io_limits",
  "wal_archive",
  "base_backup",
  "thin_expiry_protection",
  "clean_stop",
] as const;
export const PostgresPoolQualificationGate = z.enum(
  POSTGRES_POOL_QUALIFICATION_GATES,
);
export type PostgresPoolQualificationGate = z.infer<
  typeof PostgresPoolQualificationGate
>;

const Binding = { binding_id: z.uuid() };
/** These are measurements, not gate decisions. Cloudflare checks their values and their
 * current, independently reported holder scope before accepting a gate. */
const MeasuredQualification = z.discriminatedUnion("gate", [
  z.strictObject({
    gate: z.literal("host_mount_context"),
    kernel_version: z.string().min(1).max(128),
    caller_pid_namespace_inode: Positive,
    initial_pid_namespace_inode: Positive,
    caller_user_namespace_inode: Positive,
    initial_user_namespace_inode: Positive,
    next_namespace_errno: Counter.max(4095),
    storage_read: PostgresPoolQualificationRead,
    storage_observation: PoolStorageObservation,
  }),
  z.strictObject({
    gate: z.literal("finite_creator_fence"),
    binding_id: z.uuid().nullable(),
    source_generation: Positive,
    volume_handle: z.string().regex(/^pvc-[a-f0-9-]{36}$/),
    driver_sha256: Hash,
    deny_record_inode_before_restart: Positive,
    deny_record_inode_after_restart: Positive,
    deny_record_sha256_before_restart: Hash,
    deny_record_sha256_after_restart: Hash,
    deny_record_scope_sha256: Hash,
    deny_record_fsync_errno: Counter.max(4095),
    driver_restarts: Positive,
    driver_pod_uid_before_restart: z.uuid(),
    driver_pod_uid_after_restart: z.uuid(),
    driver_daemonset_uid: z.uuid(),
    driver_image: Image,
    driver_deleted_at: Counter,
    driver_replacement_ready_at: Counter,
    agent_owner_deaths: Positive,
    before_claim_requests_completed: Positive,
    denied_operations: z
      .array(
        z.discriminatedUnion("operation", [
          z.strictObject({
            operation: z.literal("node_publish"),
            grpc_status: Counter.max(16),
            message: z.literal("pool_creator_fence_denied"),
          }),
          z.strictObject({
            operation: z.literal("node_expand"),
            grpc_status: Counter.max(16),
            message: z.literal("pool_creator_fence_denied"),
          }),
          z.strictObject({
            // The pinned syncVol guard runs before its Ready/Pending branches.
            operation: z.literal("volume_reconcile"),
            error: z.literal("pool_creator_fence_denied"),
          }),
          z.strictObject({
            operation: z.literal("snapshot_create"),
            error: z.literal("pool_creator_fence_denied"),
            snapshot_uid: z.uuid(),
            source_volume_handle: z.string().regex(/^pvc-[a-f0-9-]{36}$/),
            state_at_denial: z.literal("Pending"),
            requested_at: Counter,
            deleted_at: Counter,
            absent_at: Counter,
          }),
        ]),
      )
      .max(4),
    surviving_creation_descriptors: Counter,
    final_dm_open_count: Counter,
    /** Actual node read after the controller's recorded snapshot absence. */
    physical_snapshot_count: Counter,
    physical_observed_at: Counter,
    progress_sha256: Hash,
    device_major: Counter,
    device_minor: Counter,
  }),
  z.strictObject({
    gate: z.literal("single_writer"),
    ...Binding,
    before_dm_open_count: Counter,
    mounted_dm_open_count: Positive,
    foreign_mounts: Counter,
    named_namespace_scan_errno: Counter.max(4095),
    namespaces_inspected: Positive,
    exclusive_create_errno: Counter.max(4095),
    unexpected_writer_processes: Counter,
  }),
  z.strictObject({
    gate: z.literal("mount_propagation"),
    ...Binding,
    device_major: Counter,
    device_minor: Counter,
    contexts: z
      .array(
        z.strictObject({
          kind: z.enum(["node_agent", "kubelet", "supervisor", "archiver"]),
          namespace_inode: Positive,
          mount_id: Positive,
          device_major: Counter,
          device_minor: Counter,
          filesystem: z.string().min(1).max(32),
        }),
      )
      .max(4),
  }),
  z.strictObject({
    gate: z.literal("thin_write_authority"),
    ...Binding,
    authority_revision: Positive,
    authority_sha256: Hash,
    issued_at: Counter,
    expires_at: Positive,
    renewed_at: Counter,
  }),
  z.strictObject({
    gate: z.literal("thin_io_limits"),
    ...Binding,
    device_major: Counter,
    device_minor: Counter,
    ordinary_direct_io: PostgresPoolQualificationOrdinaryIo,
    writer_cgroups: z
      .array(
        z.strictObject({
          container_id: Hash,
          cgroup_inode: Positive,
          pid: Positive.max(2147483647),
          start_ticks: Positive,
          pid_namespace: Positive,
          device_major: Counter,
          device_minor: Counter,
          write_bytes_per_second: Positive,
          write_iops_per_second: Positive,
        }),
      )
      .min(1)
      .max(8),
  }),
  z.strictObject({
    gate: z.literal("wal_archive"),
    ...Binding,
    system_identifier: z.string().regex(/^[1-9][0-9]{0,19}$/),
    timeline: Positive.max(4294967295),
    wal_segment: z.string().regex(/^[0-9A-F]{24}$/),
    archive_exit_code: Counter.max(255),
    archive_done_at: Counter,
    object_received_at: Counter,
    uncompressed_bytes: Positive,
    local_sha256: Hash,
    archived_sha256: Hash,
  }),
  z.strictObject({
    gate: z.literal("base_backup"),
    ...Binding,
    system_identifier: z.string().regex(/^[1-9][0-9]{0,19}$/),
    timeline: Positive.max(4294967295),
    backup_id: z.string().regex(/^[0-9]{8}T[0-9]{6}$/),
    catalog_state: z.enum(["DONE", "FAILED", "STARTED"]),
    completed_at: Counter,
    catalog_sha256: Hash,
    bytes: Positive.nullable(),
  }),
  z.strictObject({
    gate: z.literal("thin_expiry_protection"),
    ...Binding,
    authority_expires_at: Counter,
    protection_requested_at: Counter,
    drained_at: Counter,
    postmaster_pid: Positive.nullable(),
    device_state: z.enum(["active", "suspended", "unknown"]),
    sectors_written_before: Counter,
    sectors_written_after: Counter,
    allocated_blocks_before: Counter,
    allocated_blocks_after: Counter,
  }),
  z.strictObject({
    gate: z.literal("clean_stop"),
    ...Binding,
    system_identifier: z.string().regex(/^[1-9][0-9]{0,19}$/),
    timeline: Positive.max(4294967295),
    control_state: z.enum(["in production", "shut down", "unclean"]),
    postmaster_pid: Positive.nullable(),
    remaining_writer_processes: Counter,
    stop_exit_code: Counter.max(255),
  }),
  z.strictObject({
    gate: z.literal("cleanup"),
    binding_id: z.uuid().nullable(),
    storage: DatabaseStorageVolumeReceipt,
    remaining_pool_pods: Counter,
    remaining_instance_pods: Counter,
    remaining_primary_lease_holders: Counter,
    cnpg_hibernation: z.enum(["on", "off", "unknown"]),
    remaining_creation_descriptors: Counter,
    dm_open_count: Counter,
    foreign_mounts: Counter,
    named_namespace_scan_errno: Counter.max(4095),
    deny_record: z.enum(["absent", "present", "unknown"]),
    unmount_errno: Counter.max(4095).nullable(),
  }),
]);
/** A failed read/action has no successful facts to invent. Cleanup still needs
 * actual release measurements; these finite codes never count as a passed gate. */
export const PostgresPoolQualificationFailure = z.strictObject({
  gate: z.enum([...POSTGRES_POOL_QUALIFICATION_GATES, "cleanup"]),
  failure_code: z.enum([
    "measurement_unavailable",
    "execution_failed",
    "deadline_elapsed",
  ]),
});
export const PostgresPoolQualificationMeasurement = z.union([
  MeasuredQualification,
  PostgresPoolQualificationFailure,
]);
export type PostgresPoolQualificationMeasurement = z.infer<
  typeof PostgresPoolQualificationMeasurement
>;

/** A paired observation of this fixed direct-data workload, never an all-BIO allocation bound. */
export function postgresPoolQualificationOrdinaryIoPassed(
  scope: PostgresPoolQualificationScope,
  io: PostgresPoolQualificationOrdinaryIo,
): boolean {
  const sameLimits = (
      a: z.infer<typeof IoLimits>,
      b: z.infer<typeof IoLimits>,
    ) =>
      a.write_bytes_per_second === b.write_bytes_per_second &&
      a.write_iops_per_second === b.write_iops_per_second,
    sameWorker = (a: z.infer<typeof IoWorker>, b: z.infer<typeof IoWorker>) =>
      a.pid === b.pid &&
      a.start_ticks === b.start_ticks &&
      a.pid_namespace === b.pid_namespace &&
      a.cgroup_inode === b.cgroup_inode,
    b = io.baseline,
    c = io.capped,
    cappedLimits = c.limits_before,
    baselineElapsed = b.end_offset_nanoseconds - b.start_offset_nanoseconds,
    cappedElapsed = c.end_offset_nanoseconds - c.start_offset_nanoseconds,
    minimumElapsed =
      POOL_QUALIFICATION_ORDINARY_IO.throttle_slice_milliseconds *
      POOL_QUALIFICATION_ORDINARY_IO.minimum_slices *
      1_000_000;
  if (
    io.volume_handle !== scope.volume.volume_handle ||
    io.scratch_relative_name !==
      `${POOL_QUALIFICATION_ORDINARY_IO.scratch_name_prefix}${scope.run_id}.bin` ||
    io.unlink_errno !== 0 ||
    io.remaining_probe_processes !== 0 ||
    io.remaining_probe_descriptors !== 0 ||
    io.group_remove_errno !== 0 ||
    io.workers.reduce((n, w) => n + w.work_bytes, 0) !==
      io.scratch_file_bytes ||
    io.workers.some((w) => w.work_bytes % w.block_bytes !== 0) ||
    new Set(io.workers.map((w) => w.pid)).size !== io.workers.length ||
    new Set([
      io.dedicated_group_inode,
      ...io.workers.map((w) => w.cgroup_inode),
      ...io.inherited_limits_before.map((l) => l.cgroup_inode),
    ]).size !==
      1 + io.workers.length + io.inherited_limits_before.length ||
    io.inherited_limits_before.length !== io.inherited_limits_after.length ||
    io.inherited_limits_before.some(
      (l, i) =>
        l.cgroup_inode !== io.inherited_limits_after[i]!.cgroup_inode ||
        !sameLimits(l, io.inherited_limits_after[i]!),
    ) ||
    b.limits_before.write_bytes_per_second !== null ||
    b.limits_before.write_iops_per_second !== null ||
    !sameLimits(b.limits_before, b.limits_after) ||
    !sameLimits(c.limits_before, c.limits_after) ||
    cappedLimits.write_bytes_per_second === null ||
    cappedLimits.write_iops_per_second === null ||
    cappedLimits.write_bytes_per_second >=
      scope.storage.write_bytes_per_second ||
    cappedLimits.write_iops_per_second >= scope.storage.write_iops_per_second ||
    io.inherited_limits_before.some(
      (l) =>
        (l.write_bytes_per_second !== null &&
          cappedLimits.write_bytes_per_second! >= l.write_bytes_per_second) ||
        (l.write_iops_per_second !== null &&
          cappedLimits.write_iops_per_second! >= l.write_iops_per_second),
    ) ||
    b.end_offset_nanoseconds <= b.start_offset_nanoseconds ||
    c.end_offset_nanoseconds <= c.start_offset_nanoseconds ||
    c.start_offset_nanoseconds < b.end_offset_nanoseconds ||
    c.end_offset_nanoseconds >
      POOL_QUALIFICATION_PERMISSION.maximum_milliseconds * 1_000_000 ||
    // Twenty nominal slices of requested direct-data work and observed time
    // avoid a short transient; the twofold slowdown tests material effectiveness.
    cappedElapsed < minimumElapsed ||
    BigInt(io.scratch_file_bytes) * 1_000_000_000n <
      BigInt(cappedLimits.write_bytes_per_second) * BigInt(minimumElapsed) ||
    BigInt(cappedElapsed) <
      BigInt(baselineElapsed) *
        BigInt(POOL_QUALIFICATION_ORDINARY_IO.minimum_slowdown_factor)
  )
    return false;
  for (const phase of [b, c]) {
    if (
      phase.scratch_file_inode !== io.scratch_file_inode ||
      phase.ancestor_after.wbytes <= phase.ancestor_before.wbytes ||
      phase.ancestor_after.wios <= phase.ancestor_before.wios ||
      phase.writers.some(
        (w, i) =>
          !sameWorker(w, io.workers[i]!) ||
          w.completed_bytes !== io.workers[i]!.work_bytes ||
          w.completion_errno !== 0 ||
          w.after.wbytes - w.before.wbytes < w.completed_bytes ||
          w.after.wios <= w.before.wios,
      ) ||
      BigInt(phase.ancestor_after.wbytes - phase.ancestor_before.wbytes) <
        phase.writers.reduce(
          (n, w) => n + BigInt(w.after.wbytes - w.before.wbytes),
          0n,
        ) ||
      BigInt(phase.ancestor_after.wios - phase.ancestor_before.wios) <
        phase.writers.reduce(
          (n, w) => n + BigInt(w.after.wios - w.before.wios),
          0n,
        )
    )
      return false;
  }
  return true;
}

export function postgresPoolQualificationGatePassed(
  scope: PostgresPoolQualificationScope,
  raw: PostgresPoolQualificationMeasurement,
): boolean {
  const m = PostgresPoolQualificationMeasurement.parse(raw);
  if ("failure_code" in m) return false;
  switch (m.gate) {
    case "host_mount_context":
      return (
        m.kernel_version === scope.software.kernel_version &&
        // Pinned Linux6.18.54 include/linux/proc_ns.h initial namespace inodes.
        m.initial_pid_namespace_inode === 0xeffffffc &&
        m.initial_user_namespace_inode === 0xeffffffd &&
        m.caller_pid_namespace_inode === m.initial_pid_namespace_inode &&
        m.caller_user_namespace_inode === m.initial_user_namespace_inode &&
        [0, 2].includes(m.next_namespace_errno) &&
        m.storage_read.state === "read" &&
        m.storage_read.control_state === "shut down" &&
        m.storage_read.source_generation === scope.database_generation - 1 &&
        m.storage_read.node_uid === scope.node_uid &&
        m.storage_read.boot_id === scope.boot_id &&
        m.storage_read.postgres_image_sha256 ===
          scope.software.postgres_image.split("@sha256:")[1] &&
        m.storage_observation.database_id === scope.database_id &&
        m.storage_observation.generation === scope.database_generation - 1 &&
        m.storage_observation.node_uid === scope.node_uid &&
        m.storage_observation.boot_id === scope.boot_id &&
        m.storage_read.observed_at <= m.storage_observation.observed_at &&
        m.storage_observation.kernel_proof.dm_open_count === 0 &&
        m.storage_observation.kernel_proof.foreign_mounts === 0 &&
        m.storage_observation.kernel_proof.named_namespace_scan_complete &&
        m.storage_observation.kernel_proof.mount_id === null
      );
    case "finite_creator_fence":
      return (
        m.binding_id === null &&
        m.source_generation === scope.database_generation - 1 &&
        m.volume_handle === scope.volume.volume_handle &&
        m.driver_sha256 === scope.software.driver_sha256 &&
        m.driver_image === scope.software.driver_image &&
        m.driver_pod_uid_before_restart !== m.driver_pod_uid_after_restart &&
        m.driver_replacement_ready_at >= m.driver_deleted_at &&
        m.deny_record_inode_before_restart ===
          m.deny_record_inode_after_restart &&
        m.deny_record_sha256_before_restart ===
          m.deny_record_sha256_after_restart &&
        m.deny_record_fsync_errno === 0 &&
        new Set(m.denied_operations.map((o) => o.operation)).size === 4 &&
        m.denied_operations.every((o) =>
          "grpc_status" in o
            ? o.grpc_status === 9
            : o.operation !== "snapshot_create" ||
              (o.source_volume_handle === scope.volume.volume_handle &&
                o.deleted_at >= o.requested_at &&
                o.absent_at >= o.deleted_at),
        ) &&
        m.surviving_creation_descriptors === 0 &&
        m.final_dm_open_count === 0 &&
        m.physical_snapshot_count === 0
      );
    case "single_writer":
      return (
        m.before_dm_open_count === 0 &&
        m.foreign_mounts === 0 &&
        m.named_namespace_scan_errno === 0 &&
        m.exclusive_create_errno === 0 &&
        m.unexpected_writer_processes === 0
      );
    case "mount_propagation":
      return (
        new Set(m.contexts.map((c) => c.kind)).size === 4 &&
        m.contexts.every(
          (c) =>
            c.device_major === m.device_major &&
            c.device_minor === m.device_minor &&
            c.filesystem === "ext4",
        )
      );
    case "thin_write_authority":
      return (
        m.issued_at <= m.renewed_at &&
        m.renewed_at < m.expires_at &&
        m.expires_at - m.issued_at <= scope.storage.guard_seconds * 1_000
      );
    case "thin_io_limits":
      return (
        postgresPoolQualificationOrdinaryIoPassed(
          scope,
          m.ordinary_direct_io,
        ) &&
        m.ordinary_direct_io.device_major === m.device_major &&
        m.ordinary_direct_io.device_minor === m.device_minor &&
        new Set(m.writer_cgroups.map((c) => c.container_id)).size ===
          m.writer_cgroups.length &&
        m.writer_cgroups.every(
          (c) =>
            c.device_major === m.device_major &&
            c.device_minor === m.device_minor &&
            c.write_bytes_per_second === scope.storage.write_bytes_per_second &&
            c.write_iops_per_second === scope.storage.write_iops_per_second,
        )
      );
    case "wal_archive":
      return (
        m.archive_exit_code === 0 &&
        m.archive_done_at <= m.object_received_at &&
        m.local_sha256 === m.archived_sha256 &&
        parseInt(m.wal_segment.slice(0, 8), 16) === m.timeline
      );
    case "base_backup":
      return m.catalog_state === "DONE";
    case "thin_expiry_protection":
      return (
        m.protection_requested_at >= m.authority_expires_at &&
        m.protection_requested_at - m.authority_expires_at <= 1_000 &&
        m.drained_at >= m.protection_requested_at &&
        m.drained_at - m.authority_expires_at <=
          scope.storage.drain_seconds * 1_000 &&
        m.postmaster_pid === null &&
        m.device_state === "suspended" &&
        m.sectors_written_after === m.sectors_written_before &&
        m.allocated_blocks_after === m.allocated_blocks_before
      );
    case "clean_stop":
      return (
        m.control_state === "shut down" &&
        m.postmaster_pid === null &&
        m.remaining_writer_processes === 0 &&
        m.stop_exit_code === 0
      );
    case "cleanup":
      return (
        JSON.stringify(m.storage) === JSON.stringify(scope.volume) &&
        m.remaining_pool_pods === 0 &&
        m.remaining_instance_pods === 0 &&
        m.remaining_primary_lease_holders === 0 &&
        m.cnpg_hibernation === "on" &&
        m.remaining_creation_descriptors === 0 &&
        m.dm_open_count === 0 &&
        m.foreign_mounts === 0 &&
        m.named_namespace_scan_errno === 0 &&
        m.deny_record === "absent" &&
        (m.binding_id === null
          ? m.unmount_errno === null
          : m.unmount_errno === 0)
      );
  }
}

export const PostgresPoolQualificationProducer = z.enum([
  "node_agent",
  "controller",
]);
export const PostgresPoolQualificationReport = z
  .strictObject({
    run_id: z.uuid(),
    scope_sha256: Hash,
    sequence: Positive,
    nonce: z.string().regex(/^[a-f0-9]{32}$/),
    producer: PostgresPoolQualificationProducer,
    node_uid: z.uuid(),
    boot_id: z.uuid(),
    candidate_spec_sha256: Hash,
    started_at: Counter,
    observed_at: Counter,
    measurement: PostgresPoolQualificationMeasurement,
  })
  .refine((r) => r.observed_at >= r.started_at, {
    message: "Measurement cannot precede its read start",
  });
export type PostgresPoolQualificationReport = z.infer<
  typeof PostgresPoolQualificationReport
>;

export const PostgresPoolQualificationChallenge = z.strictObject({
  run_id: z.uuid(),
  scope_sha256: Hash,
  sequence: Positive,
  nonce: z.string().regex(/^[a-f0-9]{32}$/),
  producer: PostgresPoolQualificationProducer,
  gate: z.enum([...POSTGRES_POOL_QUALIFICATION_GATES, "cleanup"]),
  issued_at: Counter,
  expires_at: Positive,
});
export type PostgresPoolQualificationChallenge = z.infer<
  typeof PostgresPoolQualificationChallenge
>;

export const PostgresPoolQualificationExecution = z.strictObject({
  node_uid: z.uuid(),
  boot_id: z.uuid(),
  candidate_release_id: FleetReleaseId,
  candidate_spec_sha256: Hash,
  verifier_keys_sha256: Hash,
  driver_pod_uid: z.uuid(),
  driver_image: Image,
  driver_sha256: Hash,
  host_extension_image: Image,
  host_controller_sha256: Hash,
  kernel_version: z.string().min(1).max(128),
});
export type PostgresPoolQualificationExecution = z.infer<
  typeof PostgresPoolQualificationExecution
>;
/** Pending measured pieces and effect intents never advance a qualification gate. */
const ResourceVersion = z.string().regex(/^[0-9]{1,128}$/);
const Namespace = z
  .string()
  .max(63)
  .regex(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/);
const ResourceName = z
  .string()
  .max(253)
  .regex(/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/);
export const PostgresPoolQualificationProgress = z.discriminatedUnion("phase", [
  z.strictObject({
    gate: z.literal("finite_creator_fence"),
    phase: z.literal("node_fence_ready"),
    source_generation: Positive,
    volume_handle: z.string().regex(/^pvc-[a-f0-9-]{36}$/),
    driver_sha256: Hash,
    deny_record_inode: Positive,
    deny_record_sha256: Hash,
    deny_record_scope_sha256: Hash,
    deny_record_fsync_errno: Counter.max(4095),
    agent_owner_deaths: Positive,
    before_claim_requests_completed: Positive,
    surviving_creation_descriptors: Counter,
    dm_open_count: Counter,
    foreign_mounts: Counter,
    named_namespace_scan_errno: Counter.max(4095),
  }),
  z.strictObject({
    gate: z.literal("finite_creator_fence"),
    phase: z.literal("driver_delete_intent"),
    driver_pod_uid: z.uuid(),
    driver_pod_name: ResourceName,
    driver_pod_resource_version: ResourceVersion,
    driver_namespace: Namespace,
    driver_daemonset_uid: z.uuid(),
    driver_image: Image,
  }),
  z.strictObject({
    gate: z.literal("finite_creator_fence"),
    phase: z.literal("driver_restarted"),
    driver_pod_uid_before_restart: z.uuid(),
    driver_pod_uid_after_restart: z.uuid(),
    driver_daemonset_uid: z.uuid(),
    driver_image: Image,
    driver_deleted_at: Counter,
    driver_replacement_ready_at: Counter,
    volume_reconcile_error: z.literal("pool_creator_fence_denied"),
    volume_reconcile_observed_at: Counter,
  }),
  z.strictObject({
    gate: z.literal("finite_creator_fence"),
    phase: z.literal("snapshot_create_intent"),
    snapshot_name: ResourceName,
    snapshot_namespace: Namespace,
    source_volume_handle: z.string().regex(/^pvc-[a-f0-9-]{36}$/),
  }),
  z.strictObject({
    gate: z.literal("finite_creator_fence"),
    phase: z.literal("snapshot_created"),
    snapshot_uid: z.uuid(),
    snapshot_resource_version: ResourceVersion,
    snapshot_name: ResourceName,
    snapshot_namespace: Namespace,
    source_volume_handle: z.string().regex(/^pvc-[a-f0-9-]{36}$/),
  }),
  z.strictObject({
    gate: z.literal("finite_creator_fence"),
    phase: z.literal("snapshot_removed"),
    snapshot_uid: z.uuid(),
    source_volume_handle: z.string().regex(/^pvc-[a-f0-9-]{36}$/),
    state_at_denial: z.literal("Pending"),
    error: z.literal("pool_creator_fence_denied"),
    requested_at: Counter,
    deleted_at: Counter,
    absent_at: Counter,
  }),
  z.strictObject({
    gate: z.literal("cleanup"),
    phase: z.literal("controller_cleanup_observed"),
    namespace_uid: z.uuid(),
    cnpg_cluster_uid: z.uuid(),
    hibernation: z.enum(["on", "off", "unknown"]),
    remaining_instance_pods: Counter,
    remaining_pool_pods: Counter,
    primary_lease: z
      .strictObject({
        uid: z.uuid(),
        resource_version: ResourceVersion,
        holder_identity: z.string().max(253).nullable(),
      })
      .nullable(),
  }),
]);
export type PostgresPoolQualificationProgress = z.infer<
  typeof PostgresPoolQualificationProgress
>;
const { measurement: ignoredProgressMeasurement, ...progressReportFields } =
  PostgresPoolQualificationReport.shape;
void ignoredProgressMeasurement;
export const PostgresPoolQualificationProgressReport = z
  .strictObject({
    ...progressReportFields,
    progress: PostgresPoolQualificationProgress,
  })
  .refine((r) => r.observed_at >= r.started_at, {
    message: "Progress cannot precede its read start",
  });
export type PostgresPoolQualificationProgressReport = z.infer<
  typeof PostgresPoolQualificationProgressReport
>;
export const PostgresPoolQualificationProgressEvidence = z.strictObject({
  sequence: Positive,
  producer: PostgresPoolQualificationProducer,
  issued_at: Counter,
  started_at: Counter,
  observed_at: Counter,
  received_at: Counter,
  nonce_sha256: Hash,
  execution: PostgresPoolQualificationExecution,
  progress: PostgresPoolQualificationProgress,
});
export type PostgresPoolQualificationProgressEvidence = z.infer<
  typeof PostgresPoolQualificationProgressEvidence
>;

export const PostgresPoolQualificationEvidence = z.strictObject({
  sequence: Positive,
  producer: PostgresPoolQualificationProducer,
  issued_at: Counter,
  started_at: Counter,
  observed_at: Counter,
  received_at: Counter,
  execution: PostgresPoolQualificationExecution,
  measurement: PostgresPoolQualificationMeasurement,
});
export type PostgresPoolQualificationEvidence = z.infer<
  typeof PostgresPoolQualificationEvidence
>;
export const PostgresPoolQualificationRun = z.strictObject({
  id: z.uuid(),
  scope: PostgresPoolQualificationScope,
  scope_sha256: Hash,
  status: z.enum(["running", "cleanup", "completed", "failed"]),
  evidence: z.array(PostgresPoolQualificationEvidence).max(10),
  cleanup: PostgresPoolQualificationEvidence.nullable(),
  error_code: z
    .string()
    .regex(/^[a-z0-9_]{1,128}$/)
    .nullable(),
  receipt_sha256: Hash.nullable(),
  qualification: PostgresPoolQualification.nullable(),
  created_at: Counter,
  expires_at: Positive,
  completed_at: Counter.nullable(),
});
export type PostgresPoolQualificationRun = z.infer<
  typeof PostgresPoolQualificationRun
>;

export const PostgresPoolQualificationInput = z.strictObject({
  scope: PostgresPoolQualificationScope,
  scope_sha256: Hash,
  status: z.enum(["running", "cleanup"]),
  expires_at: Positive,
  challenge: PostgresPoolQualificationChallenge,
  permission: z.string().min(1).max(16384),
  policy: PostgresPoolPolicyState.nullable(),
  accepted_evidence: z.array(PostgresPoolQualificationEvidence).max(10),
  accepted_sleep: PoolSleepRecord.nullable(),
  pending_progress: z.array(PostgresPoolQualificationProgressEvidence).max(7),
});
export type PostgresPoolQualificationInput = z.infer<
  typeof PostgresPoolQualificationInput
>;

export const POOL_QUALIFICATION_PERMISSION = {
  prefix: "pq1",
  domain: "pgcf-pool-qualification/v1\n",
  maximum_length: 16384,
  maximum_milliseconds: 30000,
} as const;
/** A fixed measurement/creator-fence experiment, never tenant startup or arbitrary host execution. */
export const PoolQualificationClaims = z.strictObject({
  v: z.literal(1),
  kid: z.string().regex(STORAGE_AUTHORITY_KEY_ID_PATTERN),
  scope: PostgresPoolQualificationScope,
  scope_sha256: Hash,
  challenge: PostgresPoolQualificationChallenge,
  execution: PostgresPoolQualificationExecution,
  /** Null until Cloudflare has persisted and revalidated the actual candidate Pod context. */
  preparation_sha256: Hash.nullable(),
  progress_sha256: Hash,
  iat: Counter,
  exp: Positive,
});
export type PoolQualificationClaims = z.infer<typeof PoolQualificationClaims>;
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (k) =>
        `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
    )
    .join(",")}}`;
}
export async function postgresPoolQualificationScopeHash(
  scope: PostgresPoolQualificationScope,
) {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          canonical(PostgresPoolQualificationScope.parse(scope)),
        ),
      ),
    ),
  );
}
export async function postgresPoolQualificationNonceHash(nonce: string) {
  z.string()
    .regex(/^[a-f0-9]{32}$/)
    .parse(nonce);
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce)),
    ),
  );
}
export async function postgresPoolQualificationProgressHash(raw: unknown) {
  const progress = z
    .array(PostgresPoolQualificationProgressEvidence)
    .max(7)
    .parse(raw);
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonical(progress)),
      ),
    ),
  );
}
export function poolQualificationValidAt(
  c: PoolQualificationClaims,
  now: number,
): boolean {
  const s = c.scope,
    p = c.challenge,
    e = c.execution;
  return (
    Number.isSafeInteger(now) &&
    now >= 0 &&
    c.iat <= now + 5000 &&
    c.exp > now &&
    c.exp > c.iat &&
    c.exp <= c.iat + POOL_QUALIFICATION_PERMISSION.maximum_milliseconds &&
    c.exp <= p.expires_at &&
    p.issued_at <= c.iat &&
    p.run_id === s.run_id &&
    p.scope_sha256 === c.scope_sha256 &&
    e.node_uid === s.node_uid &&
    (p.gate === "cleanup" ||
      (e.boot_id === s.boot_id &&
        e.candidate_release_id === s.candidate_release_id &&
        e.candidate_spec_sha256 === s.candidate_spec_sha256 &&
        e.driver_image === s.software.driver_image &&
        e.driver_sha256 === s.software.driver_sha256 &&
        e.host_extension_image === s.software.host_extension_image &&
        e.host_controller_sha256 === s.software.host_controller_sha256 &&
        e.kernel_version === s.software.kernel_version))
  );
}
export async function signPoolQualificationPermission(
  raw: PoolQualificationClaims,
  key: StorageAuthorityCryptoKey,
  now = Date.now(),
) {
  const claims = PoolQualificationClaims.parse(raw);
  if (
    key.type !== "private" ||
    key.algorithm.name !== "Ed25519" ||
    !poolQualificationValidAt(claims, now) ||
    claims.scope_sha256 !==
      (await postgresPoolQualificationScopeHash(claims.scope))
  )
    throw new Error("invalid_pool_qualification_permission");
  const payload = bytesToBase64url(
      new TextEncoder().encode(JSON.stringify(claims)),
    ),
    signature = new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        key,
        new TextEncoder().encode(
          POOL_QUALIFICATION_PERMISSION.domain + payload,
        ),
      ),
    ),
    token = `${POOL_QUALIFICATION_PERMISSION.prefix}.${payload}.${bytesToBase64url(signature)}`;
  if (token.length > POOL_QUALIFICATION_PERMISSION.maximum_length)
    throw new Error("pool_qualification_permission_too_large");
  return token;
}
export async function verifyPoolQualificationPermission(
  token: string,
  keys: ReadonlyMap<string, StorageAuthorityCryptoKey>,
  now = Date.now(),
): Promise<PoolQualificationClaims | null> {
  if (token.length > POOL_QUALIFICATION_PERMISSION.maximum_length) return null;
  const parts = token.split("."),
    payload = base64urlToBytes(parts[1] ?? ""),
    signature = base64urlToBytes(parts[2] ?? "");
  if (
    parts.length !== 3 ||
    parts[0] !== POOL_QUALIFICATION_PERMISSION.prefix ||
    !payload ||
    !signature ||
    signature.length !== 64 ||
    bytesToBase64url(payload) !== parts[1] ||
    bytesToBase64url(signature) !== parts[2]
  )
    return null;
  try {
    const claims = PoolQualificationClaims.parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
            payload,
          ),
        ),
      ),
      key = keys.get(claims.kid);
    if (
      !key ||
      key.type !== "public" ||
      key.algorithm.name !== "Ed25519" ||
      !poolQualificationValidAt(claims, now) ||
      claims.scope_sha256 !==
        (await postgresPoolQualificationScopeHash(claims.scope)) ||
      !(await crypto.subtle.verify(
        "Ed25519",
        key,
        new Uint8Array(signature).buffer,
        new TextEncoder().encode(
          POOL_QUALIFICATION_PERMISSION.domain + parts[1],
        ),
      ))
    )
      return null;
    return claims;
  } catch {
    return null;
  }
}
