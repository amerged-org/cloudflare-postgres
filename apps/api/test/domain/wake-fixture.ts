// SPDX-License-Identifier: Apache-2.0
// A database that slept idle and is claimed awake again, on real D1 and Durable Object fixtures.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { expect } from "vitest";
import { readDatabasePresence } from "../../src/domain/database-actor-sync.ts";
import { fixture, report } from "./fixtures.ts";

export const actor = (id: string) =>
  env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id));
export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function sleeping() {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  const id = created.database.id;
  await report(f, id, 1);
  await actor(id).seed((await readDatabasePresence(env.DB, id))!);
  await env.DB.prepare(
    "UPDATE size_classes SET sleep_after_seconds=60 WHERE id=?",
  )
    .bind(f.size)
    .run();
  expect(
    await actor(id).recordActivity(id, {
      revision: 1,
      observed_at: new Date().toISOString(),
      last_activity_at: new Date(Date.now() - 120_000).toISOString(),
      active_connections: 0,
    }),
  ).toBe(true);
  expect((await actor(id).requestIdle(id, 1)).ok).toBe(true);
  const row = (await env.DB.prepare(
    "SELECT generation,power_operation FROM databases WHERE id=?",
  )
    .bind(id)
    .first<{ generation: number; power_operation: string }>())!;
  expect((await report(f, id, row.generation, "asleep")).status).toBe(200);
  return { ...f, id };
}
export async function untilWake(id: string) {
  for (let i = 0; i < 400; i++) {
    const row = await env.DB.prepare(
      "SELECT generation,power_operation,desired_state FROM databases WHERE id=?",
    )
      .bind(id)
      .first<{
        generation: number;
        power_operation: string;
        desired_state: string;
      }>();
    if (row?.desired_state === "running" && row.generation === 3) return row;
    await sleep(5);
  }
  throw new Error("wake_not_started");
}
export async function registered(id: string, waiterId: string) {
  for (let i = 0; i < 400; i++) {
    if (
      await runInDurableObject(actor(id), (instance) =>
        Reflect.get(instance, "waiters").has(waiterId),
      )
    )
      return;
    await sleep(5);
  }
  throw new Error("waiter_not_registered");
}
/** Cancels the loop's fallback timer: from here only a push or a publish resumes it. */
export async function parkPolling(id: string) {
  for (let i = 0; i < 400; i++) {
    const parked = await runInDurableObject(actor(id), (instance) => {
      const timer = Reflect.get(instance, "pollTimer");
      if (timer === undefined) return false;
      clearTimeout(timer);
      return true;
    });
    if (parked) return;
    await sleep(5);
  }
  throw new Error("polling_not_parked");
}
/** The node reports the woken generation ready, as it does once the unit answers. */
export const reportReady = (
  f: Parameters<typeof report>[0],
  id: string,
  generation = 3,
) => report(f, id, generation);
