// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { NodeId, OperationId, RegionId } from "./ids.ts";
import {
  StorageLvmUuid,
  ThinStorageProfile,
  thinMetadataEstimateBytes,
} from "./database-storage.ts";
import { FleetReleaseId, ThinStorageQualification } from "./releases.ts";

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ExitCode = z.number().int().min(0).max(255);
const ImageReference = z
  .string()
  .max(512)
  .regex(/^[^\s@]+@sha256:[0-9a-f]{64}$/);
const KernelVersion = ThinStorageQualification.shape.kernel_version;
const NodeName = z
  .string()
  .max(253)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/);
const KubernetesName = z
  .string()
  .max(253)
  .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/);
const LvName = z.string().regex(/^[A-Za-z0-9_.+[\]-]{1,128}$/);
const GIB = 1024 ** 3;

/** The receipt gates in release-spec order; each is decided by code from its own evidence. */
export const THIN_QUALIFICATION_GATES = [
  "data_full",
  "metadata_full",
  "noflush_quiescence",
  "resume_marker",
  "startup_bound",
  "trim_delete_recreate",
  "retained_thick_preservation",
] as const;
export const ThinQualificationGate = z.enum(THIN_QUALIFICATION_GATES);
export type ThinQualificationGate = z.infer<typeof ThinQualificationGate>;
/** Scratch setup, every gate, then removal of every scratch object before a receipt exists. */
export const THIN_QUALIFICATION_STEPS = [
  "setup",
  ...THIN_QUALIFICATION_GATES,
  "cleanup",
] as const;
export const ThinQualificationStep = z.enum([
  ...THIN_QUALIFICATION_STEPS,
  "complete",
]);
export type ThinQualificationStep = z.infer<typeof ThinQualificationStep>;

/** Producer bounds for one fenced run; they are not product capacity defaults. */
export const THIN_QUALIFICATION_LIMITS = {
  /** Raw scratch volumes created for the maximum-data metadata measurement. */
  maximum_volumes: 256,
  /** Data of the separate scratch pool whose metadata is deliberately below the profile floor. */
  metadata_pool_data_bytes: 12 * GIB,
  /** Requested metadata of that pool; LVM rounds it up to one extent. */
  metadata_pool_metadata_bytes: 2 * 1024 ** 2,
  /** Raw bytes written, deleted and recreated by trim_delete_recreate. */
  trim_bytes: 256 * 1024 ** 2,
  /** Measured direct-write rates may exceed the cgroup limit by this throttling slack. */
  io_tolerance_ppm: 1_100_000,
  /** dm-thin metadata block size. */
  metadata_block_bytes: 4096,
  /** The product pool chunk size; equal to the 64 KiB lvcreate argument. */
  chunk_bytes: 65536,
} as const;

/** Admin request: the complete finite profile and the exact current physical node. */
export const ThinQualificationRequest = z
  .strictObject({
    node_uid: z.uuid(),
    address: z.union([z.ipv4(), z.ipv6()]),
    profile: ThinStorageProfile,
  })
  .superRefine((value, context) => {
    if (value.profile.initial_data_bytes >= value.profile.maximum_data_bytes)
      context.addIssue({
        code: "custom",
        message:
          "Qualification grows the pool and needs a maximum above the initial data size",
      });
    if (
      value.profile.maximum_volumes > THIN_QUALIFICATION_LIMITS.maximum_volumes
    )
      context.addIssue({
        code: "custom",
        message:
          "Profile volume count exceeds the qualification producer bound",
      });
  });
export type ThinQualificationRequest = z.infer<typeof ThinQualificationRequest>;

/** dm-thin pool status; a failed pool reports no counters. */
export const ThinPoolStatus = z
  .strictObject({
    mode: z.enum(["rw", "ro", "out_of_data_space", "fail"]),
    used_data_blocks: Count.nullable(),
    total_data_blocks: Count.nullable(),
    used_metadata_blocks: Count.nullable(),
    total_metadata_blocks: Count.nullable(),
    error_if_no_space: z.boolean().nullable(),
    needs_check: z.boolean().nullable(),
  })
  .refine(
    (value) =>
      [
        value.used_data_blocks,
        value.total_data_blocks,
        value.used_metadata_blocks,
        value.total_metadata_blocks,
        value.error_if_no_space,
        value.needs_check,
      ].every((field) => (field === null) === (value.mode === "fail")),
    { message: "Only a failed pool omits its counters" },
  );
