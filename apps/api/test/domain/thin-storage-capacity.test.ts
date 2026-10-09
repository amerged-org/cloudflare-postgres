// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import {
  DatabaseWithOperation,
  DesiredResponse,
  DatabaseStorageVolumeReceipt,
  NodeThinStorageAuthority,
  ThinStorageProfile,
  thinStorageClass,
} from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { installThinQualifiedFixture } from "./thin-qualified-fixture.ts";
import { configureNodeRegionPolicy } from "../../src/domain/node-state.ts";
import {
  nodeThinStorageHeadroomSql,
  storageProtectionStatements,
  storageHoldVolumeStatements,
  storageDrainReservationStatement,
  thinStorageDeletionConfirmedSql,
} from "../../src/domain/storage-capacity.ts";
import {
  cleanupFixtures,
  fixture,
  request,
  observation,
  observedBody,
} from "./fixtures.ts";
import { recoverStorageProtectedDatabases } from "../../src/domain/lifecycle.ts";
import {
  releaseCoveredStartupReservationsStatement,
  databaseCpuChargeSql,
} from "../../src/domain/startup-admission.ts";
const mib = 1024 ** 2,
  gib = 1024 ** 3,
  sha = "a".repeat(64);
const vg = "ABCDEF-1234-1234-1234-1234-1234-ABCDEF",
  pool = "POOLXX-1234-1234-1234-1234-1234-ABCDEF";
