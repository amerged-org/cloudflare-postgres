// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  DesiredDatabaseStorage,
  NodeThinStorageAuthority,
  THIN_INVENTORY_INTERVAL_SECONDS,
  THIN_INVENTORY_MAX_SECONDS,
  thinStorageSamplePeriodMilliseconds,
  thinStorageVolumeReclaimed,
} from "../src/database-storage.ts";
import {
  NodeStorageHeadroomResponse,
  NodeStorageHeadroomSample,
  ThinStorageSampleTarget,
} from "../src/node-thin-storage.ts";
import { DesiredRegion } from "../src/agent.ts";

const uid = (n: number) =>
  `01234567-89ab-4def-8123-${n.toString(16).padStart(12, "0")}`;
const vg = "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef",
  pool = "bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg",
  lv = "cdefgh-cdef-cdef-cdef-cdef-cdef-cdefgh",
  image = `ghcr.io/test/driver@sha256:${"b".repeat(64)}`,
  at = (ms: number) => new Date(ms).toISOString();
const storage = DesiredDatabaseStorage.parse({
  backend: "lvm-thin-v1",
  storage_class: "pgcf-lvm-thin-v1-aaaaaaaaaaaaaaaa",
  volume_attributes_class: "pgcf-lvm-thin-v1-aaaaaaaaaaaaaaaa",
  profile_revision: 1,
  profile_sha256: "a".repeat(64),
  node_uid: uid(4),
  volume_group_uuid: vg,
  pool_uuid: pool,
  startup_reserve_bytes: 1048576,
  write_bytes_per_second: 1048576,
  write_iops_per_second: 10,
  guard_seconds: 10,
  drain_seconds: 10,
});
const physical = {
  volume_group_uuid: vg,
  total_bytes: 100 * 1024 ** 3,
  free_bytes: 90 * 1024 ** 3,
  thick_allocated_bytes: 0,
  thin_pool: {
    name: "pgcf_thinpool" as const,
    data_total_bytes: 8 * 1024 ** 3,
    data_used_bytes_upper_bound: 1024 ** 3,
    metadata_total_bytes: 128 * 1024 ** 2,
    metadata_used_bytes_upper_bound: 1024 ** 2,
  },
};
/** A composed authority: identity read at 100 s, renewed from a sample whose nonce was issued at 160 s. */
function composed(overrides: Record<string, unknown> = {}) {
  return {
    node_id: `nod_${"n".repeat(20)}`,
    name: "native-test-node",
    node_uid: uid(4),
    cluster_uid: uid(5),
    revision: 9,
    profile_revision: 1,
    profile_sha256: storage.profile_sha256,
    storage_class: storage.storage_class,
    volume_group_uuid: vg,
    pool_uuid: pool,
    driver_pod_uid: uid(6),
    driver_image: image,
    observed_at: at(160_000),
    captured_at: at(160_400),
    expires_at: at(170_000),
    write_allowed: true,
    physical,
    physical_lvs: [],
    active_lv_uuids: [],
    data_accounting_complete: true,
    protections: [],
    volumes: [],
    inventory_observed_at: at(100_000),
    inventory_expires_at: at(100_000 + THIN_INVENTORY_MAX_SECONDS * 1000),
    inventory_revision: 3,
    ...overrides,
  };
}

describe("thin write authority from an identity proof and a fresher reading", () => {
  it("publishes the inventory constants and the guard-derived sample period", () => {
    expect(THIN_INVENTORY_MAX_SECONDS).toBe(300);
    expect(THIN_INVENTORY_INTERVAL_SECONDS).toBe(60);
    expect(thinStorageSamplePeriodMilliseconds(10)).toBe(2000);
    expect(thinStorageSamplePeriodMilliseconds(120)).toBe(24_000);
    expect(() => thinStorageSamplePeriodMilliseconds(0)).toThrow();
  });

  it("never lets the composed authority outlive or predate its identity proof", () => {
    expect(NodeThinStorageAuthority.safeParse(composed()).success).toBe(true);
    // An executor report from before this change carries no identity-proof fields.
    const legacy: Record<string, unknown> = composed();
    delete legacy.inventory_observed_at;
    delete legacy.inventory_expires_at;
    delete legacy.inventory_revision;
    expect(NodeThinStorageAuthority.safeParse(legacy).success).toBe(true);
    for (const invalid of [
      // expires_at > inventory_expires_at
      {
        observed_at: at(395_000),
        expires_at: at(401_000),
      },
      // A proof valid longer than THIN_INVENTORY_MAX_SECONDS
      { inventory_expires_at: at(100_001 + THIN_INVENTORY_MAX_SECONDS * 1000) },
      // The reading is older than the identity read it was composed with.
      { inventory_observed_at: at(160_001) },
      { inventory_expires_at: at(100_000) },
      // The identity revision never runs ahead of the composed revision.
      { inventory_revision: 10 },
      // All three identity-proof fields or none.
      { inventory_revision: undefined },
    ])
      expect(
        NodeThinStorageAuthority.safeParse(composed(invalid)).success,
        JSON.stringify(invalid),
      ).toBe(false);
  });

  it("confirms a reclaimed LV only from an identity read after the deletion, never from a fast renewal", () => {
    const absent = NodeThinStorageAuthority.parse(composed());
    // The fast reading at 160 s is after the deletion at 120 s, the identity read at 100 s is not.
    expect(
      thinStorageVolumeReclaimed(storage, absent, lv, 120_000, 165_000),
    ).toBe(false);
    expect(
      thinStorageVolumeReclaimed(storage, absent, lv, 90_000, 165_000),
    ).toBe(true);
    // An identity proof stays usable after the composed authority expired, but not after its own expiry.
    expect(
      thinStorageVolumeReclaimed(storage, absent, lv, 90_000, 175_000),
    ).toBe(true);
    expect(
      thinStorageVolumeReclaimed(
        storage,
        NodeThinStorageAuthority.parse(
          composed({
            observed_at: at(100_000),
            captured_at: at(100_000),
            expires_at: at(105_000),
            inventory_expires_at: at(105_000),
          }),
        ),
        lv,
        90_000,
        106_000,
      ),
    ).toBe(false);
  });
});

