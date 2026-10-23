// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";

const directory = new URL("../../../apps/api/migrations/", import.meta.url);
const migrations = readdirSync(directory)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const MIGRATION = "0087_database_delete_incomplete_alert.sql";
const NOW = "2026-10-23T10:00:00.000Z";
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
const alert = (region: string, kind: string, active: number) =>
  db
    .prepare(
      "INSERT INTO infrastructure_alerts(region_id,kind,active,event_id,payload,delivered_at,last_attempt_at) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      region,
      kind,
      active,
      crypto.randomUUID(),
      JSON.stringify({ kind, occurred_at: NOW }),
      active ? null : NOW,
      NOW,
    );

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of migrations.filter((value) => value < MIGRATION))
    apply(name);
});
afterEach(() => db.close());

it("adds the kind of an incomplete delete to the alert episodes and keeps every episode as it was", () => {
  for (const region of ["eu-a", "eu-b"])
    db.prepare(
      `INSERT INTO regions(id,provider,provider_region,gateway_url,created_at,updated_at)
       VALUES(?,'contabo','EU',?,?,?)`,
    ).run(region, `https://${region}.example.com/pg`, NOW, NOW);
  alert("eu-a", "database_volume_critical", 1);
  alert("eu-a", "node_unexpected_reboot", 0);
  alert("eu-b", "thin_storage_blocked", 1);
  const before = db
    .prepare("SELECT * FROM infrastructure_alerts ORDER BY region_id,kind")
    .all();
  expect(() => alert("eu-b", "database_delete_incomplete", 1)).toThrow(/CHECK/);
  apply(MIGRATION);
  expect(
    db
      .prepare("SELECT * FROM infrastructure_alerts ORDER BY region_id,kind")
      .all(),
  ).toEqual(before);
  alert("eu-b", "database_delete_incomplete", 1);
  expect(() => alert("eu-b", "regional_node_disk_warning", 1)).toThrow(/CHECK/);
  // One episode of a kind for each region, as before.
  expect(() => alert("eu-b", "database_delete_incomplete", 1)).toThrow(
    /UNIQUE|PRIMARY/,
  );
  // The region's episodes still go with the region.
  db.prepare("DELETE FROM regions WHERE id='eu-b'").run();
  expect(
    db
      .prepare("SELECT kind FROM infrastructure_alerts WHERE region_id='eu-b'")
      .all(),
  ).toEqual([]);
});
