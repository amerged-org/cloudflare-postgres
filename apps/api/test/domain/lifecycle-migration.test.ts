// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { DatabaseWithOperation, newOperationId } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture } from "./fixtures.ts";

afterEach(cleanupFixtures);
const migrations = (env as typeof env & { TEST_MIGRATIONS: D1Migration[] })
  .TEST_MIGRATIONS;
async function preLifecycle() {
  for (const column of [
    "suspension_reason",
    "observed_power",
    "power_operation",
  ])
    await env.DB.prepare(`ALTER TABLE databases DROP COLUMN ${column}`).run();
  const rows = (
    await env.DB.prepare("SELECT * FROM operations ORDER BY id").all()
  ).results;
  await env.DB.prepare("DROP TABLE operations").run();
  const previous = migrations.find((value) => value.name.startsWith("0006"))!;
  for (const query of previous.queries.filter((value) =>
    /CREATE TABLE operations_resize\s*\(|CREATE (UNIQUE )?INDEX/.test(
      value.trim(),
    ),
  ))
    await env.DB.prepare(
      query.replace(/\boperations_resize\b/g, "operations"),
    ).run();
  for (const row of rows)
    await env.DB.prepare(
      `INSERT INTO operations(${Object.keys(row).join(",")}) VALUES(${Object.keys(
        row,
      )
        .map(() => "?")
        .join(",")})`,
    )
      .bind(...Object.values(row))
      .run();
}
async function migrate() {
  await env.DB.batch(
    migrations
      .find((value) => value.name.startsWith("0008"))!
      .queries.map((query) => env.DB.prepare(query)),
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
      (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results,
    );
    keys.set(
      table,
      (await env.DB.prepare(`PRAGMA foreign_key_list(${table})`).all()).results,
    );
  }
  const indexes = (
    await env.DB.prepare(
      "SELECT name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name",
    ).all()
  ).results;
  await migrate();
  for (const table of tables) {
    const after = (
      await env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()
    ).results;
    expect(
      after.map((row) =>
        Object.fromEntries(
          Object.keys(before.get(table)![0]!).map((key) => [key, row[key]]),
        ),
      ),
    ).toEqual(before.get(table));
    expect(
      (await env.DB.prepare(`PRAGMA foreign_key_list(${table})`).all()).results,
    ).toEqual(keys.get(table));
  }
  for (const index of indexes)
    expect(
      await env.DB.prepare("SELECT name,sql FROM sqlite_master WHERE name=?")
        .bind(index.name)
        .first(),
    ).toEqual(index);
  expect(
    (await env.DB.prepare("PRAGMA foreign_key_check").all()).results,
  ).toEqual([]);
  // Physical metadata cleanup retains the pre-existing cascades, including its measurement trigger.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM operations WHERE database_id=?").bind(id),
    env.DB.prepare("DELETE FROM roles WHERE database_id=?").bind(id),
    env.DB.prepare("DELETE FROM lifecycle_events WHERE database_id=?").bind(id),
    env.DB.prepare("DELETE FROM databases WHERE id=?").bind(id),
  ]);
  for (const table of [
    "maintenance_credentials",
    "usage_samples",
    "usage_hourly",
    "usage_revisions",
    "usage_rollup_progress",
  ])
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) n FROM ${table} WHERE database_id=?`,
      )
        .bind(id)
        .first("n"),
    ).toBe(0);
});

it("legacy suspension becomes manual with a genuine monotonic intent, while running legacy remains awake", async () => {
  const f = await fixture();
  const id = DatabaseWithOperation.parse(await (await f.create()).json())
    .database.id;
  await preLifecycle();
  await env.DB.prepare(
    "UPDATE databases SET desired_state='suspended' WHERE id=?",
  )
    .bind(id)
    .run();
  const archive = await env.DB.prepare(
    "SELECT archive_path FROM databases WHERE id=?",
  )
    .bind(id)
    .first("archive_path");
  await migrate();
  const row = await env.DB.prepare("SELECT * FROM databases WHERE id=?")
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
    await env.DB.prepare(
      "SELECT kind,status,generation FROM operations WHERE id=? AND database_id=?",
    )
      .bind(row!.power_operation, id)
      .first(),
  ).toEqual({ kind: "database.suspend", status: "pending", generation: 2 });
});
