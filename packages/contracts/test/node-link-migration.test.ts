// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";

const directory = new URL("../../../apps/api/migrations/", import.meta.url);
const migrations = readdirSync(directory)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const NOW = "2026-10-18T10:00:00.000Z";
const node = `nod_${"a".repeat(20)}`;
const project = `prj_${"a".repeat(20)}`;
const gateway = `https://${["gateway", "example", "com"].join(".")}`;
const endpoint = `https://${["r2", "example", "com"].join(".")}`;
let db: DatabaseSync;

/** D1 applies a migration as one transaction, which `defer_foreign_keys` lasts for. */
const apply = (name: string) => {
  db.exec("BEGIN");
  try {
    db.exec(readFileSync(new URL(name, directory), "utf8"));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};
const run = (sql: string, ...params: (string | number | null)[]) =>
  db.prepare(sql).run(...params);

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of migrations.filter((value) => value < "0063")) apply(name);
});
afterEach(() => db.close());

function populate() {
  run(
    "INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)",
    project,
    "p",
    NOW,
    NOW,
  );
  run(
    `INSERT INTO regions(id,provider,provider_region,gateway_url,backup_bucket,backup_endpoint_url,agent_key_hash,agent_last_seen_at,created_at,updated_at)
     VALUES('eu-test','contabo','EU',?,'pgcf-test',?,?,?,?,?)`,
    gateway,
    endpoint,
    "a".repeat(64),
    NOW,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO nodes(id,region_id,k8s_node_name,allocatable_memory_mib,allocatable_cpu_millicores,created_at,updated_at)
     VALUES(?,'eu-test','eu1',0,0,?,?)`,
    node,
    NOW,
    NOW,
  );
  run(
    "INSERT INTO admission_scope_fences(kind,scope_id,region_id,revision) VALUES('region','eu-test','eu-test',7)",
  );
  // The fences of projects and nodes do not cascade from a region and stay as they are.
  run(
    "INSERT INTO admission_scope_fences(kind,scope_id,project_id,revision) VALUES('project',?,?,3)",
    project,
    project,
  );
  run(
    "INSERT INTO admission_scope_fences(kind,scope_id,node_id,revision) VALUES('node',?,?,5)",
    node,
    node,
  );
  run(
    `INSERT INTO infrastructure_alerts(region_id,kind,active,event_id,payload)
     VALUES('eu-test','regional_node_stale',1,?,'{}')`,
    crypto.randomUUID(),
  );
}

it("rebuilds regions without the agent key and keeps what cascades from them", () => {
  populate();
  apply("0063_node_link.sql");
  const columns = db
    .prepare("SELECT name FROM pragma_table_info('regions')")
    .all()
    .map((row) => row.name);
  expect(columns).not.toContain("agent_key_hash");
  expect(columns).not.toContain("agent_last_seen_at");
  expect(db.prepare("SELECT id,gateway_url FROM regions").all()).toEqual([
    { id: "eu-test", gateway_url: gateway },
  ]);
  expect(
    db
      .prepare(
        "SELECT kind,scope_id,revision FROM admission_scope_fences ORDER BY kind",
      )
      .all(),
  ).toEqual([
    { kind: "node", scope_id: node, revision: 5 },
    { kind: "project", scope_id: project, revision: 3 },
    { kind: "region", scope_id: "eu-test", revision: 7 },
  ]);
  expect(
    db.prepare("SELECT region_id,kind,active FROM infrastructure_alerts").all(),
  ).toEqual([{ region_id: "eu-test", kind: "regional_node_stale", active: 1 }]);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  // The children still reference the new table.
  expect(() =>
    run(
      "INSERT INTO nodes(id,region_id,k8s_node_name,allocatable_memory_mib,allocatable_cpu_millicores,created_at,updated_at) VALUES(?,'eu-missing','x',0,0,?,?)",
      `nod_${"b".repeat(20)}`,
      NOW,
      NOW,
    ),
  ).toThrow(/FOREIGN KEY/);
});

it("drops the releases of the Talos spec and the per-node release tables", () => {
  populate();
  run(
    "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES('old','{}',?,?)",
    "b".repeat(64),
    NOW,
  );
  run(
    "INSERT INTO fleet_region_releases(region_id,release_id,revision,updated_at) VALUES('eu-test','old',1,?)",
    NOW,
  );
  apply("0063_node_link.sql");
  expect(db.prepare("SELECT count(*) n FROM fleet_releases").get()).toEqual({
    n: 0,
  });
  expect(
    db.prepare("SELECT count(*) n FROM fleet_region_releases").get(),
  ).toEqual({ n: 0 });
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((row) => row.name);
  for (const gone of [
    "fleet_node_releases",
    "fleet_node_release_observations",
    "fleet_update_policy",
    "fleet_update_candidates",
  ])
    expect(tables).not.toContain(gone);
  for (const kept of [
    "node_installs",
    "node_minutes",
    "node_volumes",
    "node_event_ids",
    "node_orders",
  ])
    expect(tables).toContain(kept);
  // A release is a node image: nothing may still demand a PostgreSQL image in a region's release,
  // or no database could be created once a region has one.
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='database_postgres_release_supported'",
      )
      .all(),
  ).toEqual([]);
});

it("widens the alert kinds with the refused enrollment and keeps the episodes", () => {
  populate();
  apply("0063_node_link.sql");
  const alert = (kind: string) =>
    run(
      `INSERT INTO infrastructure_alerts(region_id,kind,active,event_id,payload)
       VALUES('eu-test',?,1,?,'{}')`,
      kind,
      crypto.randomUUID(),
    );
  alert("node_enrollment_refused");
  expect(() => alert("regional_node_disk_warning")).toThrow(/CHECK/);
  expect(
    db.prepare("SELECT kind FROM infrastructure_alerts ORDER BY kind").all(),
  ).toEqual([
    { kind: "node_enrollment_refused" },
    { kind: "regional_node_stale" },
  ]);
});

it("keeps one row per node and minute, one volume per storage generation and one order per operation", () => {
  populate();
  apply("0063_node_link.sql");
  const minute = Math.floor(Date.parse(NOW) / 60_000);
  run(
    "INSERT INTO node_minutes(node_id,minute,samples) VALUES(?,?,0)",
    node,
    minute,
  );
  expect(() =>
    run(
      "INSERT INTO node_minutes(node_id,minute,samples) VALUES(?,?,0)",
      node,
      minute,
    ),
  ).toThrow(/UNIQUE|PRIMARY/);
  const volume = (generation: number, mounted: number) =>
    run(
      `INSERT INTO node_volumes(node_id,database_id,storage_generation,mounted,size_bytes,pool_used_bytes,
        filesystem_total_bytes,filesystem_used_bytes,inodes_total,inodes_used,observed_at)
       VALUES(?,?,?,?,1073741824,100,?,?,?,?,?)`,
      node,
      "a".repeat(20),
      generation,
      mounted,
      mounted ? 1000 : null,
      mounted ? 10 : null,
      mounted ? 100 : null,
      mounted ? 1 : null,
      NOW,
    );
  volume(1, 1);
  volume(2, 0);
  expect(() => volume(1, 0)).toThrow(/UNIQUE|PRIMARY/);
  // A mounted volume reports its filesystem and an unmounted one does not.
  expect(() =>
    run(
      `INSERT INTO node_volumes(node_id,database_id,storage_generation,mounted,size_bytes,pool_used_bytes,observed_at)
       VALUES(?,?,3,1,1073741824,100,?)`,
      node,
      "a".repeat(20),
      NOW,
    ),
  ).toThrow(/CHECK/);
  run(
    `INSERT INTO size_classes(id,memory_mib,cpu_millicores,storage_gib,max_connections,archive_timeout_seconds,backup_retention_days,created_at,updated_at)
     VALUES('small',512,500,10,100,60,7,?,?)`,
    NOW,
    NOW,
  );
  const database = "a".repeat(20);
  run(
    `INSERT INTO databases(id,project_id,region_id,node_id,name,size_class_id,desired_state,archive_path,created_at,updated_at)
     VALUES(?,?,'eu-test',?,'db','small','running',?,?,?)`,
    database,
    project,
    node,
    `s3://pgcf-test/eu-test/${database}/g1-op_${"c".repeat(20)}`,
    NOW,
    NOW,
  );
  const order = (
    operation: string,
    type: string,
    on: string | null,
    generation: number | null,
    remove = 0,
  ) =>
    run(
      `INSERT INTO node_orders(operation,node_id,type,database_id,storage_generation,remove_volume,created_at)
       VALUES(?,?,?,?,?,?,?)`,
      operation,
      node,
      type,
      on,
      generation,
      remove,
      NOW,
    );
  order(`op_${"m".repeat(20)}`, "maintenance", null, null);
  order(`op_${"s".repeat(20)}`, "superseded", database, 1, 1);
  order(`op_${"v".repeat(20)}`, "move", database, 2);
  expect(() =>
    order(`op_${"m".repeat(20)}`, "maintenance", null, null),
  ).toThrow(/UNIQUE|PRIMARY/);
  // A move names its database and storage generation, a maintenance neither; only a retired
  // generation removes its volume; the type is one of three.
  for (const [type, on, generation, remove] of [
    ["move", null, 1, 0],
    ["move", database, null, 0],
    ["maintenance", database, null, 0],
    ["maintenance", null, 1, 0],
    ["move", database, 1, 1],
    ["fence", null, null, 0],
    ["wake", database, 1, 0],
  ] as const)
    expect(() =>
      order(`op_${"x".repeat(20)}`, type, on, generation, remove),
    ).toThrow(/CHECK/);
  // The result ends an order and a failure names its reason.
  expect(() =>
    run(
      "UPDATE node_orders SET result='failed',resulted_at=? WHERE operation=?",
      NOW,
      `op_${"v".repeat(20)}`,
    ),
  ).toThrow(/CHECK/);
  run(
    "UPDATE node_orders SET result='failed',reason='no_recovery_point',resulted_at=? WHERE operation=?",
    NOW,
    `op_${"v".repeat(20)}`,
  );
  run("DELETE FROM databases WHERE id=?", database);
  expect(db.prepare("SELECT operation FROM node_orders").all()).toEqual([
    { operation: `op_${"m".repeat(20)}` },
  ]);
});

