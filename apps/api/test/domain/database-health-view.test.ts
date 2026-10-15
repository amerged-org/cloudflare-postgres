// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { Database, DatabaseWithOperation, listEnvelope } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";

const sampled: string[] = [];
afterEach(async () => {
  for (const id of sampled.splice(0))
    await env.DB.prepare("DELETE FROM usage_samples WHERE database_id=?")
      .bind(id)
      .run();
  await cleanupFixtures();
});

async function created() {
  const f = await fixture();
  const database = DatabaseWithOperation.parse(
    await (await f.create()).json(),
  ).database;
  sampled.push(database.id);
  return { ...f, id: database.id };
}
const read = async (f: { id: string; integrator: string }) =>
  Database.parse(
    await (await request(`/v1/databases/${f.id}`, f.integrator)).json(),
  );
/** What the agent reports about the volume: one row of the table the usage producer fills. */
async function sample(
  id: string,
  observedAt: string,
  used: number | null,
  allocated: number | null,
  sequence = 1,
) {
  const producer = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO usage_samples(database_id,source,producer_id,sequence,interval_start,interval_end,observed_at,payload) VALUES(?,'agent',?,?,?,?,?,?)",
  )
    .bind(
      id,
      producer,
      sequence,
      observedAt,
      observedAt,
      observedAt,
      JSON.stringify({
        database_id: id,
        producer_id: producer,
        source: "agent",
        sequence,
        observed_at: observedAt,
        storage_used_bytes: used,
        storage_allocated_bytes: allocated,
      }),
    )
    .run();
}
const operatorRow = async (admin: string, id: string) => {
  const page = await (
    await request("/v1/operational-health?scope=databases&limit=100", admin)
  ).json<{
    data: {
      id: string;
      backup: { status: string; last_completed_at: string | null };
      disk: { status: string; used_fraction: number | null };
    }[];
  }>();
  return page.data.find((row) => row.id === id)!;
};

it("reports unknown health and no storage before the first sample", async () => {
  const f = await created();
  const database = await read(f);
  expect(database.health).toEqual({
    archiving: "unknown",
    since: null,
    backup: { status: "unknown", last_base_backup_at: null },
    disk: { status: "unknown", used_ratio: null },
  });
  expect(database.storage).toBeNull();
});

it("takes backup and disk health from the producers of the operator listing", async () => {
  const f = await created();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE databases SET backup_observed_at=?,backup_health='ok',backup_last_completed_at=? WHERE id=?",
  )
    .bind(now, now, f.id)
    .run();
  await sample(f.id, now, 95, 100);
  const database = await read(f);
  expect(database.health.backup).toEqual({
    status: "ok",
    last_base_backup_at: now,
  });
  expect(database.health.disk).toEqual({ status: "warning", used_ratio: 0.95 });
  expect(database.storage).toEqual({
    used_bytes: 95,
    allocated_bytes: 100,
    observed_at: now,
  });
  // The operator sees the same verdicts: one source, not a second copy of it.
  const row = await operatorRow(f.admin, f.id);
  expect(row.backup).toMatchObject({
    status: database.health.backup.status,
    last_completed_at: database.health.backup.last_base_backup_at,
  });
  expect(row.disk).toMatchObject({
    status: database.health.disk.status,
    used_fraction: database.health.disk.used_ratio,
  });
});

it("keeps what is unknown unknown: an old sample, a failing backup, a missing figure", async () => {
  const f = await created();
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  const completed = new Date(Date.now() - 3600_000).toISOString();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE databases SET backup_observed_at=?,backup_health='failing',backup_last_completed_at=? WHERE id=?",
  )
    .bind(now, completed, f.id)
    .run();
  await sample(f.id, old, 10, 100);
  let database = await read(f);
  // A failing backup still names the last one that completed.
  expect(database.health.backup).toEqual({
    status: "failing",
    last_base_backup_at: completed,
  });
  // A sample older than the freshness window says nothing about the disk now, but is shown with its age.
  expect(database.health.disk.status).toBe("unknown");
  expect(database.storage).toEqual({
    used_bytes: 10,
    allocated_bytes: 100,
    observed_at: old,
  });
  // A newer sample that measured nothing keeps the ratio unknown and the object present.
  await sample(f.id, now, null, 100, 2);
  database = await read(f);
  expect(database.health.disk).toEqual({ status: "unknown", used_ratio: null });
  expect(database.storage).toEqual({
    used_bytes: null,
    allocated_bytes: 100,
    observed_at: now,
  });
});

it("carries the same fields in lists and in operation answers", async () => {
  const f = await created();
  const now = new Date().toISOString();
  await sample(f.id, now, 1, 4);
  const listed = listEnvelope(Database).parse(
    await (await request("/v1/databases", f.integrator)).json(),
  );
  expect(listed.data[0]!.health.disk).toEqual({
    status: "ok",
    used_ratio: 0.25,
  });
  expect(listed.data[0]!.storage).toMatchObject({ used_bytes: 1 });
  const deleted = DatabaseWithOperation.parse(
    await (
      await request(`/v1/databases/${f.id}`, f.integrator, "DELETE")
    ).json(),
  );
  expect(deleted.database.storage).toMatchObject({ allocated_bytes: 4 });
});
