// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import {
  DatabaseWithOperation,
  newOperationId,
  DesiredDatabaseStorage,
} from "@pgcf/contracts";
import { cleanupFixtures } from "./fixtures.ts";
import { thinExecutionFixture } from "./thin-execution-fixture.ts";
import { refreshNodeThinStorageMaterial } from "../../src/domain/node-thin-storage-material.ts";
import {
  reserveThinStorageLease,
  thinStorageInput,
  recordThinStorageReport,
  storageHoldSnapshotSql,
} from "../../src/domain/node-thin-storage-execution.ts";
import { ensureNodeHostConfiguration } from "../../src/domain/node-host-configuration.ts";
import {
  storeRegionJoinBundle,
  joinBundleReference,
} from "../../src/crypto/bootstrap-credentials.ts";
import sources from "../../../../infra/storage/sources.lock.json" with { type: "json" };
const releases: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
it("grows an existing measured pool for a queued first logical-quota startup without ordering a node", async () => {
  const f = await thinExecutionFixture(releases),
    created = DatabaseWithOperation.parse(await (await f.create()).json());
  expect(
    await env.DB.prepare("SELECT node_id FROM databases WHERE id=?")
      .bind(created.database.id)
      .first("node_id"),
  ).toBeNull();
  const lease = await reserveThinStorageLease(f.local, f.node);
  expect(JSON.parse(lease!.action_json!)).toMatchObject({
    kind: "grow",
    state: "pending",
    expected_pool_uuid: f.authority.pool_uuid,
  });
  expect(
    JSON.parse(lease!.action_json!).target_data_bytes,
  ).toBeGreaterThanOrEqual(5 * 1024 ** 3 + f.profile.data_reserve_bytes);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM node_additions WHERE region_id=?",
    )
      .bind(f.region)
      .first("n"),
  ).toBe(0);
});
it("the actual report CAS rejects a startup hold admitted after its captured hold inventory", async () => {
  const f = await thinExecutionFixture(releases);
  const authority = {
    ...f.authority,
    physical: {
      ...f.authority.physical,
      free_bytes: 91 * 1024 ** 3,
      thin_pool: {
        ...f.authority.physical.thin_pool!,
        data_total_bytes: 8 * 1024 ** 3,
      },
    },
  };
  await env.DB.prepare(
    "UPDATE node_thin_storage SET authority_json=? WHERE node_id=?",
  )
    .bind(JSON.stringify(authority), f.node)
    .run();
  const captured: string[] = [];
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  const held = await env.DB.prepare(
    "SELECT operation_id,storage_budget_bytes FROM database_start_admissions WHERE database_id=?",
  )
    .bind(created.database.id)
    .first<{ operation_id: string; storage_budget_bytes: number }>();
  expect(held?.storage_budget_bytes).toBe(5 * 1024 ** 3);
  const commit = (ids: string[]) =>
    env.DB.prepare(
      `UPDATE node_thin_storage SET updated_at=updated_at WHERE node_id=? AND ${storageHoldSnapshotSql}`,
    )
      .bind(f.node, JSON.stringify(ids))
      .run();
  expect((await commit(captured)).meta.changes).toBe(0);
  expect((await commit([held!.operation_id])).meta.changes).toBe(1);
});
it("retains running thin bindings and finite read counters across material change, interruption and authenticated read-only acceptance", async () => {
  const f = await thinExecutionFixture(releases);
  // This controlled existing binding is a D1 authority fixture, not fabricated live storage evidence.
  const created = DatabaseWithOperation.parse(
    await (await f.create()).json(),
  ).database;
  const storage = DesiredDatabaseStorage.parse({
    backend: "lvm-thin-v1",
    storage_class: f.authority.storage_class,
    volume_attributes_class: f.authority.storage_class,
    profile_revision: 1,
    profile_sha256: f.authority.profile_sha256,
    node_uid: f.uid,
    volume_group_uuid: f.authority.volume_group_uuid,
    pool_uuid: f.authority.pool_uuid,
    startup_reserve_bytes: f.profile.startup_reserve_bytes,
    write_bytes_per_second: f.profile.write_bytes_per_second,
    write_iops_per_second: f.profile.write_iops_per_second,
    guard_seconds: 120,
    drain_seconds: 10,
  });
  const receipt = {
    storage_generation: 1,
    storage_uid: crypto.randomUUID(),
    namespace_uid: crypto.randomUUID(),
    cluster_uid: crypto.randomUUID(),
    node_uid: f.uid,
    volume_group_uuid: f.authority.volume_group_uuid,
    pool_uuid: f.authority.pool_uuid!,
    volume_handle: `pvc-${crypto.randomUUID()}`,
    lv_uuid: "VOLUME-1234-1234-1234-1234-1234-ABCDEF",
    pvc_uid: crypto.randomUUID(),
    pv_uid: crypto.randomUUID(),
  };
  const volume = {
    database_id: created.id,
    generation: 1,
    storage_generation: 1,
    storage_uid: receipt.storage_uid,
    namespace_uid: receipt.namespace_uid,
    cluster_uid: receipt.cluster_uid,
    volume_handle: receipt.volume_handle,
    lv_uuid: receipt.lv_uuid,
    pvc_uid: receipt.pvc_uid,
    pv_uid: receipt.pv_uid,
    storage_class: storage.storage_class,
    volume_attributes_class: storage.volume_attributes_class,
    io: [
      {
        pod_uid: crypto.randomUUID(),
        write_bytes_per_second: f.profile.write_bytes_per_second,
        write_iops_per_second: f.profile.write_iops_per_second,
      },
    ],
  };
  const authority = {
    ...f.authority,
    physical_lvs: [
      {
        name: receipt.volume_handle,
        lv_uuid: receipt.lv_uuid,
        size_bytes: 5 * 1024 ** 3,
        segtype: "thin" as const,
      },
    ],
    active_lv_uuids: [receipt.lv_uuid],
    volumes: [volume],
  };
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE databases SET node_id=?,storage_profile_json=?,storage_volume_json=?,observed_state='ready',observed_power='awake',observed_generation=1 WHERE id=?",
    ).bind(
      f.node,
      JSON.stringify(storage),
      JSON.stringify(receipt),
      created.id,
    ),
    env.DB.prepare(
      "UPDATE node_thin_storage SET authority_json=?,lease_id=?,lease_revision=7,lease_expires_at=? WHERE node_id=?",
    ).bind(
      JSON.stringify(authority),
      newOperationId(),
      new Date(Date.now() + 500).toISOString(),
      f.node,
    ),
  ]);
  // Healthy already-current authority must not be held Pending by an ordinary read renewal.
  expect(await refreshNodeThinStorageMaterial(f.local, f.node)).toEqual({
    selected: true,
    qualified: true,
  });
  await storeRegionJoinBundle(
    env.DB,
    f.local.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 2),
    f.bundle,
  );
  await env.DB.prepare(
    "UPDATE regions SET bootstrap_material_revision=2 WHERE id=?",
  )
    .bind(f.region)
    .run();
  const host = await ensureNodeHostConfiguration(f.local, {
    node_id: f.node,
    node_uid: f.uid,
  });
  const patch = await env.DB.prepare(
    "SELECT * FROM fleet_patch_operations WHERE node_id=?",
  )
    .bind(f.node)
    .first<Record<string, unknown>>();
  const keys = Object.keys(patch!),
    values = keys.map((k) =>
      k === "operation_id"
        ? newOperationId()
        : k === "material_revision"
          ? 2
          : k === "host_configuration_revision"
            ? host.revision
            : k === "host_configuration_sha256"
              ? host.sha256
              : k === "observed_json"
                ? JSON.stringify({
                    ...JSON.parse(String(patch![k])),
                    host_configuration_sha256: host.sha256,
                    runtime_admission_sha256: host.profile_sha256,
                  })
                : patch![k],
    );
  await env.DB.prepare(
    `INSERT INTO fleet_patch_operations(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
  )
    .bind(...values)
    .run();
  expect(await refreshNodeThinStorageMaterial(f.local, f.node)).toEqual({
    selected: true,
    qualified: false,
  });
  expect(
    await env.DB.prepare(
      "SELECT material_revision FROM node_thin_storage WHERE node_id=?",
    )
      .bind(f.node)
      .first("material_revision"),
  ).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 550));
  // The real test DO has no Native container: its explicit startup rejection must retain the durable read lease.
  await expect(refreshNodeThinStorageMaterial(f.local, f.node)).rejects.toThrow(
    "thin_storage_container_unavailable",
  );
  const before = await env.DB.prepare(
    "SELECT material_revision,lease_revision,action_json FROM node_thin_storage WHERE node_id=?",
  )
    .bind(f.node)
    .first();
  expect(before).toEqual({
    material_revision: 2,
    lease_revision: 8,
    action_json: null,
  });
  expect(await refreshNodeThinStorageMaterial(f.local, f.node)).toEqual({
    selected: true,
    qualified: false,
  });
  expect(
    await env.DB.prepare(
      "SELECT material_revision,lease_revision,action_json FROM node_thin_storage WHERE node_id=?",
    )
      .bind(f.node)
      .first(),
  ).toEqual(before);
  const input = await thinStorageInput(f.local, f.node);
  expect(input.class_creation_allowed).toBe(false);
  expect(input.lease.action).toBeNull();
  const accepted = {
    ...authority,
    revision: 2,
    observed_at: input.lease.issued_at,
    captured_at: new Date().toISOString(),
    expires_at: input.lease.expires_at,
  };
  await recordThinStorageReport(f.local, f.node, {
    expected_revision: 8,
    authority: accepted,
    boot_id: f.qualified.bootId,
    system_uuid: f.qualified.qualification.system_uuid,
    pool_tag: null,
    action_applied: false,
    software: {
      kernel_version:
        f.qualified.spec.thin_storage_qualification!.kernel_version,
      host_extension_image:
        f.qualified.spec.thin_storage_qualification!.host_extension_image,
      host_configuration_sha256: host.sha256,
      driver_image_id: f.profile.driver_image,
      driver_sha256: sources.driver.binary_sha256,
      lvm_sha256: sources.driver.lvm_binary_sha256,
      tools_sha256: sources.thin_tools.binary_sha256,
      thin_tools_version: sources.thin_tools.version,
      thin_module_live: true,
      cgroup_host_view: true,
    },
  });
  expect(await refreshNodeThinStorageMaterial(f.local, f.node)).toEqual({
    selected: true,
    qualified: true,
  });
  expect(
    await env.DB.prepare(
      "SELECT generation,storage_generation,storage_volume_json,observed_power FROM databases WHERE id=?",
    )
      .bind(created.id)
      .first(),
  ).toEqual({
    generation: 1,
    storage_generation: 1,
    storage_volume_json: JSON.stringify(receipt),
    observed_power: "awake",
  });
  expect(
    await env.DB.prepare(
      "SELECT lease_revision,authority_revision,action_json FROM node_thin_storage WHERE node_id=?",
    )
      .bind(f.node)
      .first(),
  ).toEqual({ lease_revision: 8, authority_revision: 2, action_json: null });
});