export type ThinPoolStatus = z.infer<typeof ThinPoolStatus>;
/** One bounded write against a scratch volume; the error is classified, never assumed. */
export const ThinQualificationWrite = z.strictObject({
  exit_code: ExitCode,
  error: z.enum(["enospc", "eio", "other"]).nullable(),
  written_bytes: Count,
  milliseconds: Count,
});
export type ThinQualificationWrite = z.infer<typeof ThinQualificationWrite>;

export const ThinQualificationIdentity = z.strictObject({
  node_uid: z.uuid(),
  cluster_uid: z.uuid(),
  boot_id: z.uuid(),
  system_uuid: z.uuid(),
  kernel_version: KernelVersion,
  volume_group_uuid: StorageLvmUuid,
  volume_group_bytes: Count,
  extent_bytes: Count.positive(),
  driver_pod_uid: z.uuid(),
  driver_image: ImageReference,
  driver_image_id: z.string().min(1).max(1024),
  driver_sha256: Sha256,
  lvm_sha256: Sha256,
  tools_sha256: Sha256,
  thin_tools_version: z.string().min(1).max(32),
  host_extension_image: ImageReference,
  host_extension_version: z.string().min(1).max(128),
  observed_at: z.iso.datetime(),
});
export type ThinQualificationIdentity = z.infer<
  typeof ThinQualificationIdentity
>;

const LogicalVolume = z.strictObject({
  name: LvName,
  lv_uuid: StorageLvmUuid,
  size_bytes: Count,
  segtype: z.string().regex(/^[a-z0-9-]{1,32}$/),
});
/** Every retained thick identity the scratch run must leave untouched. */
export const ThinQualificationThickSnapshot = z.strictObject({
  observed_at: z.iso.datetime(),
  thick_allocated_bytes: Count,
  volumes: z.array(LogicalVolume).max(4096),
  claims: z
    .array(
      z.strictObject({
        pv_name: KubernetesName,
        pv_uid: z.uuid(),
        pvc_uid: z.uuid(),
        namespace: KubernetesName,
      }),
    )
    .max(4096),
  lvm_volumes: z
    .array(z.strictObject({ name: KubernetesName, uid: z.uuid() }))
    .max(4096),
  clusters: z
    .array(
      z.strictObject({
        namespace: KubernetesName,
        uid: z.uuid(),
        ready: z.boolean(),
        continuous_archiving: z.boolean(),
      }),
    )
    .max(4096),
});
export type ThinQualificationThickSnapshot = z.infer<
  typeof ThinQualificationThickSnapshot
>;

/** Fresh node identity, untouched baseline and the scratch pool created with the profile geometry. */
export const ThinQualificationSetup = z.strictObject({
  identity: ThinQualificationIdentity,
  volume_group_free_bytes: Count,
  logical_volumes: z.array(LogicalVolume).max(4096),
  thick: ThinQualificationThickSnapshot,
  pool: z.strictObject({
    pool_uuid: StorageLvmUuid,
    data_bytes: Count.positive(),
    metadata_bytes: Count.positive(),
    chunk_bytes: Count.positive(),
    when_full: z.string().max(16),
    zeroing: z.boolean(),
    tags: z.array(z.string().max(128)).max(16),
  }),
  namespace_uid: z.uuid(),
  storage_class_uid: z.uuid(),
  attributes_class_uid: z.uuid(),
});
export type ThinQualificationSetup = z.infer<typeof ThinQualificationSetup>;

export const ThinQualificationDataFull = z.strictObject({
  pool_uuid_before: StorageLvmUuid,
  pool_uuid_after: StorageLvmUuid,
  pool_data_bytes_before: Count,
  pool_data_bytes_after: Count,
  grow_target_bytes: Count,
  chunk_bytes: Count.positive(),
  volumes_before: z.array(StorageLvmUuid).min(1).max(8),
  volumes_after: z.array(StorageLvmUuid).max(8),
  marker_committed: z.boolean(),
  fill: ThinQualificationWrite,
  full: ThinPoolStatus,
  probe: ThinQualificationWrite,
  acknowledged_commits: Count,
  grown: ThinPoolStatus,
  restart_ready_milliseconds: Count,
  marker_present: z.boolean(),
  acknowledged_present: Count,
  kernel_modes: z.array(z.string().max(64)).max(64),
});
export type ThinQualificationDataFull = z.infer<
  typeof ThinQualificationDataFull
