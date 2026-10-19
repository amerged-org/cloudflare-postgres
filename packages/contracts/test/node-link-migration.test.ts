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
  ])
    expect(tables).toContain(kept);
  // The orders and the archive credentials are the lifecycle's (0065), not this migration's.
  for (const absent of [
    "node_orders",
    "database_archive_credentials",
    "archive_credentials",
  ])
    expect(tables).not.toContain(absent);
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

it("gives a node the columns of its hello and drops the releases that state no OS facts", () => {
  populate();
  for (const name of migrations.filter((v) => v >= "0063" && v < "0072"))
    apply(name);
  run(
    "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES('old','{}',?,?)",
    "b".repeat(64),
    NOW,
  );
  run(
    "INSERT INTO fleet_region_releases(region_id,release_id,revision,updated_at) VALUES('eu-test','old',1,?)",
    NOW,
  );
  apply("0072_node_os.sql");
  const count = (table: string) =>
    db.prepare(`SELECT count(*) n FROM ${table}`).get();
  expect(count("fleet_releases")).toEqual({ n: 0 });
  expect(count("fleet_region_releases")).toEqual({ n: 0 });
  // The node keeps its row, with nothing reported yet.
  expect(
    db
      .prepare(
        "SELECT os_boot_id,os_booted_at,os_kernel_release,os_packages_sha256 FROM nodes WHERE id=?",
      )
      .get(node),
  ).toEqual({
    os_boot_id: null,
    os_booted_at: null,
    os_kernel_release: null,
    os_packages_sha256: null,
  });
  const report = (column: string, value: string) =>
    run(`UPDATE nodes SET ${column}=? WHERE id=?`, value, node);
  report("os_boot_id", crypto.randomUUID());
  report("os_booted_at", NOW);
  report("os_kernel_release", "6.12.113+deb13-amd64");
  report("os_packages_sha256", "a".repeat(64));
  for (const [column, value] of [
    ["os_boot_id", "boot"],
    ["os_booted_at", "yesterday"],
    ["os_kernel_release", "k".repeat(65)],
    ["os_packages_sha256", "A".repeat(64)],
  ] as const)
    expect(() => report(column, value), column).toThrow(/CHECK/);
});

it("gives a node the column of the host files it holds and drops the releases that state none", () => {
  populate();
  for (const name of migrations.filter((v) => v >= "0063" && v < "0079"))
    apply(name);
  run(
    "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES('old','{}',?,?)",
    "b".repeat(64),
    NOW,
  );
  run(
    "INSERT INTO fleet_region_releases(region_id,release_id,revision,updated_at) VALUES('eu-test','old',1,?)",
    NOW,
  );
  apply("0079_release_host_files.sql");
  // The node's row and what it reported stay; a release without host files cannot be read as a
  // spec any more and goes with the assignments that name it.
  const count = (table: string) =>
    db.prepare(`SELECT count(*) n FROM ${table}`).get();
  expect(count("fleet_releases")).toEqual({ n: 0 });
  expect(count("fleet_region_releases")).toEqual({ n: 0 });
  expect(
    db.prepare("SELECT os_host_files_sha256 FROM nodes WHERE id=?").get(node),
  ).toEqual({ os_host_files_sha256: null });
  const report = (value: string) =>
    run("UPDATE nodes SET os_host_files_sha256=? WHERE id=?", value, node);
  report("a".repeat(64));
  for (const value of ["A".repeat(64), "a".repeat(63), "a".repeat(65)])
    expect(() => report(value)).toThrow(/CHECK/);
});

