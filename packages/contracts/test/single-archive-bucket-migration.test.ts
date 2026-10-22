// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";

const directory = new URL("../../../apps/api/migrations/", import.meta.url);
const migrations = readdirSync(directory)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const MIGRATION = "0083_single_archive_bucket.sql";
const NOW = "2026-10-19T10:00:00.000Z";
let db: DatabaseSync;

/** D1 applies a migration as one transaction. */
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
const columns = () =>
  (db.prepare("PRAGMA table_info(regions)").all() as { name: string }[]).map(
    (column) => column.name,
  );

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of migrations.filter((value) => value < MIGRATION))
    apply(name);
});
afterEach(() => db.close());

it("takes the archive bucket off the regions and keeps every region with its children and endpoint", () => {
  const endpoint = `https://${["r2", "example", "com"].join(".")}`;
  for (const [id, bucket] of [
    ["eu-test", "pgcf-test-eu"],
    ["us-test", "pgcf-test-other"],
  ] as const) {
    db.prepare(
      `INSERT INTO regions(id,provider,provider_region,gateway_url,gateway_binding,backup_bucket,backup_endpoint_url,created_at,updated_at)
       VALUES(?,'contabo','EU',?,NULL,?,?,?,?)`,
    ).run(id, `https://${id}.example.com/pg`, bucket, endpoint, NOW, NOW);
    db.prepare(
      "INSERT INTO node_region_policies(region_id,max_nodes) VALUES(?,3)",
    ).run(id);
  }
  expect(columns()).toContain("backup_bucket");
  apply(MIGRATION);
  expect(columns()).not.toContain("backup_bucket");
  expect(columns()).toContain("backup_endpoint_url");
  expect(
    db.prepare("SELECT id,backup_endpoint_url FROM regions ORDER BY id").all(),
  ).toEqual([
    { id: "eu-test", backup_endpoint_url: endpoint },
    { id: "us-test", backup_endpoint_url: endpoint },
  ]);
  expect(
    db.prepare("SELECT count(*) n FROM node_region_policies").get(),
  ).toEqual({ n: 2 });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

const RUNBOOK = readFileSync(
  new URL("../../../docs/operations/operator-installation.md", import.meta.url),
  "utf8",
);
const MOVE = RUNBOOK.slice(
  RUNBOOK.indexOf("### Moving to another archive bucket"),
  RUNBOOK.indexOf("### Keeping the DatabaseActors warm"),
);
/** The runbook's installation inputs: where the region endpoint check lives. */
const INPUTS = RUNBOOK.slice(
  RUNBOOK.indexOf("## Reviewed deployment inputs"),
  RUNBOOK.indexOf("### The node firewall"),
);
/** The one fenced SQL block of a runbook section that holds `needle`, with its placeholders filled. */
function runbookSql(
  needle: string,
  values: Record<string, string>,
  section = MOVE,
) {
  const blocks = [...section.matchAll(/^ *```sql\n([\s\S]*?)^ *```/gm)]
    .map((match) => match[1]!)
    .filter((block) => block.includes(needle));
  expect(blocks).toHaveLength(1);
  let sql = blocks[0]!.trim().replace(/;$/, "");
  for (const [placeholder, value] of Object.entries(values))
    sql = sql.replaceAll(placeholder, value);
  return sql;
}

it("runs the SQL of the bucket-move runbook on the migrated schema and selects what the steps say", () => {
  db.close();
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of migrations) apply(name);
  const OLD = "pgcf-old";
  const id = (letter: string) => `${letter}${"1".repeat(19)}`;
  const operation = (letter: string) => `op_${letter.repeat(20)}`;
  const project = `prj_${"a".repeat(20)}`;
  const node = `nod_${"a".repeat(20)}`;
  const endpoint = `https://${["r2", "example", "com"].join(".")}`;
  const run = (sql: string, ...params: (string | number | null)[]) =>
    db.prepare(sql).run(...params);
  run(
    "INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)",
    project,
    "p",
    NOW,
    NOW,
  );
  run(
    `INSERT INTO regions(id,provider,provider_region,gateway_url,backup_endpoint_url,created_at,updated_at)
     VALUES('eu-test','contabo','EU',?,?,?,?)`,
    `https://${["gateway", "example", "com"].join(".")}`,
    endpoint,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO nodes(id,region_id,hostname,allocatable_memory_mib,allocatable_cpu_millicores,created_at,updated_at)
     VALUES(?,'eu-test','eu1',0,0,?,?)`,
    node,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO size_classes(id,memory_mib,cpu_millicores,storage_gib,max_connections,archive_timeout_seconds,backup_retention_days,created_at,updated_at)
     VALUES('small',512,500,10,100,60,7,?,?)`,
    NOW,
    NOW,
  );
  const database = (
    letter: string,
    bucket: string,
    desired: string,
    extra: Record<string, string | number | null> = {},
  ) => {
    const columns = {
      id: id(letter),
      project_id: project,
      region_id: "eu-test",
      node_id: node,
      name: `db-${letter}`,
      size_class_id: "small",
      desired_state: desired,
      archive_path: `s3://${bucket}/eu-test/${id(letter)}/g1-${operation(letter)}`,
      created_at: NOW,
      updated_at: NOW,
      ...extra,
    };
    run(
      `INSERT INTO databases(${Object.keys(columns).join(",")}) VALUES(${Object.keys(
        columns,
      )
        .map(() => "?")
        .join(",")})`,
      ...Object.values(columns),
    );
  };
  const credential = (
    letter: string,
    access: string,
    issued: string,
    expires: string,
  ) =>
    run(
      `INSERT INTO archive_credentials(id,node_id,database_id,archive_path,access,issued_at,expires_at)
       SELECT ?,?,id,archive_path,?,?,? FROM databases WHERE id=?`,
      `crd_${letter.repeat(20)}`,
      node,
      access,
      issued,
      expires,
      id(letter),
    );
  // a, b, c, f run; d is suspended by hand; e is deleted and confirmed; g names another bucket.
  database("a", OLD, "running");
  database("b", OLD, "running");
  database("c", OLD, "running");
  database("d", OLD, "suspended", { suspension_reason: "manual" });
  database("e", OLD, "running");
  database("f", OLD, "running");
  database("g", "pgcf-elsewhere", "suspended", { suspension_reason: "manual" });
  run(
    "UPDATE databases SET desired_state='deleted',observed_state='deleted',observed_generation=generation,deleted_at=? WHERE id=?",
    NOW,
    id("e"),
  );
  const T = "2026-10-22T10:00:00.000Z";
  const before = "2026-10-22T09:00:00.000Z";
  const after = "2026-10-22T11:00:00.000Z";
  const later = "2026-10-29T11:00:00.000Z";
  credential("a", "read_write", after, later);
  credential("b", "read_write", before, "2026-10-29T09:00:00.000Z");
  credential("f", "read_only", after, later);

  // Step 3: the archives of the databases that are not deleted and name the old bucket, and no other.
  expect(
    db
      .prepare(runbookSql("SELECT substr(archive_path", { "<old>": OLD }))
      .all()
      .map((row) => Object.values(row)[0])
      .sort(),
  ).toEqual(
    ["a", "b", "c", "d", "f"].map(
      (letter) => `eu-test/${id(letter)}/g1-${operation(letter)}`,
    ),
  );

  // Step 7: the databases that cannot have switched yet are awake or possibly awake and hold no
  // read-write credential issued after the time: b (an older one), c (none) and f (read-only);
  // a (newer), d (suspended by hand) and e (deleted) are not counted.
  expect(
    db.prepare(runbookSql("SELECT d.node_id,count(*) n", { "<T>": T })).all(),
  ).toEqual([{ node_id: node, n: 3 }]);

  // Step 11: the last credential issued before T_KEY, then the forced refresh that removes those rows
  // and keeps the newer ones.
  expect(
    db
      .prepare(runbookSql("SELECT max(expires_at)", { "<T_KEY>": T }))
      .all()
      .map((row) => Object.values(row)[0]),
  ).toEqual(["2026-10-29T09:00:00.000Z"]);
  db.exec(runbookSql("DELETE FROM archive_credentials", { "<T_KEY>": T }));
  expect(
    db
      .prepare("SELECT id FROM archive_credentials ORDER BY id")
      .all()
      .map((row) => row.id),
  ).toEqual([`crd_${"a".repeat(20)}`, `crd_${"f".repeat(20)}`]);
});

it("checks and corrects the endpoint of every region, which no API can change", () => {
  db.close();
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of migrations) apply(name);
  const bucket = `https://${"a".repeat(32)}.eu.r2.example.com`;
  // A region made the way the old runbook said for a region outside the EU: the general endpoint.
  const general = `https://${"a".repeat(32)}.r2.example.com`;
  const project = `prj_${"a".repeat(20)}`;
  const run = (sql: string, ...params: (string | number | null)[]) =>
    db.prepare(sql).run(...params);
  const row = (sql: string, ...params: (string | number | null)[]) =>
    db.prepare(sql).all(...params);
  run(
    "INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)",
    project,
    "p",
    NOW,
    NOW,
  );
  run(
    `INSERT INTO size_classes(id,memory_mib,cpu_millicores,storage_gib,max_connections,archive_timeout_seconds,backup_retention_days,created_at,updated_at)
     VALUES('small',512,500,10,100,60,7,?,?)`,
    NOW,
    NOW,
  );
  for (const [region, endpoint, letter] of [
    ["eu-test", bucket, "a"],
    ["us-test", general, "b"],
    ["us-spare", general, "c"],
  ] as const) {
    const node = `nod_${letter.repeat(20)}`;
    const database = `${letter}${"1".repeat(19)}`;
    const path = `s3://pgcf-test/${region}/${database}/g1-op_${letter.repeat(20)}`;
    run(
      `INSERT INTO regions(id,provider,provider_region,gateway_url,backup_endpoint_url,created_at,updated_at)
       VALUES(?,'contabo','EU',?,?,?,?)`,
      region,
      `https://${region}.example.com/pg`,
      endpoint,
      NOW,
      NOW,
    );
    // A region without a node yet (us-spare) is the one US1 is installed into.
    if (region === "us-spare") continue;
    run(
      `INSERT INTO nodes(id,region_id,hostname,allocatable_memory_mib,allocatable_cpu_millicores,created_at,updated_at)
       VALUES(?,?,?,0,0,?,?)`,
      node,
      region,
      `${letter}1`,
      NOW,
      NOW,
    );
    run(
      `INSERT INTO databases(id,project_id,region_id,node_id,name,size_class_id,desired_state,archive_path,created_at,updated_at)
       VALUES(?,?,?,?,?,'small','running',?,?,?)`,
      database,
      project,
      region,
      node,
      `db-${letter}`,
      path,
      NOW,
      NOW,
    );
    run(
      `INSERT INTO archive_credentials(id,node_id,database_id,archive_path,access,issued_at,expires_at)
       VALUES(?,?,?,?,'read_write',?,?)`,
      `crd_${letter.repeat(20)}`,
      node,
      database,
      path,
      NOW,
      "2026-10-26T10:00:00.000Z",
    );
  }
  const values = { "<endpoint>": bucket, "<region>": "us-test" };

  // The check answers exactly the regions that name another endpoint than the bucket's.
  const check = runbookSql(
    "SELECT id,backup_endpoint_url FROM regions",
    values,
    INPUTS,
  );
  expect(row(check)).toEqual([
    { id: "us-spare", backup_endpoint_url: general },
    { id: "us-test", backup_endpoint_url: general },
  ]);

  // The correction fixes one named region, forces its nodes to read a new credential, and touches no other.
  const correction = runbookSql(
    "UPDATE regions SET backup_endpoint_url",
    values,
    INPUTS,
  );
  const before = row("SELECT * FROM regions WHERE id<>'us-test' ORDER BY id");
  db.exec(correction);
  db.exec(correction);
  expect(row(check)).toEqual([
    { id: "us-spare", backup_endpoint_url: general },
  ]);
  expect(row("SELECT * FROM regions WHERE id<>'us-test' ORDER BY id")).toEqual(
    before,
  );
  expect(
    row(
      "SELECT backup_endpoint_url,gateway_url,provider_region,created_at,updated_at>? changed FROM regions WHERE id='us-test'",
      NOW,
    ),
  ).toEqual([
    {
      backup_endpoint_url: bucket,
      gateway_url: "https://us-test.example.com/pg",
      provider_region: "EU",
      created_at: NOW,
      changed: 1,
    },
  ]);
  expect(
    row("SELECT id FROM archive_credentials ORDER BY id").map(
      (value) => value.id,
    ),
  ).toEqual([`crd_${"a".repeat(20)}`]);
});

it("makes the prefix list again for the last warm round, so a database created after it is inside the window of the passes by time", () => {
  const steps = MOVE.slice(MOVE.indexOf("\n3. Copy"), MOVE.indexOf("\n4. "));
  const text = steps.replace(/\s+/g, " ");
  // The last round makes its own list at its start and starts copying within an hour of it.
  expect(text).toMatch(/last round.{0,100}makes its own list at its start/);
  expect(text).toMatch(/within an hour of making the list/);
  // The claim that the passes by time catch a later database is tied to that list, not to any list.
  expect(text).not.toMatch(
    /they catch a database created after the list was made/,
  );
});
