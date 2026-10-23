// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";

const directory = new URL("../../../apps/api/migrations/", import.meta.url);
const migrations = readdirSync(directory)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const MIGRATION = "0085_unreserved_role_names.sql";
const plan = readFileSync(
  new URL(
    "../../../docs/architecture/cloudflare-convergence-and-serverless-plan.md",
    import.meta.url,
  ),
  "utf8",
);
/** The statements the plan's step (0) and the migration's header give the operator, character for character. */
const NAMES = "('pgcf_backup','public','none')";
const CHECK = `SELECT database_id, name FROM roles WHERE name IN ${NAMES} OR EXISTS (SELECT 1 FROM json_each(member_of_json) WHERE value IN ${NAMES})`;
const STRIP = `UPDATE roles SET member_of_json = (SELECT json_group_array(value) FROM json_each(member_of_json) WHERE value NOT IN ${NAMES}) WHERE EXISTS (SELECT 1 FROM json_each(member_of_json) WHERE value IN ${NAMES})`;
const REMOVE = `DELETE FROM roles WHERE name IN ${NAMES}`;
const NOW = "2026-10-22T10:00:00.000Z";
const project = `prj_${"a".repeat(20)}`;
const database = `a${"1".repeat(19)}`;
const gateway = `https://${["gateway", "example", "com"].join(".")}`;
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
    `INSERT INTO regions(id,provider,provider_region,gateway_url,created_at,updated_at)
     VALUES('eu-a','contabo','EU',?,?,?)`,
    gateway,
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

// The old API lets a role name any live role but the owner as `member_of` target, so a role can name
// `pgcf_backup`, `public` or `none` while that row is live. Deleting only the named row in D1 leaves the
// member naming a role that is absent, which no node page of the new contract carries.
it("finds a role that is a member of a closed name, and the statements of the plan clear it before the row", () => {
  insertRole("app", { owner: 1 });
  insertRole("pgcf_backup");
  insertRole("x", { member_of_json: '["other","pgcf_backup"]' });
  insertRole("other");
  insertRole("gone", {
    member_of_json: '["public"]',
    deleted_at: NOW,
    delete_operation_id: `op_${"c".repeat(20)}`,
  });
  const check = () =>
    db.prepare(CHECK).all() as { database_id: string; name: string }[];
  expect(
    check()
      .map((row) => row.name)
      .sort(),
  ).toEqual(["gone", "pgcf_backup", "x"]);
  // The row deleted alone: a check on `roles.name` answers nothing, and the member keeps the name.
  run(REMOVE);
  expect(
    db
      .prepare(
        "SELECT name FROM roles WHERE name IN ('pgcf_backup', 'public', 'none')",
      )
      .all(),
  ).toEqual([]);
  expect(
    check()
      .map((row) => row.name)
      .sort(),
  ).toEqual(["gone", "x"]);
  expect(() => apply(MIGRATION)).not.toThrow();
});

it("removes the closed names from the member lists of every role, tombstones included, and keeps the others", () => {
  insertRole("app", { owner: 1 });
  insertRole("pgcf_backup");
  insertRole("x", { member_of_json: '["other","pgcf_backup"]' });
  insertRole("y", { member_of_json: '["pgcf_backup"]' });
  insertRole("other");
  insertRole("gone", {
    member_of_json: '["public"]',
    deleted_at: NOW,
    delete_operation_id: `op_${"c".repeat(20)}`,
  });
  const members = () =>
    db.prepare("SELECT name, member_of_json FROM roles ORDER BY name").all();
  run(STRIP);
  run(REMOVE);
  expect(db.prepare(CHECK).all()).toEqual([]);
  expect(members()).toEqual([
    { name: "app", member_of_json: "[]" },
    { name: "gone", member_of_json: "[]" },
    { name: "other", member_of_json: "[]" },
    { name: "x", member_of_json: '["other"]' },
    { name: "y", member_of_json: "[]" },
  ]);
  expect(() => apply(MIGRATION)).not.toThrow();
});

it("gives the operator those statements as they are tested, in the plan and in the migration's header", () => {
  const header = readFileSync(new URL(MIGRATION, directory), "utf8")
    .split("\n")
    .filter((line) => line.startsWith("--"))
    .map((line) => line.replace(/^-- ?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
  expect(header).toContain(CHECK);
  // Step (0) of the row and the Open row each give the check; step (0) gives the other two as well.
  expect(plan.split(CHECK).length - 1).toBeGreaterThanOrEqual(2);
  expect(plan).toContain(STRIP);
  expect(plan).toContain(REMOVE);
  // The old check on `roles.name` alone is not the check any more.
  expect(plan).not.toContain(
    "SELECT database_id, name FROM roles WHERE name IN ('pgcf_backup', 'public', 'none')",
  );
  expect(plan).not.toContain("SELECT count(*) FROM roles WHERE name IN");
});