>;

export const ThinQualificationMetadataFull = z.strictObject({
  scratch: z.strictObject({
    pool_uuid: StorageLvmUuid,
    data_bytes: Count.positive(),
    metadata_bytes: Count.positive(),
    marker_sha256: Sha256,
    exhaust: ThinQualificationWrite,
    exhausted: ThinPoolStatus,
    probe: ThinQualificationWrite,
    probe_used_data_blocks_before: Count.nullable(),
    probe_used_data_blocks_after: Count.nullable(),
    check_exit_code: ExitCode.nullable(),
    repair_exit_code: ExitCode,
    activation_exit_code: ExitCode,
    marker_sha256_after: Sha256.nullable(),
  }),
  maximum: z.strictObject({
    pool_uuid: StorageLvmUuid,
    data_bytes: Count.positive(),
    metadata_bytes: Count.positive(),
    volumes: Count,
    written_bytes: Count,
    status: ThinPoolStatus,
  }),
  reboot: z.strictObject({
    boot_id_before: z.uuid(),
    boot_id_after: z.uuid(),
    pool_active: z.boolean(),
    volume_active: z.boolean(),
    marker_present: z.boolean(),
  }),
});
export type ThinQualificationMetadataFull = z.infer<
  typeof ThinQualificationMetadataFull
>;

export const ThinQualificationNoflush = z.strictObject({
  writer: z.strictObject({
    lv_uuid: StorageLvmUuid,
    dirty_bytes: Count,
    suspend_milliseconds: Count,
    state: z.enum(["ACTIVE", "SUSPENDED"]),
    lv_state: z.string().length(1),
    write_sectors_first: Count,
    write_sectors_second: Count,
    used_data_blocks_first: Count,
    used_data_blocks_second: Count,
    observed_milliseconds: Count,
    resume_milliseconds: Count,
    drain_bytes: Count,
    drain_milliseconds: Count,
    fsck_exit_code: ExitCode,
  }),
  full: z.strictObject({
    lv_uuid: StorageLvmUuid,
    pool: ThinPoolStatus,
    suspend_milliseconds: Count,
    state: z.enum(["ACTIVE", "SUSPENDED"]),
    resume_milliseconds: Count,
  }),
});
export type ThinQualificationNoflush = z.infer<typeof ThinQualificationNoflush>;

export const ThinQualificationResumeMarker = z.strictObject({
  lv_uuid_before: StorageLvmUuid,
  lv_uuid_after: StorageLvmUuid,
  pool_uuid_before: StorageLvmUuid,
  pool_uuid_after: StorageLvmUuid,
  marker_committed: z.boolean(),
  long_statement_active: z.boolean(),
  suspended: z.boolean(),
  resume_target_verified: z.boolean(),
  changed_identity_refused: z.boolean(),
  restart_ready_milliseconds: Count,
  marker_present: z.boolean(),
  uncommitted_rows: Count,
});
export type ThinQualificationResumeMarker = z.infer<
  typeof ThinQualificationResumeMarker
>;

export const ThinQualificationStartupBound = z.strictObject({
  lv_uuid: StorageLvmUuid,
  chunk_bytes: Count.positive(),
  used_data_blocks_before: Count,
  used_data_blocks_ready: Count,
  used_data_blocks_idle: Count,
  ready_milliseconds: Count,
  idle_milliseconds: Count,
  ext4_groups: Count,
  ext4_groups_zeroed: Count,
  io_limit: z.strictObject({
    write_bytes_per_second: Count,
    write_iops_per_second: Count,
  }),
  measured_write_bytes_per_second: Count,
  measured_write_iops_per_second: Count,
  executor_cycle_milliseconds: Count,
});
export type ThinQualificationStartupBound = z.infer<
  typeof ThinQualificationStartupBound
>;