it("stores an installer's tokens as hashes, one install per node and one node per token", () => {
  populate();
  apply("0063_node_link.sql");
  const install = (id: string, token: string, progress: string) =>
    run(
      `INSERT INTO node_installs(node_id,image_version,token_hash,progress_hash,allowed_sources_json,issued_at,expires_at)
       VALUES(?,'1.0.0',?,?,'[]',?,?)`,
      id,
      token,
      progress,
      NOW,
      "2026-10-18T10:30:00.000Z",
    );
  install(node, "a".repeat(64), "b".repeat(64));
  expect(() => install(node, "c".repeat(64), "d".repeat(64))).toThrow(
    /UNIQUE|PRIMARY/,
  );
  expect(() =>
    install(`nod_${"b".repeat(20)}`, "a".repeat(64), "e".repeat(64)),
  ).toThrow(/UNIQUE/);
  expect(() =>
    install(`nod_${"c".repeat(20)}`, "not hex", "f".repeat(64)),
  ).toThrow(/CHECK/);
  // The enrollment fills its three columns together.
  expect(() =>
    run("UPDATE node_installs SET enrolled_at=? WHERE node_id=?", NOW, node),
  ).toThrow(/CHECK/);
  run(
    "UPDATE node_installs SET enrolled_at=?,enrolled_public_key='k',enrolled_node_uid='u' WHERE node_id=?",
    NOW,
    node,
  );
});