const thinProjects: string[] = [];
const extraClasses: string[] = [];
const qualifiedReleases: string[] = [];
afterEach(async () => {
  for (const project of thinProjects.splice(0))
    await env.DB.prepare(
      "UPDATE databases SET storage_protected_operation=NULL WHERE project_id=?",
    )
      .bind(project)
      .run();
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
async function thinFixture(dataFree = 32 * gib, poolData = 32 * gib) {
  const f = await fixture(8192, 1),
    now = Date.now(),
    observed = new Date(now).toISOString();
  thinProjects.push(f.project);
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
    `SELECT ${nodeThinStorageHeadroomSql()} fits FROM nodes n JOIN size_classes s ON s.id=? WHERE n.id=?`,
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
it("does not count latent VG free when the allocated pool cannot cover startup and bounded writes", async () => {
  const f = await thinFixture(520 * mib);
  expect(await fits(f)).toBe(0);
  expect(
    await nodeFor(
      DatabaseWithOperation.parse(await (await f.create()).json()).database.id,
    ),
  ).toBeNull();
});
it("serializes concurrent starts against physical storage holds and retains an uncertain failed start", async () => {
  const f = await thinFixture(512 * mib + 5 * gib + 1);
  const values = await Promise.all([f.create("one"), f.create("two")]);
  const bodies = await Promise.all(
    values.map(async (response) =>
      DatabaseWithOperation.parse(await response.json()),
    ),
  );
  const assigned = await Promise.all(bodies.map((v) => nodeFor(v.database.id)));
  expect(assigned.filter((v) => v === f.node)).toHaveLength(1);
  const active = bodies[assigned.indexOf(f.node)]!;
  await env.DB.prepare(
    "UPDATE operations SET status='failed',completed_at=?,error_code='operation_timeout' WHERE id=?",
  )
    .bind(new Date().toISOString(), active.operation.id)
    .run();
  expect(await fits(f)).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT storage_budget_bytes FROM database_start_admissions WHERE operation_id=?",
    )
      .bind(active.operation.id)
      .first("storage_budget_bytes"),
  ).toBe(5 * gib);
});
it("selected unqualified, unknown, stale or changed physical authority never falls back to thick admission", async () => {
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
  await publish(f, { ...f.authority, data_accounting_complete: false });
  expect(await fits(f)).toBe(0);
  await publish(f, { ...f.authority, node_uid: crypto.randomUUID() });
  expect(await fits(f)).toBe(0);
  await publish(f, {
    ...f.authority,
    expires_at: new Date(Date.now() - 1).toISOString(),
  });
  expect(await fits(f)).toBe(0);
});
it("physical metadata headroom and explicit logical quota maximum constrain a new volume", async () => {
  const f = await thinFixture();
  await publish(f, {
    ...f.authority,
    physical: {
      ...f.authority.physical,
      thin_pool: {
        ...f.authority.physical.thin_pool!,
        metadata_used_bytes_upper_bound: gib - 64 * mib,
      },
    },
  });
  expect(await fits(f)).toBe(0);
  await publish(f, f.authority);
  await env.DB.prepare("UPDATE size_classes SET storage_gib=17 WHERE id=?")
    .bind(f.size)
    .run();
  expect(await fits(f)).toBe(0);
});

async function bindVolume(
  f: Awaited<ReturnType<typeof thinFixture>>,
  created: ReturnType<typeof DatabaseWithOperation.parse>,
) {
  const receipt = DatabaseStorageVolumeReceipt.parse({
    storage_generation: 1,
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
    storage_generation: 1,
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
  protect = false,
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
    ...(protect ? storageProtectionStatements(env.DB, authority) : []),
  ]);
  return authority;
}
async function protectiveStop() {
  const f = await thinFixture(),
    created = DatabaseWithOperation.parse(await (await f.create()).json()),
    bound = await bindVolume(f, created),
    now = Date.now();
  const authority = await accepted(
    f,
    {
      ...bound.authority,
      revision: 2,
      observed_at: new Date(now).toISOString(),
      expires_at: new Date(now + 30000).toISOString(),
      write_allowed: false,
      protections: [
        {
          database_id: created.database.id,
          generation: 1,
          operation_id: created.operation.id,
          storage_uid: bound.receipt.storage_uid,
          namespace_uid: bound.receipt.namespace_uid,
          cluster_uid: bound.receipt.cluster_uid,
          node_uid: f.nodeUid,
          profile_sha256: sha,
          requested_at: now,
          hibernation_on: true,
          pods_absent: true,
        },
      ],
    },
    true,
  );
  return { ...f, created, ...bound, authority };
}
it("a proven protective stop releases CPU and recovers through one real bounded resume intent", async () => {
  const f = await protectiveStop(),
    id = f.created.database.id;
  expect(
    await env.DB.prepare(
      "SELECT desired_state,observed_power,storage_protected_generation FROM databases WHERE id=?",
    )
      .bind(id)
      .first(),
  ).toEqual({
    desired_state: "running",
    observed_power: "hibernated",
    storage_protected_generation: 1,
  });
  expect(
    await env.DB.prepare(
      `SELECT ${databaseCpuChargeSql()} charge FROM databases d JOIN size_classes s ON s.id=d.size_class_id WHERE d.id=?`,
    )
      .bind(id)
      .first("charge"),
  ).toBe(0);
  expect(await recoverStorageProtectedDatabases(env.DB, f.region)).toEqual([]);
  const now = Date.now();
  await accepted(f, {
    ...f.authority,
    revision: 3,
    observed_at: new Date(now).toISOString(),
    expires_at: new Date(now + 30000).toISOString(),
    write_allowed: true,
  });
  expect(await recoverStorageProtectedDatabases(env.DB, f.region)).toEqual([
    id,
  ]);
  expect(await recoverStorageProtectedDatabases(env.DB, f.region)).toEqual([]);
  expect(
    await env.DB.prepare(
      `SELECT ${databaseCpuChargeSql()} charge FROM databases d JOIN size_classes s ON s.id=d.size_class_id WHERE d.id=?`,
    )
      .bind(id)
      .first("charge"),
  ).toBe(600);
  expect(
    await env.DB.prepare(
      "SELECT generation,desired_state,storage_protected_at FROM databases WHERE id=?",
    )
      .bind(id)
      .first(),
  ).toEqual({
    generation: 2,
    desired_state: "running",
    storage_protected_at: null,
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM operations WHERE database_id=? AND kind='database.resume'",
    )
      .bind(id)
      .first("n"),
  ).toBe(1);
});
it("manual suspension wins over a current protective stop and stale Native repeats cannot reopen it", async () => {
  const f = await protectiveStop(),
    id = f.created.database.id;
  const suspended = await request(
    `/v1/databases/${id}/suspend`,
    f.integrator,
    "POST",
    undefined,
    crypto.randomUUID(),
  );
  expect(suspended.status).toBe(202);
  await env.DB.batch(storageProtectionStatements(env.DB, f.authority));
  expect(await recoverStorageProtectedDatabases(env.DB, f.region)).toEqual([]);
  expect(
    await env.DB.prepare(
      "SELECT desired_state,generation,storage_protected_at FROM databases WHERE id=?",
    )
      .bind(id)
      .first(),
  ).toEqual({
    desired_state: "suspended",
    generation: 2,
    storage_protected_at: null,
  });
});
it("a fresh RAM sample alone cannot settle storage; a later bound Native physical read can", async () => {
  const f = await protectiveStop();
  const release = () =>
    releaseCoveredStartupReservationsStatement(env.DB, {
      nodeId: f.node,
      nodeUid: f.nodeUid,
    }).run();
  expect(
    await env.DB.prepare(
      "SELECT ready_at FROM database_start_admissions WHERE operation_id=?",
    )
      .bind(f.created.operation.id)
      .first("ready_at"),
  ).not.toBeNull();
  await new Promise((done) => setTimeout(done, 5100));
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE node_memory_samples SET observed_at=? WHERE node_id=? AND node_uid=?",
  )
    .bind(new Date(now).toISOString(), f.node, f.nodeUid)
    .run();
  expect((await release()).meta.changes).toBe(0);
  await accepted(f, {
    ...f.authority,
    revision: 3,
    observed_at: new Date(now).toISOString(),
    expires_at: new Date(now + 30000).toISOString(),
  });
  expect((await release()).meta.changes).toBe(1);
}, 15000);
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

