// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { readDatabasePresence } from "../../src/domain/database-actor-sync.ts";
import {
  cleanupFixtures,
  fixture,
  observation,
  observedBody,
  request,
} from "./fixtures.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
});
const actor = (id: string) =>
  env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function ready() {
  const f = await fixture();
  const result = DatabaseWithOperation.parse(await (await f.create()).json());
  const id = result.database.id;
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([observation(id, 1)]),
  );
  return { ...f, id };
}
async function createRole(
  f: Awaited<ReturnType<typeof ready>>,
  body: Record<string, unknown>,
) {
  const response = await request(
    `/v1/databases/${f.id}/roles`,
    f.integrator,
    "POST",
    body,
    crypto.randomUUID(),
  );
  expect(response.status).toBe(201);
  const generation = await env.DB.prepare(
    "SELECT generation FROM databases WHERE id=?",
  )
    .bind(f.id)
    .first<number>("generation");
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([observation(f.id, generation!)]),
  );
  await actor(f.id).seed((await readDatabasePresence(env.DB, f.id))!);
}
/** Puts the ready database to idle sleep through the real activity and idle path. */
async function sleep(f: Awaited<ReturnType<typeof ready>>) {
  await env.DB.prepare(
    "UPDATE size_classes SET sleep_after_seconds=60 WHERE id=?",
  )
    .bind(f.size)
    .run();
  const row = (await env.DB.prepare(
    "SELECT generation FROM databases WHERE id=?",
  )
    .bind(f.id)
    .first<{ generation: number }>())!;
  expect(
    await actor(f.id).recordActivity(f.id, {
      revision: row.generation,
      observed_at: new Date().toISOString(),
      last_activity_at: new Date(Date.now() - 120_000).toISOString(),
      active_connections: 0,
    }),
  ).toBe(true);
  expect((await actor(f.id).requestIdle(f.id, row.generation)).ok).toBe(true);
  const sleeping = (await env.DB.prepare(
    "SELECT generation,power_operation FROM databases WHERE id=?",
  )
    .bind(f.id)
    .first<{ generation: number; power_operation: string }>())!;
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(f.id, sleeping.generation, "hibernated"),
        power: {
          operation: sleeping.power_operation,
          revision: sleeping.generation,
          state: "hibernated",
        },
      },
    ]),
  );
}
const wakes = async (id: string) =>
  env.DB.prepare(
    "SELECT COUNT(*) count FROM operations WHERE database_id=? AND kind IN('database.wake','database.resume')",
  )
    .bind(id)
    .first<number>("count");

it("an expired credential is answered as an expired password and never wakes the database", async () => {
  const f = await ready();
  const until = new Date(Date.now() + 1500).toISOString();
  await createRole(f, { name: "report_job", valid_until: until });
  // Before the expiry the role is admitted like any other.
  expect((await actor(f.id).admit(f.id, "report_job")).ok).toBe(true);
  await sleep(f);
  await wait(Math.max(0, Date.parse(until) - Date.now()) + 300);
  const before = await wakes(f.id);
  const prepared = vi.spyOn(Object.getPrototypeOf(env.DB), "prepare");
  expect(
    await actor(f.id).ensureAwake(f.id, "report_job", {
      deadline: Date.now() + 1000,
    }),
  ).toEqual({ ok: false, sqlstate: "28P01" });
  expect(await actor(f.id).admit(f.id, "report_job")).toEqual({
    ok: false,
    sqlstate: "28P01",
  });
  // The actor's own record decides: no database read, no wake, no connection budget spent.
  expect(prepared).not.toHaveBeenCalled();
  expect(await wakes(f.id)).toBe(before);
  expect(
    await env.DB.prepare("SELECT desired_state FROM databases WHERE id=?")
      .bind(f.id)
      .first("desired_state"),
  ).toBe("suspended");
});

it("the authoritative read refuses an expired role even where a stale presence still lists it", async () => {
  const f = await ready();
  const until = new Date(Date.now() + 1200).toISOString();
  await createRole(f, { name: "report_job", valid_until: until });
  const current = (await readDatabasePresence(env.DB, f.id))!;
  await wait(Math.max(0, Date.parse(until) - Date.now()) + 300);
  // A presence from before the expiry was known: a bare name is a role without expiry.
  await actor(f.id).seed({
    ...current,
    revision: current.revision + 1,
    roles: ["app", "report_job"],
  });
  expect(await actor(f.id).admit(f.id, "report_job")).toEqual({
    ok: false,
    sqlstate: "28P01",
  });
});

