// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  DesiredDatabaseStorage,
  ThinStorageProfile,
  thinWriteExposure,
  thinStorageClassObject,
  thinVolumeAttributesClassObject,
} from "../src/database-storage.ts";

describe("qualified thin storage authority", () => {
  it("accounts64KiB random-write allocation in both data and metadata without a free-space cap", () => {
    expect(thinWriteExposure(409600, 100)).toEqual({
      chunks: 107,
      data_bytes: 7012352,
      metadata_bytes: 16384,
    });
    expect(() =>
      thinWriteExposure(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    ).toThrow();
  });
  it("pins an immutable class and rejects arbitrary CSI classes", () => {
    const value = {
      backend: "lvm-thin-v1",
      storage_class: `pgcf-lvm-thin-v1-${"a".repeat(16)}`,
      volume_attributes_class: `pgcf-lvm-thin-v1-${"a".repeat(16)}`,
      profile_revision: 1,
      profile_sha256: "a".repeat(64),
      node_uid: "11111111-1111-4111-8111-111111111111",
      volume_group_uuid: "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef",
      pool_uuid: "bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg",
      startup_reserve_bytes: 128 * 1024 ** 2,
      write_bytes_per_second: 1024 ** 2,
      write_iops_per_second: 100,
      guard_seconds: 10,
      drain_seconds: 10,
    };
    expect(DesiredDatabaseStorage.parse(value)).toEqual(value);
    expect(
      DesiredDatabaseStorage.safeParse({ ...value, storage_class: "pgcf-lvm" })
        .success,
    ).toBe(false);
    expect(
      DesiredDatabaseStorage.safeParse({
        ...value,
        profile_sha256: "b".repeat(64),
      }).success,
    ).toBe(false);
  });
  it("bounds pool geometry and preserves legacy classes rather than using logical quotas", () => {
    const profile = {
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
    };
    // WBPS-only accounting would accept624MiB here; random-write chunk exposure exceeds2GiB.
    expect(
      ThinStorageProfile.safeParse({
        ...profile,
        guard_seconds: 120,
        drain_seconds: 120,
      }).success,
    ).toBe(false);
    const parsed = ThinStorageProfile.parse(profile);
    const object = thinStorageClassObject(parsed, "a".repeat(64));
    expect(object.parameters.thinProvision).toBe("yes");
    expect(object.parameters).toHaveProperty(
      "formatoptions",
      "-E lazy_itable_init=0,lazy_journal_init=0",
    );
    expect(
      thinVolumeAttributesClassObject(parsed, "a".repeat(64)).parameters
        .qosBandwithWritePerSec,
    ).toBe("1048576");
    expect(object.reclaimPolicy).toBe("Retain");
    expect(object.metadata).not.toHaveProperty(
      "annotations.storageclass.kubernetes.io/is-default-class",
    );
    expect(
      ThinStorageProfile.safeParse({ ...profile, metadata_bytes: 1024 ** 2 })
        .success,
    ).toBe(false);
    expect(
      ThinStorageProfile.safeParse({
        ...profile,
        initial_data_bytes: 64 * 1024 ** 2,
      }).success,
    ).toBe(false);
  });
});
