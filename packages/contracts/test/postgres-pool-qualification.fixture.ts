// SPDX-License-Identifier: Apache-2.0
// Structural contract fixtures; never live qualification evidence.
import type {
  PostgresPoolQualificationScope,
  PostgresPoolQualificationOrdinaryIo,
} from "../src/postgres-pool-qualification.ts";
import { postgresPoolQualificationNonceHash } from "../src/postgres-pool-qualification.ts";
export function qualificationScopeFixture() {
  const uuid = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const lvm = "aaaaaa-bbbb-cccc-dddd-eeee-ffff-gggggg";
  const image = `ghcr.io/amerged-org/pgcf-regional:test@sha256:${"a".repeat(64)}`;
  return {
    version: 1,
    run_id: uuid(1),
    region_id: "eu-test",
    node_id: `nod_${"a".repeat(20)}`,
    node_uid: uuid(2),
    boot_id: uuid(3),
    cluster_uid: uuid(4),
    database_id: "a".repeat(20),
    database_generation: 2,
    configuration_fingerprint: "b".repeat(64),
    candidate_release_id: "pool-candidate",
    candidate_spec_sha256: "c".repeat(64),
    storage: {
      backend: "lvm-thin-v1",
      storage_class: `pgcf-lvm-thin-v1-${"d".repeat(16)}`,
      volume_attributes_class: `pgcf-lvm-thin-v1-${"d".repeat(16)}`,
      profile_revision: 9,
      profile_sha256: "d".repeat(64),
      node_uid: uuid(2),
      volume_group_uuid: lvm,
      pool_uuid: "hhhhhh-iiii-jjjj-kkkk-llll-mmmm-nnnnnn",
      startup_reserve_bytes: 1073741824,
      write_bytes_per_second: 1048576,
      write_iops_per_second: 100,
      guard_seconds: 10,
      drain_seconds: 10,
    },
    volume: {
      storage_generation: 1,
      storage_uid: uuid(5),
      namespace_uid: uuid(6),
      cluster_uid: uuid(7),
      node_uid: uuid(2),
      volume_group_uuid: lvm,
      pool_uuid: "hhhhhh-iiii-jjjj-kkkk-llll-mmmm-nnnnnn",
      volume_handle: `pvc-${uuid(8)}`,
      lv_uuid: "oooooo-pppp-qqqq-rrrr-ssss-tttt-uuuuuu",
      pvc_uid: uuid(8),
      pv_uid: uuid(9),
    },
    thin_id: 1,
    software: {
      driver_image: image,
      driver_sha256: "e".repeat(64),
      supervisor_image: image,
      supervisor_sha256: "f".repeat(64),
      postgres_image: image,
      archiver_image: image,
      host_extension_image: image,
      host_controller_sha256: "8".repeat(64),
      kernel_version: "6.18.54-talos",
    },
  };
}

export async function qualificationHostFixture(
  s: PostgresPoolQualificationScope,
  scopeHash: string,
  nonce: string,
  at: number,
  preparationHash = "9".repeat(64),
  podUid = "00000000-0000-4000-8000-000000000090",
) {
  return {
    gate: "host_mount_context" as const,
    kernel_version: s.software.kernel_version,
    caller_pid_namespace_inode: 0xeffffffc,
    initial_pid_namespace_inode: 0xeffffffc,
    caller_user_namespace_inode: 0xeffffffd,
    initial_user_namespace_inode: 0xeffffffd,
    next_namespace_errno: 2,
    storage_read: {
      v: 1 as const,
      command: "inspect_readonly" as const,
      qualification_run_id: s.run_id,
      qualification_scope_sha256: scopeHash,
      preparation_sha256: preparationHash,
      nonce_sha256: await postgresPoolQualificationNonceHash(nonce),
      database_id: s.database_id,
      source_generation: s.database_generation - 1,
      node_uid: s.node_uid,
      boot_id: s.boot_id,
      pool_pod_uid: podUid,
      postgres_image_sha256: s.software.postgres_image.split("@sha256:")[1]!,
      device_major: 253,
      device_minor: 2,
      state: "read" as const,
      system_identifier: "7412345678901234567",
      timeline: 1,
      control_state: "shut down",
      observed_at: at,
      error: null,
    },
    storage_observation: {
      v: 1 as const,
      database_id: s.database_id,
      generation: s.database_generation - 1,
      node_uid: s.node_uid,
      boot_id: s.boot_id,
      storage: {
        backend: "lvm-thin-v1" as const,
        storage_generation: s.volume.storage_generation,
        storage_uid: s.volume.storage_uid,
        namespace_uid: s.volume.namespace_uid,
        cnpg_cluster_uid: s.volume.cluster_uid,
        pvc_uid: s.volume.pvc_uid,
        pv_uid: s.volume.pv_uid,
        volume_handle: s.volume.volume_handle,
        volume_group_uuid: s.volume.volume_group_uuid,
        lv_uuid: s.volume.lv_uuid,
        thin_id: s.thin_id,
        profile: s.storage,
      },
      kernel_proof: {
        device_major: 253,
        device_minor: 2,
        mount_id: null,
        dm_open_count: 0,
        foreign_mounts: 0,
        complete_namespace_scan: false as const,
        named_namespace_scan_complete: true,
        zero_before_bind: true,
        exclusive_superblock_creation: false,
        nonlazy_unmount_verified: true,
        never_attached_verified: false,
        creator_fence: null,
        mountpoint: null,
      },
      observed_at: at,
    },
  };
}

