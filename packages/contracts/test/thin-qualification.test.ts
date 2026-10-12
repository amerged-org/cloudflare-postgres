// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ThinStorageProfile } from "../src/database-storage.ts";
import { ThinStorageQualification } from "../src/releases.ts";
import {
  ThinQualificationRequest,
  ThinQualificationResumeMarker,
  thinQualificationGatePass,
  thinQualificationPassed,
  thinQualificationReceiptMaterial,
  thinStorageQualificationFromRun,
  type ThinQualificationRun,
  THIN_QUALIFICATION_LIMITS,
} from "../src/thin-qualification.ts";
import { thinQualificationFixture } from "./thin-qualification.fixture.ts";

const profile = ThinStorageProfile.parse({
  version: 1,
  driver_image: `ghcr.io/amerged-org/pgcf-regional:lvm-thin-sha-${"a".repeat(40)}@sha256:${"b".repeat(64)}`,
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
});
const at = "2026-10-11T10:00:00.000Z";
const hostImage = `ghcr.io/amerged-org/pgcf-regional:sandbox-extension-sha-${"c".repeat(40)}@sha256:${"c".repeat(64)}`;
function sample() {
  return thinQualificationFixture(profile, {
    node_uid: "11111111-2222-4333-8444-555555555555",
    cluster_uid: "66666666-7777-4888-8999-aaaaaaaaaaaa",
    host_extension_image: hostImage,
    kernel_version: "6.18.51-talos",
    at,
  });
}
function run(overrides: Partial<ThinQualificationRun> = {}) {
  const value = sample();
  return {
    status: "completed" as const,
    profile,
    profile_sha256: "d".repeat(64),
    driver_image: profile.driver_image,
    host_extension_image: hostImage,
    kernel_version: "6.18.51-talos",
    receipt_sha256: "e".repeat(64),
    qualified_at: at,
    setup: value.setup,
    gates: value.gates,
    cleanup: value.cleanup,
    ...overrides,
  };
}