it("a same-generation Regional Ready report cannot overwrite a Native protective stop", async () => {
  const f = await protectiveStop(),
    id = f.created.database.id;
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(id, 1),
        postgres: {
          image: f.postgres.reference,
          image_id: "sha256:" + f.postgres.sha256,
        },
      },
    ]),
  );
  expect(
    await env.DB.prepare("SELECT observed_power FROM databases WHERE id=?")
      .bind(id)
      .first("observed_power"),
  ).toBe("hibernated");
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
  expect(database.storage_startup).toEqual({
    operation_id: created.operation.id,
    generation: 1,
    node_uid: f.nodeUid,
    budget_bytes: 5 * gib,
    expires_at: f.authority.expires_at,
  });
  expect(database.storage_authority).toBeUndefined();
});
it("a retained protected generation emits no startup grant but a real newer recovery does", async () => {
  const f = await protectiveStop(),
    id = f.created.database.id;
  await accepted(f, { ...f.authority, revision: 3, write_allowed: true });
  const holds = () =>
    env.DB.prepare(
      "SELECT operation_id,generation,budget_bytes,storage_budget_bytes,ready_at FROM database_start_admissions WHERE database_id=? ORDER BY generation",
    )
      .bind(id)
      .all();
  const retained = (await holds()).results;
  expect(retained[0]!.ready_at).not.toBeNull();
  const desired = async () =>
    DesiredResponse.parse(
      await (await request("/agent/v1/desired", f.agent)).json(),
    ).databases.find((db) => db.id === id)!;
  const host = async () => {
    const response = await request(
      `/agent/v1/nodes/${f.node}/storage-guard`,
      f.agent,
    );
    expect(response.status).toBe(200);
    return (await response.json()) as {
      databases: {
        database_id: string;
        startup_operation_id: string | null;
        startup_expires_at: number | null;
      }[];
    };
  };
  expect((await desired()).storage_startup).toBeUndefined();
  expect(
    (await host()).databases.find((db) => db.database_id === id),
  ).toMatchObject({ startup_operation_id: null, startup_expires_at: null });
  expect((await holds()).results).toEqual(retained);
  const resumed = DatabaseWithOperation.parse(
    await (
      await request(
        `/v1/databases/${id}/resume`,
        f.integrator,
        "POST",
        undefined,
        crypto.randomUUID(),
      )
    ).json(),
  );
  expect(resumed.operation.kind).toBe("database.resume");
  expect(resumed.database.generation).toBe(2);
  expect((await desired()).storage_startup?.operation_id).toBe(
    resumed.operation.id,
  );
  expect(
    (await host()).databases.find((db) => db.database_id === id)
      ?.startup_operation_id,
  ).toBe(resumed.operation.id);
  expect((await holds()).results[0]).toEqual(retained[0]);
});
it("an uncertain unready hold stays reserved but cannot restart its protected generation", async () => {
  const f = await thinFixture(),
    created = DatabaseWithOperation.parse(await (await f.create()).json()),
    id = created.database.id;
  await env.DB.prepare(
    "UPDATE databases SET storage_protected_at=?,storage_protected_generation=generation,storage_protected_operation=? WHERE id=?",
  )
    .bind(new Date().toISOString(), created.operation.id, id)
    .run();
  const before = await env.DB.prepare(
    "SELECT operation_id,budget_bytes,storage_budget_bytes,ready_at FROM database_start_admissions WHERE database_id=?",
  )
    .bind(id)
    .first();
  expect(before!.ready_at).toBeNull();
  const page = DesiredResponse.parse(
    await (await request("/agent/v1/desired", f.agent)).json(),
  );
  expect(
    page.databases.find((db) => db.id === id)!.storage_startup,
  ).toBeUndefined();
  const response = await request(
    `/agent/v1/nodes/${f.node}/storage-guard`,
    f.agent,
  );
  expect(response.status).toBe(200);
  const host = (await response.json()) as {
    databases: { database_id: string; startup_operation_id: string | null }[];
  };
  expect(
    host.databases.find((db) => db.database_id === id)!.startup_operation_id,
  ).toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT operation_id,budget_bytes,storage_budget_bytes,ready_at FROM database_start_admissions WHERE database_id=?",
    )
      .bind(id)
      .first(),
  ).toEqual(before);
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

