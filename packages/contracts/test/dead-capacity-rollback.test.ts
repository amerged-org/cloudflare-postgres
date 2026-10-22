// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { SizeClass } from "../src/index.ts";

// The rollback below migration 0082 is SQL in docs/operations/infrastructure-backups.md. An operator
// runs it when the API Worker goes back to a release that still reads what 0082 dropped, so this test
// runs the document's own statements over the schema and the data that 0082 leaves behind.
const directory = new URL("../../../apps/api/migrations/", import.meta.url);
const migrations = readdirSync(directory)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const MIGRATION = "0082_drop_dead_capacity_fields.sql";
const RUNBOOK = new URL(
  "../../../docs/operations/infrastructure-backups.md",
  import.meta.url,
);
const HEADING = "\n## Rolling back below migration 0082\n";
const NOW = "2026-10-20T10:00:00.000Z";
const project = `prj_${"a".repeat(20)}`;
const node = `nod_${"a".repeat(20)}`;
const gateway = `https://${["gateway", "example", "com"].join(".")}`;
const endpoint = `https://${["r2", "example", "com"].join(".")}`;
// Database IDs start with any letter: the usage statements work through them one first letter at a time.
const first = `a${"1".repeat(19)}`;
const last = `z${"2".repeat(19)}`;
const RESERVED = [
  "reserved_cpu_millicore_seconds",
  "reserved_memory_mib_seconds",
  "reserved_storage_byte_seconds",
];
// The contract of the API Worker from before 0082, as packages/contracts/src/usage.ts had it: the part that
// reads a stored hour (strict, the three reserved_* metrics required) and the resource snapshot of an event
// (strict, five fields). A copy, because the current contract no longer has them.
const Count = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER);
const OLDER_METRICS = [
  "provisioned_seconds",
  "awake_seconds",
  "memory_mib_seconds",
  "cpu_millicore_seconds",
  "reserved_memory_mib_seconds",
  "reserved_cpu_millicore_seconds",
  "reserved_storage_byte_seconds",
  "storage_used_bytes_max",
  "storage_allocated_bytes",
  "backup_bytes_max",
  "ingress_bytes",
  "egress_bytes",
  "connections",
  "connection_seconds",
] as const;
const OlderUsageRow = z.strictObject({
  final: z.boolean(),
  metrics: z.strictObject(
    Object.fromEntries(OLDER_METRICS.map((name) => [name, Count.nullable()])),
  ),
  gaps: z
    .array(
      z.enum([
        ...OLDER_METRICS,
        "lifecycle",
        "resource_snapshot",
        "traffic_coverage",
        "rollup_pending",
      ]),
    )
    .max(OLDER_METRICS.length + 4),
});
const OlderResourceSnapshot = z.strictObject({
  memory_mib: Count.int(),
  cpu_millicores: Count.int(),
  reserved_memory_mib: Count.int(),
  reserved_cpu_millicores: Count.int(),
  storage_allocated_bytes: Count.int().nullable(),
});
const open: DatabaseSync[] = [];
afterEach(() => {
  for (const database of open.splice(0)) database.close();
});

/** The runbook's rollback section. */
function section(): string {
  const text = readFileSync(RUNBOOK, "utf8");
  const start = text.indexOf(HEADING);
  expect(start, "the runbook has the rollback section").toBeGreaterThan(-1);
  const end = text.indexOf("\n## ", start + HEADING.length);
  return text.slice(start, end === -1 ? undefined : end);
}

/** The fenced `sql` blocks of the runbook's rollback section: schema, hourly usage, snapshots, roll forward. */
function sections(): [string, string, string, string] {
  const blocks = [...section().matchAll(/```sql\n([\s\S]*?)```/g)].map(
    (match) => match[1]!,
  );
  expect(
    blocks,
    "schema, hourly usage, lifecycle snapshots and the statement to roll forward",
  ).toHaveLength(4);
  return blocks as [string, string, string, string];
}
const rollbackBlocks = (): [string, string, string] => {
  const [schema, usage, lifecycle] = sections();
  return [schema, usage, lifecycle];
};

/** D1 applies a migration as one transaction, which `defer_foreign_keys` lasts for. */
const transaction = (target: DatabaseSync, sql: string) => {
  target.exec("BEGIN");
  try {
    target.exec(sql);
    target.exec("COMMIT");
  } catch (error) {
    target.exec("ROLLBACK");
    throw error;
  }
};
const apply = (target: DatabaseSync, name: string) =>
  transaction(target, readFileSync(new URL(name, directory), "utf8"));
