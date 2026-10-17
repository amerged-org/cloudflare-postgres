// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  DesiredDatabaseStorage,
  NodeThinStorageAuthority,
  THIN_INVENTORY_INTERVAL_SECONDS,
  THIN_INVENTORY_MAX_SECONDS,
  thinStorageVolumeReclaimed,
} from "../src/database-storage.ts";
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
  it("publishes the inventory constants", () => {
    expect(THIN_INVENTORY_MAX_SECONDS).toBe(300);
    expect(THIN_INVENTORY_INTERVAL_SECONDS).toBe(60);
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

describe("the desired region's storage nodes", () => {
  it("carries a storage node's thin pool room in write_allowed and no field the deployed controller refuses", () => {
    const region = {
      id: "eu-test",
      backup: {
        bucket: "pgcf-backups",
        endpoint_url: "https://r2.example.invalid",
        region: "auto",
      },
    };
    for (const room of [true, false])
      expect(
        DesiredRegion.parse({
          ...region,
          storage_nodes: [composed({ write_allowed: room })],
        }).storage_nodes![0]!.write_allowed,
      ).toBe(room);
    expect(
      DesiredRegion.safeParse({
        ...region,
        storage_nodes: [composed({ room: true })],
      }).success,
    ).toBe(false);
  });
});