export const ThinQualificationTrim = z.strictObject({
  chunk_bytes: Count.positive(),
  written_bytes: Count,
  deleted_lv_uuid: StorageLvmUuid,
  used_data_blocks_baseline: Count,
  used_data_blocks_written: Count,
  used_data_blocks_deleted: Count,
  deleted_absent_lvs: z.boolean(),
  deleted_absent_kernel: z.boolean(),
  last_lv_uuid: StorageLvmUuid,
  pool_uuid_before: StorageLvmUuid,
  pool_present_after_last: z.boolean(),
  reinitialized_pool_uuid: StorageLvmUuid.nullable(),
  recreated_lv_uuid: StorageLvmUuid,
  recreated_read_bytes: Count,
  recreated_nonzero_bytes: Count,
});
export type ThinQualificationTrim = z.infer<typeof ThinQualificationTrim>;

/** Executor-observed part; Cloudflare adds its own placement facts before deciding the gate. */
export const ThinQualificationRetainedObservation = z.strictObject({
  baseline: ThinQualificationThickSnapshot,
  after: ThinQualificationThickSnapshot,
});
export const ThinQualificationRetained =
  ThinQualificationRetainedObservation.extend({
    thin_profile_databases: Count,
  });
export type ThinQualificationRetained = z.infer<
  typeof ThinQualificationRetained
>;

/** Proof that every scratch object, LV and the scratch pool are gone again. */
export const ThinQualificationCleanup = z.strictObject({
  namespace_absent: z.boolean(),
  storage_class_absent: z.boolean(),
  attributes_class_absent: z.boolean(),
  scratch_volumes_absent: z.boolean(),
  pool_absent: z.boolean(),
  spare_absent: z.boolean(),
  logical_volumes_match_baseline: z.boolean(),
  volume_group_free_bytes: Count,
  baseline_free_bytes: Count,
});
export type ThinQualificationCleanup = z.infer<typeof ThinQualificationCleanup>;
export function thinQualificationCleanupVerified(
  value: ThinQualificationCleanup,
): boolean {
  return (
    value.namespace_absent &&
    value.storage_class_absent &&
    value.attributes_class_absent &&
    value.scratch_volumes_absent &&
    value.pool_absent &&
    value.spare_absent &&
    value.logical_volumes_match_baseline &&
    value.volume_group_free_bytes === value.baseline_free_bytes
  );
}

export const ThinQualificationEvidence = {
  data_full: ThinQualificationDataFull,
  metadata_full: ThinQualificationMetadataFull,
  noflush_quiescence: ThinQualificationNoflush,
  resume_marker: ThinQualificationResumeMarker,
  startup_bound: ThinQualificationStartupBound,
  trim_delete_recreate: ThinQualificationTrim,
  retained_thick_preservation: ThinQualificationRetained,
} as const;
export type ThinQualificationEvidence = {
  [G in ThinQualificationGate]: z.infer<(typeof ThinQualificationEvidence)[G]>;
};

function record<G extends ThinQualificationGate>(gate: G) {
  return z
    .strictObject({
      pass: z.boolean(),
      evidence: ThinQualificationEvidence[gate],
      measured_at: z.iso.datetime(),
    })
    .optional();
}
export const ThinQualificationGates = z.strictObject({
  data_full: record("data_full"),
  metadata_full: record("metadata_full"),
  noflush_quiescence: record("noflush_quiescence"),
  resume_marker: record("resume_marker"),
  startup_bound: record("startup_bound"),
  trim_delete_recreate: record("trim_delete_recreate"),
  retained_thick_preservation: record("retained_thick_preservation"),
});
export type ThinQualificationGates = z.infer<typeof ThinQualificationGates>;

