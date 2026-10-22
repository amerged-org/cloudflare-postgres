// SPDX-License-Identifier: Apache-2.0
// A wake of an idle sleeper that does not end in a running database returns the database to its idle
// sleep, so that the node proves the sleep again and the next connection wakes it with a new ticket
// (`recoverFailedResume`, which a resume that failed already uses). A wake the agent does not carry
// out reaches D1 as the agent's `asleep` at the wake's generation (a ticket it refuses, a start
// that fails, a restart of the agent), and the power timeout ends it. A persistent node error
// (`volume_missing`, `identity_mismatch`) is no wake failure and returns nothing to sleep. Real D1
// and Durable Object harness; no live evidence.
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { runCron } from "../../src/cron.ts";
import { cleanupFixtures, report, verdicts } from "./fixtures.ts";
import { actor, sleeping, untilWake } from "./wake-fixture.ts";

afterEach(async () => {
  await env.DB.prepare("DELETE FROM reconciliation_cursors").run();
  await env.DB.prepare("DELETE FROM power_timeout_cursor").run();
  await cleanupFixtures();
});

type Sleeper = Awaited<ReturnType<typeof sleeping>>;
const row = (id: string) =>
  env.DB.prepare(
    "SELECT desired_state,suspension_reason,generation,power_operation,observed_state,observed_power,observed_generation,proven_sleep_json,status_message FROM databases WHERE id=?",
  )
    .bind(id)
    .first<{
      desired_state: string;
      suspension_reason: string | null;
      generation: number;
      power_operation: string;
      observed_state: string;
      observed_power: string;
      observed_generation: number;
      proven_sleep_json: string | null;
      status_message: string | null;
    }>();
const operation = (id: string) =>
  env.DB.prepare(
    "SELECT kind,status,error_code,generation FROM operations WHERE id=?",
  )
    .bind(id)
    .first<{
      kind: string;
      status: string;
      error_code: string | null;
      generation: number;
    }>();
const lastEvent = async (id: string) =>
  env.DB.prepare(
    "SELECT kind,generation FROM lifecycle_events WHERE database_id=? ORDER BY id DESC LIMIT 1",
  )
    .bind(id)
    .first();

/** A connection wakes the idle sleeper: the Actor's ticket is claimed in D1 at generation 3. */
async function woken(f: Sleeper) {
  const admitted = await actor(f.id).admitWake(f.id, "app");
  if (!admitted.ok || !("wake" in admitted)) throw new Error("no wake ticket");
  const claimed = await untilWake(f.id);
  expect(claimed.power_operation).toBe(admitted.wake.operation);
  expect(await operation(claimed.power_operation)).toMatchObject({
    kind: "database.wake",
    status: "pending",
    generation: 3,
  });
  return claimed;
}

/** The sleep is proven again at generation 4 and the next connection gets a new ticket for 5. */
async function wakesNormally(f: Sleeper, hibernation: string) {
  expect(await verdicts(await report(f, f.id, 4, "asleep"))).toEqual([
    "accept",
  ]);
  expect(await operation(hibernation)).toMatchObject({
    kind: "database.hibernate",
    status: "succeeded",
  });
  expect(await lastEvent(f.id)).toEqual({ kind: "hibernated", generation: 4 });
  expect(await row(f.id)).toMatchObject({
    desired_state: "suspended",
    suspension_reason: "idle",
    observed_state: "provisioning",
    observed_power: "hibernated",
    observed_generation: 4,
    proven_sleep_json: expect.stringContaining("system_identifier"),
  });
  const again = await actor(f.id).admitWake(f.id, "app");
  if (!again.ok || !("wake" in again)) throw new Error("no new wake ticket");
  expect(again.wake.generation).toBe(5);
  const claimed = await untilWake(f.id, 5);
  expect(claimed.power_operation).toBe(again.wake.operation);
  expect((await report(f, f.id, 5)).status).toBe(200);
  expect(await row(f.id)).toMatchObject({
    desired_state: "running",
    observed_state: "ready",
    observed_power: "awake",
    observed_generation: 5,
  });
  expect(await operation(again.wake.operation)).toMatchObject({
    kind: "database.wake",
    status: "succeeded",
  });
}

