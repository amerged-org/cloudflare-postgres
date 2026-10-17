// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { runInDurableObject, type D1Migration } from "cloudflare:test";
import {
  DatabaseWithOperation,
  DatabaseRestored,
  DesiredResponse,
  DatabaseStorageVolumeReceipt,
  NodeThinStorageAuthority,
  ThinStorageProfile,
  newOperationId,
  thinStorageClass,
} from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { installThinQualifiedFixture } from "./thin-qualified-fixture.ts";
import { configureNodeRegionPolicy } from "../../src/domain/node-state.ts";
import {
  thinPoolRoomSql,
  storageHoldVolumeStatements,
  thinStorageDeletionConfirmedSql,
} from "../../src/domain/storage-capacity.ts";
import {
  cleanupFixtures,
  fixture,
  request,
  observation,
  observedBody,
} from "./fixtures.ts";
import { runNodeCapacity } from "../../src/domain/node-capacity.ts";
import { releaseCoveredStartupReservationsStatement } from "../../src/domain/startup-admission.ts";
import { powerTransitionStatements } from "../../src/domain/lifecycle.ts";
import type { DatabaseRow } from "../../src/domain/rows.ts";
const mib = 1024 ** 2,
  gib = 1024 ** 3,
  sha = "a".repeat(64);
const vg = "ABCDEF-1234-1234-1234-1234-1234-ABCDEF",
  pool = "POOLXX-1234-1234-1234-1234-1234-ABCDEF";
const extraClasses: string[] = [];
const qualifiedReleases: string[] = [];
const recoveryArchiveKeys: string[] = [];
afterEach(async () => {
  if (recoveryArchiveKeys.length)
    await env.ARCHIVE.delete(recoveryArchiveKeys.splice(0));
  await cleanupFixtures();
  for (const id of qualifiedReleases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
  for (const size of extraClasses.splice(0))
    await env.DB.prepare("DELETE FROM size_classes WHERE id=?")
      .bind(size)
      .run();
});
async function thinFixture(
  dataFree = 32 * gib,
  poolData = 32 * gib,
  beforeThin?: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
) {
  const f = await fixture(8192, 1),
    now = Date.now(),
    observed = new Date(now).toISOString();
  if (beforeThin) await beforeThin(f);
  const node = await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
    .bind(f.node)
    .first<{ node_uid: string }>();
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 2,
    purchases_enabled: false,
    order: null,
    placement_mode: "actual_ram",
    maximum_database_memory_mib: 4096,
    postgres_memory_request_mib: 128,
  });
  await env.DB.prepare(
    "INSERT INTO node_memory_samples(node_id,node_uid,minute,observed_at,working_set_bytes,capacity_memory_bytes,available_bytes,memory_pressure) VALUES(?,?,?,?,?,?,?,0)",
  )
    .bind(
      f.node,
      node!.node_uid,
      Math.floor(now / 60000),
      observed,
      1024 * mib,
      8192 * mib,
      7168 * mib,
    )
    .run();
  const profile = ThinStorageProfile.parse({
    version: 1,
    driver_image: `registry.invalid/driver@sha256:${sha}`,
    initial_data_bytes: poolData,
    growth_bytes: 8 * gib,
    maximum_data_bytes: 64 * gib,
    metadata_bytes: gib,
    vg_reserve_bytes: 4 * gib,
    data_reserve_bytes: 512 * mib,
    metadata_reserve_bytes: 64 * mib,
    startup_reserve_bytes: 32 * mib,
    write_bytes_per_second: mib,
    write_iops_per_second: 10,
    guard_seconds: 30,
    drain_seconds: 10,
    maximum_volumes: 1000,
    maximum_quota_gib: 16,
  });
  const authority = NodeThinStorageAuthority.parse({
    node_id: f.node,
    name: f.nodeName,
    node_uid: node!.node_uid,
    cluster_uid: crypto.randomUUID(),
    revision: 1,
    profile_revision: 1,
    profile_sha256: sha,
    storage_class: thinStorageClass(sha),
    volume_group_uuid: vg,
    pool_uuid: pool,
    driver_pod_uid: crypto.randomUUID(),
    driver_image: profile.driver_image,
    observed_at: observed,
    captured_at: observed,
    expires_at: new Date(now + 30000).toISOString(),
    write_allowed: true,
    physical: {
      volume_group_uuid: vg,
      total_bytes: 100 * gib,
      free_bytes: 67 * gib,
      thick_allocated_bytes: 0,
      thin_pool: {
        name: "pgcf_thinpool",
        data_total_bytes: poolData,
        data_used_bytes_upper_bound: poolData - dataFree,
        metadata_total_bytes: gib,
        metadata_used_bytes_upper_bound: 0,
      },
    },
    physical_lvs: [],
    active_lv_uuids: [],
    data_accounting_complete: true,
    protections: [],
    volumes: [],
  });
  await env.DB.prepare(
    "INSERT INTO node_thin_storage(node_id,node_uid,cluster_uid,address,volume_group_uuid,profile_revision,profile_sha256,profile_json,allow_new_databases,authority_revision,authority_json,authority_received_at,material_revision,qualified_driver_image,status,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?,1,1,?,?,1,?,'ready',?,?)",
  )
    .bind(
      f.node,
      node!.node_uid,
      authority.cluster_uid,
      "192.0.2.1",
      vg,
      sha,
      JSON.stringify(profile),
      JSON.stringify(authority),
      observed,
      profile.driver_image,
      observed,
      observed,
    )
    .run();
  const qualified = await installThinQualifiedFixture(
    env.DB,
    f.node,
    profile,
    authority.cluster_uid,
  );
  qualifiedReleases.push(qualified.releaseId);
  // The controller's minute sample of the same pool.
  await env.DB.prepare(
    "INSERT INTO node_storage_observations(node_id,node_uid,observed_at,received_at,physical_json) VALUES(?,?,?,?,?)",
  )
    .bind(
      f.node,
      node!.node_uid,
      observed,
      observed,
      JSON.stringify(authority.physical),
    )
    .run();
  return {
    ...f,
    profile,
    authority,
    nodeUid: node!.node_uid,
    postgres: qualified.spec.components.find((c) => c.name === "postgres")!,
    bootId: qualified.bootId,
  };
}
const nodeFor = (id: string) =>
  env.DB.prepare("SELECT node_id FROM databases WHERE id=?")
    .bind(id)
    .first("node_id");