function sameUuids(a: readonly string[], b: readonly string[]) {
  return (
    a.length === b.length &&
    new Set(a).size === a.length &&
    [...a].sort().join() === [...b].sort().join()
  );
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
function sortedBy<T>(values: readonly T[], key: (value: T) => string) {
  return canonical([...values].sort((a, b) => (key(a) < key(b) ? -1 : 1)));
}
function failedClosed(write: ThinQualificationWrite, limitMs?: number) {
  return (
    write.exit_code !== 0 &&
    (write.error === "enospc" || write.error === "eio") &&
    (limitMs === undefined || write.milliseconds <= limitMs)
  );
}
function poolFull(status: ThinPoolStatus) {
  return (
    status.used_data_blocks !== null &&
    status.total_data_blocks !== null &&
    status.total_data_blocks > 0 &&
    status.used_data_blocks === status.total_data_blocks
  );
}
/** The bounded stop drain: the larger of the startup reserve and one maximum logical quota. */
export function thinQualificationDrainBudget(
  profile: ThinStorageProfile,
): number {
  return Math.max(
    profile.startup_reserve_bytes,
    profile.maximum_quota_gib * GIB,
  );
}
/** The scratch pool is below the profile metadata floor for its own data size. */
export function thinQualificationBelowFloor(
  profile: ThinStorageProfile,
  dataBytes: number,
  metadataBytes: number,
): boolean {
  return (
    thinMetadataEstimateBytes(dataBytes, 1) * 4 +
      profile.metadata_reserve_bytes >
    metadataBytes
  );
}

/** Pass criteria from measured numbers only; a missing or unknown value never passes. */
export function thinQualificationGatePass<G extends ThinQualificationGate>(
  gate: G,
  raw: ThinQualificationEvidence[G],
  profile: ThinStorageProfile,
): boolean {
  const p = ThinStorageProfile.parse(profile),
    drainMs = p.drain_seconds * 1000;
  switch (gate) {
    case "data_full": {
      const e = ThinQualificationDataFull.parse(raw);
      return (
        e.pool_uuid_after === e.pool_uuid_before &&
        sameUuids(e.volumes_after, e.volumes_before) &&
        e.pool_data_bytes_before === p.initial_data_bytes &&
        e.chunk_bytes === THIN_QUALIFICATION_LIMITS.chunk_bytes &&
        e.marker_committed &&
        failedClosed(e.fill) &&
        e.full.mode === "out_of_data_space" &&
        e.full.error_if_no_space === true &&
        poolFull(e.full) &&
        failedClosed(e.probe, drainMs) &&
        e.grow_target_bytes ===
          Math.min(
            p.maximum_data_bytes,
            p.initial_data_bytes + p.growth_bytes,
          ) &&
        e.pool_data_bytes_after === e.grow_target_bytes &&
        e.grown.mode === "rw" &&
        e.grown.total_data_blocks !== null &&
        e.grown.used_data_blocks !== null &&
        e.grown.total_data_blocks * e.chunk_bytes === e.pool_data_bytes_after &&
        e.grown.used_data_blocks < e.grown.total_data_blocks &&
        e.marker_present &&
        e.acknowledged_present === e.acknowledged_commits
      );
    }
    case "metadata_full": {
      const e = ThinQualificationMetadataFull.parse(raw),
        s = e.scratch,
        m = e.maximum,
        r = e.reboot;
      const repaired =
        (s.activation_exit_code === 0 &&
          s.marker_sha256_after === s.marker_sha256) ||
        (s.activation_exit_code !== 0 && s.marker_sha256_after === null);
      const noNewChunks =
        s.exhausted.mode === "fail" ||
        (s.probe_used_data_blocks_before !== null &&
          s.probe_used_data_blocks_after === s.probe_used_data_blocks_before);
      return (
        thinQualificationBelowFloor(p, s.data_bytes, s.metadata_bytes) &&
        failedClosed(s.exhaust) &&
        (s.exhausted.mode === "ro" || s.exhausted.mode === "fail") &&
        failedClosed(s.probe, drainMs) &&
        noNewChunks &&
        repaired &&
        m.data_bytes === p.maximum_data_bytes &&
        m.metadata_bytes === p.metadata_bytes &&
        m.volumes === p.maximum_volumes &&
        poolFull(m.status) &&
        m.status.used_metadata_blocks !== null &&
        m.status.used_metadata_blocks *
          THIN_QUALIFICATION_LIMITS.metadata_block_bytes <=
          p.metadata_bytes - p.metadata_reserve_bytes &&
        r.boot_id_after !== r.boot_id_before &&
        r.pool_active &&
        r.volume_active &&
        r.marker_present
      );
    }
    case "noflush_quiescence": {
      const e = ThinQualificationNoflush.parse(raw),
        w = e.writer,
        f = e.full;
      return (
        w.dirty_bytes > 0 &&
        w.state === "SUSPENDED" &&
        w.lv_state === "s" &&
        w.observed_milliseconds >= 1000 &&
        w.write_sectors_second === w.write_sectors_first &&
        w.used_data_blocks_second === w.used_data_blocks_first &&
        w.suspend_milliseconds <= drainMs &&
        w.drain_bytes <= thinQualificationDrainBudget(p) &&
        w.drain_milliseconds <= drainMs &&
        w.fsck_exit_code === 0 &&
        f.pool.mode === "out_of_data_space" &&
        poolFull(f.pool) &&
        f.state === "SUSPENDED" &&
        f.suspend_milliseconds <= drainMs
      );
    }
    case "resume_marker": {
      const e = ThinQualificationResumeMarker.parse(raw);
      return (
        e.marker_committed &&
        e.long_statement_active &&
        e.suspended &&
        e.resume_target_verified &&
        e.changed_identity_refused &&
        e.lv_uuid_after === e.lv_uuid_before &&
        e.pool_uuid_after === e.pool_uuid_before &&
        e.marker_present &&
        e.uncommitted_rows === 0
      );
    }
    case "startup_bound": {
      const e = ThinQualificationStartupBound.parse(raw),
        tolerance = THIN_QUALIFICATION_LIMITS.io_tolerance_ppm;
      return (
        e.used_data_blocks_ready >= e.used_data_blocks_before &&
        (e.used_data_blocks_ready - e.used_data_blocks_before) *
          e.chunk_bytes <=
          thinQualificationDrainBudget(p) &&
        e.ext4_groups > 0 &&
        e.ext4_groups_zeroed === e.ext4_groups &&
        e.io_limit.write_bytes_per_second > 0 &&
        e.io_limit.write_iops_per_second > 0 &&
        e.io_limit.write_bytes_per_second <= p.write_bytes_per_second &&
        e.io_limit.write_iops_per_second <= p.write_iops_per_second &&
        e.measured_write_bytes_per_second * 1_000_000 <=
          p.write_bytes_per_second * tolerance &&
        e.measured_write_iops_per_second * 1_000_000 <=
          p.write_iops_per_second * tolerance &&
        e.executor_cycle_milliseconds < p.guard_seconds * 500
      );
    }
    case "trim_delete_recreate": {
      const e = ThinQualificationTrim.parse(raw);
      return (
        e.written_bytes === THIN_QUALIFICATION_LIMITS.trim_bytes &&
        e.used_data_blocks_written >= e.used_data_blocks_baseline &&
        (e.used_data_blocks_written - e.used_data_blocks_baseline) *
          e.chunk_bytes >=
          e.written_bytes &&
        e.used_data_blocks_deleted === e.used_data_blocks_baseline &&
        e.deleted_absent_lvs &&
        e.deleted_absent_kernel &&
        e.last_lv_uuid !== e.deleted_lv_uuid &&
        (e.pool_present_after_last
          ? e.reinitialized_pool_uuid === null
          : e.reinitialized_pool_uuid !== null &&
            e.reinitialized_pool_uuid !== e.pool_uuid_before) &&
        e.recreated_lv_uuid !== e.deleted_lv_uuid &&
        e.recreated_lv_uuid !== e.last_lv_uuid &&
        e.recreated_read_bytes === e.written_bytes &&
        e.recreated_nonzero_bytes === 0
      );
    }
    case "retained_thick_preservation": {
      const e = ThinQualificationRetained.parse(raw),
        a = e.baseline,
        b = e.after;
      return (
        a.thick_allocated_bytes === b.thick_allocated_bytes &&
        sortedBy(a.volumes, (v) => v.lv_uuid) ===
          sortedBy(b.volumes, (v) => v.lv_uuid) &&
        sortedBy(a.claims, (v) => v.pv_uid) ===
          sortedBy(b.claims, (v) => v.pv_uid) &&
        sortedBy(a.lvm_volumes, (v) => v.uid) ===
          sortedBy(b.lvm_volumes, (v) => v.uid) &&
        sortedBy(a.clusters, (v) => v.uid) ===
          sortedBy(b.clusters, (v) => v.uid) &&
        e.thin_profile_databases === 0
      );
    }
  }
  return false;
}

/** Setup is accepted only for a clean volume group and the exact profile pool geometry. */
export function thinQualificationSetupValid(
  setup: ThinQualificationSetup,
  profile: ThinStorageProfile,
): boolean {
  const value = ThinQualificationSetup.parse(setup);
  return (
    value.pool.data_bytes === profile.initial_data_bytes &&
    value.pool.metadata_bytes === profile.metadata_bytes &&
    value.pool.chunk_bytes === THIN_QUALIFICATION_LIMITS.chunk_bytes &&
    value.pool.when_full === "error" &&
    value.identity.driver_image === profile.driver_image &&
    !value.logical_volumes.some(
      (lv) =>
        lv.segtype === "thin" ||
        lv.segtype === "thin-pool" ||
        lv.name === "[lvol0_pmspare]",
    )
  );
}

/** Private executor journal: every mutating step is recorded before dispatch. */
export const ThinQualificationJournalEntry = z
  .strictObject({
    key: z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,95}$/),
    state: z.enum(["dispatched", "confirmed"]),
    nonce: OperationId,
    at: z.iso.datetime(),
    facts: z.record(z.string(), z.unknown()).nullable(),
  })
  .refine((value) => JSON.stringify(value.facts).length <= 32768, {
    message: "Journal facts are bounded",
  });