it("recovers one quiesced physical LV in an8GiB pool while keeping both real5GiB startup holds", async () => {
  const f = await thinFixture(8 * gib, 8 * gib),
    created = DatabaseWithOperation.parse(await (await f.create()).json()),
    bound = await bindVolume(f, created),
    now = Date.now();
  const authority = await accepted(
    f,
    {
      ...bound.authority,
      revision: 2,
      active_lv_uuids: [bound.receipt.lv_uuid],
      observed_at: new Date(now).toISOString(),
      captured_at: new Date(now).toISOString(),
      expires_at: new Date(now + 30000).toISOString(),
      volumes: bound.authority.volumes.map((v) => ({
        ...v,
        quiesced: true,
        io: [],
      })),
    },
    true,
  );
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM database_start_admissions WHERE database_id=?",
    )
      .bind(created.database.id)
      .first("n"),
  ).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT storage_volume_json FROM database_start_admissions WHERE database_id=?",
    )
      .bind(created.database.id)
      .first("storage_volume_json"),
  ).not.toBeNull();
  expect(
    await env.DB.prepare(
      `SELECT ${nodeThinStorageHeadroomSql("n", "s", "d")} valid FROM databases d JOIN nodes n ON n.id=d.node_id JOIN size_classes s ON s.id=d.size_class_id WHERE d.id=?`,
    )
      .bind(created.database.id)
      .first("valid"),
  ).toBe(1);
  expect(await recoverStorageProtectedDatabases(env.DB, f.region)).toEqual([
    created.database.id,
  ]);
  const holds = (
    await env.DB.prepare(
      "SELECT storage_budget_bytes,ready_at FROM database_start_admissions WHERE database_id=? ORDER BY generation",
    )
      .bind(created.database.id)
      .all()
  ).results;
  expect(holds).toEqual([
    { storage_budget_bytes: 5 * gib, ready_at: null },
    { storage_budget_bytes: 5 * gib, ready_at: null },
  ]);
  expect(
    await env.DB.prepare(
      "SELECT generation,observed_power FROM databases WHERE id=?",
    )
      .bind(created.database.id)
      .first(),
  ).toEqual({ generation: 2, observed_power: "awake" });
  expect(authority.physical.thin_pool!.data_total_bytes).toBe(8 * gib);
  const again = await accepted(
    f,
    {
      ...authority,
      revision: 3,
      observed_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30000).toISOString(),
      volumes: authority.volumes.map((v) => ({ ...v, generation: 2 })),
    },
    true,
  );
  expect(await recoverStorageProtectedDatabases(env.DB, f.region)).toEqual([
    created.database.id,
  ]);
  const current = await env.DB.prepare(
    "SELECT generation,power_operation FROM databases WHERE id=?",
  )
    .bind(created.database.id)
    .first<{ generation: number; power_operation: string }>();
  expect(current!.generation).toBe(3);
  const podUid = crypto.randomUUID();
  const ready = await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(created.database.id, 3),
        power: {
          state: "awake",
          operation: current!.power_operation,
          revision: 3,
        },
        postgres: {
          image: f.postgres.reference,
          image_id: "sha256:" + f.postgres.sha256,
        },
        runtime_attestation: {
          v: 1,
          database_id: created.database.id,
          generation: 3,
          storage_generation: 1,
          node_uid: f.nodeUid,
          boot_id: f.bootId,
          cluster_uid: f.authority.cluster_uid,
          namespace_uid: bound.receipt.namespace_uid,
          cnpg_cluster_uid: bound.receipt.cluster_uid,
          storage_uid: bound.receipt.storage_uid,
          pvc_uid: bound.receipt.pvc_uid,
          pv_uid: bound.receipt.pv_uid,
          pod_uid: podUid,
          container_id: "c".repeat(64),
          postgres_image_sha256: f.postgres.sha256,
          memory_request_bytes: 128 * mib,
          memory_limit_bytes: 256 * mib,
          observed_at: Date.now(),
          configuration_fingerprint: "f".repeat(64),
        },
      },
    ]),
  );
  expect(ready.status).toBe(200);
  const before = await env.DB.prepare(
    "SELECT COUNT(*) n FROM database_start_admissions WHERE database_id=? AND ready_at IS NULL",
  )
    .bind(created.database.id)
    .first("n");
  expect(before).toBe(1); // The intermediate resume hold needs physical supersession proof.
  const at = Date.now() + 1;
  const running = await accepted(f, {
    ...again,
    revision: 4,
    observed_at: new Date(at).toISOString(),
    captured_at: new Date(at).toISOString(),
    expires_at: new Date(at + 30000).toISOString(),
    volumes: again.volumes.map((v) => ({
      ...v,
      generation: 3,
      quiesced: false,
      io: [
        {
          pod_uid: podUid,
          write_bytes_per_second: f.profile.write_bytes_per_second,
          write_iops_per_second: f.profile.write_iops_per_second,
        },
      ],
    })),
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM database_start_admissions WHERE database_id=? AND ready_at IS NULL",
    )
      .bind(created.database.id)
      .first("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM database_start_admissions WHERE database_id=?",
    )
      .bind(created.database.id)
      .first("n"),
  ).toBe(3);
  const release = () =>
    releaseCoveredStartupReservationsStatement(env.DB, {
      nodeId: f.node,
      nodeUid: f.nodeUid,
    }).run();
  expect((await release()).meta.changes).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 5100));
  const later = Date.now();
  await env.DB.prepare(
    "UPDATE node_memory_samples SET observed_at=? WHERE node_id=? AND node_uid=?",
  )
    .bind(new Date(later).toISOString(), f.node, f.nodeUid)
    .run();
  await accepted(f, {
    ...running,
    revision: 5,
    observed_at: new Date(later).toISOString(),
    captured_at: new Date(later).toISOString(),
    expires_at: new Date(later + 30000).toISOString(),
  });
  expect((await release()).meta.changes).toBe(3);
}, 15000);