async function fits(f: Awaited<ReturnType<typeof thinFixture>>) {
  return await env.DB.prepare(
    `SELECT ${thinPoolRoomSql()} fits FROM nodes n JOIN size_classes s ON s.id=? WHERE n.id=?`,
  )
    .bind(f.size, f.node)
    .first("fits");
}
async function publish(
  f: Awaited<ReturnType<typeof thinFixture>>,
  authority: unknown,
) {
  await env.DB.prepare(
    "UPDATE node_thin_storage SET authority_json=? WHERE node_id=?",
  )
    .bind(JSON.stringify(authority), f.node)
    .run();
}
/** The node's latest physical sample, as the controller reports it every minute. */
async function physicalSample(
  f: Awaited<ReturnType<typeof thinFixture>>,
  pool: { dataFree: number; metadataFree?: number; dataTotal?: number },
  ageMs = 0,
  vgFree = 67 * gib,
) {
  const dataTotal = pool.dataTotal ?? 32 * gib;
  const at = new Date(Date.now() - ageMs).toISOString();
  await env.DB.prepare(
    "INSERT INTO node_storage_observations(node_id,node_uid,observed_at,received_at,physical_json) VALUES(?,?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET observed_at=excluded.observed_at,received_at=excluded.received_at,physical_json=excluded.physical_json",
  )
    .bind(
      f.node,
      f.nodeUid,
      at,
      at,
      JSON.stringify({
        volume_group_uuid: vg,
        total_bytes: 100 * gib,
        free_bytes: vgFree,
        thick_allocated_bytes: 0,
        thin_pool: {
          name: "pgcf_thinpool",
          data_total_bytes: dataTotal,
          data_used_bytes_upper_bound: dataTotal - pool.dataFree,
          metadata_total_bytes: gib,
          metadata_used_bytes_upper_bound: gib - (pool.metadataFree ?? gib),
        },
      }),
    )
    .run();
}
async function room(
  f: Awaited<ReturnType<typeof thinFixture>>,
  database?: string,
) {
  return database
    ? await env.DB.prepare(
        `SELECT ${thinPoolRoomSql("n", "s", "d")} room FROM databases d JOIN nodes n ON n.id=d.node_id JOIN size_classes s ON s.id=d.size_class_id WHERE d.id=?`,
      )
        .bind(database)
        .first("room")
    : await env.DB.prepare(
        `SELECT ${thinPoolRoomSql("n", "s")} room FROM nodes n JOIN size_classes s ON s.id=? WHERE n.id=?`,
      )
        .bind(f.size, f.node)
        .first("room");
}

it("has room while the node's fresh physical sample leaves the profile's data and metadata reserve free", async () => {
  const f = await thinFixture();
  // The reserves are 512 MiB of data and 64 MiB of metadata.
  await physicalSample(f, { dataFree: 512 * mib, metadataFree: 64 * mib });
  expect(await room(f)).toBe(1);
  await physicalSample(f, { dataFree: 512 * mib - 1 });
  expect(await room(f)).toBe(0);
  await physicalSample(f, { dataFree: gib, metadataFree: 64 * mib - 1 });
  expect(await room(f)).toBe(0);
  // A sample older than two minutes, or none, says nothing.
  await physicalSample(f, { dataFree: gib }, 121_000);
  expect(await room(f)).toBe(0);
  await env.DB.prepare("DELETE FROM node_storage_observations WHERE node_id=?")
    .bind(f.node)
    .run();
  expect(await room(f)).toBe(0);
  await physicalSample(f, { dataFree: gib }, 100_000);
  expect(await room(f)).toBe(1);
  // Neither the node's write authority, its freshness nor an audit turn's error enters the rule:
  // room is space in the pool. A writer without io.max (a pool slot) failed the audit live and
  // refused every wake on the node.
  await publish(f, {
    ...f.authority,
    write_allowed: false,
    observed_at: new Date(Date.now() - 3_600_000).toISOString(),
    expires_at: new Date(Date.now() - 3_570_000).toISOString(),
  });
  expect(await room(f)).toBe(1);
  await env.DB.prepare(
    "UPDATE node_thin_storage SET error_code='thin_storage_io_limit_missing' WHERE node_id=?",
  )
    .bind(f.node)
    .run();
  expect(await room(f)).toBe(1);
});

it("judges a database by its own pool, and a new volume by the node's openness to new databases", async () => {
  const f = await thinFixture();
  await physicalSample(f, { dataFree: gib });
  const created = DatabaseWithOperation.parse(
    await (await f.create("pooled")).json(),
  );
  expect(await nodeFor(created.database.id)).toBe(f.node);
  expect(await room(f, created.database.id)).toBe(1);
  await env.DB.prepare(
    "UPDATE node_thin_storage SET allow_new_databases=0 WHERE node_id=?",
  )
    .bind(f.node)
    .run();
  expect(await room(f)).toBe(0);
  expect(await room(f, created.database.id)).toBe(1);
  // A recreated pool is another pool: the database's volume is not in it.
  await publish(f, {
    ...f.authority,
    pool_uuid: "POOLYY-1234-1234-1234-1234-1234-ABCDEF",
  });
  expect(await room(f, created.database.id)).toBe(0);
});

