// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  thinLvmFacts,
  thinPoolCommand,
  thinIoLimit,
  thinPodCgroupPaths,
  thinWriterPods,
  thinDeletingVolume,
  assertThinStorageHostSettings,
} from "../src/thin-storage.ts";
import type {
  NodeThinStorageInput,
  NodeThinPoolAction,
} from "@pgcf/contracts/node-thin-storage";
const vg = "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef",
  pool = "bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg";
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
const input = {
  lease: {
    volume_group_uuid: vg,
    node_uid: "22222222-2222-4222-8222-222222222222",
    profile,
  },
} as NodeThinStorageInput;
test("thin host qualification requires actual bound verifier settings even when absent files would byte-match", () => {
  const keys = { cf: "A".repeat(43) },
    settings = {
      cloudflare: {
        node_id: "nod_abcdefghijklmnopqrst",
        node_uid: input.lease.node_uid,
        region_id: "us-dev",
        material_revision: 1,
        api_url: "https://api.invalid",
        agent_key_file: "/var/lib/pgcf-sandbox/agent-key",
        storage_authority: {
          keys,
          sha256: createHash("sha256")
            .update(JSON.stringify(keys))
            .digest("hex"),
          legacy_database_ids: [],
        },
      },
    };
  const scope = {
    ...input,
    lease: {
      ...input.lease,
      node_id: settings.cloudflare.node_id,
      region_id: settings.cloudflare.region_id,
      material_revision: 1,
      cluster_uid: "33333333-3333-4333-8333-333333333333",
      release_id: "guard-fixture",
      databases: [],
    },
    host_configuration: {
      status: {
        version: 1,
        node_id: settings.cloudflare.node_id,
        node_uid: input.lease.node_uid,
        region_id: settings.cloudflare.region_id,
        cluster_uid: "33333333-3333-4333-8333-333333333333",
        material_revision: 1,
        revision: 1,
        sha256: "a".repeat(64),
        release_id: "guard-fixture",
        pool_policy_revision: 1,
        profile_sha256: "b".repeat(64),
        created_at: "2026-10-09T00:00:00.000Z",
      },
      files: [
        {
          path: "/var/lib/pgcf-sandbox/settings.json",
          permissions: 384,
          content: JSON.stringify(settings),
        },
        {
          path: "/var/lib/pgcf-sandbox/agent-key",
          permissions: 384,
          content: "test-only\n",
        },
      ],
    },
    callback: {
      url: "https://api.invalid/internal/storage",
      bearer: "a".repeat(32),
    },
  } as NodeThinStorageInput;
  assert.doesNotThrow(() => assertThinStorageHostSettings(scope));
  const absent = structuredClone(scope);
  const cfg = JSON.parse(absent.host_configuration.files[0].content);
  delete cfg.cloudflare.storage_authority;
  absent.host_configuration.files[0].content = JSON.stringify(cfg);
  assert.throws(
    () => assertThinStorageHostSettings(absent),
    /host_guard_unqualified/,
  );
  const wrong = structuredClone(scope);
  const changed = JSON.parse(wrong.host_configuration.files[0].content);
  changed.cloudflare.storage_authority.sha256 = "f".repeat(64);
  wrong.host_configuration.files[0].content = JSON.stringify(changed);
  assert.throws(
    () => assertThinStorageHostSettings(wrong),
    /host_guard_unqualified/,
  );
  const rebound = structuredClone(scope);
  rebound.lease.material_revision = 2;
  assert.throws(
    () => assertThinStorageHostSettings(rebound),
    /host_guard_unqualified/,
  );
});
const action = {
  kind: "initialize",
  state: "pending",
  nonce: "op_abcdefghijklmnopqrst",
  target_data_bytes: 1024 ** 3,
  target_metadata_bytes: profile.metadata_bytes,
  expected_pool_uuid: null,
  driver_pod_uid: null,
  boot_id: null,
  dispatched_at: null,
  deadline_at: null,
} as NodeThinPoolAction;
function facts(rows: Record<string, unknown>[] = [], dm = "") {
  return thinLvmFacts(
    JSON.stringify({
      report: [
        {
          vg: [
            {
              vg_name: "pgcf",
              vg_uuid: vg,
              vg_size: "21474836480",
              vg_free: "19327352832",
              vg_extent_size: "4194304",
              vg_permissions: "writeable",
              vg_missing_pv_count: "0",
              pv_count: "1",
            },
          ],
        },
      ],
    }),
    JSON.stringify({ report: [{ lv: rows }] }),
    dm,
  );
}
const poolRow = {
  vg_uuid: vg,
  lv_name: "pgcf_thinpool",
  lv_uuid: pool,
  lv_size: "1073741824",
  segtype: "thin-pool",
  pool_lv: "",
  lv_attr: "twi-aotz--",
  data_percent: "0.00",
  metadata_percent: "0.30",
  lv_metadata_size: "134217728",
  lv_when_full: "error",
  lv_tags: `pgcf.node.${input.lease.node_uid},pgcf.action.${action.nonce}`,
};
test("complete LVM and kernel inventory retains internal IDs and refuses unexplained active devices", () => {
  const value = facts(
    [poolRow],
    `LVM-${vg.replaceAll("-", "")}${pool.replaceAll("-", "")}-tpool`,
  );
  assert.deepEqual(value.active, [pool]);
  assert.equal(value.physical.thin_pool?.data_used_bytes_upper_bound, 107375);
  assert.throws(
    () => facts([poolRow], `LVM-${vg.replaceAll("-", "")}${"d".repeat(32)}`),
    /thin_storage_kernel_lv_unexplained/,
  );
});
test("pool writes use bounded absolute sizes and never retry a dispatched unknown outcome", () => {
  const value = facts();
  assert.equal(thinPoolCommand(input, value, action)?.[0], "lvcreate");
  assert.throws(
    () => thinPoolCommand(input, value, { ...action, state: "dispatched" }),
    /thin_storage_initialize_outcome_unknown/,
  );
  assert.throws(
    () =>
      thinPoolCommand(input, value, {
        ...action,
        target_data_bytes: 9 * 1024 ** 3,
      }),
    /thin_storage_action_scope_changed/,
  );
  assert.equal(
    thinPoolCommand(input, facts([poolRow]), {
      ...action,
      state: "dispatched",
    }),
    null,
  );
  const grow = {
    ...action,
    kind: "grow",
    expected_pool_uuid: pool,
    target_data_bytes: 2 * 1024 ** 3,
  } as NodeThinPoolAction;
  assert.deepEqual(thinPoolCommand(input, facts([poolRow]), grow), [
    "lvextend",
    "--size",
    "2147483648B",
    "pgcf/pgcf_thinpool",
  ]);
  assert.throws(
    () =>
      thinPoolCommand(input, facts([poolRow]), {
        ...grow,
        state: "dispatched",
      }),
    /thin_storage_grow_outcome_unknown/,
  );
  const largerMetadata = {
    ...input,
    lease: {
      ...input.lease,
      profile: { ...profile, metadata_bytes: 256 * 1024 ** 2 },
    },
  } as NodeThinStorageInput;
  assert.deepEqual(
    thinPoolCommand(largerMetadata, facts([poolRow]), {
      ...grow,
      target_data_bytes: 1024 ** 3,
      target_metadata_bytes: 256 * 1024 ** 2,
    }),
    ["lvextend", "--poolmetadatasize", "268435456B", "pgcf/pgcf_thinpool"],
  );
});
test("physical IO proof requires exact device and finite caps on an identity-bound Pod cgroup", () => {
  assert.deepEqual(
    thinIoLimit("253:2 rbps=max wbps=1048576 riops=max wiops=100\n", 253, 2),
    { write_bytes_per_second: 1048576, write_iops_per_second: 100 },
  );
  assert.throws(() => thinIoLimit("253:2 wbps=max wiops=100", 253, 2));
  assert.throws(() => thinIoLimit("253:3 wbps=1 wiops=1", 253, 2));
  assert.throws(() => thinPodCgroupPaths("../../pgcf"));
  assert.equal(thinPodCgroupPaths(input.lease.node_uid).length, 7);
});