it("unknown or different-LV old holds cannot share a new startup or overwrite their captured identity", async () => {
  const f = await thinFixture(8 * gib, 8 * gib),
    created = DatabaseWithOperation.parse(await (await f.create()).json()),
    bound = await bindVolume(f, created),
    at = Date.now();
  const a = NodeThinStorageAuthority.parse({
    ...bound.authority,
    revision: 2,
    active_lv_uuids: [bound.receipt.lv_uuid],
    observed_at: new Date(at).toISOString(),
    captured_at: new Date(at).toISOString(),
    expires_at: new Date(at + 30000).toISOString(),
    volumes: bound.authority.volumes.map((v) => ({ ...v, quiesced: true })),
  });
  // Legacy/unknown binding remains unknown despite a current database receipt.
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE node_thin_storage SET authority_revision=2,authority_json=?,authority_received_at=? WHERE node_id=?",
    ).bind(JSON.stringify(a), a.observed_at, f.node),
    ...storageProtectionStatements(env.DB, a),
  ]);
  expect(await recoverStorageProtectedDatabases(env.DB, f.region)).toEqual([]);
  const different = JSON.stringify({
    ...bound.receipt,
    lv_uuid: "OTHERX-1234-1234-1234-1234-1234-ABCDEF",
  });
  await env.DB.prepare(
    "UPDATE database_start_admissions SET storage_volume_json=? WHERE operation_id=?",
  )
    .bind(different, created.operation.id)
    .run();
  await accepted(f, a, true);
  expect(await recoverStorageProtectedDatabases(env.DB, f.region)).toEqual([]);
  await expect(
    env.DB.prepare(
      "UPDATE database_start_admissions SET storage_volume_json=? WHERE operation_id=?",
    )
      .bind(JSON.stringify(bound.receipt), created.operation.id)
      .run(),
  ).rejects.toThrow("database_start_storage_binding_immutable");
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM database_start_admissions WHERE database_id=?",
    )
      .bind(created.database.id)
      .first("n"),
  ).toBe(1);
});

