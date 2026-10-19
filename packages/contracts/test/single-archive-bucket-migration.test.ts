// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";

const directory = new URL("../../../apps/api/migrations/", import.meta.url);
const migrations = readdirSync(directory)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const MIGRATION = "0078_single_archive_bucket.sql";
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
    ["eu-test", "pgcf-m1-eu-backups"],
    ["us-test", "pgcf-backups-us"],
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
