// SPDX-License-Identifier: Apache-2.0
// The keep-warm visit (`DatabaseActor.warm`) must change nothing an admission could see: not the
// Actor's rows, its in-memory admission state, a wake ticket, D1, or the Actor's existence. Real
// D1 and Durable Object harness.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { newDatabaseId } from "@pgcf/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { publishDatabaseAdmission } from "../../src/domain/database-admission-snapshot.ts";
import {
  admissionSnapshotFixture,
  sleepingSnapshotFixture,
} from "./admission-snapshot-fixture.ts";
import { cleanupFixtures } from "./fixtures.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
});
const actor = (id: string) =>
  env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id));

/** Every row of every table of the Actor, every key of its KV storage, and what it holds in memory for admissions. */
function actorState(id: string) {
  return runInDurableObject(actor(id), async (instance, state) => {
    const tables = state.storage.sql
      .exec<{ name: string; sql: string }>(
        "SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
      )
      .toArray();
    return JSON.stringify({
      tables: tables.map((table) => ({
        ...table,
        rows: state.storage.sql.exec(`SELECT * FROM "${table.name}"`).toArray(),
      })),
      // The KV storage API keeps its entries in `_cf_KV`, which the table listing above skips.
      kv: [...(await state.storage.list()).entries()],
      alarm: await state.storage.getAlarm(),
      memory: {
        admissions: Reflect.get(instance, "admissions"),
        wake: Reflect.get(instance, "wake") ?? null,
        waiters: [...Reflect.get(instance, "waiters").keys()],
        claim: Reflect.get(instance, "claim")?.operation ?? null,
        ticketMutation: Reflect.get(instance, "ticketMutation") ?? null,
        polling: Reflect.get(instance, "polling"),
        pushed: Reflect.get(instance, "pushed"),
      },
    });
  });
}
/** What D1 holds about a database's admission (the rows, not the statement's timing). */
async function d1State(id: string) {
  const answers = await env.DB.batch([
    env.DB.prepare("SELECT * FROM databases WHERE id=?").bind(id),
    env.DB.prepare(
      "SELECT * FROM database_admission_epochs WHERE database_id=?",
    ).bind(id),
    env.DB.prepare("SELECT * FROM operations WHERE database_id=?").bind(id),
  ]);
  return JSON.stringify(answers.map((answer) => answer.results));
}
const ticketState = (id: string) =>
  runInDurableObject(
    actor(id),
    (_instance, state) =>
      state.storage.sql
        .exec<{ state: string }>("SELECT state FROM database_ticket")
        .toArray()[0]?.state,
  );

it("leaves an awake database's rows, memory, D1 and admission answer exactly as they were", async () => {
  const f = await admissionSnapshotFixture();
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  const answer = await actor(f.id).admitWake(f.id, "app");
  expect(answer.ok).toBe(true);
  const before = [await actorState(f.id), await d1State(f.id)];
  const prepare = vi.spyOn(Object.getPrototypeOf(env.DB), "prepare");
  for (let visit = 0; visit < 3; visit++) await actor(f.id).warm();
  expect(prepare).not.toHaveBeenCalled();
  prepare.mockRestore();
  expect([await actorState(f.id), await d1State(f.id)]).toEqual(before);
  expect(await actor(f.id).admitWake(f.id, "app")).toEqual(answer);
});

it("leaves a sleeping database's issued wake ticket, rows, memory and D1 exactly as they were", async () => {
  const f = await sleepingSnapshotFixture();
  const issued = await actor(f.id).admitWake(f.id, "reader");
  if (!issued.ok || !("wake" in issued)) throw new Error("no wake ticket");
  // The ticket's claim runs in the background; wait for it, so that nothing is moving.
  await expect
    .poll(() => ticketState(f.id), { interval: 5, timeout: 3000 })
    .toBe("claimed");
  await expect
    .poll(
      () =>
        runInDurableObject(
          actor(f.id),
          (instance) => Reflect.get(instance, "claim")?.operation ?? null,
        ),
      { interval: 5, timeout: 3000 },
    )
    .toBeNull();
  const answer = await actor(f.id).admitWake(f.id, "reader");
  expect(answer).toMatchObject({ ok: true, wake: issued.wake });
  const before = [await actorState(f.id), await d1State(f.id)];
  const prepare = vi.spyOn(Object.getPrototypeOf(env.DB), "prepare");
  for (let visit = 0; visit < 3; visit++) await actor(f.id).warm();
  expect(prepare).not.toHaveBeenCalled();
  prepare.mockRestore();
  expect([await actorState(f.id), await d1State(f.id)]).toEqual(before);
  expect(await actor(f.id).admitWake(f.id, "reader")).toEqual(answer);
});

it("creates nothing in an Actor that holds nothing yet, and it still refuses as an unknown database", async () => {
  const id = newDatabaseId();
  const prepare = vi.spyOn(Object.getPrototypeOf(env.DB), "prepare");
  await actor(id).warm();
  const state = await actorState(id);
  expect(JSON.parse(state).tables).toEqual([]);
  expect(JSON.parse(state).kv).toEqual([]);
  expect(JSON.parse(state).alarm).toBeNull();
  expect(prepare).not.toHaveBeenCalled();
  expect(await actor(id).admitWake(id, "app")).toEqual({
    ok: false,
    sqlstate: "3D000",
  });
  expect(await actorState(id)).toBe(state);
});
