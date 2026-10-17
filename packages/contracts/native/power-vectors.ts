// SPDX-License-Identifier: Apache-2.0
// These fixtures are conformance inputs, never live acceptance or product defaults.
const uid = (n: number) =>
  `01234567-89ab-4def-8123-${n.toString(16).padStart(12, "0")}`;

export async function physicalReclamationVectors() {
  const {
    DesiredDatabaseStorage,
    NodeThinStorageAuthority,
    thinStorageVolumeReclaimed,
  } = await import("../src/database-storage.ts");
  const storage = DesiredDatabaseStorage.parse({
    backend: "lvm-thin-v1",
    storage_class: "pgcf-lvm-thin-v1-aaaaaaaaaaaaaaaa",
    volume_attributes_class: "pgcf-lvm-thin-v1-aaaaaaaaaaaaaaaa",
    profile_revision: 1,
    profile_sha256: "a".repeat(64),
    node_uid: uid(4),
    volume_group_uuid: "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef",
    pool_uuid: "bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg",
    startup_reserve_bytes: 1048576,
    write_bytes_per_second: 1048576,
    write_iops_per_second: 10,
    guard_seconds: 2,
    drain_seconds: 1,
  });
  const authority = NodeThinStorageAuthority.parse({
    node_id: `nod_${"n".repeat(20)}`,
    name: "native-test-node",
    node_uid: uid(4),
    cluster_uid: uid(5),
    revision: 3,
    profile_revision: 1,
    profile_sha256: storage.profile_sha256,
    storage_class: storage.storage_class,
    volume_group_uuid: storage.volume_group_uuid,
    pool_uuid: null,
    driver_pod_uid: uid(6),
    driver_image: `ghcr.io/test/driver@sha256:${"b".repeat(64)}`,
    observed_at: new Date(100001).toISOString(),
    captured_at: new Date(100001).toISOString(),
    expires_at: new Date(102001).toISOString(),
    write_allowed: false,
    physical: {
      volume_group_uuid: storage.volume_group_uuid,
      total_bytes: 10000000,
      free_bytes: 10000000,
      thick_allocated_bytes: 0,
      thin_pool: null,
    },
    physical_lvs: [],
    active_lv_uuids: [],
    data_accounting_complete: true,
    protections: [],
    volumes: [],
  });
  const lv = "cdefgh-cdef-cdef-cdef-cdef-cdef-cdefgh";
  const variants: Array<[string, typeof authority]> = [
    ["reclaimed_after_last_pool_removed", authority],
    [
      "physical_lv_still_present",
      {
        ...authority,
        physical_lvs: [
          { name: "owned", lv_uuid: lv, size_bytes: 1048576, segtype: "thin" },
        ],
      },
    ],
    [
      "active_kernel_device_still_present",
      { ...authority, active_lv_uuids: [lv] },
    ],
    [
      "physical_accounting_incomplete",
      { ...authority, data_accounting_complete: false },
    ],
    [
      "stale_predelete_report",
      { ...authority, observed_at: new Date(99999).toISOString() },
    ],
    ["replacement_node_uid", { ...authority, node_uid: uid(999) }],
    // A fast renewal after the deletion carries an identity read from before it.
    [
      "renewed_after_identity_read_before_deletion",
      {
        ...authority,
        inventory_observed_at: new Date(99999).toISOString(),
        inventory_expires_at: new Date(99999 + 300000).toISOString(),
        inventory_revision: 2,
      },
    ],
    // An identity read after the deletion stays a proof after its last renewal expired.
    [
      "identity_read_after_deletion_outlives_renewal",
      {
        ...authority,
        expires_at: new Date(100002).toISOString(),
        inventory_observed_at: new Date(100001).toISOString(),
        inventory_expires_at: new Date(100001 + 300000).toISOString(),
        inventory_revision: 3,
      },
    ],
  ];
  return variants.map(([name, value]) => ({
    name,
    db: { node: "native-test-node", storage },
    nodes: [NodeThinStorageAuthority.parse(value)],
    lv,
    after: 100000,
    now: 100002,
    expected: thinStorageVolumeReclaimed(storage, value, lv, 100000, 100002),
  }));
}
