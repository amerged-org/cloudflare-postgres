// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import {
  DatabaseWithOperation,
  bytesToBase64url,
  NodeThinStorageAuthority as AuthoritySchema,
  type NodeThinStorageAuthority,
  type ThinStorageProfile,
} from "@pgcf/contracts";
import { storageWriteAuthorityForDatabase } from "../../src/domain/node-thin-storage.ts";
import type { Env } from "../../src/env.ts";
import type { DatabaseRow } from "../../src/domain/rows.ts";
import { cleanupFixtures, fixture } from "./fixtures.ts";
import {
  storageProtectionStatements,
  storageProtectionCurrentSql,
} from "../../src/domain/storage-capacity.ts";
import { databaseCpuChargeSql } from "../../src/domain/startup-admission.ts";
import { installThinQualifiedFixture } from "./thin-qualified-fixture.ts";
const qualifiedReleases: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of qualifiedReleases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});

it("the actual D1 signer refuses a malformed retained receipt outside the immutable physical profile", async () => {
  const f = await fixture(0, 95),
    created = DatabaseWithOperation.parse(
      await (await f.create()).json(),
    ).database,
    uid = await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
      .bind(f.node)
      .first<string>("node_uid");
  const now = Date.now(),
    at = new Date(now).toISOString(),
    end = new Date(now + 10000).toISOString();
  const hash = "a".repeat(64),
    vg = "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef",
    pool = "bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg",
    lv = "cdefgh-cdef-cdef-cdef-cdef-cdef-cdefgh";
  const receipt = {
    storage_generation: 1,
    storage_uid: "11111111-1111-4111-8111-111111111111",
    namespace_uid: "22222222-2222-4222-8222-222222222222",
    cluster_uid: "33333333-3333-4333-8333-333333333333",
    node_uid: uid!,
    volume_group_uuid: vg,
    pool_uuid: pool,
    volume_handle: "pvc-44444444-4444-4444-8444-444444444444",
    lv_uuid: lv,
    pvc_uid: "44444444-4444-4444-8444-444444444444",
    pv_uid: "55555555-5555-4555-8555-555555555555",
  };
  const profile: ThinStorageProfile = {
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
  const storage = {
    backend: "lvm-thin-v1",
    storage_class: `pgcf-lvm-thin-v1-${hash.slice(0, 16)}`,
    volume_attributes_class: `pgcf-lvm-thin-v1-${hash.slice(0, 16)}`,
    profile_revision: 1,
    profile_sha256: hash,
    node_uid: uid!,
    volume_group_uuid: vg,
    pool_uuid: pool,
    startup_reserve_bytes: profile.startup_reserve_bytes,
    write_bytes_per_second: profile.write_bytes_per_second,
    write_iops_per_second: profile.write_iops_per_second,
    guard_seconds: 10,
    drain_seconds: 10,
  };
  const authority: NodeThinStorageAuthority = {
    node_id: f.node,
    name: f.nodeName,
    node_uid: uid!,
    cluster_uid: "66666666-6666-4666-8666-666666666666",
    revision: 1,
    profile_revision: 1,
    profile_sha256: hash,
    storage_class: storage.storage_class,
    volume_group_uuid: vg,
    pool_uuid: pool,
    driver_pod_uid: "77777777-7777-4777-8777-777777777777",
    driver_image: profile.driver_image,
    observed_at: at,
    captured_at: at,
    expires_at: end,
    write_allowed: true,
    physical: {
      volume_group_uuid: vg,
      total_bytes: 20 * 1024 ** 3,
      free_bytes: 18 * 1024 ** 3,
      thick_allocated_bytes: 0,
      thin_pool: {
        name: "pgcf_thinpool",
        data_total_bytes: 1024 ** 3,
        data_used_bytes_upper_bound: 64 * 1024 ** 2,
        metadata_total_bytes: 128 * 1024 ** 2,
        metadata_used_bytes_upper_bound: 1024 ** 2,
      },
    },
    physical_lvs: [
      {
        name: receipt.volume_handle,
        lv_uuid: lv,
        size_bytes: 5 * 1024 ** 3,
        segtype: "thin",
      },
    ],
    active_lv_uuids: [lv],
    data_accounting_complete: true,
    protections: [],
    volumes: [
      {
        database_id: created.id,
        generation: 1,
        storage_generation: receipt.storage_generation,
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
            pod_uid: "88888888-8888-4888-8888-888888888888",
            write_bytes_per_second: profile.write_bytes_per_second,
            write_iops_per_second: profile.write_iops_per_second,
          },
        ],
      },
    ],
  };
  await env.DB.prepare(
    "UPDATE nodes SET allocatable_memory_mib=8192 WHERE id=?",
  )
    .bind(f.node)
    .run();
  await env.DB.prepare(
    `INSERT INTO node_thin_storage(node_id,node_uid,cluster_uid,address,volume_group_uuid,profile_revision,profile_sha256,profile_json,allow_new_databases,authority_revision,authority_json,authority_received_at,lease_revision,material_revision,qualified_driver_image,status,created_at,updated_at) VALUES (?,?,?,'203.0.113.10',?,1,?,?,1,1,?,?,0,1,?,'ready',?,?)`,
  )
    .bind(
      f.node,
      uid,
      authority.cluster_uid,
      vg,
      hash,
      JSON.stringify(profile),
      JSON.stringify(authority),
      at,
      profile.driver_image,
      at,
      at,
    )
    .run();
  await env.DB.prepare(
    "UPDATE databases SET node_id=?,storage_profile_json=?,storage_volume_json=? WHERE id=?",
  )
    .bind(f.node, JSON.stringify(storage), JSON.stringify(receipt), created.id)
    .run();
  const database = await env.DB.prepare("SELECT * FROM databases WHERE id=?")
    .bind(created.id)
    .first<DatabaseRow>();
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) throw new Error("Expected Ed25519 key pair");
  const exportedPrivate = await crypto.subtle.exportKey(
      "pkcs8",
      pair.privateKey,
    ),
    exportedPublic = await crypto.subtle.exportKey("raw", pair.publicKey);
  if (
    !(exportedPrivate instanceof ArrayBuffer) ||
    !(exportedPublic instanceof ArrayBuffer)
  )
    throw new Error("Expected binary Ed25519 export");
  const selected = {
    ...env,
    NODE_PROOF_SIGNING_KEY_ID: "cf",
    BOOTSTRAP_RELAY_SIGNING_KEYS: JSON.stringify({
      active: "cf",
      keys: { cf: bytesToBase64url(new Uint8Array(exportedPrivate)) },
    }),
    BOOTSTRAP_VERIFIER_KEYS: JSON.stringify({
      cf: bytesToBase64url(new Uint8Array(exportedPublic)),
    }),
  } as Env;
  expect(
    await storageWriteAuthorityForDatabase(selected, database!, now),
  ).toBeUndefined();
  const qualified = await installThinQualifiedFixture(
    env.DB,
    f.node,
    profile,
    authority.cluster_uid,
  );
  qualifiedReleases.push(qualified.releaseId);
  expect(
    await storageWriteAuthorityForDatabase(selected, database!, now),
  ).toMatch(/^sa1\./);
  expect(
    await storageWriteAuthorityForDatabase(
      selected,
      {
        ...database!,
        storage_volume_json: JSON.stringify({
          ...receipt,
          node_uid: "99999999-9999-4999-8999-999999999999",
        }),
      },
      now,
    ),
  ).toBeUndefined();
  await env.DB.prepare(
    "UPDATE fleet_node_release_observations SET facts_json=? WHERE node_id=?",
  )
    .bind(JSON.stringify({ boot_id: crypto.randomUUID() }), f.node)
    .run();
  expect(
    await storageWriteAuthorityForDatabase(selected, database!, now),
  ).toBeUndefined();
  await env.DB.prepare(
    "UPDATE fleet_node_release_observations SET facts_json=? WHERE node_id=?",
  )
    .bind(JSON.stringify({ boot_id: qualified.bootId }), f.node)
    .run();
  const quiesced = AuthoritySchema.parse({
    ...authority,
    revision: 2,
    volumes: authority.volumes.map((v) => ({ ...v, quiesced: true, io: [] })),
  });
  await env.DB.prepare(
    "UPDATE node_thin_storage SET authority_revision=2,authority_json=? WHERE node_id=?",
  )
    .bind(JSON.stringify(quiesced), f.node)
    .run();
  const cpu = () =>
    env.DB.prepare(
      `SELECT ${databaseCpuChargeSql("d", "s")} charge FROM databases d JOIN size_classes s ON s.id=d.size_class_id WHERE d.id=?`,
    )
      .bind(created.id)
      .first<number>("charge");
  const priorCpu = await cpu();
  await env.DB.batch(storageProtectionStatements(env.DB, quiesced));
  const protectedRow = await env.DB.prepare(
    "SELECT storage_protected_at,observed_power,observed_generation FROM databases WHERE id=?",
  )
    .bind(created.id)
    .first<{
      storage_protected_at: string | null;
      observed_power: string;
      observed_generation: number;
    }>();
  expect(protectedRow?.storage_protected_at).not.toBeNull();
  expect(protectedRow?.observed_power).toBe(database!.observed_power);
  expect(protectedRow?.observed_generation).toBe(database!.observed_generation);
  expect(await cpu()).toBe(priorCpu);
  expect(priorCpu).toBeGreaterThan(0);
  expect(
    await env.DB.prepare(
      `SELECT ${storageProtectionCurrentSql("d")} valid FROM databases d WHERE d.id=?`,
    )
      .bind(created.id)
      .first<number>("valid"),
  ).toBe(1);
  const { request } = await import("./fixtures.ts");
  const deletedAt = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE databases SET desired_state='deleted',observed_state='deleted',observed_generation=generation,deleted_at=? WHERE id=?",
  )
    .bind(deletedAt, created.id)
    .run();
  const host = async () => {
    const response = await request(
      `/agent/v1/nodes/${f.node}/storage-guard`,
      f.agent,
    );
    expect(response.status).toBe(200);
    return (await response.json()) as {
      databases: {
        database_id: string;
        volume: unknown;
        write_blocked: boolean;
      }[];
    };
  };
  expect((await host()).databases[0]).toMatchObject({
    database_id: created.id,
    volume: receipt,
    write_blocked: true,
  });
  const absentAt = new Date(Date.now() + 1).toISOString();
  const reclaimed = AuthoritySchema.parse({
    ...quiesced,
    revision: 3,
    observed_at: absentAt,
    captured_at: absentAt,
    volumes: [],
    physical_lvs: [],
    active_lv_uuids: [],
  });
  await env.DB.prepare(
    "UPDATE node_thin_storage SET authority_revision=3,authority_json=?,authority_received_at=? WHERE node_id=?",
  )
    .bind(JSON.stringify(reclaimed), absentAt, f.node)
    .run();
  expect((await host()).databases[0]).toMatchObject({
    database_id: created.id,
    volume: null,
    write_blocked: false,
  });
});

it("the actual host HTTPS route exposes only the current region's retained thick assignments", async () => {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(
    await (await f.create()).json(),
  ).database;
  const { request } = await import("./fixtures.ts");
  await env.DB.prepare(
    "UPDATE regions SET bootstrap_material_revision=1 WHERE id=?",
  )
    .bind(f.region)
    .run();
  const response = await request(
    `/agent/v1/nodes/${f.node}/storage-guard`,
    f.agent,
  );
  expect(response.status).toBe(200);
  const value = (await response.json()) as {
    legacy: unknown[];
    databases: unknown[];
    node_uid: string;
  };
  expect(value.legacy).toEqual([
    {
      database_id: created.id,
      generation: 1,
      namespace: `pgcf-db-${created.id}`,
    },
  ]);
  expect(value.databases).toEqual([]);
  expect(
    (await request(`/agent/v1/nodes/${f.node}/storage-guard`, f.foreignAgent))
      .status,
  ).toBe(404);
  expect(
    (await request(`/agent/v1/nodes/${f.node}/storage-guard`, f.integrator))
      .status,
  ).toBe(401);
});