export type ThinQualificationJournalEntry = z.infer<
  typeof ThinQualificationJournalEntry
>;
export const ThinQualificationJournal = z
  .strictObject({
    revision: Count,
    entries: z.array(ThinQualificationJournalEntry).max(512),
  })
  .refine(
    (value) =>
      new Set(value.entries.map((entry) => entry.key)).size ===
      value.entries.length,
    { message: "Journal keys are unique" },
  );
export type ThinQualificationJournal = z.infer<typeof ThinQualificationJournal>;
export const ThinQualificationCheckpoint = z.strictObject({
  expected_revision: Count,
  entry: ThinQualificationJournalEntry,
});
export type ThinQualificationCheckpoint = z.infer<
  typeof ThinQualificationCheckpoint
>;

/** Private sealed custody for one bounded executor turn of one run step. */
export const ThinQualificationInput = z.strictObject({
  run: z.strictObject({
    id: OperationId,
    step: z.enum(THIN_QUALIFICATION_STEPS),
    node_id: NodeId,
    region_id: RegionId,
    node_uid: z.uuid(),
    cluster_uid: z.uuid(),
    name: NodeName,
    provider_instance_id: z.string().min(1).max(128),
    address: z.union([z.ipv4(), z.ipv6()]),
    release_id: FleetReleaseId,
    spec_sha256: Sha256,
    profile: ThinStorageProfile,
    profile_sha256: Sha256,
    postgres_image: ImageReference,
    setup: ThinQualificationSetup.nullable(),
    lease: z.strictObject({
      operation_id: OperationId,
      revision: Count.positive(),
      issued_at: z.iso.datetime(),
      expires_at: z.iso.datetime(),
    }),
    journal: ThinQualificationJournal,
  }),
  host_extension: z.strictObject({
    image: ImageReference,
    version: z.string().min(1).max(128),
    sha256: Sha256,
  }),
  cluster_endpoint: z.url(),
  talos_admin_config: z
    .string()
    .min(1)
    .max(256 * 1024),
  kubeconfig: z
    .string()
    .min(1)
    .max(256 * 1024),
  callback: z.strictObject({
    url: z.url(),
    bearer: z.string().min(32).max(128),
  }),
});
export type ThinQualificationInput = z.infer<typeof ThinQualificationInput>;

