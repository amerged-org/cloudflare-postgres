// SPDX-License-Identifier: Apache-2.0
// What the rollback rule of the slot pool reads (`apps/node-agent/README.md`, "Rolling back to an
// earlier release"): before an older agent is assigned, every database of the node reads the public
// `observed_state` `hibernated` with `suspension_reason` `manual`. `observed_power` alone says
// nothing of a wake that is under way: the claim of a wake leaves it as it was, and the agent
// reports nothing while it starts PostgreSQL. `unproven` is the one report the check cannot see.
// Real D1 and Durable Object harness; no live evidence.
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, refusal, report, request } from "./fixtures.ts";
import { actor, reportReady, sleeping, untilWake } from "./wake-fixture.ts";

afterEach(cleanupFixtures);

type Sleeper = Awaited<ReturnType<typeof sleeping>>;

/** What an operator reads of the database: the public view, and the column the rule must not use. */
async function read(f: Sleeper) {
  const response = await request(`/v1/databases/${f.id}`, f.admin);
  expect(response.status).toBe(200);
  const view = await response.json<{
    desired_state: string;
    observed_state: string;
    suspension_reason: string | null;
  }>();
  const power = await env.DB.prepare(
    "SELECT observed_power FROM databases WHERE id=?",
  )
    .bind(f.id)
    .first<{ observed_power: string }>();
  return { ...view, observed_power: power!.observed_power };
}
const suspend = (f: Sleeper) =>
  request(`/v1/databases/${f.id}/suspend`, f.integrator, "POST");
/** The rollback check: no slot can hold a database that reads this. */
const held = (view: Awaited<ReturnType<typeof read>>) =>
  view.observed_state === "hibernated" && view.suspension_reason === "manual";

it("passes only a database suspended by hand and proven asleep at its current generation", async () => {
  const f = await sleeping();
  // An idle sleeper reads hibernated, but a connection wakes it into a slot: not held.
  const idle = await read(f);
  expect(idle).toMatchObject({
    observed_state: "hibernated",
    suspension_reason: "idle",
  });
  expect(held(idle)).toBe(false);
  // The suspension moves the generation. The database passes once the node, which sees the new
  // generation on its next pull, says it asleep at that generation.
  expect((await suspend(f)).status).toBe(202);
  expect(held(await read(f))).toBe(false);
  expect((await report(f, f.id, 3, "asleep")).status).toBe(200);
  expect(held(await read(f))).toBe(true);
});

it("fails a database whose wake began before its suspension, though observed_power still says hibernated", async () => {
  const f = await sleeping();
  const admitted = await actor(f.id).admitWake(f.id, "app");
  if (!admitted.ok || !("wake" in admitted)) throw new Error("no wake ticket");
  await untilWake(f.id);
  // The wake is claimed and the agent starts PostgreSQL; it reports nothing until it is ready.
  const waking = await read(f);
  expect(waking).toMatchObject({
    desired_state: "running",
    observed_power: "hibernated",
  });
  expect(held(waking)).toBe(false);
  // The suspension is refused while the wake runs, so the database stays failing the check.
  expect(await refusal(await suspend(f))).toMatchObject({
    status: 409,
    reason: "not_ready",
  });
  expect(held(await read(f))).toBe(false);
  // The wake ends ready; the suspension that follows moves the generation, and the database fails
  // the check until the node says it asleep at that generation.
  expect((await reportReady(f, f.id)).status).toBe(200);
  expect((await suspend(f)).status).toBe(202);
  const suspending = await read(f);
  expect(suspending).toMatchObject({
    desired_state: "suspended",
    suspension_reason: "manual",
  });
  expect(held(suspending)).toBe(false);
  expect((await report(f, f.id, 4, "asleep")).status).toBe(200);
  expect(held(await read(f))).toBe(true);
});

it("keeps reading a held database as hibernated when the node finds its sleep unproven (the check's blind spot, which the node's own count covers)", async () => {
  const f = await sleeping();
  expect((await suspend(f)).status).toBe(202);
  expect((await report(f, f.id, 3, "asleep")).status).toBe(200);
  expect(held(await read(f))).toBe(true);
  // An agent that starts and cannot prove the sleep reports unproven and recovers the database
  // in a slot. The API keeps the power, the generation and the state as they were.
  expect((await report(f, f.id, 3, "unproven")).status).toBe(200);
  expect(held(await read(f))).toBe(true);
});