const shape = (target: DatabaseSync, table: string) =>
  target
    .prepare(
      `SELECT name,type,"notnull",dflt_value,pk FROM pragma_table_info('${table}') ORDER BY name`,
    )
    .all();
/** `statement` once for each first letter of the database ID, the way 0082 runs it. */
const byFirstLetter = (statement: string) => {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const body = statement.trim().replace(/;$/, "");
  return [...letters]
    .map((letter, index) =>
      index === letters.length - 1
        ? `${body} AND database_id>='${letter}';`
        : `${body} AND database_id>='${letter}' AND database_id<'${letters[index + 1]}';`,
    )
    .join("\n");
};

// Every metric of a stored hour that stays after 0082, the way the rollup writes it (all keys, null when unknown).
const kept = {
  provisioned_seconds: 3600,
  awake_seconds: 1800,
  memory_mib_seconds: 5,
  cpu_millicore_seconds: 6,
  storage_used_bytes_max: 4,
  storage_allocated_bytes: 7,
  backup_bytes_max: null,
  ingress_bytes: 8,
  egress_bytes: 9,
  connections: 3,
  connection_seconds: 12,
};
const reserved = {
  reserved_memory_mib_seconds: 640,
  reserved_cpu_millicore_seconds: 600,
  reserved_storage_byte_seconds: 7,
};

/** A final hourly row, as the rollup of either Worker stores it. */
const insertHour = (
  target: DatabaseSync,
  id: string,
  at: string,
  metrics: object,
  gaps: string[],
) =>
  target
    .prepare(
      "INSERT INTO usage_hourly(database_id,hour,metrics,gaps,final,computed_at) VALUES(?,?,?,?,1,?)",
    )
    .run(id, at, JSON.stringify(metrics), JSON.stringify(gaps), NOW);
/** A lifecycle event with the resource snapshot the Worker keeps for usage. */
const insertEvent = (
  target: DatabaseSync,
  id: string,
  kind: string,
  snapshot: object | null,
) =>
  target
    .prepare(
      `INSERT INTO lifecycle_events(database_id,kind,node_id,size_class_id,generation,occurred_at,resource_snapshot)
       VALUES(?,?,?,'small',1,?,?)`,
    )
    .run(
      id,
      kind,
      node,
      NOW,
      snapshot === null ? null : JSON.stringify(snapshot),
    );

/** A control database before 0082: the dropped columns in use, the old usage shape stored. */
function before(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  open.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of migrations.filter((value) => value < MIGRATION))
    apply(db, name);
  return db;
}

/** The same database after 0082, and after a Worker of the release that follows it ran for a while. */
function after(): DatabaseSync {
  const db = before();
  const run = (sql: string, ...params: (string | number | null)[]) =>
    db.prepare(sql).run(...params);
  const hour = (id: string, at: string, metrics: object, gaps: string[]) =>
    insertHour(db, id, at, metrics, gaps);
  const event = (id: string, kind: string, snapshot: object | null) =>
    insertEvent(db, id, kind, snapshot);
  run(
    "INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)",
    project,
    "p",
    NOW,
    NOW,
  );
  for (const id of ["eu-a", "eu-b"])
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
  const policy = (region: string, threshold: number, hash: string) =>
    run(
      `INSERT INTO node_region_policies(region_id,max_nodes,standing_cost_profile,standing_cost_profile_hash,ram_expansion_threshold_ppm,placement_mode,postgres_memory_request_mib,maximum_database_memory_mib)
       VALUES(?,4,?,?,?,'actual_ram',128,4096)`,
      region,
      JSON.stringify({ id: region, trigger: "regional_actual_ram" }),
      hash,
      threshold,
    );
  policy("eu-a", 800000, "b".repeat(64));
  policy("eu-b", 760000, "c".repeat(64));
  hour(first, "2026-10-19T08:00:00.000Z", { ...kept, ...reserved }, [
    "reserved_memory_mib_seconds",
    "traffic_coverage",
  ]);
  hour(last, "2026-10-19T08:00:00.000Z", { ...kept, ...reserved }, []);
  event(first, "created", {
    memory_mib: 512,
    cpu_millicores: 500,
    reserved_memory_mib: 640,
    reserved_cpu_millicores: 600,
    storage_allocated_bytes: 10737418240,
  });
  event(last, "deleted", null);
  apply(db, MIGRATION);
  // The Worker that still ran between 0082 and its replacement wrote the old shape.
  hour(last, "2026-10-19T09:00:00.000Z", { ...kept, ...reserved }, [
    "reserved_storage_byte_seconds",
  ]);
  event(first, "ready", {
    memory_mib: 512,
    cpu_millicores: 500,
    reserved_memory_mib: 640,
    reserved_cpu_millicores: 600,
    storage_allocated_bytes: 10737418240,
  });
  // The Worker that follows 0082 writes limits only and no reserved metric.
  hour(first, "2026-10-19T09:00:00.000Z", { ...kept }, ["lifecycle"]);
  event(last, "woke", { memory_mib: 256, cpu_millicores: 100 });
  return db;
}

