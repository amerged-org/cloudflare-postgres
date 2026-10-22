// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";

const directory = new URL("../../../apps/api/migrations/", import.meta.url);
const migrations = readdirSync(directory)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const MIGRATION = "0082_drop_dead_capacity_fields.sql";
const NOW = "2026-10-20T10:00:00.000Z";
const project = `prj_${"a".repeat(20)}`;
const node = `nod_${"a".repeat(20)}`;
const gateway = `https://${["gateway", "example", "com"].join(".")}`;
const endpoint = `https://${["r2", "example", "com"].join(".")}`;
// Database IDs start with any letter: the migration works through them one first letter at a time.
const first = `a${"1".repeat(19)}`;
const last = `z${"2".repeat(19)}`;
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
const columns = (table: string) =>
  db
    .prepare(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((row) => row.name);

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of migrations.filter((value) => value < MIGRATION))
    apply(name);
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
  for (const id of ["eu-a", "eu-b", "eu-c"])
    run(
      `INSERT INTO regions(id,provider,provider_region,gateway_url,backup_bucket,backup_endpoint_url,created_at,updated_at)
       VALUES(?,'contabo','EU',?,'pgcf-test',?,?,?)`,
      id,
      gateway,
      endpoint,
      NOW,
      NOW,
    );
  run(
    `INSERT INTO nodes(id,region_id,hostname,allocatable_memory_mib,allocatable_cpu_millicores,created_at,updated_at,memory_window_valid,memory_utilization_ppm)
     VALUES(?,'eu-a','eu1',0,0,?,?,1,500000)`,
    node,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO size_classes(id,memory_mib,cpu_millicores,cpu_request_millicores,storage_gib,max_connections,archive_timeout_seconds,backup_retention_days,created_at,updated_at)
     VALUES('small',512,500,25,10,100,60,7,?,?)`,
    NOW,
    NOW,
  );
  for (const id of [first, last])
    run(
      `INSERT INTO databases(id,project_id,region_id,node_id,name,size_class_id,desired_state,archive_path,created_at,updated_at)
       VALUES(?,?,'eu-a',?,?,'small','running','s3://pgcf-test/eu-a/x',?,?)`,
      id,
      project,
      node,
      id,
      NOW,
      NOW,
    );
}

const reserved = {
  reserved_memory_mib_seconds: 640,
  reserved_cpu_millicore_seconds: 600,
  reserved_storage_byte_seconds: 7,
};
const kept = {
  provisioned_seconds: 3600,
  awake_seconds: 1800,
  memory_mib_seconds: 5,
  cpu_millicore_seconds: 6,
  storage_allocated_bytes: 7,
  connections: 3,
};
const hour = (id: string, at: string, metrics: object, gaps: string[]) =>
  run(
    "INSERT INTO usage_hourly(database_id,hour,metrics,gaps,final,computed_at) VALUES(?,?,?,?,1,?)",
    id,
    at,
    JSON.stringify(metrics),
    JSON.stringify(gaps),
    NOW,
  );

it("removes the three reserved usage metrics from hourly rows and keeps every row with its other metrics", () => {
  populate();
  hour(first, "2026-10-19T08:00:00.000Z", { ...kept, ...reserved }, [
    "reserved_memory_mib_seconds",
    "traffic_coverage",
    "reserved_storage_byte_seconds",
    "resource_snapshot",
  ]);
  hour(first, "2026-10-19T09:00:00.000Z", { ...kept, ...reserved }, [
    "reserved_cpu_millicore_seconds",
  ]);
  hour(last, "2026-10-19T08:00:00.000Z", { ...kept, ...reserved }, []);
  // A row that never held them, as the rollup of a database before metering would leave it.
  hour(last, "2026-10-19T09:00:00.000Z", { ...kept }, ["lifecycle"]);
  const before = db.prepare("SELECT count(*) n FROM usage_hourly").get();
  apply(MIGRATION);
  expect(db.prepare("SELECT count(*) n FROM usage_hourly").get()).toEqual(
    before,
  );
  const rows = db
    .prepare(
      "SELECT database_id,hour,metrics,gaps,final,computed_at FROM usage_hourly ORDER BY database_id,hour",
    )
    .all()
    .map((row) => ({
      ...row,
      metrics: JSON.parse(String(row.metrics)),
      gaps: JSON.parse(String(row.gaps)),
    }));
  expect(rows).toEqual([
    {
      database_id: first,
      hour: "2026-10-19T08:00:00.000Z",
      metrics: kept,
      gaps: ["traffic_coverage", "resource_snapshot"],
      final: 1,
      computed_at: NOW,
    },
    {
      database_id: first,
      hour: "2026-10-19T09:00:00.000Z",
      metrics: kept,
      gaps: [],
      final: 1,
      computed_at: NOW,
    },
    {
      database_id: last,
      hour: "2026-10-19T08:00:00.000Z",
      metrics: kept,
      gaps: [],
      final: 1,
      computed_at: NOW,
    },
    {
      database_id: last,
      hour: "2026-10-19T09:00:00.000Z",
      metrics: kept,
      gaps: ["lifecycle"],
      final: 1,
      computed_at: NOW,
    },
  ]);
});

it("rewrites the stored resource snapshots to the limits and keeps the lifecycle events immutable", () => {
  populate();
  const event = (id: string, kind: string, snapshot: object | null) =>
    run(
      `INSERT INTO lifecycle_events(database_id,kind,node_id,size_class_id,generation,occurred_at,resource_snapshot)
       VALUES(?,?,?,'small',1,?,?)`,
      id,
      kind,
      node,
      NOW,
      snapshot === null ? null : JSON.stringify(snapshot),
    );
  const snapshot = {
    memory_mib: 512,
    cpu_millicores: 500,
    reserved_memory_mib: 640,
    reserved_cpu_millicores: 600,
    storage_allocated_bytes: 10737418240,
  };
  event(first, "created", snapshot);
  event(last, "woke", { ...snapshot, storage_allocated_bytes: null });
  event(last, "deleted", null);
  apply(MIGRATION);
  expect(
    db
      .prepare(
        "SELECT kind,resource_snapshot FROM lifecycle_events ORDER BY id",
      )
      .all()
      .map((row) => [
        row.kind,
        row.resource_snapshot === null
          ? null
          : JSON.parse(String(row.resource_snapshot)),
      ]),
  ).toEqual([
    ["created", { memory_mib: 512, cpu_millicores: 500 }],
    ["woke", { memory_mib: 512, cpu_millicores: 500 }],
    ["deleted", null],
  ]);
  expect(() =>
    run("UPDATE lifecycle_events SET generation=2 WHERE kind='created'"),
  ).toThrow(/immutable/);
  // Usage still follows the events: a new one counts a revision for its database.
  event(first, "ready", { memory_mib: 512, cpu_millicores: 500 });
  expect(
    db
      .prepare("SELECT revision FROM usage_revisions WHERE database_id=?")
      .get(first),
  ).toEqual({ revision: 2 });
});

it("clears the standing profile hash that folded in a RAM threshold and keeps the hash of the profile alone", () => {
  const profile = (id: string, trigger?: string) =>
    JSON.stringify({ id, ...(trigger === undefined ? {} : { trigger }) });
  const policy = (
    region: string,
    threshold: number | null,
    trigger: string | undefined,
    hash: string,
  ) =>
    run(
      `INSERT INTO node_region_policies(region_id,max_nodes,standing_cost_profile,standing_cost_profile_hash,ram_expansion_threshold_ppm,placement_mode,postgres_memory_request_mib,maximum_database_memory_mib,node_ram_warning_threshold_ppm)
       VALUES(?,4,?,?,?, 'actual_ram',128,4096,900000)`,
      region,
      profile(region, trigger),
      hash,
      threshold,
    );
  populate();
  // The 76 % threshold and the thresholdless profile without a trigger hashed the profile alone.
  policy("eu-a", 760000, "ram_76_percent", "a".repeat(64));
  policy("eu-b", 800000, "regional_actual_ram", "b".repeat(64));
  policy("eu-c", null, undefined, "c".repeat(64));
  run(
    "INSERT INTO regions(id,provider,provider_region,gateway_url,backup_bucket,backup_endpoint_url,created_at,updated_at) VALUES('eu-d','contabo','EU',?,'pgcf-test',?,?,?)",
    gateway,
    endpoint,
    NOW,
    NOW,
  );
  policy("eu-d", null, "ram_76_percent", "d".repeat(64));
  run(
    "INSERT INTO regions(id,provider,provider_region,gateway_url,backup_bucket,backup_endpoint_url,created_at,updated_at) VALUES('eu-e','contabo','EU',?,'pgcf-test',?,?,?)",
    gateway,
    endpoint,
    NOW,
    NOW,
  );
  run("INSERT INTO node_region_policies(region_id) VALUES('eu-e')");
  apply(MIGRATION);
  expect(
    db
      .prepare(
        "SELECT region_id,standing_cost_profile_hash h FROM node_region_policies ORDER BY region_id",
      )
      .all(),
  ).toEqual([
    { region_id: "eu-a", h: "a".repeat(64) },
    { region_id: "eu-b", h: null },
    { region_id: "eu-c", h: "c".repeat(64) },
    { region_id: "eu-d", h: null },
    { region_id: "eu-e", h: null },
  ]);
  for (const gone of [
    "ram_expansion_threshold_ppm",
    "ram_warning_threshold_ppm",
    "placement_mode",
    "postgres_memory_request_mib",
  ])
    expect(columns("node_region_policies")).not.toContain(gone);
  // The rest of the policy is untouched.
  expect(
    db
      .prepare(
        "SELECT max_nodes,maximum_database_memory_mib m,node_ram_warning_threshold_ppm w FROM node_region_policies WHERE region_id='eu-b'",
      )
      .get(),
  ).toEqual({ max_nodes: 4, m: 4096, w: 900000 });
});

it("drops the regional RAM window, its alert kind and the node window columns", () => {
  populate();
  run(
    "INSERT INTO node_memory_samples(node_id,node_uid,minute,observed_at,working_set_bytes,capacity_memory_bytes,available_bytes,memory_pressure) VALUES(?,?,1,?,10,100,90,0)",
    node,
    crypto.randomUUID(),
    NOW,
  );
  const alert = (region: string, kind: string, utilization: number | null) =>
    run(
      "INSERT INTO infrastructure_alerts(region_id,kind,active,event_id,payload) VALUES(?,?,1,?,?)",
      region,
      kind,
      crypto.randomUUID(),
      JSON.stringify({
        kind,
        regional_ram_utilization_ppm: utilization,
        allocated_nodes: 1,
      }),
    );
  alert("eu-a", "regional_ram_warning", 810000);
  alert("eu-a", "regional_node_cap_reached", 760000);
  alert("eu-b", "regional_node_stale", null);
  run(
    "UPDATE infrastructure_alerts SET delivered_at=?,last_attempt_at=?",
    NOW,
    NOW,
  );
  apply(MIGRATION);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((row) => row.name);
  expect(tables).not.toContain("node_memory_samples");
  expect(tables).not.toContain("infrastructure_alerts_previous");
  for (const gone of [
    "memory_window_observed_at",
    "memory_window_valid",
    "memory_utilization_ppm",
    "memory_expansion_triggered_at",
  ])
    expect(columns("nodes")).not.toContain(gone);
  expect(
    db
      .prepare(
        "SELECT region_id,kind,active,delivered_at,last_attempt_at,json_extract(payload,'$.regional_ram_utilization_ppm') u,json_type(payload,'$.regional_ram_utilization_ppm') t FROM infrastructure_alerts ORDER BY region_id,kind",
      )
      .all(),
  ).toEqual([
    {
      region_id: "eu-a",
      kind: "regional_node_cap_reached",
      active: 1,
      delivered_at: NOW,
      last_attempt_at: NOW,
      u: null,
      t: "null",
    },
    {
      region_id: "eu-b",
      kind: "regional_node_stale",
      active: 1,
      delivered_at: NOW,
      last_attempt_at: NOW,
      u: null,
      t: "null",
    },
  ]);
  expect(() => alert("eu-c", "regional_ram_warning", null)).toThrow(/CHECK/);
  alert("eu-c", "node_unexpected_reboot", null);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("drops the size class CPU request and the key from the stored resource profiles", () => {
  populate();
  run(
    "INSERT INTO resource_profiles(id,revision,created_at,updated_at) VALUES('profile',1,?,?)",
    NOW,
    NOW,
  );
  const resources = (extra: object) =>
    JSON.stringify({
      memory_mib: 512,
      cpu_millicores: 500,
      storage_gib: 10,
      ...extra,
    });
  run(
    `INSERT INTO resource_profile_revisions(profile_id,revision,size_class_id,resources_json,sha256,created_at)
     VALUES('profile',1,'small',?,?,?)`,
    resources({ cpu_request_millicores: 25 }),
    "e".repeat(64),
    NOW,
  );
  run(
    `INSERT INTO size_classes(id,memory_mib,cpu_millicores,storage_gib,max_connections,archive_timeout_seconds,backup_retention_days,created_at,updated_at)
     VALUES('plain',256,100,1,50,60,7,?,?)`,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO resource_profile_revisions(profile_id,revision,size_class_id,resources_json,sha256,created_at)
     VALUES('profile',2,'plain',?,?,?)`,
    resources({}),
    "f".repeat(64),
    NOW,
  );
  apply(MIGRATION);
  expect(columns("size_classes")).not.toContain("cpu_request_millicores");
  expect(
    db
      .prepare(
        "SELECT revision,resources_json,sha256 FROM resource_profile_revisions ORDER BY revision",
      )
      .all(),
  ).toEqual([
    { revision: 1, resources_json: resources({}), sha256: "e".repeat(64) },
    { revision: 2, resources_json: resources({}), sha256: "f".repeat(64) },
  ]);
  expect(
    db
      .prepare(
        "SELECT memory_mib,cpu_millicores FROM size_classes WHERE id='small'",
      )
      .get(),
  ).toEqual({ memory_mib: 512, cpu_millicores: 500 });
});
