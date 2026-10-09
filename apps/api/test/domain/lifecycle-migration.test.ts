// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { DatabaseWithOperation, newOperationId } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture } from "./fixtures.ts";

const migrations = (env as typeof env & { TEST_MIGRATIONS: D1Migration[] })
  .TEST_MIGRATIONS;
const prefix = "lifecycle_history_";
const names = new Set(
  migrations
    .filter((m) => m.name < "0009")
    .flatMap((m) =>
      m.queries.flatMap((query) =>
        [
          ...query.matchAll(
            /\bCREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER)\s+([a-z][a-z0-9_]*)/g,
          ),
        ].map((match) => match[1]!),
      ),
    ),
);
const historicalSQL = (query: string) =>
  query.replace(/\b[a-z][a-z0-9_]*\b/g, (name) =>
    names.has(name) ? prefix + name : name,
  );
const history = {
  prepare: (query: string) => env.DB.prepare(historicalSQL(query)),
};
afterEach(async () => {
  for (const type of ["trigger", "table"]) {
    const objects = (
      await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type=? AND name GLOB ? ORDER BY rowid DESC",
      )
        .bind(type, prefix + "*")
        .all<{ name: string }>()
    ).results;
    for (const object of objects)
      await env.DB.prepare(`DROP ${type.toUpperCase()} ${object.name}`).run();
  }
  await cleanupFixtures();
});
async function preLifecycle() {
  // Rehearse the genuine pre-0008 schema without downgrading today's guarded tables.
  for (const migration of migrations.filter((m) => m.name < "0008"))
    await env.DB.batch(
      migration.queries.map((query) => history.prepare(query)),
    );
  const tables = (
    await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB ? ORDER BY rowid",
    )
      .bind(prefix + "*")
      .all<{ name: string }>()
  ).results;
  for (const table of tables) {
    const source = table.name.slice(prefix.length);
    const columns = (
      await env.DB.prepare(`PRAGMA table_info(${table.name})`).all<{
        name: string;
      }>()
    ).results
      .map((row) => row.name)
      .join(",");
    // Lifecycle/sample inserts may already have created their revision row.
    await env.DB.prepare(
      `INSERT OR REPLACE INTO ${table.name}(${columns}) SELECT ${columns} FROM ${source}`,
    ).run();
  }
}
async function migrate() {
  await env.DB.batch(
    migrations
      .find((value) => value.name.startsWith("0008"))!
      .queries.map((query) => history.prepare(query)),
  );
}

it("the actual D1 lifecycle migration preserves every parent, ciphertext, operation, measurement, index and foreign key", async () => {
  const f = await fixture();
  const id = DatabaseWithOperation.parse(await (await f.create()).json())
    .database.id;
  const time = new Date().toISOString(),
    hour = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO operations(id,kind,status,project_id,database_id,generation,error_code,error_message,created_at,updated_at,completed_at) VALUES(?,'database.delete','failed',?,?,1,'original','historical',?,?,?)",
    ).bind(newOperationId(), f.project, id, time, time, time),
    env.DB.prepare(
      "INSERT INTO usage_samples(database_id,source,producer_id,sequence,interval_start,interval_end,observed_at,payload) VALUES(?,'gateway','producer',1,?,?,?,'{}')",
    ).bind(id, hour, time, time),
    env.DB.prepare(
      "INSERT INTO usage_hourly(database_id,hour,metrics,gaps,final,computed_at) VALUES(?,?,'{}','[]',0,?)",
    ).bind(id, hour, time),
    env.DB.prepare(
      "INSERT INTO usage_rollup_progress(database_id,next_hour) VALUES(?,?)",
    ).bind(id, hour),
  ]);
  await preLifecycle();
  const tables = [
    "databases",
    "roles",
    "maintenance_credentials",
    "operations",
    "lifecycle_events",
    "usage_samples",
    "usage_hourly",
    "usage_revisions",
    "usage_rollup_progress",
  ];
  const before = new Map<string, Record<string, unknown>[]>();
  const keys = new Map<string, unknown[]>();
  for (const table of tables) {
    before.set(
      table,
      (await history.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())
        .results,
    );
    keys.set(
      table,
      (await history.prepare(`PRAGMA foreign_key_list(${table})`).all())
        .results,
    );
  }
  const indexes = (
    await history
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name",
      )
      .all()
  ).results;
  await migrate();
  for (const table of tables) {
    const after = (
      await history.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()
    ).results;
    expect(
      after.map((row) =>
        Object.fromEntries(
          Object.keys(before.get(table)![0]!).map((key) => [key, row[key]]),
        ),
      ),
    ).toEqual(before.get(table));
    expect(
      (await history.prepare(`PRAGMA foreign_key_list(${table})`).all())
        .results,
    ).toEqual(keys.get(table));
  }
  for (const index of indexes)
    expect(
      await history
        .prepare("SELECT name,sql FROM sqlite_master WHERE name=?")
        .bind(index.name)
        .first(),
    ).toEqual(index);
  expect(
    (await history.prepare("PRAGMA foreign_key_check").all()).results,
  ).toEqual([]);
  // Physical metadata cleanup retains the pre-existing cascades, including its measurement trigger.
  await env.DB.batch([
    history.prepare("DELETE FROM operations WHERE database_id=?").bind(id),
    history.prepare("DELETE FROM roles WHERE database_id=?").bind(id),
    history
      .prepare("DELETE FROM lifecycle_events WHERE database_id=?")
      .bind(id),
    history.prepare("DELETE FROM databases WHERE id=?").bind(id),
  ]);
  for (const table of [
    "maintenance_credentials",
    "usage_samples",
    "usage_hourly",
    "usage_revisions",
    "usage_rollup_progress",
  ])
    expect(
      await history
        .prepare(`SELECT COUNT(*) n FROM ${table} WHERE database_id=?`)
        .bind(id)
        .first("n"),
    ).toBe(0);
});

it("legacy suspension becomes manual with a genuine monotonic intent, while running legacy remains awake", async () => {
  const f = await fixture();
  const id = DatabaseWithOperation.parse(await (await f.create()).json())
    .database.id;
  await preLifecycle();
  await history
    .prepare("UPDATE databases SET desired_state='suspended' WHERE id=?")
    .bind(id)
    .run();
  const archive = await history
    .prepare("SELECT archive_path FROM databases WHERE id=?")
    .bind(id)
    .first("archive_path");
  await migrate();
  const row = await history
    .prepare("SELECT * FROM databases WHERE id=?")
    .bind(id)
    .first();
  expect(row).toMatchObject({
    desired_state: "suspended",
    generation: 2,
    suspension_reason: "manual",
    observed_power: "awake",
    archive_path: archive,
  });
  expect(
    await history
      .prepare(
        "SELECT kind,status,generation FROM operations WHERE id=? AND database_id=?",
      )
      .bind(row!.power_operation, id)
      .first(),
  ).toEqual({ kind: "database.suspend", status: "pending", generation: 2 });
});