/** Structural counter vector for schema/authority tests, never a measured IO receipt. */
export function qualificationOrdinaryIoFixture(
  s: PostgresPoolQualificationScope,
): PostgresPoolQualificationOrdinaryIo {
  const work = 524288,
    file = 123,
    workers = [0, 1].map((i) => ({
      pid: 20 + i,
      start_ticks: 100 + i,
      pid_namespace: 0xeffffffc,
      cgroup_inode: 2001 + i,
      work_bytes: work,
      block_bytes: 4096 as const,
    })),
    inherited = [
      {
        cgroup_inode: 1000,
        write_bytes_per_second: s.storage.write_bytes_per_second,
        write_iops_per_second: s.storage.write_iops_per_second,
      },
    ],
    caps = {
      write_bytes_per_second: Math.max(
        1,
        Math.floor(s.storage.write_bytes_per_second / 4),
      ),
      write_iops_per_second: Math.max(
        1,
        Math.floor(s.storage.write_iops_per_second / 4),
      ),
    },
    phase = (second: boolean) => ({
      start_offset_nanoseconds: second ? 1010000000 : 0,
      end_offset_nanoseconds: second ? 5010000000 : 1000000000,
      scratch_file_inode: file,
      limits_before: second
        ? caps
        : { write_bytes_per_second: null, write_iops_per_second: null },
      limits_after: second
        ? caps
        : { write_bytes_per_second: null, write_iops_per_second: null },
      ancestor_before: {
        wbytes: 8192 + (second ? work * 2 : 0),
        wios: 2 + (second ? (work * 2) / 4096 : 0),
      },
      ancestor_after: {
        wbytes: 8192 + (second ? work * 4 : work * 2),
        wios: 2 + (second ? (work * 4) / 4096 : (work * 2) / 4096),
      },
      writers: workers.map((worker) => ({
        pid: worker.pid,
        start_ticks: worker.start_ticks,
        pid_namespace: worker.pid_namespace,
        cgroup_inode: worker.cgroup_inode,
        before: {
          wbytes: 4096 + (second ? work : 0),
          wios: 1 + (second ? work / 4096 : 0),
        },
        after: {
          wbytes: 4096 + (second ? work * 2 : work),
          wios: 1 + (second ? (work * 2) / 4096 : work / 4096),
        },
        completed_bytes: worker.work_bytes,
        completion_errno: 0,
      })),
    });
  return {
    purpose: "ordinary_direct_data_effectiveness",
    volume_handle: s.volume.volume_handle,
    scratch_relative_name: `.pgcf-q-io-${s.run_id}.bin`,
    scratch_file_inode: file,
    scratch_file_bytes: work * 2,
    device_major: 253,
    device_minor: 2,
    dedicated_group_inode: 2000,
    inherited_limits_before: inherited,
    inherited_limits_after: structuredClone(inherited),
    workers,
    baseline: phase(false),
    capped: phase(true),
    unlink_errno: 0,
    remaining_probe_processes: 0,
    remaining_probe_descriptors: 0,
    group_remove_errno: 0,
  };
}