/** One completed step; Cloudflare recomputes every gate decision from the evidence. */
export const ThinQualificationReport = z.discriminatedUnion("step", [
  z.strictObject({ step: z.literal("setup"), setup: ThinQualificationSetup }),
  z.strictObject({
    step: z.literal("data_full"),
    evidence: ThinQualificationDataFull,
  }),
  z.strictObject({
    step: z.literal("metadata_full"),
    evidence: ThinQualificationMetadataFull,
  }),
  z.strictObject({
    step: z.literal("noflush_quiescence"),
    evidence: ThinQualificationNoflush,
  }),
  z.strictObject({
    step: z.literal("resume_marker"),
    evidence: ThinQualificationResumeMarker,
  }),
  z.strictObject({
    step: z.literal("startup_bound"),
    evidence: ThinQualificationStartupBound,
  }),
  z.strictObject({
    step: z.literal("trim_delete_recreate"),
    evidence: ThinQualificationTrim,
  }),
  z.strictObject({
    step: z.literal("retained_thick_preservation"),
    evidence: ThinQualificationRetainedObservation,
  }),
  z.strictObject({
    step: z.literal("cleanup"),
    cleanup: ThinQualificationCleanup,
  }),
]);
export type ThinQualificationReport = z.infer<typeof ThinQualificationReport>;