it("places new databases by room alone, beyond the logical size of the volumes already placed", async () => {
  // 1 GiB of the pool is free; each database has a 5 GiB quota.
  const f = await thinFixture(gib);
  await physicalSample(f, { dataFree: gib });
  for (const name of ["first", "second", "third"]) {
    const created = DatabaseWithOperation.parse(
      await (await f.create(name)).json(),
    );
    expect(await nodeFor(created.database.id)).toBe(f.node);
  }
  await physicalSample(f, { dataFree: 256 * mib });
  const refused = DatabaseWithOperation.parse(
    await (await f.create("fourth")).json(),
  );
  expect(await nodeFor(refused.database.id)).toBeNull();
});

it("resumes a thin database only while its node has room", async () => {
  const f = await thinFixture();
  await physicalSample(f, { dataFree: gib });
  const created = DatabaseWithOperation.parse(
    await (await f.create("sleeper")).json(),
  );
  const id = created.database.id;
  await env.DB.prepare(
    "UPDATE databases SET desired_state='suspended',suspension_reason='manual',observed_state='provisioning',observed_power='hibernated',observed_generation=generation,power_operation=NULL WHERE id=?",
  )
    .bind(id)
    .run();
  await env.DB.prepare(
    "DELETE FROM database_start_admissions WHERE database_id=?",
  )
    .bind(id)
    .run();
  const resume = () =>
    request(
      `/v1/databases/${id}/resume`,
      f.integrator,
      "POST",
      undefined,
      crypto.randomUUID(),
    );
  await physicalSample(f, { dataFree: 256 * mib });
  const refused = await resume();
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({
    error: { details: { reason: "node_capacity" } },
  });
  await physicalSample(f, { dataFree: gib });
  expect((await resume()).status).toBe(202);
});

it("refuses a thin wake claim without room, but never the ticket claim a pool hit may have answered", async () => {
  const f = await thinFixture();
  await physicalSample(f, { dataFree: gib });
  const created = DatabaseWithOperation.parse(
    await (await f.create("idle")).json(),
  );
  const id = created.database.id;
  await env.DB.prepare(
    "UPDATE databases SET desired_state='suspended',suspension_reason='idle',observed_state='provisioning',observed_power='hibernated',observed_generation=generation WHERE id=?",
  )
    .bind(id)
    .run();
  const role = (await env.DB.prepare(
    "SELECT name FROM roles WHERE database_id=? AND deleted_at IS NULL LIMIT 1",
  )
    .bind(id)
    .first<string>("name"))!;
  const row = async () =>
    (await env.DB.prepare("SELECT * FROM databases WHERE id=?")
      .bind(id)
      .first<DatabaseRow>())!;
  const wake = async (ticket: boolean) =>
    (
      await env.DB.batch(
        powerTransitionStatements(
          env.DB,
          await row(),
          "wake",
          newOperationId(),
          new Date().toISOString(),
          role,
          undefined,
          ticket,
        ),
      )
    )[0]!.meta.changes;
  await physicalSample(f, { dataFree: 256 * mib });
  expect(await wake(false)).toBe(0);
  expect(await wake(true)).toBe(1);
});

/** Whether the node's NodeBootstrap Durable Object was asked for a thin storage turn. */
async function turnAsked(f: Awaited<ReturnType<typeof thinFixture>>) {
  return await runInDurableObject(
    env.NODE_BOOTSTRAP.get(
      env.NODE_BOOTSTRAP.idFromName(`thin-storage:${f.node}`),
    ),
    async (_instance, state) =>
      (await state.storage.get<string>("thinStorageNodeId")) === f.node,
  );
}
async function forgetTurn(f: Awaited<ReturnType<typeof thinFixture>>) {
  await runInDurableObject(
    env.NODE_BOOTSTRAP.get(
      env.NODE_BOOTSTRAP.idFromName(`thin-storage:${f.node}`),
    ),
    async (_instance, state) => {
      await state.storage.deleteAlarm();
      await state.storage.deleteAll();
    },
  );
}

it("asks for the pool growth turn when free space falls below the reserve and one start, while the pool can grow", async () => {
  const f = await thinFixture();
  // The reserve is 512 MiB and a start 32 MiB.
  await physicalSample(f, { dataFree: 600 * mib });
  await runNodeCapacity(env, f.region);
  expect(await turnAsked(f)).toBe(false);
  await physicalSample(f, { dataFree: 540 * mib });
  await runNodeCapacity(env, f.region, true);
  expect(await turnAsked(f)).toBe(false);
  await runNodeCapacity(env, f.region);
  expect(await turnAsked(f)).toBe(true);
  await forgetTurn(f);
  // At its maximum, or with the volume group too full for the growth step, it cannot grow.
  await physicalSample(f, { dataFree: 540 * mib, dataTotal: 64 * gib });
  await runNodeCapacity(env, f.region);
  expect(await turnAsked(f)).toBe(false);
  await physicalSample(f, { dataFree: 540 * mib }, 0, 8 * gib);
  await runNodeCapacity(env, f.region);
  expect(await turnAsked(f)).toBe(false);
  await forgetTurn(f);
});

it("serves each storage node's room as its write_allowed, in a page the deployed controller still parses", async () => {
  const f = await thinFixture();
  const node = async () =>
    DesiredResponse.parse(
      await (await request("/agent/v1/desired", f.agent)).json(),
    ).region.storage_nodes?.find((entry) => entry.node_id === f.node);
  await physicalSample(f, { dataFree: gib });
  expect(await node()).toMatchObject({ write_allowed: true });
  // The controller schema allows no other field in a storage node entry.
  expect(await node()).not.toHaveProperty("room");
  await physicalSample(f, { dataFree: 256 * mib });
  expect(await node()).toMatchObject({ write_allowed: false });
  // A node closed to new databases still has room for the databases it holds.
  await physicalSample(f, { dataFree: gib });
  await env.DB.prepare(
    "UPDATE node_thin_storage SET allow_new_databases=0 WHERE node_id=?",
  )
    .bind(f.node)
    .run();
  expect(await node()).toMatchObject({ write_allowed: true });
});

