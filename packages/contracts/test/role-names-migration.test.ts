// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";

const directory = new URL("../../../apps/api/migrations/", import.meta.url);
const migrations = readdirSync(directory)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const MIGRATION = "0084_unreserved_role_names.sql";
const NOW = "2026-10-22T10:00:00.000Z";
const project = `prj_${"a".repeat(20)}`;
const database = `a${"1".repeat(19)}`;
const gateway = `https://${["gateway", "example", "com"].join(".")}`;
const endpoint = `https://${["r2", "example", "com"].join(".")}`;
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
const run = (sql: string, ...params: (string | number | null)[]) =>
  db.prepare(sql).run(...params);
const roles = () =>
  db.prepare("SELECT * FROM roles ORDER BY database_id, name").all();
const shape = () =>
  db
    .prepare(
      "SELECT cid,name,type,\"notnull\",dflt_value,pk FROM pragma_table_info('roles') ORDER BY cid",
    )
    .all();
const insertRole = (
  name: string,
  extra: Record<string, string | number> = {},
) => {
  const row: Record<string, string | number> = {
    database_id: database,
    name,
    password_ciphertext: "c".repeat(22),
    password_iv: "i".repeat(16),
    password_kid: "k1",
    created_at: NOW,
    updated_at: NOW,
    ...extra,
  };
  run(
    `INSERT INTO roles(${Object.keys(row).join(",")}) VALUES(${Object.keys(row)
      .map(() => "?")
      .join(",")})`,
    ...Object.values(row),
  );
};

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of migrations.filter((value) => value < MIGRATION))
    apply(name);
  run(
    "INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,'p',?,?)",
    project,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO regions(id,provider,provider_region,gateway_url,backup_bucket,backup_endpoint_url,created_at,updated_at)
     VALUES('eu-a','contabo','EU',?,'pgcf-test',?,?,?)`,
    gateway,
    endpoint,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO size_classes(id,memory_mib,cpu_millicores,storage_gib,max_connections,archive_timeout_seconds,backup_retention_days,created_at,updated_at)
     VALUES('small',512,500,10,100,60,7,?,?)`,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO databases(id,project_id,region_id,name,size_class_id,desired_state,archive_path,created_at,updated_at)
     VALUES(?,?,'eu-a','main','small','running','s3://pgcf-test/eu-a/x',?,?)`,
    database,
    project,
    NOW,
    NOW,
  );
});
afterEach(() => db.close());

it("accepts the role names of the Kubernetes runtime and refuses what the node and PostgreSQL reserve", () => {
  insertRole("app", { owner: 1 });
  for (const name of ["streaming_replica", "cnpg_app", "cnpg_pooler"])
    expect(() => insertRole(name), `${name} before`).toThrow(/CHECK/);
  // `public` and `none` are what `CREATE ROLE` refuses by exact name, and D1 took them until now.
  for (const name of ["public", "none"])
    expect(() => insertRole(name), `${name} before`).not.toThrow();
  run("DELETE FROM roles WHERE name IN ('public', 'none')");
  apply(MIGRATION);
  for (const name of [
    "streaming_replica",
    "cnpg_app",
    "cnpg_pooler",
    "pgcf_maintenance",
  ])
    expect(() => insertRole(name), `${name} after`).not.toThrow();
  for (const name of [
    "postgres",
    "pg_monitor",
    "pg_",
    "pgcf_backup",
    "public",
    "none",
    "App",
    "_x",
    "a-b",
  ])
    expect(() => insertRole(name), `${name} after`).toThrow(/CHECK/);
  // Exact names, not prefixes, and the keywords PostgreSQL accepts as a quoted role name stay.
  for (const name of [
    "pgcf_backup2",
    "public_reader",
    "nonesuch",
    "current_user",
  ])
    expect(() => insertRole(name), `${name} after`).not.toThrow();
  expect(() => insertRole("a".repeat(64))).toThrow(/CHECK/);
});

// D1 accepts these names today: the node's own backup role, which a customer role would alter, and
// the two names PostgreSQL refuses, which stop the database from waking.
it.each(["pgcf_backup", "public", "none"])(
  "does not run while a role is named %s, and leaves the table as it was",
  (name) => {
    insertRole("app", { owner: 1 });
    insertRole(name);
    const before = { rows: roles(), shape: shape() };
    expect(() => apply(MIGRATION)).toThrow(/CHECK/);
    expect(roles()).toEqual(before.rows);
    expect(shape()).toEqual(before.shape);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE name='roles_next'")
        .all(),
    ).toEqual([]);
    // The deploy step "no role holds one of the names" is what makes it run.
    run("DELETE FROM roles WHERE name=?", name);
    expect(() => apply(MIGRATION)).not.toThrow();
    expect(roles()).toHaveLength(1);
  },
);

it("keeps every role with its credential, attributes and tombstone, and the shape of the table", () => {
  insertRole("app", { owner: 1, password_revision: 3 });
  insertRole("reader", {
    valid_until: "2031-01-02T03:04:05.000Z",
    connection_limit: 5,
    member_of_json: '["app"]',
    bypass_rls: 1,
    created_by_key_id: `key_${"a".repeat(20)}`,
  });
  insertRole("gone", {
    deleted_at: NOW,
    deleted_by_key_id: `key_${"b".repeat(20)}`,
    delete_operation_id: `op_${"c".repeat(20)}`,
  });
  const before = { rows: roles(), shape: shape() };
  apply(MIGRATION);
  expect(roles()).toEqual(before.rows);
  expect(shape()).toEqual(before.shape);
  expect(roles()).toHaveLength(3);
});

it("keeps the primary key, one owner per database, the database reference and the other checks", () => {
  apply(MIGRATION);
  insertRole("app", { owner: 1 });
  expect(() => insertRole("app")).toThrow(/UNIQUE/);
  expect(() => insertRole("other", { owner: 1 })).toThrow(/UNIQUE/);
  expect(() =>
    db
      .prepare(
        "INSERT INTO roles(database_id,name,password_ciphertext,password_iv,password_kid,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(`b${"1".repeat(19)}`, "x", "c", "i".repeat(16), "k1", NOW, NOW),
  ).toThrow(/FOREIGN KEY/);
  const refused: Record<string, string | number>[] = [
    { password_iv: "short" },
    { password_revision: 0 },
    { valid_until: "tomorrow" },
    { connection_limit: 0 },
    { member_of_json: "{}" },
    { bypass_rls: 2 },
    { created_at: "2026-10-22" },
  ];
  for (const extra of refused)
    expect(() => insertRole("late", extra), JSON.stringify(extra)).toThrow(
      /CHECK/,
    );
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE tbl_name='roles' AND type='index' AND name='roles_one_owner_idx'",
      )
      .all(),
  ).toHaveLength(1);
});