test("IO accounting retains unready and terminating writers until actual terminal task or DM quiescence proof", () => {
  const pod = (
    uid: string,
    phase: string,
    ready: boolean,
    deleting = false,
  ) => ({
    metadata: {
      uid,
      labels: { "cnpg.io/podRole": "instance" },
      ...(deleting ? { deletionTimestamp: "2026-10-09T00:00:00.000Z" } : {}),
    },
    status: {
      phase,
      conditions: [{ type: "Ready", status: ready ? "True" : "False" }],
    },
  });
  const list = [
    pod("unready", "Running", false),
    pod("terminating", "Running", false, true),
    pod("pending", "Pending", false),
    pod("complete", "Succeeded", false),
    pod("failed", "Failed", false),
  ];
  assert.deepEqual(
    thinWriterPods(list).map((p) => (p.metadata as { uid: string }).uid),
    ["unready", "terminating", "pending"],
  );
});

test("a fixed growth command survives concurrent thin usage but still refuses changed UUID or VG headroom", () => {
  const grow = {
    ...action,
    kind: "grow" as const,
    expected_pool_uuid: pool,
    target_data_bytes: 2 * 1024 ** 3,
  };
  const before = facts([poolRow]);
  const during = facts([
    { ...poolRow, data_percent: "50.00", metadata_percent: "0.50" },
  ]);
  assert.deepEqual(
    thinPoolCommand(input, before, grow),
    thinPoolCommand(input, during, grow),
  );
  assert.throws(
    () =>
      thinPoolCommand(
        input,
        { ...during, pool_uuid: "defghi-defg-defg-defg-defg-defg-defghi" },
        grow,
      ),
    /thin_storage_pool_identity_changed/,
  );
  assert.throws(
    () => thinPoolCommand(input, { ...during, free: 0 }, grow),
    /thin_storage_growth_unqualified/,
  );
});