/** Public run state: identities, measurements and decisions; never private custody. */
export const ThinQualificationRun = z.strictObject({
  id: OperationId,
  node_id: NodeId,
  region_id: RegionId,
  node_uid: z.uuid(),
  release_id: FleetReleaseId,
  spec_sha256: Sha256,
  profile: ThinStorageProfile,
  profile_sha256: Sha256,
  driver_image: ImageReference,
  host_extension_image: ImageReference,
  postgres_image: ImageReference,
  kernel_version: KernelVersion.nullable(),
  status: z.enum(["running", "failed", "completed"]),
  step: ThinQualificationStep,
  error_code: z.string().max(128).nullable(),
  setup: ThinQualificationSetup.nullable(),
  gates: ThinQualificationGates,
  cleanup: ThinQualificationCleanup.nullable(),
  receipt_sha256: Sha256.nullable(),
  qualified_at: z.iso.datetime().nullable(),
  qualification: ThinStorageQualification.nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  completed_at: z.iso.datetime().nullable(),
});
export type ThinQualificationRun = z.infer<typeof ThinQualificationRun>;

type ReceiptRun = Pick<
  ThinQualificationRun,
  | "id"
  | "node_id"
  | "region_id"
  | "node_uid"
  | "release_id"
  | "spec_sha256"
  | "profile"
  | "profile_sha256"
  | "driver_image"
  | "host_extension_image"
  | "postgres_image"
  | "kernel_version"
  | "setup"
  | "gates"
  | "cleanup"
  | "qualified_at"
>;
/** The complete run evidence hashed into receipt_sha256 with the installation canonicalization. */
export function thinQualificationReceiptMaterial(run: ReceiptRun) {
  return {
    purpose: "pgcf-thin-storage-qualification/v1",
    run_id: run.id,
    node_id: run.node_id,
    region_id: run.region_id,
    node_uid: run.node_uid,
    release_id: run.release_id,
    spec_sha256: run.spec_sha256,
    profile: run.profile,
    profile_sha256: run.profile_sha256,
    driver_image: run.driver_image,
    host_extension_image: run.host_extension_image,
    postgres_image: run.postgres_image,
    kernel_version: run.kernel_version,
    setup: run.setup,
    gates: run.gates,
    cleanup: run.cleanup,
    qualified_at: run.qualified_at,
  };
}

/** Every gate passed by code and every scratch object was removed. */
export function thinQualificationPassed(
  run: Pick<ThinQualificationRun, "profile" | "setup" | "gates" | "cleanup">,
): boolean {
  return (
    run.setup !== null &&
    thinQualificationSetupValid(run.setup, run.profile) &&
    THIN_QUALIFICATION_GATES.every((gate) => {
      const value = run.gates[gate];
      return (
        value !== undefined &&
        value.pass &&
        thinQualificationGatePass(
          gate,
          value.evidence as ThinQualificationEvidence[typeof gate],
          run.profile,
        )
      );
    }) &&
    run.cleanup !== null &&
    thinQualificationCleanupVerified(run.cleanup)
  );
}

/** The exact release receipt a completed run yields; anything else is not a produced receipt. */
export function thinStorageQualificationFromRun(
  run: Pick<
    ThinQualificationRun,
    | "status"
    | "profile"
    | "profile_sha256"
    | "driver_image"
    | "host_extension_image"
    | "kernel_version"
    | "receipt_sha256"
    | "qualified_at"
    | "setup"
    | "gates"
    | "cleanup"
  >,
): ThinStorageQualification {
  if (
    run.status !== "completed" ||
    !run.receipt_sha256 ||
    !run.qualified_at ||
    !run.kernel_version ||
    !thinQualificationPassed(run)
  )
    throw new Error("thin_qualification_incomplete");
  return ThinStorageQualification.parse({
    profile_sha256: run.profile_sha256,
    driver_image: run.driver_image,
    host_extension_image: run.host_extension_image,
    kernel_version: run.kernel_version,
    receipt_sha256: run.receipt_sha256,
    qualified_at: run.qualified_at,
    gates: Object.fromEntries(
      THIN_QUALIFICATION_GATES.map((gate) => [gate, true]),
    ),
  });
}
