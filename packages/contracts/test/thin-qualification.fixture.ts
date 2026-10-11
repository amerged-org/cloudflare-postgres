// SPDX-License-Identifier: Apache-2.0
// Controlled evidence for contract and authority tests; never a live qualification result.
import {
  thinMetadataEstimateBytes,
  type ThinStorageProfile,
} from "../src/database-storage.ts";
import {
  THIN_QUALIFICATION_GATES,
  THIN_QUALIFICATION_LIMITS,
  thinQualificationGatePass,
  type ThinQualificationCleanup,
  type ThinQualificationEvidence,
  type ThinQualificationGates,
  type ThinQualificationSetup,
} from "../src/thin-qualification.ts";

const GIB = 1024 ** 3;
const lv = (seed: string) =>
  `${seed.repeat(6).slice(0, 6)}-${seed.repeat(4).slice(0, 4)}-${seed.repeat(4).slice(0, 4)}-${seed.repeat(4).slice(0, 4)}-${seed.repeat(4).slice(0, 4)}-${seed.repeat(4).slice(0, 4)}-${seed.repeat(6).slice(0, 6)}`;

export interface ThinQualificationFixtureOptions {
  node_uid: string;
  cluster_uid: string;
  host_extension_image: string;
  kernel_version: string;
  at: string;
}
/** Consistent evidence for one profile whose gates the shared evaluator accepts. */
export function thinQualificationFixture(
  profile: ThinStorageProfile,
  options: ThinQualificationFixtureOptions,
) {
  const chunk = THIN_QUALIFICATION_LIMITS.chunk_bytes,
    grown = Math.min(
      profile.maximum_data_bytes,
      profile.initial_data_bytes + profile.growth_bytes,
    ),
    pool = lv("P"),
    thick = {
      observed_at: options.at,
      thick_allocated_bytes: 5 * GIB,
      volumes: [
        {
          name: "pvc-11111111-1111-4111-8111-111111111111",
          lv_uuid: lv("T"),
          size_bytes: 5 * GIB,
          segtype: "linear",
        },
      ],
      claims: [
        {
          pv_name: "pvc-11111111-1111-4111-8111-111111111111",
          pv_uid: "21111111-1111-4111-8111-111111111111",
          pvc_uid: "11111111-1111-4111-8111-111111111111",
          namespace: "pgcf-db-abcdefghijklmnopqrst",
        },
      ],
      lvm_volumes: [
        {
          name: "pvc-11111111-1111-4111-8111-111111111111",
          uid: "31111111-1111-4111-8111-111111111111",
        },
      ],
      clusters: [
        {
          namespace: "pgcf-db-abcdefghijklmnopqrst",
          uid: "41111111-1111-4111-8111-111111111111",
          ready: true,
          continuous_archiving: true,
        },
      ],
    };
  const setup: ThinQualificationSetup = {
    identity: {
      node_uid: options.node_uid,
      cluster_uid: options.cluster_uid,
      boot_id: "51111111-1111-4111-8111-111111111111",
      system_uuid: "61111111-1111-4111-8111-111111111111",
      kernel_version: options.kernel_version,
      volume_group_uuid: lv("V"),
      volume_group_bytes: 103075020800,
      extent_bytes: 4 * 1024 ** 2,
      driver_pod_uid: "71111111-1111-4111-8111-111111111111",
      driver_image: profile.driver_image,
      driver_image_id: profile.driver_image,
      driver_sha256: "1".repeat(64),
      lvm_sha256: "2".repeat(64),
      tools_sha256: "3".repeat(64),
      thin_tools_version: "1.1.0",
      host_extension_image: options.host_extension_image,
      host_extension_version: "0.1.0",
      observed_at: options.at,
    },
    volume_group_free_bytes: 103075020800 - 5 * GIB,
    logical_volumes: thick.volumes,
    thick,
    pool: {
      pool_uuid: pool,
      data_bytes: profile.initial_data_bytes,
      metadata_bytes: profile.metadata_bytes,
      chunk_bytes: chunk,
      when_full: "error",
      zeroing: true,
      tags: [`pgcf.node.${options.node_uid}`],
    },
    namespace_uid: "81111111-1111-4111-8111-111111111111",
    storage_class_uid: "91111111-1111-4111-8111-111111111111",
    attributes_class_uid: "a1111111-1111-4111-8111-111111111111",
  };
  const status = (
    mode: "rw" | "out_of_data_space",
    used: number,
    total: number,
    metadata: number,
  ) => ({
    mode,
    used_data_blocks: used,
    total_data_blocks: total,
    used_metadata_blocks: metadata,
    total_metadata_blocks: profile.metadata_bytes / 4096,
    error_if_no_space: true,
    needs_check: false,
  });
  const evidence: ThinQualificationEvidence = {
    data_full: {
      pool_uuid_before: pool,
      pool_uuid_after: pool,
      pool_data_bytes_before: profile.initial_data_bytes,
      pool_data_bytes_after: grown,
      grow_target_bytes: grown,
      chunk_bytes: chunk,
      volumes_before: [lv("A"), lv("F")],
      volumes_after: [lv("F"), lv("A")],
      marker_committed: true,
      fill: {
        exit_code: 1,
        error: "enospc",
        written_bytes: profile.initial_data_bytes - 64 * 1024 ** 2,
        milliseconds: 21_400,
      },
      full: status(
        "out_of_data_space",
        profile.initial_data_bytes / chunk,
        profile.initial_data_bytes / chunk,
        1180,
      ),
      probe: {
        exit_code: 1,
        error: "enospc",
        written_bytes: 0,
        milliseconds: 20,
      },
      acknowledged_commits: 214,
      grown: status(
        "rw",
        profile.initial_data_bytes / chunk,
        grown / chunk,
        1180,
      ),
      restart_ready_milliseconds: 4_300,
      marker_present: true,
      acknowledged_present: 214,
      kernel_modes: ["out-of-data-space (error IO)", "write"],
    },
    metadata_full: {
      scratch: {
        pool_uuid: lv("S"),
        data_bytes: THIN_QUALIFICATION_LIMITS.metadata_pool_data_bytes,
        metadata_bytes: 4 * 1024 ** 2,
        marker_sha256: "4".repeat(64),
        exhaust: {
          exit_code: 1,
          error: "eio",
          written_bytes: 5_301_600_256,
          milliseconds: 9_800,
        },
        exhausted: {
          mode: "ro",
          used_data_blocks: 80_896,
          total_data_blocks: 196_608,
          used_metadata_blocks: 1024,
          total_metadata_blocks: 1024,
          error_if_no_space: true,
          needs_check: false,
        },
        probe: {
          exit_code: 1,
          error: "eio",
          written_bytes: 0,
          milliseconds: 10,
        },
        probe_used_data_blocks_before: 80_896,
        probe_used_data_blocks_after: 80_896,
        check_exit_code: 0,
        repair_exit_code: 0,
        activation_exit_code: 0,
        marker_sha256_after: "4".repeat(64),
      },
      maximum: {
        pool_uuid: pool,
        data_bytes: profile.maximum_data_bytes,
        metadata_bytes: profile.metadata_bytes,
        volumes: profile.maximum_volumes,
        written_bytes: profile.maximum_data_bytes,
        status: status(
          "out_of_data_space",
          profile.maximum_data_bytes / chunk,
          profile.maximum_data_bytes / chunk,
          Math.ceil(
            thinMetadataEstimateBytes(
              profile.maximum_data_bytes,
              profile.maximum_volumes,
            ) / 4096,
          ),
        ),
      },
    },
    noflush_quiescence: {
      writer: {
        lv_uuid: lv("W"),
        dirty_bytes: 41_943_040,
        suspend_milliseconds: 30,
        state: "SUSPENDED",
        lv_state: "s",
        write_sectors_first: 1_204_224,
        write_sectors_second: 1_204_224,
        used_data_blocks_first: 2_100,
        used_data_blocks_second: 2_100,
        observed_milliseconds: 3_000,
        resume_milliseconds: 20,
        drain_bytes: 41_943_040,
        drain_milliseconds: Math.min(
          9_000,
          profile.drain_seconds * 1000 - 1000,
        ),
        fsck_exit_code: 0,
      },
      full: {
        lv_uuid: lv("F"),
        pool: status(
          "out_of_data_space",
          profile.maximum_data_bytes / chunk,
          profile.maximum_data_bytes / chunk,
          2_000,
        ),
        suspend_milliseconds: 40,
        state: "SUSPENDED",
        resume_milliseconds: 20,
      },
    },
    resume_marker: {
      lv_uuid_before: lv("R"),
      lv_uuid_after: lv("R"),
      pool_uuid_before: pool,
      pool_uuid_after: pool,
      marker_committed: true,
      long_statement_active: true,
      suspended: true,
      resume_target_verified: true,
      changed_identity_refused: true,
      restart_ready_milliseconds: 3_900,
      marker_present: true,
      uncommitted_rows: 0,
    },
    startup_bound: {
      lv_uuid: lv("B"),
      chunk_bytes: chunk,
      used_data_blocks_before: 2_100,
      used_data_blocks_ready: 2_100 + 1_500,
      used_data_blocks_idle: 2_100 + 1_500,
      ready_milliseconds: 6_200,
      idle_milliseconds: 30_000,
      ext4_groups: 56,
      ext4_groups_zeroed: 56,
      io_limit: {
        write_bytes_per_second: profile.write_bytes_per_second,
        write_iops_per_second: profile.write_iops_per_second,
      },
      measured_write_bytes_per_second: profile.write_bytes_per_second,
      measured_write_iops_per_second: profile.write_iops_per_second,
      executor_cycle_milliseconds: Math.floor(profile.guard_seconds * 250),
    },
    trim_delete_recreate: {
      chunk_bytes: chunk,
      written_bytes: THIN_QUALIFICATION_LIMITS.trim_bytes,
      deleted_lv_uuid: lv("D"),
      used_data_blocks_baseline: 16,
      used_data_blocks_written:
        16 + THIN_QUALIFICATION_LIMITS.trim_bytes / chunk,
      used_data_blocks_deleted: 16,
      deleted_absent_lvs: true,
      deleted_absent_kernel: true,
      last_lv_uuid: lv("L"),
      pool_uuid_before: pool,
      pool_present_after_last: false,
      reinitialized_pool_uuid: lv("N"),
      recreated_lv_uuid: lv("C"),
      recreated_read_bytes: THIN_QUALIFICATION_LIMITS.trim_bytes,
      recreated_nonzero_bytes: 0,
    },
    retained_thick_preservation: {
      baseline: thick,
      after: { ...thick, observed_at: options.at },
      thin_profile_databases: 0,
    },
  };
  const gates = Object.fromEntries(
    THIN_QUALIFICATION_GATES.map((gate) => [
      gate,
      {
        pass: thinQualificationGatePass(gate, evidence[gate], profile),
        evidence: evidence[gate],
        measured_at: options.at,
      },
    ]),
  ) as ThinQualificationGates;
  const cleanup: ThinQualificationCleanup = {
    namespace_absent: true,
    storage_class_absent: true,
    attributes_class_absent: true,
    scratch_volumes_absent: true,
    pool_absent: true,
    spare_absent: true,
    logical_volumes_match_baseline: true,
    volume_group_free_bytes: setup.volume_group_free_bytes,
    baseline_free_bytes: setup.volume_group_free_bytes,
  };
  return { setup, evidence, gates, cleanup };
}