it("a protected4GiB tenant can drain a real suspend/delete intent with zero additional RAM and no startup grant", async () => {
  const f = await thinFixture(8 * gib, 8 * gib);
  await env.DB.prepare("UPDATE size_classes SET memory_mib=4096 WHERE id=?")
    .bind(f.size)
    .run();
  const created = DatabaseWithOperation.parse(await (await f.create()).json()),
    bound = await bindVolume(f, created),
    at = Date.now();
  let a = await accepted(
    f,
    {
      ...bound.authority,
      revision: 2,
      active_lv_uuids: [bound.receipt.lv_uuid],
      observed_at: new Date(at).toISOString(),
      captured_at: new Date(at).toISOString(),
      expires_at: new Date(at + 30000).toISOString(),
      volumes: bound.authority.volumes.map((v) => ({ ...v, quiesced: true })),
    },
    true,
  );
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
        startup_operation_id: null;
        runtime_authority: null;
        drain: null | {
          operation_id: string;
          kind: string;
          budget_bytes: number;
        };
      }[];
    };
  };
  const value = (await host()).databases[0]!;
  expect(value).toMatchObject({
    database_id: created.database.id,
    desired_state: "suspended",
    startup_operation_id: null,
    runtime_authority: null,
    drain: {
      operation_id: stop.operation.id,
      kind: "database.suspend",
      budget_bytes: 5 * gib,
    },
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
      "SELECT budget_bytes,storage_budget_bytes FROM database_start_admissions WHERE operation_id=?",
    )
      .bind(stop.operation.id)
      .first(),
  ).toEqual({ budget_bytes: 0, storage_budget_bytes: 5 * gib });
  const desired = DesiredResponse.parse(
    await (await request("/agent/v1/desired", f.agent)).json(),
  );
  expect(
    desired.databases.find((d) => d.id === created.database.id)!
      .storage_startup,
  ).toBeUndefined();
  await storageDrainReservationStatement(env.DB, {
    databaseId: created.database.id,
    operationId: created.operation.id,
    generation: 2,
    nodeId: f.node,
    now: new Date().toISOString(),
  }).run();
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM database_start_admissions WHERE database_id=?",
    )
      .bind(created.database.id)
      .first("n"),
  ).toBe(2);
  const wrong = NodeThinStorageAuthority.parse({
    ...a,
    revision: 4,
    physical_lvs: a.physical_lvs.map((v) => ({
      ...v,
      lv_uuid: "OTHERX-1234-1234-1234-1234-1234-ABCDEF",
    })),
    active_lv_uuids: ["OTHERX-1234-1234-1234-1234-1234-ABCDEF"],
    volumes: a.volumes.map((v) => ({
      ...v,
      lv_uuid: "OTHERX-1234-1234-1234-1234-1234-ABCDEF",
    })),
  });
  await env.DB.prepare(
    "UPDATE node_thin_storage SET authority_revision=4,authority_json=? WHERE node_id=?",
  )
    .bind(JSON.stringify(wrong), f.node)
    .run();
  expect((await host()).databases[0]!.drain).toBeNull();
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
  expect((await host()).databases[0]!).toMatchObject({
    desired_state: "deleted",
    startup_operation_id: null,
    runtime_authority: null,
    drain: {
      operation_id: deleted.operation.id,
      kind: "database.delete",
      budget_bytes: 5 * gib,
    },
  });
  expect(
    await env.DB.prepare(
      "SELECT SUM(budget_bytes) n FROM database_start_admissions WHERE database_id=?",
    )
      .bind(created.database.id)
      .first("n"),
  ).toBe(memoryBefore);
  const expired = {
    ...a,
    observed_at: new Date(Date.now() - 30000).toISOString(),
    expires_at: new Date(Date.now() - 1).toISOString(),
  };
  await env.DB.prepare(
    "UPDATE node_thin_storage SET authority_json=? WHERE node_id=?",
  )
    .bind(JSON.stringify(expired), f.node)
    .run();
  expect((await host()).databases[0]!.drain).toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM database_start_admissions WHERE database_id=?",
    )
      .bind(created.database.id)
      .first("n"),
  ).toBe(3);
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