it("places logical quotas against fresh physical thin headroom instead of the old GiB reservation", async () => {
  const f = await thinFixture();
  const first = DatabaseWithOperation.parse(
    await (await f.create("first")).json(),
  );
  expect(await nodeFor(first.database.id)).toBe(f.node);
  const second = DatabaseWithOperation.parse(
    await (await f.create("second")).json(),
  );
  expect(await nodeFor(second.database.id)).toBe(f.node);
  const rows = (
    await env.DB.prepare(
      "SELECT storage_profile_json FROM databases WHERE project_id=?",
    )
      .bind(f.project)
      .all<{ storage_profile_json: string }>()
  ).results;
  expect(rows).toHaveLength(2);
  for (const row of rows)
    expect(JSON.parse(row.storage_profile_json)).toMatchObject({
      backend: "lvm-thin-v1",
      node_uid: f.nodeUid,
      pool_uuid: pool,
      profile_sha256: sha,
    });
  expect(
    (
      await env.DB.prepare(
        "SELECT storage_budget_bytes FROM database_start_admissions WHERE node_id=?",
      )
        .bind(f.node)
        .all()
    ).results,
  ).toEqual([
    { storage_budget_bytes: 5 * gib },
    { storage_budget_bytes: 5 * gib },
  ]);
});
it("a thin node that is not ready for new databases or has no fresh sample never falls back to thick admission", async () => {
  const f = await thinFixture();
  await env.DB.prepare("UPDATE nodes SET storage_gib_total=100 WHERE id=?")
    .bind(f.node)
    .run();
  await env.DB.prepare(
    "UPDATE node_thin_storage SET status='qualifying' WHERE node_id=?",
  )
    .bind(f.node)
    .run();
  expect(
    await nodeFor(
      DatabaseWithOperation.parse(await (await f.create()).json()).database.id,
    ),
  ).toBeNull();
  await env.DB.prepare(
    "UPDATE node_thin_storage SET status='ready' WHERE node_id=?",
  )
    .bind(f.node)
    .run();
  expect(await fits(f)).toBe(1);
  await physicalSample(f, { dataFree: gib }, 121_000);
  expect(await fits(f)).toBe(0);
  expect(
    await nodeFor(
      DatabaseWithOperation.parse(await (await f.create("later")).json())
        .database.id,
    ),
  ).toBeNull();
});
it("the metadata reserve and the explicit logical quota maximum constrain a new volume", async () => {
  const f = await thinFixture();
  await physicalSample(f, { dataFree: 8 * gib, metadataFree: 64 * mib - 1 });
  expect(await fits(f)).toBe(0);
  await physicalSample(f, { dataFree: 8 * gib, metadataFree: 64 * mib });
  expect(await fits(f)).toBe(1);
  await env.DB.prepare("UPDATE size_classes SET storage_gib=17 WHERE id=?")
    .bind(f.size)
    .run();
  expect(await fits(f)).toBe(0);
});
async function bindVolume(
  f: Awaited<ReturnType<typeof thinFixture>>,
  created: ReturnType<typeof DatabaseWithOperation.parse>,
  storageGeneration = 1,
) {
  const receipt = DatabaseStorageVolumeReceipt.parse({
    storage_generation: storageGeneration,
    storage_uid: crypto.randomUUID(),
    namespace_uid: crypto.randomUUID(),
    cluster_uid: crypto.randomUUID(),
    node_uid: f.nodeUid,
    volume_group_uuid: vg,
    pool_uuid: pool,
    volume_handle: "pvc-" + crypto.randomUUID(),
    lv_uuid: "VOLUMX-1234-1234-1234-1234-1234-ABCDEF",
    pvc_uid: crypto.randomUUID(),
    pv_uid: crypto.randomUUID(),
  });
  await env.DB.prepare("UPDATE databases SET storage_volume_json=? WHERE id=?")
    .bind(JSON.stringify(receipt), created.database.id)
    .run();
  const volume = {
    database_id: created.database.id,
    generation: created.database.generation,
    storage_generation: storageGeneration,
    storage_uid: receipt.storage_uid,
    namespace_uid: receipt.namespace_uid,
    cluster_uid: receipt.cluster_uid,
    volume_handle: receipt.volume_handle,
    lv_uuid: receipt.lv_uuid,
    pvc_uid: receipt.pvc_uid,
    pv_uid: receipt.pv_uid,
    storage_class: thinStorageClass(sha),
    volume_attributes_class: thinStorageClass(sha),
    io: [],
  };
  const authority = NodeThinStorageAuthority.parse({
    ...f.authority,
    physical_lvs: [
      {
        name: receipt.volume_handle,
        lv_uuid: receipt.lv_uuid,
        size_bytes: 5 * gib,
        segtype: "thin",
      },
    ],
    volumes: [volume],
  });
  return { receipt, volume, authority };
}
async function accepted(
  f: Awaited<ReturnType<typeof thinFixture>>,
  input: NodeThinStorageAuthority,
) {
  const authority = NodeThinStorageAuthority.parse(input);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE node_thin_storage SET authority_revision=?,authority_json=?,authority_received_at=? WHERE node_id=?",
    ).bind(
      authority.revision,
      JSON.stringify(authority),
      new Date().toISOString(),
      f.node,
    ),
    ...storageHoldVolumeStatements(env.DB, authority),
  ]);
  return authority;
}