/**
 * The node took the ticket, did not start the database and reports it asleep at the wake's
 * generation, as after a refused ticket or a restart of the agent: D1 shows the database running
 * and asleep with a wake that nothing carries out, until the power timeout returns it to sleep.
 */
async function wakeThatNeverEnds(f: Sleeper) {
  const wake = await woken(f);
  expect(await verdicts(await report(f, f.id, 3, "asleep"))).toEqual([
    "accept",
  ]);
  expect(await row(f.id)).toMatchObject({
    desired_state: "running",
    observed_state: "provisioning",
    observed_power: "hibernated",
    observed_generation: 3,
  });
  // A wake that is not 20 minutes old is left to the node.
  expect((await runCron(env)).failed).toBe(0);
  expect((await row(f.id))!.generation).toBe(3);
  await env.DB.prepare("UPDATE operations SET updated_at=? WHERE id=?")
    .bind(
      new Date(Date.now() - 21 * 60_000).toISOString(),
      wake.power_operation,
    )
    .run();
  expect((await runCron(env)).failed).toBe(1);
  expect(await operation(wake.power_operation)).toMatchObject({
    status: "failed",
    error_code: "operation_timeout",
  });
  const after = await row(f.id);
  expect(after).toMatchObject({
    desired_state: "suspended",
    suspension_reason: "idle",
    generation: 4,
    observed_power: "hibernated",
    status_message: "Wake failed: operation_timeout",
  });
  expect(await operation(after!.power_operation)).toMatchObject({
    kind: "database.hibernate",
    status: "pending",
    generation: 4,
  });
  return after!;
}

it("returns the idle sleeper to its idle sleep when its wake never ends, the node proves the sleep, and the next connection wakes it with a new ticket", async () => {
  const f = await sleeping();
  const after = await wakeThatNeverEnds(f);
  await wakesNormally(f, after.power_operation);
});

it("fails a return to sleep that the node does not prove, and leaves the sleeper suspended", async () => {
  const f = await sleeping();
  const after = await wakeThatNeverEnds(f);
  // The suspension is not proven yet, but D1 knows the database asleep: the cron leaves it be.
  await env.DB.prepare("UPDATE operations SET updated_at=? WHERE id=?")
    .bind(
      new Date(Date.now() - 21 * 60_000).toISOString(),
      after.power_operation,
    )
    .run();
  await runCron(env);
  expect(await row(f.id)).toMatchObject({
    desired_state: "suspended",
    suspension_reason: "idle",
    generation: 4,
  });
  expect(await operation(after.power_operation)).toMatchObject({
    status: "failed",
    error_code: "operation_timeout",
  });
});

it("leaves a wake that a persistent node error ended at running and error, and the next connections reuse its ticket", async () => {
  const f = await sleeping();
  const wake = await woken(f);
  // The volume of the database is missing on the node: the agent reports this for as long as it is.
  expect(
    await verdicts(
      await report(f, f.id, 3, "error", { error: "volume_missing" }),
    ),
  ).toEqual(["accept"]);
  const failed = await row(f.id);
  expect(failed).toMatchObject({
    desired_state: "running",
    generation: 3,
    observed_state: "error",
  });
  expect(await operation(wake.power_operation)).toMatchObject({
    status: "failed",
    error_code: "volume_missing",
  });
  // No return to sleep and no new wake: a connection takes the ticket it has, at the same
  // generation, and the power timeout has no open wake left to return to sleep.
  const again = await actor(f.id).admitWake(f.id, "app");
  if (!again.ok || !("wake" in again)) throw new Error("no wake ticket");
  expect(again.wake.generation).toBe(3);
  await env.DB.prepare("UPDATE operations SET updated_at=? WHERE id=?")
    .bind(
      new Date(Date.now() - 21 * 60_000).toISOString(),
      wake.power_operation,
    )
    .run();
  await runCron(env);
  expect(await row(f.id)).toEqual(failed);
});
