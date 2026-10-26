// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";

const directory = new URL("../../../apps/api/migrations/", import.meta.url);
const migration = "0090_storage_mib.sql";
const now = "2026-10-26T10:00:00.000Z";
const project = `prj_${"a".repeat(20)}`;
const database = `a${"1".repeat(19)}`;
const inherited = `b${"1".repeat(19)}`;
const node = `nod_${"a".repeat(20)}`;
const operation = `op_${"a".repeat(20)}`;
let db: DatabaseSync;
const insert = (
  table: string,
  fields: Record<string, string | number | null>,
) =>
  db
    .prepare(
      `INSERT INTO ${table}(${Object.keys(fields).join(",")}) VALUES(${Object.keys(
        fields,
      )
        .map(() => "?")
        .join(",")})`,
    )
    .run(...Object.values(fields));
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
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(directory)
    .filter((name) => name.endsWith(".sql") && name < migration)
    .sort())
    apply(name);
  insert("projects", {
    id: project,
    name: "migration",
    created_at: now,
    updated_at: now,
  });
  insert("regions", {
    id: "eu-a",
    provider: "contabo",
    provider_region: "EU",
    gateway_url: "https://gateway.example.com",
    created_at: now,
    updated_at: now,
  });
  insert("nodes", {
    id: node,
    region_id: "eu-a",
    hostname: "node-a",
    allocatable_memory_mib: 4096,
    allocatable_cpu_millicores: 2000,
    created_at: now,
    updated_at: now,
  });
  insert("size_classes", {
    id: "small",
    memory_mib: 512,
    cpu_millicores: 500,
    storage_gib: 10,
    max_connections: 100,
    archive_timeout_seconds: 60,
    backup_retention_days: 7,
    created_at: now,
    updated_at: now,
  });
  for (const id of [database, inherited])
    insert("databases", {
      id,
      project_id: project,
      region_id: "eu-a",
      node_id: node,
      name: id,
      size_class_id: "small",
      desired_state: "running",
      archive_path: `s3://pgcf-test/eu-a/${id}`,
      own_storage_gib: id === database ? 12 : null,
      created_at: now,
      updated_at: now,
    });
  insert("roles", {
    database_id: database,
    name: "app",
    owner: 1,
    password_ciphertext: "c".repeat(22),
    password_iv: "i".repeat(16),
    password_kid: "v1",
    created_at: now,
    updated_at: now,
  });
  insert("resource_profiles", {
    id: "profile",
    revision: 1,
    created_at: now,
    updated_at: now,
  });
  insert("resource_profile_revisions", {
    profile_id: "profile",
    revision: 1,
    size_class_id: "small",
    resources_json: JSON.stringify({ storage_gib: 10 }),
    sha256: "a".repeat(64),
    created_at: now,
  });
  insert("operations", {
    id: operation,
    kind: "database.restore",
    status: "pending",
    project_id: project,
    database_id: database,
    generation: 1,
    created_at: now,
    updated_at: now,
  });
  insert("database_replacements", {
    operation,
    database_id: database,
    node_id: node,
    project_id: project,
    region_id: "eu-a",
    phase: "proving",
    source_generation: 1,
    source_storage_generation: 1,
    source_archive_path: `s3://pgcf-test/eu-a/${database}`,
    requested_backup_id: "20261026T100000",
    target_time: now,
    created_at: now,
    updated_at: now,
  });
});
afterEach(() => db.close());

it("converts legacy storage exactly while preserving identities, credentials, profile hashes and active replacement locks", () => {
  const roles = db.prepare("SELECT * FROM roles").all();
  const profiles = db.prepare("SELECT * FROM resource_profile_revisions").all();
  const replacements = db.prepare("SELECT * FROM database_replacements").all();
  const archives = db
    .prepare("SELECT id,archive_path,generation FROM databases ORDER BY id")
    .all();
  apply(migration);
  expect(db.prepare("SELECT id,storage_mib FROM size_classes").all()).toEqual([
    { id: "small", storage_mib: 10 * 1024 },
  ]);
  expect(
    db.prepare("SELECT id,own_storage_mib FROM databases ORDER BY id").all(),
  ).toEqual([
    { id: database, own_storage_mib: 12 * 1024 },
    { id: inherited, own_storage_mib: null },
  ]);
  expect(
    db
      .prepare(
        "SELECT database_id,storage_mib FROM database_resources ORDER BY database_id",
      )
      .all(),
  ).toEqual([
    { database_id: database, storage_mib: 12 * 1024 },
    { database_id: inherited, storage_mib: 10 * 1024 },
  ]);
  expect(db.prepare("SELECT * FROM roles").all()).toEqual(roles);
  expect(db.prepare("SELECT * FROM resource_profile_revisions").all()).toEqual(
    profiles,
  );
  expect(db.prepare("SELECT * FROM database_replacements").all()).toEqual(
    replacements,
  );
  expect(
    db
      .prepare("SELECT id,archive_path,generation FROM databases ORDER BY id")
      .all(),
  ).toEqual(archives);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(() =>
    db
      .prepare("UPDATE databases SET own_storage_mib=16384 WHERE id=?")
      .run(database),
  ).toThrow("database_replacement_in_progress");
  expect(() =>
    db.exec("UPDATE size_classes SET storage_mib=16384 WHERE id='small'"),
  ).toThrow("database_replacement_in_progress");
  db.prepare("UPDATE databases SET own_storage_mib=500 WHERE id=?").run(
    inherited,
  );
  expect(
    db
      .prepare("SELECT storage_mib FROM database_resources WHERE database_id=?")
      .get(inherited),
  ).toEqual({ storage_mib: 500 });
  for (const value of [0, 1, 501, 67_108_868])
    expect(() =>
      db
        .prepare("UPDATE databases SET own_storage_mib=? WHERE id=?")
        .run(value, inherited),
    ).toThrow(/CHECK/);
  expect(() => db.exec("SELECT storage_gib FROM size_classes")).toThrow(
    /no such column/,
  );
});

it("backfills and permanently retains the native protocol floor from populated MiB state", () => {
  for (const name of [
    migration,
    "0091_role_membership_options.sql",
    "0092_independent_alert_delivery.sql",
  ])
    apply(name);
  db.prepare("UPDATE databases SET own_storage_mib=500 WHERE id=?").run(
    inherited,
  );
  apply("0093_native_protocol_floor.sql");
  expect(
    db
      .prepare(
        "SELECT native_extended_resources_required FROM regions WHERE id='eu-a'",
      )
      .get(),
  ).toEqual({ native_extended_resources_required: 1 });
  db.prepare("UPDATE databases SET own_storage_mib=1024 WHERE id=?").run(
    inherited,
  );
  expect(() =>
    db.exec(
      "UPDATE regions SET native_extended_resources_required=0 WHERE id='eu-a'",
    ),
  ).toThrow("native_protocol_floor_cannot_decrease");
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