const hours = (db: DatabaseSync) =>
  db
    .prepare(
      "SELECT database_id,hour,metrics,gaps,final,computed_at FROM usage_hourly ORDER BY database_id,hour",
    )
    .all()
    .map((row) => ({
      database_id: String(row.database_id),
      hour: String(row.hour),
      metrics: JSON.parse(String(row.metrics)) as Record<string, unknown>,
      gaps: JSON.parse(String(row.gaps)) as string[],
      final: row.final,
      computed_at: row.computed_at,
    }));
const snapshots = (db: DatabaseSync) =>
  db
    .prepare("SELECT kind,resource_snapshot FROM lifecycle_events ORDER BY id")
    .all()
    .map((row) => [
      row.kind,
      row.resource_snapshot === null
        ? null
        : JSON.parse(String(row.resource_snapshot)),
    ]);

/**
 * What a Worker of the release before 0082 refuses in this database, by its own contract: the hours
 * (`GET /v1/usage` answers 500 for a range that covers one) and the snapshots (its rollup reads one as a
 * `resource_snapshot` gap and loses the awake-time metrics of the span).
 */
const refused = (target: DatabaseSync) => ({
  hours: target
    .prepare(
      "SELECT database_id,hour,metrics,gaps,final FROM usage_hourly ORDER BY database_id,hour",
    )
    .all()
    .filter(
      (row) =>
        !OlderUsageRow.safeParse({
          final: row.final === 1,
          metrics: JSON.parse(String(row.metrics)),
          gaps: JSON.parse(String(row.gaps)),
        }).success,
    )
    .map((row) => `${row.database_id}|${row.hour}`),
  snapshots: target
    .prepare(
      "SELECT database_id,kind,resource_snapshot FROM lifecycle_events WHERE resource_snapshot IS NOT NULL ORDER BY id",
    )
    .all()
    .filter(
      (row) =>
        !OlderResourceSnapshot.safeParse(
          JSON.parse(String(row.resource_snapshot)),
        ).success,
    )
    .map((row) => `${row.database_id}|${row.kind}`),
});

let db: DatabaseSync;
beforeEach(() => {
  db = after();
});
const run = (sql: string) => db.prepare(sql).run();