it("an ordinary deleted report waits for a fresh negative Native physical read of the frozen LV", async () => {
  const f = await thinFixture(),
    created = DatabaseWithOperation.parse(await (await f.create()).json()),
    bound = await bindVolume(f, created);
  await accepted(f, bound.authority);
  const deletion = DatabaseWithOperation.parse(
    await (
      await request(
        `/v1/databases/${created.database.id}`,
        f.integrator,
        "DELETE",
        undefined,
        crypto.randomUUID(),
      )
    ).json(),
  );
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      observation(created.database.id, deletion.database.generation, "deleted"),
    ]),
  );
  expect(
    await env.DB.prepare("SELECT observed_state FROM databases WHERE id=?")
      .bind(created.database.id)
      .first("observed_state"),
  ).not.toBe("deleted");
  const now = Date.now() + 1;
  await accepted(f, {
    ...bound.authority,
    revision: 2,
    observed_at: new Date(now).toISOString(),
    expires_at: new Date(now + 30000).toISOString(),
    physical_lvs: [],
    active_lv_uuids: [],
    volumes: [],
  });
  expect(
    await env.DB.prepare(
      `SELECT ${thinStorageDeletionConfirmedSql("d")} safe FROM databases d WHERE d.id=?`,
    )
      .bind(created.database.id)
      .first("safe"),
  ).toBe(1);
  await request("/agent/v1/observations", f.agent, "POST", {
    ...observedBody([
      observation(created.database.id, deletion.database.generation, "deleted"),
    ]),
    observed_at: new Date(Date.now() + 2).toISOString(),
  });
  expect(
    await env.DB.prepare("SELECT observed_state FROM databases WHERE id=?")
      .bind(created.database.id)
      .first("observed_state"),
  ).toBe("deleted");
});

it("desired state replicates the immutable storage profile and the real startup hold without inventing an IO token", async () => {
  const f = await thinFixture(),
    created = DatabaseWithOperation.parse(await (await f.create()).json());
  const response = await request("/agent/v1/desired", f.agent);
  expect(response.status).toBe(200);
  const desired = DesiredResponse.parse(await response.json()),
    database = desired.databases.find(
      (value) => value.id === created.database.id,
    )!;
  expect(desired.region.storage_nodes).toHaveLength(1);
  expect(database.storage).toMatchObject({
    profile_sha256: sha,
    pool_uuid: pool,
    node_uid: f.nodeUid,
  });
});
it("thin quota growth preserves the physical receipt and class while shrink remains forbidden", async () => {
  const f = await thinFixture(),
    created = DatabaseWithOperation.parse(await (await f.create()).json()),
    bound = await bindVolume(f, created);
  await accepted(f, bound.authority);
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(created.database.id, 1),
        postgres: {
          image: f.postgres.reference,
          image_id: "sha256:" + f.postgres.sha256,
        },
      },
    ]),
  );
  const before = await env.DB.prepare(
    "SELECT storage_profile_json,storage_volume_json FROM databases WHERE id=?",
  )
    .bind(created.database.id)
    .first();
  const target = "grow" + crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  extraClasses.push(target);
  await env.DB.prepare(
    "INSERT INTO size_classes(id,memory_mib,cpu_millicores,cpu_request_millicores,storage_gib,max_connections,sleep_after_seconds,archive_timeout_seconds,backup_retention_days,enabled,created_at,updated_at) SELECT ?,memory_mib,cpu_millicores,cpu_request_millicores,8,max_connections,sleep_after_seconds,archive_timeout_seconds,backup_retention_days,1,created_at,updated_at FROM size_classes WHERE id=?",
  )
    .bind(target, f.size)
    .run();
  const resized = await request(
    `/v1/databases/${created.database.id}`,
    f.integrator,
    "PATCH",
    { size_class_id: target },
    crypto.randomUUID(),
  );
  expect(resized.status).toBe(202);
  expect(
    await env.DB.prepare(
      "SELECT storage_profile_json,storage_volume_json FROM databases WHERE id=?",
    )
      .bind(created.database.id)
      .first(),
  ).toEqual(before);
  expect(
    (
      await request(
        `/v1/databases/${created.database.id}`,
        f.integrator,
        "PATCH",
        { size_class_id: f.size },
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(400);
});
it("a ready thin startup retains its quota runway until later Native proof includes the actual Pod IO limits", async () => {
  const f = await thinFixture(),
    created = DatabaseWithOperation.parse(await (await f.create()).json()),
    bound = await bindVolume(f, created);
  const ready = await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(created.database.id, 1),
        postgres: {
          image: f.postgres.reference,
          image_id: "sha256:" + f.postgres.sha256,
        },
      },
    ]),
  );
  expect(ready.status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 5100));
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE node_memory_samples SET observed_at=? WHERE node_id=? AND node_uid=?",
  )
    .bind(new Date(now).toISOString(), f.node, f.nodeUid)
    .run();
  const proof = {
    ...bound.authority,
    revision: 2,
    observed_at: new Date(now).toISOString(),
    captured_at: new Date(now).toISOString(),
    expires_at: new Date(now + 30000).toISOString(),
  };
  await accepted(f, proof);
  const release = () =>
    releaseCoveredStartupReservationsStatement(env.DB, {
      nodeId: f.node,
      nodeUid: f.nodeUid,
    }).run();
  expect((await release()).meta.changes).toBe(0);
  await accepted(f, {
    ...proof,
    revision: 3,
    volumes: [
      {
        ...bound.volume,
        io: [
          {
            pod_uid: crypto.randomUUID(),
            write_bytes_per_second: f.profile.write_bytes_per_second,
            write_iops_per_second: f.profile.write_iops_per_second,
          },
        ],
      },
    ],
  });
  expect((await release()).meta.changes).toBe(1);
}, 15000);

