// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

const directory = new URL("../../../apps/api/migrations/", import.meta.url);
const migration = "0098_cold_storage.sql";
const now = "2026-10-26T10:00:00.000Z";
const slept = "2026-10-20T10:00:00.000Z";
const project = `prj_${"a".repeat(20)}`;
const database = "a".repeat(20);
const node = `nod_${"a".repeat(20)}`;
const operation = `op_${"a".repeat(20)}`;
const path = `s3://pgcf-test/eu-a/${database}/g1-${operation}`;
const proof = JSON.stringify({
  system_identifier: "7428512345678901234",
  timeline: 1,
  checkpoint_lsn: "0/3000028",
  last_archived_segment: "000000010000000000000002",
  proven_at: slept,
});
let db: DatabaseSync;
const insert = (table: string, row: Record<string, string | number | null>) =>
  db
    .prepare(
      `INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(
        row,
      )
        .map(() => "?")
        .join(",")})`,
    )
    .run(...Object.values(row));
const apply = (name: string) => {
  db.exec("SAVEPOINT migration");
  try {
    db.exec(readFileSync(new URL(name, directory), "utf8"));
    db.exec("RELEASE migration");
  } catch (error) {
    db.exec("ROLLBACK TO migration; RELEASE migration");
    throw error;
  }
};
beforeAll(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
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
    storage_mib: 1024,
    max_connections: 100,
    archive_timeout_seconds: 60,
    backup_retention_days: 7,
    created_at: now,
    updated_at: now,
  });
  insert("databases", {
    id: database,
    project_id: project,
    region_id: "eu-a",
    node_id: node,
    name: database,
    size_class_id: "small",
    desired_state: "suspended",
    observed_state: "provisioning",
    observed_power: "hibernated",
    suspension_reason: "idle",
    generation: 4,
    observed_generation: 4,
    storage_generation: 1,
    archive_path: path,
    proven_sleep_json: proof,
    created_at: now,
    updated_at: now,
  });
  insert("database_recovery_points", {
    database_id: database,
    node_id: node,
    storage_generation: 1,
    generation: 4,
    state: "asleep",
    proven_sleep_json: proof,
    backup_json: null,
    observed_at: now,
    received_at: now,
  });
});
beforeEach(() => db.exec("SAVEPOINT scenario"));
afterEach(() => db.exec("ROLLBACK TO scenario; RELEASE scenario"));
afterAll(() => db.close());

