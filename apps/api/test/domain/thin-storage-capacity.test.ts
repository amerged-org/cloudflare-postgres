// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import {
  DatabaseWithOperation,
  NodeThinStorageAuthority,
  ThinStorageProfile,
  newOperationId,
  thinStorageClass,
} from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { configureNodeRegionPolicy } from "../../src/domain/node-state.ts";
import { thinPoolRoomSql } from "../../src/domain/storage-capacity.ts";
import { cleanupFixtures, fixture, request, report } from "./fixtures.ts";
import { powerTransitionStatements } from "../../src/domain/lifecycle.ts";
import type { DatabaseRow } from "../../src/domain/rows.ts";
const mib = 1024 ** 2,
  gib = 1024 ** 3,
  sha = "a".repeat(64);
const vg = "ABCDEF-1234-1234-1234-1234-1234-ABCDEF",
  pool = "POOLXX-1234-1234-1234-1234-1234-ABCDEF";
const extraClasses: string[] = [];
const recoveryArchiveKeys: string[] = [];
afterEach(async () => {
  if (recoveryArchiveKeys.length)
    await env.ARCHIVE.delete(recoveryArchiveKeys.splice(0));
  await cleanupFixtures();
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
    "INSERT INTO node_thin_storage(node_id,node_uid,volume_group_uuid,profile_revision,profile_sha256,profile_json,allow_new_databases,authority_revision,authority_json,authority_received_at,status,created_at,updated_at) VALUES(?,?,?,1,?,?,1,1,?,?,'ready',?,?)",
  )
    .bind(
      f.node,
      node!.node_uid,
      vg,
      sha,
      JSON.stringify(profile),
      JSON.stringify(authority),
      observed,
      observed,
      observed,
    )
    .run();
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
  // room is space in the pool. An audit error live refused every wake on the node.
  await publish(f, {
    ...f.authority,
    write_allowed: false,
    observed_at: new Date(Date.now() - 3_600_000).toISOString(),
    expires_at: new Date(Date.now() - 3_570_000).toISOString(),
  });
  expect(await room(f)).toBe(1);
  await env.DB.prepare(
    "UPDATE node_thin_storage SET error_code='thin_storage_driver_unqualified' WHERE node_id=?",
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
    "UPDATE node_thin_storage SET status='selected' WHERE node_id=?",
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
it("the existing hold-ledger migration preserves uncertain and acknowledged RAM rows while zero RAM is stop-only", async () => {
  const f = await thinFixture();
  const first = DatabaseWithOperation.parse(
      await (await f.create("migration-uncertain")).json(),
    ),
    second = DatabaseWithOperation.parse(
      await (await f.create("migration-ready")).json(),
    );
  await report(f, second.database.id, 1);
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