it("a 4 GiB tenant's sleep and deletion never drain or reserve a hold: the lease keeps the frozen volume a running writer until it is read absent", async () => {
  const f = await thinFixture(8 * gib, 8 * gib);
  await env.DB.prepare("UPDATE size_classes SET memory_mib=4096 WHERE id=?")
    .bind(f.size)
    .run();
  const created = DatabaseWithOperation.parse(await (await f.create()).json()),
    bound = await bindVolume(f, created),
    at = Date.now();
  let a = await accepted(f, {
    ...bound.authority,
    revision: 2,
    active_lv_uuids: [bound.receipt.lv_uuid],
    observed_at: new Date(at).toISOString(),
    captured_at: new Date(at).toISOString(),
    expires_at: new Date(at + 30000).toISOString(),
    volumes: bound.authority.volumes.map((v) => ({ ...v, quiesced: true })),
  });
  await env.DB.prepare(
    "UPDATE node_memory_samples SET available_bytes=0,working_set_bytes=capacity_memory_bytes,memory_pressure=1 WHERE node_id=?",
  )
    .bind(f.node)
    .run();
  const memoryBefore = await env.DB.prepare(
    "SELECT SUM(budget_bytes) n FROM database_start_admissions WHERE database_id=?",
  )
    .bind(created.database.id)
    .first("n");
  // The controller's ready report of the start.
  await env.DB.prepare(
    "UPDATE databases SET observed_state='ready',observed_power='awake',observed_generation=generation WHERE id=?",
  )
    .bind(created.database.id)
    .run();
  const suspended = await request(
    `/v1/databases/${created.database.id}/suspend`,
    f.integrator,
    "POST",
    undefined,
    crypto.randomUUID(),
  );
  expect(suspended.status).toBe(202);
  const stop = DatabaseWithOperation.parse(await suspended.json());
  a = await accepted(f, {
    ...a,
    revision: 3,
    volumes: a.volumes.map((v) => ({ ...v, generation: 2 })),
  });
  const host = async () => {
    const r = await request(`/agent/v1/nodes/${f.node}/storage-guard`, f.agent);
    expect(r.status).toBe(200);
    return (await r.json()) as {
      databases: {
        database_id: string;
        desired_state: string;
        startup_operation_id: string | null;
        runtime_authority: null;
        drain: null | {
          operation_id: string;
          kind: string;
          budget_bytes: number;
        };
      }[];
    };
  };
  // A sleep never drains: the host lease permits the database as a running writer, and no
  // storage hold is reserved for it.
  const value = (await host()).databases[0]!;
  expect(value).toMatchObject({
    database_id: created.database.id,
    desired_state: "running",
    startup_operation_id: created.operation.id,
    runtime_authority: null,
    drain: null,
  });
  expect(
    await env.DB.prepare(
      "SELECT SUM(budget_bytes) n FROM database_start_admissions WHERE database_id=?",
    )
      .bind(created.database.id)
      .first("n"),
  ).toBe(memoryBefore);
  expect(
    await env.DB.prepare(
      "SELECT 1 FROM database_start_admissions WHERE operation_id=?",
    )
      .bind(stop.operation.id)
      .first(),
  ).toBeNull();
  await accepted(f, a);
  const deleted = DatabaseWithOperation.parse(
    await (
      await request(
        `/v1/databases/${created.database.id}`,
        f.integrator,
        "DELETE",
        undefined,
        crypto.randomUUID(),
      )
    ).json(),
  );
  expect(deleted.operation.kind).toBe("database.delete");
  a = await accepted(f, {
    ...a,
    revision: 5,
    volumes: a.volumes.map((v) => ({ ...v, generation: 3 })),
  });
  // Not read absent yet: the deletion stays a running writer, with no drain and no hold.
  expect((await host()).databases[0]!).toMatchObject({
    desired_state: "running",
    startup_operation_id: created.operation.id,
    runtime_authority: null,
    drain: null,
  });
  expect(
    await env.DB.prepare(
      "SELECT SUM(budget_bytes) n FROM database_start_admissions WHERE database_id=?",
    )
      .bind(created.database.id)
      .first("n"),
  ).toBe(memoryBefore);
  expect(
    await env.DB.prepare(
      "SELECT 1 FROM database_start_admissions WHERE operation_id=?",
    )
      .bind(deleted.operation.id)
      .first(),
  ).toBeNull();
});

it("the existing hold-ledger migration preserves uncertain and acknowledged RAM rows while zero RAM is stop-only", async () => {
  const f = await thinFixture();
  const first = DatabaseWithOperation.parse(
      await (await f.create("migration-uncertain")).json(),
    ),
    second = DatabaseWithOperation.parse(
      await (await f.create("migration-ready")).json(),
    );
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(second.database.id, 1),
        postgres: {
          image: f.postgres.reference,
          image_id: "sha256:" + f.postgres.sha256,
        },
      },
    ]),
  );
  const migrations = (env as typeof env & { TEST_MIGRATIONS: D1Migration[] })
    .TEST_MIGRATIONS;
  const legacy = migrations.find((m) => m.name.startsWith("0019"))!,
    upgrade = migrations.find((m) => m.name.startsWith("0034"))!;
  const rename = (sql: string) =>
    sql
      .replaceAll("database_start_admissions", "migration_hold_probe")
      .replaceAll(
        "database_start_admission_immutable",
        "migration_hold_probe_immutable",
      );
  const columns =
    "operation_id,database_id,generation,node_id,node_uid,budget_bytes,granted_at,grant_sample_observed_at,ready_at,ready_sample_observed_at";
  try {
    for (const query of legacy.queries)
      await env.DB.prepare(rename(query)).run();
    await env.DB.prepare(
      `INSERT INTO migration_hold_probe(rowid,${columns}) SELECT rowid+11,${columns} FROM database_start_admissions WHERE operation_id IN(?,?)`,
    )
      .bind(first.operation.id, second.operation.id)
      .run();
    const before = (
      await env.DB.prepare(
        `SELECT rowid,${columns} FROM migration_hold_probe ORDER BY operation_id`,
      ).all()
    ).results;
    expect(before.some((row) => row.ready_at === null)).toBe(true);
    expect(before.some((row) => row.ready_at !== null)).toBe(true);
    const begin = upgrade.queries.findIndex((q) =>
        q.includes("CREATE TABLE database_start_admissions_storage_next"),
      ),
      end = upgrade.queries.findIndex((q) =>
        q.includes("CREATE TABLE node_thin_storage"),
      );
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(begin);
    await env.DB.batch(
      upgrade.queries
        .slice(begin, end)
        .map((query) => env.DB.prepare(rename(query))),
    );
    const after = (
      await env.DB.prepare(
        `SELECT rowid,${columns} FROM migration_hold_probe ORDER BY operation_id`,
      ).all()
    ).results;
    expect(after).toEqual(before);
    const drain = upgrade.queries.find((q) =>
      q.includes("CREATE TRIGGER database_storage_drain_only"),
    )!;
    await env.DB.prepare(
      rename(drain).replace(
        "CREATE TRIGGER database_storage_drain_only",
        "CREATE TRIGGER migration_storage_drain_only",
      ),
    ).run();
    await expect(
      env.DB.prepare(
        "INSERT INTO migration_hold_probe(operation_id,database_id,generation,node_id,node_uid,budget_bytes,granted_at,grant_sample_observed_at,storage_budget_bytes) SELECT operation_id,database_id,generation,node_id,node_uid,0,granted_at,grant_sample_observed_at,5368709120 FROM database_start_admissions WHERE operation_id=?",
      )
        .bind(first.operation.id)
        .run(),
    ).rejects.toThrow("database_storage_drain_only");
  } finally {
    await env.DB.prepare("DROP TABLE IF EXISTS migration_hold_probe").run();
    await env.DB.prepare(
      "DROP TABLE IF EXISTS migration_hold_probe_storage_next",
    ).run();
  }
});