it("backfills only the current proven sleep without changing the power intent or storage", () => {
  const before = db.prepare("SELECT * FROM databases").get();
  apply(migration);
  expect(db.prepare("SELECT * FROM databases").get()).toEqual({
    ...before,
    storage_residency: "local",
    sleep_since: slept,
    storage_operation_id: null,
  });
  expect(
    db.prepare("SELECT native_cold_storage_required FROM regions").get(),
  ).toEqual({ native_cold_storage_required: 0 });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("serializes active pins against an exact retention delete batch", () => {
  apply(migration);
  archive();
  insert("archive_retention_claims", {
    archive_path: path,
    claim: "retention-a",
    keys_json: "[]",
    created_at: now,
  });
  expect(() =>
    insert("archive_pins", {
      operation,
      archive_path: path,
      database_id: database,
      created_at: now,
    }),
  ).toThrow(/archive_retention_in_progress/);
  db.exec("DELETE FROM archive_retention_claims");
  insert("archive_pins", {
    operation,
    archive_path: path,
    database_id: database,
    created_at: now,
  });
  expect(() =>
    insert("archive_retention_claims", {
      archive_path: path,
      claim: "retention-b",
      keys_json: "[]",
      created_at: now,
    }),
  ).toThrow(/archive_pinned/);
});

it.each([
  "UPDATE database_recovery_points SET generation=3",
  "UPDATE database_recovery_points SET storage_generation=2",
  "UPDATE databases SET observed_power='awake'",
  "UPDATE databases SET observed_generation=3",
  "UPDATE databases SET proven_sleep_json=NULL",
  "UPDATE databases SET proven_sleep_json=json_set(proven_sleep_json,'$.proven_at','2999-01-01T00:00:00.000Z')",
])(
  "does not invent a historical sleep from stale or missing proof: %s",
  (change) => {
    db.exec(change);
    apply(migration);
    expect(db.prepare("SELECT sleep_since FROM databases").get()).toEqual({
      sleep_since: null,
    });
  },
);

function archive(id = operation) {
  insert("cold_storage_operations", {
    id,
    kind: "database.archive",
    status: "running",
    project_id: project,
    database_id: database,
    generation: 4,
    created_at: now,
    updated_at: now,
  });
  insert("database_cold_storage", {
    operation: id,
    kind: "archive",
    database_id: database,
    project_id: project,
    region_id: "eu-a",
    phase: "verifying",
    source_node_id: node,
    source_generation: 4,
    source_storage_generation: 1,
    source_archive_path: path,
    source_backup_id: "20261020T090000",
    proven_sleep_json: proof,
    created_at: now,
    updated_at: now,
  });
}

it("keeps the native floor and archive pin after archival, and rejects an unverified retirement", () => {
  apply(migration);
  archive();
  expect(
    db.prepare("SELECT native_cold_storage_required FROM regions").get(),
  ).toEqual({ native_cold_storage_required: 1 });
  expect(() =>
    db.exec("UPDATE regions SET native_cold_storage_required=0"),
  ).toThrow(/floor/);
  expect(() =>
    db.exec("UPDATE database_cold_storage SET phase='retiring'"),
  ).toThrow(/CHECK/);
  insert("archive_pins", {
    operation,
    archive_path: path,
    database_id: database,
    created_at: now,
  });
  db.prepare(
    "UPDATE database_cold_storage SET phase='archived',verification_receipt_json='{}',source_removed_at=?,completed_at=?",
  ).run(now, now);
  db.prepare(
    "UPDATE cold_storage_operations SET status='succeeded',completed_at=?",
  ).run(now);
  expect(
    db
      .prepare(
        "SELECT archive_path FROM archive_pins WHERE released_at IS NULL",
      )
      .all(),
  ).toEqual([{ archive_path: path }]);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("bounds verification to one operation per region and requires a precise durable retention batch", () => {
  apply(migration);
  archive();
  expect(() => archive(`op_${"b".repeat(20)}`)).toThrow(/UNIQUE/);
  insert("archive_retention_claims", {
    archive_path: path,
    claim: "retention-a",
    keys_json: JSON.stringify(["base/backup/data.tar.gz"]),
    created_at: now,
  });
  expect(() =>
    insert("archive_retention_claims", {
      archive_path: path,
      claim: "retention-b",
      keys_json: null,
      created_at: now,
    }),
  ).toThrow(/UNIQUE/);
  expect(() =>
    db.exec("UPDATE archive_retention_claims SET keys_json='{}'"),
  ).toThrow(/archive_retention_claim_immutable/);
  expect(() =>
    db.exec("UPDATE archive_retention_claims SET claim='another-token'"),
  ).toThrow(/archive_retention_claim_immutable/);
  expect(() =>
    insert("archive_retention_claims", {
      archive_path: path + "/another",
      claim: "retention-c",
      keys_json: "{}",
      created_at: now,
    }),
  ).toThrow(/CHECK/);
});

it("stores independent cron cursors with the identifier type of their scan", () => {
  apply(migration);
  insert("cold_storage_cursors", {
    name: "cold_storage_operations",
    cursor: null,
  });
  insert("cold_storage_cursors", { name: "cold_storage_due", cursor: null });
  db.prepare(
    "UPDATE cold_storage_cursors SET cursor=? WHERE name='cold_storage_operations'",
  ).run(operation);
  db.prepare(
    "UPDATE cold_storage_cursors SET cursor=? WHERE name='cold_storage_due'",
  ).run(database);
  expect(
    db
      .prepare("SELECT name,cursor FROM cold_storage_cursors ORDER BY name")
      .all(),
  ).toEqual([
    { name: "cold_storage_due", cursor: database },
    { name: "cold_storage_operations", cursor: operation },
  ]);
  expect(() =>
    db
      .prepare(
        "UPDATE cold_storage_cursors SET cursor=? WHERE name='cold_storage_due'",
      )
      .run(operation),
  ).toThrow(/CHECK/);
  expect(() =>
    db
      .prepare(
        "UPDATE cold_storage_cursors SET cursor=? WHERE name='cold_storage_operations'",
      )
      .run(database),
  ).toThrow(/CHECK/);
  expect(() =>
    insert("cold_storage_cursors", { name: "another_scan", cursor: null }),
  ).toThrow(/CHECK/);
});