test("only a genuine current delete retains its sealed LV after Kube resource removal", () => {
  const receipt = {
    storage_generation: 1,
    storage_uid: "11111111-1111-4111-8111-111111111111",
    namespace_uid: "22222222-2222-4222-8222-222222222222",
    cluster_uid: "33333333-3333-4333-8333-333333333333",
    node_uid: input.lease.node_uid,
    volume_group_uuid: vg,
    pool_uuid: pool,
    volume_handle: "pvc-44444444-4444-4444-8444-444444444444",
    lv_uuid: "cdefgh-cdef-cdef-cdef-cdef-cdef-cdefgh",
    pvc_uid: "44444444-4444-4444-8444-444444444444",
    pv_uid: "55555555-5555-4555-8555-555555555555",
  };
  const policy = {
    backend: "lvm-thin-v1",
    storage_class: "pgcf-lvm-thin-v1-" + "a".repeat(16),
    volume_attributes_class: "pgcf-lvm-thin-v1-" + "a".repeat(16),
    profile_revision: 1,
    profile_sha256: "a".repeat(64),
    node_uid: receipt.node_uid,
    volume_group_uuid: vg,
    pool_uuid: pool,
    startup_reserve_bytes: profile.startup_reserve_bytes,
    write_bytes_per_second: profile.write_bytes_per_second,
    write_iops_per_second: profile.write_iops_per_second,
    guard_seconds: 10,
    drain_seconds: 10,
  } as const;
  const db = {
    id: "abcdefghijklmnopqrst",
    generation: 2,
    storage_generation: 1,
    desired_state: "deleted",
    archive_path: "s3://test/database",
    power_operation: null,
    stop_operation: {
      operation_id: "op_abcdefghijklmnopqrst",
      kind: "database.delete",
      generation: 2,
    },
    storage: policy,
    volume: receipt,
    startup: null,
  } as const;
  const actual = facts([
    poolRow,
    {
      vg_uuid: vg,
      lv_name: receipt.volume_handle,
      lv_uuid: receipt.lv_uuid,
      lv_size: String(5 * 1024 ** 3),
      segtype: "thin",
      pool_lv: "pgcf_thinpool",
      lv_attr: "Vwi-s-tz--",
      data_percent: "1.00",
      metadata_percent: "",
      lv_metadata_size: "",
      lv_when_full: "",
      lv_tags: "",
    },
  ]);
  const scope = { ...input.lease, name: "actual-node" };
  assert.equal(
    thinDeletingVolume(scope, db, actual, {})?.lv_uuid,
    receipt.lv_uuid,
  );
  assert.equal(
    thinDeletingVolume(scope, { ...db, stop_operation: null }, actual, {}),
    null,
  );
  assert.equal(
    thinDeletingVolume(scope, { ...db, desired_state: "running" }, actual, {}),
    null,
  );
  assert.throws(
    () =>
      thinDeletingVolume(
        scope,
        db,
        { ...actual, pool_uuid: "defghi-defg-defg-defg-defg-defg-defghi" },
        {},
      ),
    /retained_delete_identity_changed/,
  );
  assert.throws(
    () =>
      thinDeletingVolume(scope, db, actual, {
        namespace: { metadata: { uid: "replacement" } },
      }),
    /retained_delete_identity_changed/,
  );
});