/** Actual local R2 + D1 restore/delete lifecycle; the physical frame is controlled metadata, not Dev evidence. */
async function pendingThinRestore() {
  let original: DatabaseWithOperation | undefined;
  const f = await thinFixture(32 * gib, 32 * gib, async (base) => {
    await configureNodeRegionPolicy(env.DB, {
      region_id: base.region,
      max_nodes: 2,
      purchases_enabled: false,
      order: null,
      placement_mode: "actual_ram",
      maximum_database_memory_mib: 4096,
      postgres_memory_request_mib: 128,
    });
    const prior = Date.now() - 60000,
      uid = await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
        .bind(base.node)
        .first<string>("node_uid");
    await env.DB.prepare(
      "INSERT INTO node_memory_samples(node_id,node_uid,minute,observed_at,working_set_bytes,capacity_memory_bytes,available_bytes,memory_pressure) VALUES(?,?,?,?,?,?,?,0)",
    )
      .bind(
        base.node,
        uid,
        Math.floor(prior / 60000),
        new Date(prior).toISOString(),
        1024 * mib,
        8192 * mib,
        7168 * mib,
      )
      .run();
    await env.DB.prepare("UPDATE nodes SET storage_gib_total=95 WHERE id=?")
      .bind(base.node)
      .run();
    original = DatabaseWithOperation.parse(
      await (await base.create("retained_thick_original")).json(),
    );
  });
  const source = original!,
    archive = await env.DB.prepare(
      "SELECT archive_path FROM databases WHERE id=?",
    )
      .bind(source.database.id)
      .first<string>("archive_path");
  const prefix =
      archive!.replace(`s3://${env.ARCHIVE_BUCKET_NAME}/`, "") + "/database/",
    begin = new Date(Date.now() - 3600000).toISOString(),
    end = new Date(Date.now() - 3480000).toISOString(),
    backup = begin.replace(/[-:]/g, "").slice(0, 15);
  const objects = [
    [
      `${prefix}base/${backup}/backup.info`,
      `status=DONE\nbegin_time=${begin}\nend_time=${end}\nbegin_wal=00000001${"0".repeat(15)}1\nend_wal=00000001${"0".repeat(15)}1\nxlog_segment_size=16777216\n`,
    ],
    [`${prefix}base/${backup}/data.tar.gz`, "local-fixture"],
    [
      `${prefix}wals/00000001${"0".repeat(8)}/00000001${"0".repeat(15)}1.gz`,
      "local-wal",
    ],
  ];
  for (const [key, value] of objects) {
    recoveryArchiveKeys.push(key!);
    await env.ARCHIVE.put(key!, value!);
  }
  const restoredResponse = await request(
    `/v1/databases/${source.database.id}/restore`,
    f.integrator,
    "POST",
    { mode: "full", name: "cancelled_before_receipt" },
  );
  expect(restoredResponse.status).toBe(202);
  const restored = DatabaseRestored.parse(await restoredResponse.json()),
    id = restored.target_database.id;
  expect(restored.operation.kind).toBe("database.restore");
  expect(
    await env.DB.prepare("SELECT storage_generation FROM databases WHERE id=?")
      .bind(id)
      .first("storage_generation"),
  ).toBe(2);
  expect(
    await env.DB.prepare(
      "SELECT storage_volume_json FROM database_start_admissions WHERE operation_id=?",
    )
      .bind(restored.operation.id)
      .first("storage_volume_json"),
  ).toBeNull();
  return { f, source, restored };
}
async function deletedUnboundRestore() {
  const { f, source, restored } = await pendingThinRestore(),
    id = restored.target_database.id;
  const deletion = DatabaseWithOperation.parse(
    await (
      await request(
        `/v1/databases/${id}`,
        f.integrator,
        "DELETE",
        undefined,
        crypto.randomUUID(),
      )
    ).json(),
  );
  expect(deletion.database.generation).toBe(2);
  // The first current receipt arrives only after the restore grant is already superseded.
  const receipt = DatabaseStorageVolumeReceipt.parse({
    storage_generation: 2,
    storage_uid: crypto.randomUUID(),
    namespace_uid: crypto.randomUUID(),
    cluster_uid: crypto.randomUUID(),
    node_uid: f.nodeUid,
    volume_group_uuid: vg,
    pool_uuid: pool,
    lv_uuid: "RESTOR-1234-1234-1234-1234-1234-ABCDEF",
    pvc_uid: crypto.randomUUID(),
    pv_uid: crypto.randomUUID(),
    volume_handle: "pvc-" + crypto.randomUUID(),
  });
  await env.DB.prepare("UPDATE databases SET storage_volume_json=? WHERE id=?")
    .bind(JSON.stringify(receipt), id)
    .run();
  const pvc = crypto.randomUUID(),
    thick = {
      database_id: source.database.id,
      generation: source.database.generation,
      storage_generation: 1,
      storage_uid: crypto.randomUUID(),
      namespace_uid: crypto.randomUUID(),
      cluster_uid: crypto.randomUUID(),
      pvc_uid: pvc,
      pv_uid: crypto.randomUUID(),
      volume_handle: "pvc-" + pvc,
      lv_uuid: "THICKX-1234-1234-1234-1234-1234-ABCDEF",
      storage_class: "pgcf-lvm",
      volume_attributes_class: null,
      io: [],
    };
  const frame = (revision: number) => {
    const at = Date.now() + 1;
    return NodeThinStorageAuthority.parse({
      ...f.authority,
      revision,
      pool_uuid: null,
      write_allowed: false,
      observed_at: new Date(at).toISOString(),
      captured_at: new Date(at).toISOString(),
      expires_at: new Date(at + 30000).toISOString(),
      physical: {
        ...f.authority.physical,
        thin_pool: null,
        thick_allocated_bytes: 5 * gib,
        free_bytes: 95 * gib,
      },
      physical_lvs: [
        {
          name: thick.volume_handle,
          lv_uuid: thick.lv_uuid,
          size_bytes: 5 * gib,
          segtype: "linear",
        },
      ],
      active_lv_uuids: [thick.lv_uuid],
      volumes: [thick],
    });
  };
  await accepted(f, frame(2));
  const observationResponse = await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([observation(id, 2, "deleted")]),
  );
  expect(observationResponse.status).toBe(200);
  expect(
    await env.DB.prepare("SELECT observed_state FROM databases WHERE id=?")
      .bind(id)
      .first("observed_state"),
  ).toBe("deleted");
  const retained = await env.DB.prepare(
    "SELECT generation,storage_volume_json,ready_at FROM database_start_admissions WHERE operation_id=?",
  )
    .bind(restored.operation.id)
    .first<{
      generation: number;
      storage_volume_json: string | null;
      ready_at: string | null;
    }>();
  expect(retained).toMatchObject({ generation: 1, storage_volume_json: null });
  expect(retained!.ready_at).not.toBeNull();
  const release = () =>
    releaseCoveredStartupReservationsStatement(env.DB, {
      nodeId: f.node,
      nodeUid: f.nodeUid,
    }).run();
  expect((await release()).meta.changes).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 5100));
  const complete = frame(3);
  await env.DB.prepare(
    "UPDATE node_memory_samples SET observed_at=? WHERE node_id=? AND node_uid=?",
  )
    .bind(complete.observed_at, f.node, f.nodeUid)
    .run();
  return { f, restored, source, receipt, complete, release };
}
it(
  "releases a superseded never-bound restore hold only after confirmed deletion and a later global zero-Thin read while retaining the original thick volume",
  { timeout: 15000 },
  async () => {
    const { f, restored, source, complete, release } =
      await deletedUnboundRestore();
    await accepted(f, complete);
    expect((await release()).meta.changes).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT count(*) n FROM database_start_admissions WHERE operation_id=?",
      )
        .bind(restored.operation.id)
        .first("n"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT desired_state,storage_profile_json FROM databases WHERE id=?",
      )
        .bind(source.database.id)
        .first(),
    ).toEqual({ desired_state: "running", storage_profile_json: null });
    expect(
      JSON.parse(
        (await env.DB.prepare(
          "SELECT authority_json FROM node_thin_storage WHERE node_id=?",
        )
          .bind(f.node)
          .first<string>("authority_json"))!,
      ).active_lv_uuids,
    ).toEqual(complete.active_lv_uuids);
  },
);