it("keeps a boot report per node, bounded, and widens the alert kinds with the unexpected reboot", () => {
  populate();
  for (const name of migrations.filter((v) => v >= "0063" && v < "0073"))
    apply(name);
  const report = (
    previous: string | null,
    expected: number | null,
    change: Record<string, string | number | null> = {},
  ) => {
    const row = {
      id: crypto.randomUUID(),
      node_id: node,
      kind: "boot",
      boot_id: crypto.randomUUID(),
      previous_boot_id: previous,
      received_at: NOW,
      expected_reboot: expected,
      body: "{}",
      ...change,
    };
    run(
      `INSERT INTO node_diagnostics(id,node_id,kind,boot_id,previous_boot_id,received_at,expected_reboot,body)
       VALUES(?,?,?,?,?,?,?,?)`,
      ...Object.values(row),
    );
  };
  // The episode that was there stays, and the new kind joins it.
  const episodes = db.prepare("SELECT * FROM infrastructure_alerts").all();
  apply("0073_node_diagnostics.sql");
  expect(db.prepare("SELECT * FROM infrastructure_alerts").all()).toEqual(
    episodes,
  );
  run(
    `INSERT INTO infrastructure_alerts(region_id,kind,active,event_id,payload)
     VALUES('eu-test','node_unexpected_reboot',1,?,'{}')`,
    crypto.randomUUID(),
  );
  expect(() =>
    run(
      `INSERT INTO infrastructure_alerts(region_id,kind,active,event_id,payload)
       VALUES('eu-test','node_rebooted',1,?,'{}')`,
      crypto.randomUUID(),
    ),
  ).toThrow(/CHECK/);
  // A reboot is expected, unexpected, or not claimed because no earlier boot was known.
  const previous = crypto.randomUUID();
  report(previous, 1);
  report(previous, 0);
  report(null, null);
  for (const broken of [
    () => report(previous, null),
    () => report(null, 0),
    () => report(previous, 2),
    () => report(previous, 1, { kind: "journal" }),
    () => report(previous, 1, { boot_id: "boot" }),
    () => report(previous, 1, { received_at: "yesterday" }),
    () => report(previous, 1, { body: "not json" }),
    () => report(previous, 1, { body: "[" + "0,".repeat(600_000) + "0]" }),
  ])
    expect(broken).toThrow(/CHECK/);
  expect(() =>
    report(previous, 1, { node_id: `nod_${"z".repeat(20)}` }),
  ).toThrow(/FOREIGN KEY/);
  // The reports go with their node.
  run("DELETE FROM nodes WHERE id=?", node);
  expect(db.prepare("SELECT count(*) n FROM node_diagnostics").get()).toEqual({
    n: 0,
  });
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

it("keeps one row per node and minute and one volume per storage generation", () => {
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
});

it("keeps one order per operation and refuses what is no order", () => {
  populate();
  apply("0063_node_link.sql");
  apply("0064_placement_resources.sql");
  apply("0065_lifecycle.sql");
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
      `INSERT INTO lifecycle_orders(operation,node_id,type,database_id,storage_generation,remove_volume,created_at)
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
  // A failure names its reason, and a result is done or failed.
  expect(() =>
    run(
      "UPDATE lifecycle_orders SET result_status='failed' WHERE operation=?",
      `op_${"v".repeat(20)}`,
    ),
  ).toThrow(/CHECK/);
  expect(() =>
    run(
      "UPDATE lifecycle_orders SET result_status='paused' WHERE operation=?",
      `op_${"v".repeat(20)}`,
    ),
  ).toThrow(/CHECK/);
  run(
    "UPDATE lifecycle_orders SET result_status='failed',result_reason='no_recovery_point' WHERE operation=?",
    `op_${"v".repeat(20)}`,
  );
  // An order never reopens, changes what it orders or takes back a volume removal.
  run(
    "UPDATE lifecycle_orders SET closed_at=? WHERE operation=?",
    NOW,
    `op_${"s".repeat(20)}`,
  );
  for (const change of [
    "closed_at=NULL",
    "remove_volume=0",
    "storage_generation=2",
    "node_id='nod_zzzzzzzzzzzzzzzzzzzz'",
  ])
    expect(() =>
      run(
        `UPDATE lifecycle_orders SET ${change} WHERE operation=?`,
        `op_${"s".repeat(20)}`,
      ),
    ).toThrow(/lifecycle_order_immutable/);
  run("DELETE FROM databases WHERE id=?", database);
  expect(db.prepare("SELECT operation FROM lifecycle_orders").all()).toEqual([
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