it("gives the dropped columns and the empty RAM sample table back as migrations 0018, 0024 and 0038 made them", () => {
  transaction(db, rollbackBlocks().join("\n"));
  const reference = before();
  for (const table of [
    "node_region_policies",
    "nodes",
    "size_classes",
    "node_memory_samples",
  ])
    expect(shape(db, table), table).toEqual(shape(reference, table));
  expect(
    db.prepare("SELECT count(*) n FROM node_memory_samples").get(),
  ).toEqual({ n: 0 });
  // The checks come back with the columns.
  expect(() =>
    run("UPDATE node_region_policies SET placement_mode='x'"),
  ).toThrow(/CHECK/);
  expect(() =>
    run("UPDATE node_region_policies SET ram_warning_threshold_ppm=0"),
  ).toThrow(/CHECK/);
  expect(() => run("UPDATE nodes SET memory_window_valid=2")).toThrow(/CHECK/);
  expect(() =>
    run("UPDATE size_classes SET cpu_request_millicores=501"),
  ).toThrow(/CHECK/);
  // What the older Worker writes finds the columns it names.
  run(
    "UPDATE node_region_policies SET ram_expansion_threshold_ppm=760000,postgres_memory_request_mib=256,placement_mode='actual_ram'",
  );
  run("UPDATE size_classes SET cpu_request_millicores=25");
  run("UPDATE nodes SET memory_window_valid=1,memory_utilization_ppm=1000000");
  db.prepare(
    "INSERT INTO node_memory_samples(node_id,node_uid,minute,observed_at,working_set_bytes,capacity_memory_bytes,available_bytes,memory_pressure,capacity_cpu_millicores,cpu_usage_nano_cores) VALUES(?,'uid',1,?,10,100,90,0,2000,5)",
  ).run(node, NOW);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("makes the newer Worker's strict size class parse fail until the statement to roll forward has run", () => {
  const sizeClasses = () =>
    db
      .prepare("SELECT * FROM size_classes")
      .all()
      .map((row) =>
        SizeClass.safeParse({ ...row, enabled: row.enabled === 1 }),
      );
  const afterMigration = shape(db, "size_classes");
  expect(sizeClasses().map((result) => result.success)).toEqual([true]);
  transaction(db, rollbackBlocks().join("\n"));
  expect(sizeClasses().map((result) => result.success)).toEqual([false]);
  transaction(db, sections()[3]);
  expect(sizeClasses().map((result) => result.success)).toEqual([true]);
  expect(shape(db, "size_classes")).toEqual(afterMigration);
});

it("restores the defaults of a policy, a node and a size class, and leaves a cleared approval hash cleared", () => {
  transaction(db, rollbackBlocks().join("\n"));
  expect(
    db
      .prepare(
        `SELECT region_id,max_nodes,maximum_database_memory_mib m,standing_cost_profile_hash h,
          ram_expansion_threshold_ppm e,ram_warning_threshold_ppm w,placement_mode,postgres_memory_request_mib r
         FROM node_region_policies ORDER BY region_id`,
      )
      .all(),
  ).toEqual([
    // 0082 cleared the hash that folded in 800000, and the older Worker reads the restored
    // threshold as none: the policy stays unapproved until its capacity policy is stored again.
    {
      region_id: "eu-a",
      max_nodes: 4,
      m: 4096,
      h: null,
      e: null,
      w: null,
      placement_mode: "reserved",
      r: null,
    },
    {
      region_id: "eu-b",
      max_nodes: 4,
      m: 4096,
      h: "c".repeat(64),
      e: null,
      w: null,
      placement_mode: "reserved",
      r: null,
    },
  ]);
  expect(
    db
      .prepare(
        "SELECT memory_window_observed_at o,memory_window_valid v,memory_utilization_ppm u,memory_expansion_triggered_at t FROM nodes",
      )
      .get(),
  ).toEqual({ o: null, v: 0, u: null, t: null });
  expect(
    db.prepare("SELECT cpu_request_millicores c FROM size_classes").get(),
  ).toEqual({ c: null });
});

const rolledBack = (target: DatabaseSync, chunked: boolean) => {
  const [schema, usage, lifecycle] = rollbackBlocks();
  transaction(
    target,
    chunked
      ? [
          schema,
          byFirstLetter(usage),
          lifecycle.replace(/UPDATE lifecycle_events[^;]*;/, byFirstLetter),
        ].join("\n")
      : [schema, usage, lifecycle].join("\n"),
  );
};

it("gives every hourly row and snapshot the keys the older release requires and keeps what they hold", () => {
  const rows = hours(db).length;
  const events = snapshots(db).length;
  // After 0082 the older contract refuses what the newer Worker stored, and accepts the rows the older Worker
  // wrote in between; after the migration it refuses nothing.
  expect(refused(db)).toEqual({
    hours: [
      `${first}|2026-10-19T08:00:00.000Z`,
      `${first}|2026-10-19T09:00:00.000Z`,
      `${last}|2026-10-19T08:00:00.000Z`,
    ],
    snapshots: [`${first}|created`, `${last}|woke`],
  });
  rolledBack(db, false);
  expect(refused(db)).toEqual({ hours: [], snapshots: [] });
  const gaps = (names: string[]) =>
    [...new Set([...names, ...RESERVED])].sort();
  const unknown = Object.fromEntries(RESERVED.map((name) => [name, null]));
  expect(hours(db)).toEqual([
    {
      database_id: first,
      hour: "2026-10-19T08:00:00.000Z",
      metrics: { ...kept, ...unknown },
      gaps: gaps(["traffic_coverage"]),
      final: 1,
      computed_at: NOW,
    },
    {
      database_id: first,
      hour: "2026-10-19T09:00:00.000Z",
      metrics: { ...kept, ...unknown },
      gaps: gaps(["lifecycle"]),
      final: 1,
      computed_at: NOW,
    },
    {
      database_id: last,
      hour: "2026-10-19T08:00:00.000Z",
      metrics: { ...kept, ...unknown },
      gaps: gaps([]),
      final: 1,
      computed_at: NOW,
    },
    // A row the older Worker wrote after 0082 has its keys and is not touched.
    {
      database_id: last,
      hour: "2026-10-19T09:00:00.000Z",
      metrics: { ...kept, ...reserved },
      gaps: ["reserved_storage_byte_seconds"],
      final: 1,
      computed_at: NOW,
    },
  ]);
  expect(hours(db)).toHaveLength(rows);
  // The limits stand in for the reserved figures, which the older release wrote equal to them;
  // the allocated storage is unknown.
  expect(snapshots(db)).toEqual([
    [
      "created",
      {
        memory_mib: 512,
        cpu_millicores: 500,
        reserved_memory_mib: 512,
        reserved_cpu_millicores: 500,
        storage_allocated_bytes: null,
      },
    ],
    ["deleted", null],
    [
      "ready",
      {
        memory_mib: 512,
        cpu_millicores: 500,
        reserved_memory_mib: 640,
        reserved_cpu_millicores: 600,
        storage_allocated_bytes: 10737418240,
      },
    ],
    [
      "woke",
      {
        memory_mib: 256,
        cpu_millicores: 100,
        reserved_memory_mib: 256,
        reserved_cpu_millicores: 100,
        storage_allocated_bytes: null,
      },
    ],
  ]);
  expect(snapshots(db)).toHaveLength(events);
  // The events stay immutable.
  expect(() =>
    run("UPDATE lifecycle_events SET generation=2 WHERE kind='created'"),
  ).toThrow(/immutable/);
});

it("gives the same rows when the usage statements run one first letter of the database ID at a time", () => {
  const other = after();
  rolledBack(db, false);
  rolledBack(other, true);
  expect(hours(other)).toEqual(hours(db));
  expect(snapshots(other)).toEqual(snapshots(db));
  expect(() =>
    other.exec("UPDATE lifecycle_events SET generation=2 WHERE kind='created'"),
  ).toThrow(/immutable/);
});

const NEWER_HOUR = "2026-10-19T10:00:00.000Z";
it("leaves what the newer Worker writes before the older Worker is live refused until the usage statements run again", () => {
  const [, usage, lifecycle] = rollbackBlocks();
  rolledBack(db, false);
  // The first migration has run and the older Worker is not deployed yet: the newer Worker keeps going.
  // Its rollup stores an hour without the three metrics, and a wake keeps the two limits only.
  insertHour(db, first, NEWER_HOUR, { ...kept }, ["traffic_coverage"]);
  insertEvent(db, first, "woke", { memory_mib: 512, cpu_millicores: 500 });
  // With the older Worker live, its strict contract refuses both, and nothing else repairs them.
  expect(refused(db)).toEqual({
    hours: [`${first}|${NEWER_HOUR}`],
    snapshots: [`${first}|woke`],
  });
  const settledHours = hours(db).filter((row) => row.hour !== NEWER_HOUR);
  const settledSnapshots = snapshots(db).slice(0, -1);
  // The second migration: the two usage statements again, right after the older Worker is live.
  transaction(db, [usage, lifecycle].join("\n"));
  expect(refused(db)).toEqual({ hours: [], snapshots: [] });
  const unknown = Object.fromEntries(RESERVED.map((name) => [name, null]));
  expect(hours(db).find((row) => row.hour === NEWER_HOUR)).toEqual({
    database_id: first,
    hour: NEWER_HOUR,
    metrics: { ...kept, ...unknown },
    gaps: [
      "reserved_cpu_millicore_seconds",
      "reserved_memory_mib_seconds",
      "reserved_storage_byte_seconds",
      "traffic_coverage",
    ],
    final: 1,
    computed_at: NOW,
  });
  expect(snapshots(db).at(-1)).toEqual([
    "woke",
    {
      memory_mib: 512,
      cpu_millicores: 500,
      reserved_memory_mib: 512,
      reserved_cpu_millicores: 500,
      storage_allocated_bytes: null,
    },
  ]);
  // What the first migration repaired stays as it is: both statements only touch rows that lack the keys.
  expect(hours(db).filter((row) => row.hour !== NEWER_HOUR)).toEqual(
    settledHours,
  );
  expect(snapshots(db).slice(0, -1)).toEqual(settledSnapshots);
});

it("tells the operator to run the usage statements again as a second migration right after the older Worker is live", () => {
  const text = section().replace(/\s+/g, " ");
  expect(text).toMatch(/second migration file/);
  expect(text).toMatch(/right after the older Worker is live/i);
  // The residual window between the deploy and the second migration is stated.
  expect(text).toMatch(/finalizes/);
});