/** The last millisecond of the current second: PostgreSQL applies the expiry at its start. */
const endOfThisSecond = () =>
  new Date(Math.floor(Date.now() / 1000) * 1000 + 999).toISOString();

it("refuses a role from the whole second its expiry falls in, as PostgreSQL does", async () => {
  const f = await ready();
  await createRole(f, {
    name: "report_job",
    valid_until: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const current = (await readDatabasePresence(env.DB, f.id))!;
  // The expiry is a few hundred milliseconds ahead, in the second PostgreSQL already counts as
  // the one the credential stopped in: the actor must not admit what PostgreSQL would refuse.
  await actor(f.id).seed({
    ...current,
    revision: current.revision + 1,
    roles: [
      { name: "app", valid_until: null },
      { name: "report_job", valid_until: endOfThisSecond() },
    ],
  });
  expect(await actor(f.id).admit(f.id, "report_job")).toEqual({
    ok: false,
    sqlstate: "28P01",
  });
  expect((await actor(f.id).admit(f.id, "app")).ok).toBe(true);
});

it("the authoritative read applies the same second, where a stale presence lists the role", async () => {
  const f = await ready();
  await createRole(f, {
    name: "report_job",
    valid_until: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const current = (await readDatabasePresence(env.DB, f.id))!;
  await env.DB.prepare(
    "UPDATE roles SET valid_until=? WHERE database_id=? AND name=?",
  )
    .bind(endOfThisSecond(), f.id, "report_job")
    .run();
  await actor(f.id).seed({
    ...current,
    revision: current.revision + 1,
    roles: ["app", "report_job"],
  });
  expect(await actor(f.id).admit(f.id, "report_job")).toEqual({
    ok: false,
    sqlstate: "28P01",
  });
});

it("admits from a presence persisted before roles carried an expiry", async () => {
  const f = await ready();
  await actor(f.id).seed((await readDatabasePresence(env.DB, f.id))!);
  // The form every actor already holds: a list of bare role names.
  await runInDurableObject(actor(f.id), (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE database_presence SET roles=?",
      JSON.stringify(["app"]),
    );
  });
  await evictDurableObject(actor(f.id));
  const prepared = vi.spyOn(Object.getPrototypeOf(env.DB), "prepare");
  expect(await actor(f.id).admit(f.id, "other")).toEqual({
    ok: false,
    sqlstate: "28P01",
  });
  expect(prepared).not.toHaveBeenCalled();
  expect((await actor(f.id).admit(f.id, "app")).ok).toBe(true);
});

it("persists a role without an expiry as the bare name the previous Worker reads", async () => {
  const f = await ready();
  const until = new Date(Date.now() + 3_600_000).toISOString();
  await createRole(f, { name: "plain_job" });
  await createRole(f, { name: "report_job", valid_until: until });
  const stored = await runInDurableObject(actor(f.id), (_instance, state) =>
    JSON.parse(
      state.storage.sql
        .exec<{ roles: string }>(
          "SELECT roles FROM database_presence WHERE singleton=1",
        )
        .one().roles,
    ),
  );
  // Only the role that has an expiry needs the object form, so rolling the Worker back leaves
  // every database that does not use expiries with a presence it still parses.
  expect(stored).toEqual([
    "app",
    "plain_job",
    { name: "report_job", valid_until: until },
  ]);
});

it("an unexpired role and the owner still wake the sleeping database", async () => {
  const f = await ready();
  await createRole(f, {
    name: "report_job",
    valid_until: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await sleep(f);
  const pending = actor(f.id).ensureAwake(f.id, "report_job", {
    waiterId: crypto.randomUUID(),
    deadline: Date.now() + 800,
  });
  // The wake is requested before the (absent) region could report it ready.
  for (let attempt = 0; attempt < 100 && (await wakes(f.id)) === 0; attempt++)
    await wait(10);
  expect(await wakes(f.id)).toBe(1);
  await pending;
});