describe("headroom samples against a Cloudflare nonce", () => {
  const sample = () => ({
    nonce: "0123456789abcdef0123456789abcdef",
    node_uid: uid(4),
    captured_at: at(160_100),
    physical,
    lvs: [
      {
        name: "pgcf_thinpool",
        segtype: "thin-pool",
        size_bytes: 8 * 1024 ** 3,
      },
      {
        name: "pvc-11111111-1111-4111-8111-111111111111",
        segtype: "thin",
        size_bytes: 5 * 1024 ** 3,
      },
    ],
    lv_count: 2,
    witnesses: {
      cluster_uid: uid(5),
      boot_id: uid(7),
      volume_group_uuid: vg,
      driver_pod_uid: uid(6),
      driver_image: image,
    },
    scrape_milliseconds: 180,
  });

  it("accepts one complete exporter scrape, or none with a null nonce", () => {
    expect(NodeStorageHeadroomSample.parse(sample())).toEqual(sample());
    expect(
      NodeStorageHeadroomSample.safeParse({ ...sample(), nonce: null }).success,
    ).toBe(true);
    expect(
      NodeStorageHeadroomSample.parse({ ...sample(), qualification_run: null })
        .qualification_run,
    ).toBeNull();
    expect(
      NodeStorageHeadroomSample.parse({
        ...sample(),
        qualification_run: `op_${"q".repeat(20)}`,
      }).qualification_run,
    ).toBe(`op_${"q".repeat(20)}`);
    for (const invalid of [
      // The LV series must number exactly the volume group's LV count.
      { lv_count: 3 },
      { nonce: "0123456789ABCDEF0123456789abcdef" },
      { nonce: "0123456789abcdef" },
      { qualification_run: "not-a-run" },
      // The scrape belongs to the witnessed volume group.
      {
        witnesses: { ...sample().witnesses, volume_group_uuid: pool },
      },
      { lvs: [...sample().lvs, sample().lvs[1]], lv_count: 3 },
      {
        physical: {
          ...physical,
          thin_pool: { ...physical.thin_pool, name: "other" },
        },
      },
    ])
      expect(
        NodeStorageHeadroomSample.safeParse({ ...sample(), ...invalid })
          .success,
        JSON.stringify(invalid),
      ).toBe(false);
  });

  it("renews or refuses explicitly and always hands out the next nonce", () => {
    const renewed = {
      accepted: true,
      reason: null,
      nonce: "fedcba9876543210fedcba9876543210",
      period_milliseconds: 2000,
      authority: NodeThinStorageAuthority.parse(composed()),
      tokens: [{ database_id: "a".repeat(20), token: "sa1.e30.e30" }],
    };
    expect(NodeStorageHeadroomResponse.parse(renewed)).toEqual(renewed);
    const refused = {
      ...renewed,
      accepted: false,
      reason: "thin_storage_sample_witness_changed",
      authority: null,
      tokens: [],
    };
    expect(NodeStorageHeadroomResponse.parse(refused)).toEqual(refused);
    for (const invalid of [
      { ...refused, authority: renewed.authority },
      { ...refused, tokens: renewed.tokens },
      { ...renewed, reason: "thin_storage_sample_witness_changed" },
      { ...refused, reason: null },
      { ...refused, reason: "witness_changed" },
    ])
      expect(NodeStorageHeadroomResponse.safeParse(invalid).success).toBe(
        false,
      );
    // A qualification run's sample is recorded without authority or tokens.
    expect(
      NodeStorageHeadroomResponse.safeParse({
        ...renewed,
        authority: null,
        tokens: [],
      }).success,
    ).toBe(true);
  });

  it("names each sampled node once in the desired region, with its period and qualification run", () => {
    const target = {
      node_id: `nod_${"n".repeat(20)}`,
      name: "native-test-node",
      node_uid: uid(4),
      period_milliseconds: 2000,
      qualification_run: null,
    };
    expect(ThinStorageSampleTarget.parse(target)).toEqual(target);
    expect(
      ThinStorageSampleTarget.safeParse({ ...target, period_milliseconds: 100 })
        .success,
    ).toBe(false);
    const region = {
      id: "eu-test",
      backup: {
        bucket: "pgcf-backups",
        endpoint_url: "https://r2.example.invalid",
        region: "auto",
      },
    };
    expect(
      DesiredRegion.safeParse({
        ...region,
        storage_samples: [
          target,
          {
            ...target,
            node_id: `nod_${"m".repeat(20)}`,
            node_uid: uid(9),
            qualification_run: `op_${"q".repeat(20)}`,
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      DesiredRegion.safeParse({ ...region, storage_samples: [target, target] })
        .success,
    ).toBe(false);
  });
});