it(
  "retains the never-bound restore obligation for a remaining Thin LV, unknown active mapper or changed physical identity",
  { timeout: 15000 },
  async () => {
    const { f, restored, receipt, complete, release } =
      await deletedUnboundRestore();
    await accepted(
      f,
      NodeThinStorageAuthority.parse({
        ...complete,
        physical_lvs: [
          ...complete.physical_lvs,
          {
            name: receipt.volume_handle,
            lv_uuid: receipt.lv_uuid,
            size_bytes: 5 * gib,
            segtype: "thin",
          },
        ],
      }),
    );
    expect((await release()).meta.changes).toBe(0);
    await accepted(
      f,
      NodeThinStorageAuthority.parse({
        ...complete,
        revision: 4,
        active_lv_uuids: [...complete.active_lv_uuids, receipt.lv_uuid],
      }),
    );
    expect((await release()).meta.changes).toBe(0);
    await accepted(
      f,
      NodeThinStorageAuthority.parse({
        ...complete,
        revision: 5,
        inventory_revision: 5,
        inventory_observed_at: new Date(Date.now() - 121000).toISOString(),
        inventory_expires_at: new Date(Date.now() + 60000).toISOString(),
      }),
    );
    expect((await release()).meta.changes).toBe(0);
    await accepted(
      f,
      NodeThinStorageAuthority.parse({
        ...complete,
        revision: 6,
        node_uid: crypto.randomUUID(),
      }),
    );
    expect((await release()).meta.changes).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT storage_volume_json,storage_budget_bytes FROM database_start_admissions WHERE operation_id=?",
      )
        .bind(restored.operation.id)
        .first(),
    ).toEqual({ storage_volume_json: null, storage_budget_bytes: 5 * gib });
  },
);
