// SPDX-License-Identifier: Apache-2.0
// A wake of an idle sleeper that does not end in a running database returns the database to its idle
// sleep, so that the node proves the sleep again and the next connection wakes it with a new ticket
// (`recoverFailedResume`, which a resume that failed already uses). Real D1 and Durable Object
// harness; no live evidence.
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { runCron } from "../../src/cron.ts";
import { cleanupFixtures, report, verdicts } from "./fixtures.ts";
import { actor, sleeping, untilWake } from "./wake-fixture.ts";

afterEach(async () => {
  vi.restoreAllMocks();
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

it("returns the idle sleeper to its idle sleep when the node reports an error for the wake, and the node's proof ends the sleep again", async () => {
  const f = await sleeping();
  const wake = await woken(f);
  expect(
    await verdicts(
      await report(f, f.id, 3, "error", {
        error: "start_failed",
        message: "the unit did not start",
      }),
    ),
  ).toEqual(["accept"]);
  // The wake fails with the node's reason, and the database is the idle sleeper it was before it.
  expect(await operation(wake.power_operation)).toMatchObject({
    status: "failed",
    error_code: "start_failed",
  });
  const after = await row(f.id);
  expect(after).toMatchObject({
    desired_state: "suspended",
    suspension_reason: "idle",
    generation: 4,
    observed_state: "provisioning",
    observed_power: "hibernated",
    status_message: "Wake failed: start_failed",
  });
  expect(await operation(after!.power_operation)).toMatchObject({
    kind: "database.hibernate",
    status: "pending",
    generation: 4,
  });
  // The node's report of the failed wake, sent again, changes nothing.
  expect(
    await verdicts(
      await report(f, f.id, 3, "error", { error: "start_failed" }),
    ),
  ).toEqual(["stale"]);
  expect((await row(f.id))!.generation).toBe(4);
  await wakesNormally(f, after!.power_operation);
});

it("returns the idle sleeper to its idle sleep when its wake never ends, as after a refused ticket or a restart of the agent", async () => {
  const f = await sleeping();
  const wake = await woken(f);
  // The node took the page, did not start the database and reports it asleep at the wake's
  // generation: D1 shows it running and asleep, with a wake that nothing carries out.
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
  });
  expect(await operation(after!.power_operation)).toMatchObject({
    kind: "database.hibernate",
    status: "pending",
  });
  // The suspension is not proven yet, but D1 knows the database asleep: the cron leaves it be.
  await env.DB.prepare("UPDATE operations SET updated_at=? WHERE id=?")
    .bind(
      new Date(Date.now() - 21 * 60_000).toISOString(),
      after!.power_operation,
    )
    .run();
  await runCron(env);
  expect((await row(f.id))!.generation).toBe(4);
  expect(await operation(after!.power_operation)).toMatchObject({
    status: "failed",
    error_code: "operation_timeout",
  });
});

it("asks for the report again while another writer wins the return to sleep", async () => {
  const f = await sleeping();
  const wake = await woken(f);
  const batch = env.DB.batch.bind(env.DB);
  const spy = vi
    .spyOn(env.DB, "batch")
    .mockImplementation(async (statements: D1PreparedStatement[]) => {
      await env.DB.prepare("UPDATE databases SET updated_at=? WHERE id=?")
        .bind("2099-01-01T00:00:00.000Z", f.id)
        .run();
      return batch(statements);
    });
  const lost = await verdicts(
    await report(f, f.id, 3, "error", { error: "start_failed" }),
  );
  spy.mockRestore();
  // The node sends what was not accepted again, and nothing was written for it.
  expect(lost).toEqual(["conflict"]);
  expect(await row(f.id)).toMatchObject({
    desired_state: "running",
    generation: 3,
  });
  expect(await operation(wake.power_operation)).toMatchObject({
    status: "pending",
  });
  expect(
    await verdicts(
      await report(f, f.id, 3, "error", { error: "start_failed" }),
    ),
  ).toEqual(["accept"]);
  expect(await row(f.id)).toMatchObject({
    desired_state: "suspended",
    suspension_reason: "idle",
    generation: 4,
  });
});