describe("thin storage qualification producer contract", () => {
  it("the metadata scratch pool has more chunks than its rounded-up metadata can map", () => {
    const limits = THIN_QUALIFICATION_LIMITS,
      extent = 4 * 1024 ** 2,
      metadata =
        Math.ceil(limits.metadata_pool_metadata_bytes / extent) * extent;
    // Measured with the pinned driver image: sequential 64 KiB chunks pack at most about 216
    // mappings per 4 KiB dm-thin metadata block, so one 4 MiB extent maps about 13.5 GiB.
    const mappable = (metadata / limits.metadata_block_bytes) * 216;
    expect(
      limits.metadata_pool_data_bytes / limits.chunk_bytes,
    ).toBeGreaterThan(mappable * 1.15);
  });
  it("bounds requests to growable profiles inside the producer's volume bound", () => {
    const request = {
      node_uid: "11111111-2222-4333-8444-555555555555",
      address: "192.0.2.10",
      profile,
    };
    expect(ThinQualificationRequest.safeParse(request).success).toBe(true);
    expect(
      ThinQualificationRequest.safeParse({
        ...request,
        profile: { ...profile, initial_data_bytes: profile.maximum_data_bytes },
      }).success,
    ).toBe(false);
    expect(
      ThinQualificationRequest.safeParse({
        ...request,
        profile: { ...profile, maximum_volumes: 257 },
      }).success,
    ).toBe(false);
  });

  it("a completed run yields exactly one release receipt and nothing else yields one", () => {
    const qualification = thinStorageQualificationFromRun(run());
    expect(ThinStorageQualification.parse(qualification)).toEqual({
      profile_sha256: "d".repeat(64),
      driver_image: profile.driver_image,
      host_extension_image: hostImage,
      kernel_version: "6.18.51-talos",
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
    });
    expect(() =>
      thinStorageQualificationFromRun(run({ status: "failed" })),
    ).toThrow("thin_qualification_incomplete");
    const missing = run();
    delete missing.gates.resume_marker;
    expect(() => thinStorageQualificationFromRun(missing)).toThrow();
    // A stored pass flag is never trusted over the evidence it describes.
    const forged = run();
    forged.gates.trim_delete_recreate!.evidence.recreated_nonzero_bytes = 4096;
    expect(() => thinStorageQualificationFromRun(forged)).toThrow();
    const dirty = run();
    dirty.cleanup = { ...dirty.cleanup!, pool_absent: false };
    expect(thinQualificationPassed(dirty)).toBe(false);
    expect(
      thinQualificationReceiptMaterial({
        ...run(),
        id: "op_abcdefghijklmnopqrst",
        node_id: "nod_abcdefghijklmnopqrst",
        region_id: "eu-dev",
        node_uid: "11111111-2222-4333-8444-555555555555",
        release_id: "r2",
        spec_sha256: "f".repeat(64),
        postgres_image: `registry.example/postgres@sha256:${"1".repeat(64)}`,
      }).gates,
    ).toEqual(run().gates);
  });

  it("data_full needs a fast error on the full pool and every acknowledged commit after growth", () => {
    const { evidence } = sample();
    expect(
      thinQualificationGatePass("data_full", evidence.data_full, profile),
    ).toBe(true);
    // Queue mode would hang writers instead of failing them.
    expect(
      thinQualificationGatePass(
        "data_full",
        {
          ...evidence.data_full,
          full: { ...evidence.data_full.full, error_if_no_space: false },
        },
        profile,
      ),
    ).toBe(false);
    expect(
      thinQualificationGatePass(
        "data_full",
        {
          ...evidence.data_full,
          probe: { ...evidence.data_full.probe, milliseconds: 10_001 },
        },
        profile,
      ),
    ).toBe(false);
    expect(
      thinQualificationGatePass(
        "data_full",
        { ...evidence.data_full, acknowledged_present: 213 },
        profile,
      ),
    ).toBe(false);
  });

  it("metadata_full fails closed below the floor and keeps the maximum pool inside its reserve", () => {
    const { evidence } = sample(),
      value = evidence.metadata_full;
    expect(thinQualificationGatePass("metadata_full", value, profile)).toBe(
      true,
    );
    expect(
      thinQualificationGatePass(
        "metadata_full",
        {
          ...value,
          scratch: {
            ...value.scratch,
            exhausted: { ...value.scratch.exhausted, mode: "rw" },
          },
        },
        profile,
      ),
    ).toBe(false);
    expect(
      thinQualificationGatePass(
        "metadata_full",
        {
          ...value,
          scratch: { ...value.scratch, probe_used_data_blocks_after: 80_897 },
        },
        profile,
      ),
    ).toBe(false);
    expect(
      thinQualificationGatePass(
        "metadata_full",
        {
          ...value,
          maximum: {
            ...value.maximum,
            status: {
              ...value.maximum.status,
              used_metadata_blocks: (96 * 1024 ** 2) / 4096 + 1,
            },
          },
        },
        profile,
      ),
    ).toBe(false);
    // A refused activation is fail-closed only without a claimed data readback.
    expect(
      thinQualificationGatePass(
        "metadata_full",
        {
          ...value,
          scratch: {
            ...value.scratch,
            activation_exit_code: 5,
            marker_sha256_after: null,
          },
        },
        profile,
      ),
    ).toBe(true);
  });

  it("noflush_quiescence requires frozen writes, no new chunks and a bounded drain", () => {
    const value = sample().evidence.noflush_quiescence;
    expect(
      thinQualificationGatePass("noflush_quiescence", value, profile),
    ).toBe(true);
    expect(
      thinQualificationGatePass(
        "noflush_quiescence",
        {
          ...value,
          writer: { ...value.writer, write_sectors_second: 1_204_232 },
        },
        profile,
      ),
    ).toBe(false);
    expect(
      thinQualificationGatePass(
        "noflush_quiescence",
        {
          ...value,
          writer: { ...value.writer, drain_bytes: 7 * 1024 ** 3 + 1 },
        },
        profile,
      ),
    ).toBe(false);
  });

  it("resume_marker keeps the committed marker and never the uncommitted statement", () => {
    const value = sample().evidence.resume_marker;
    expect(thinQualificationGatePass("resume_marker", value, profile)).toBe(
      true,
    );
    expect(
      thinQualificationGatePass(
        "resume_marker",
        { ...value, uncommitted_rows: 1 },
        profile,
      ),
    ).toBe(false);
    // The run never resumes a changed identity, so it records no such refusal.
    expect(
      ThinQualificationResumeMarker.safeParse({
        ...value,
        changed_identity_refused: true,
      }).success,
    ).toBe(false);
  });

  it("startup_bound bounds the start, the cgroup limit and the executor turn", () => {
    const value = sample().evidence.startup_bound;
    expect(thinQualificationGatePass("startup_bound", value, profile)).toBe(
      true,
    );
    expect(
      thinQualificationGatePass(
        "startup_bound",
        { ...value, executor_cycle_milliseconds: 5_000 },
        profile,
      ),
    ).toBe(false);
    expect(
      thinQualificationGatePass(
        "startup_bound",
        { ...value, ext4_groups_zeroed: 55 },
        profile,
      ),
    ).toBe(false);
  });

  it("trim_delete_recreate returns extents and reads back no residual data", () => {
    const value = sample().evidence.trim_delete_recreate;
    expect(
      thinQualificationGatePass("trim_delete_recreate", value, profile),
    ).toBe(true);
    expect(
      thinQualificationGatePass(
        "trim_delete_recreate",
        { ...value, reinitialized_pool_uuid: null },
        profile,
      ),
    ).toBe(false);
    expect(
      thinQualificationGatePass(
        "trim_delete_recreate",
        { ...value, used_data_blocks_deleted: 17 },
        profile,
      ),
    ).toBe(false);
  });

  it("retained_thick_preservation needs unchanged thick identities and no thin databases", () => {
    const value = sample().evidence.retained_thick_preservation;
    expect(
      thinQualificationGatePass("retained_thick_preservation", value, profile),
    ).toBe(true);
    expect(
      thinQualificationGatePass(
        "retained_thick_preservation",
        {
          ...value,
          after: {
            ...value.after,
            clusters: [{ ...value.after.clusters[0]!, ready: false }],
          },
        },
        profile,
      ),
    ).toBe(false);
    expect(
      thinQualificationGatePass(
        "retained_thick_preservation",
        { ...value, thin_profile_databases: 1 },
        profile,
      ),
    ).toBe(false);
  });
});
