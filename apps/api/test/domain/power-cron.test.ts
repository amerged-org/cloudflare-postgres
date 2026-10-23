// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { runCron } from "../../src/cron.ts";
import { cleanupFixtures, fixture, request, report } from "./fixtures.ts";

afterEach(async () => {
  await env.DB.prepare("DELETE FROM reconciliation_cursors").run();
  await env.DB.prepare("DELETE FROM power_timeout_cursor").run();
  await cleanupFixtures();
});

async function suspended() {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  const id = created.database.id;
  await report(f, id, 1);
  const result = DatabaseWithOperation.parse(
    await (
      await request(`/v1/databases/${id}/suspend`, f.integrator, "POST")
    ).json(),
  );
  await env.DB.prepare("UPDATE operations SET updated_at=? WHERE id=?")
    .bind(new Date(Date.now() - 21 * 60_000).toISOString(), result.operation.id)
    .run();
  return { ...f, id, operation: result.operation.id };
}

it("compensates timed-out quiescence before failing the operation without inventing readiness", async () => {
  const f = await suspended();
  const before = await env.DB.prepare(
    "SELECT archive_path,node_id,size_class_id FROM databases WHERE id=?",
  )
    .bind(f.id)
    .first();
  const result = await runCron(env);
  expect(result.failed).toBe(1);
  expect(
    await env.DB.prepare("SELECT status,error_code FROM operations WHERE id=?")
      .bind(f.operation)
      .first(),
  ).toEqual({ status: "failed", error_code: "power_timeout" });
  const row = await env.DB.prepare(
    "SELECT desired_state,generation,power_operation,observed_state,observed_power FROM databases WHERE id=?",
  )
    .bind(f.id)
    .first<{
      desired_state: string;
      generation: number;
      power_operation: string;
      observed_state: string;
      observed_power: string;
    }>();
  expect(row).toMatchObject({
    desired_state: "running",
    generation: 3,
    observed_state: "provisioning",
    observed_power: "awake",
  });
  expect(row!.power_operation).not.toBe(f.operation);
  expect(
    await env.DB.prepare("SELECT kind,status FROM operations WHERE id=?")
      .bind(row!.power_operation)
      .first(),
  ).toEqual({ kind: "database.resume", status: "pending" });
  expect(
    await env.DB.prepare(
      "SELECT archive_path,node_id,size_class_id FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual(before);
  expect((await runCron(env)).failed).toBe(0);
  expect(
    await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
      .bind(f.id)
      .first("generation"),
  ).toBe(3);
});

it("keeps an accepted deletion pending until cleanup is confirmed, even after the operation deadline", async () => {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  const id = created.database.id;
  await report(f, id, 1);
  const removed = DatabaseWithOperation.parse(
    await (await request(`/v1/databases/${id}`, f.integrator, "DELETE")).json(),
  );
  const stale = new Date(Date.now() - 25 * 3_600_000).toISOString();
  await env.DB.prepare(
    "UPDATE operations SET created_at=?,updated_at=? WHERE id=?",
  )
    .bind(stale, stale, removed.operation.id)
    .run();
  const operation = () =>
    env.DB.prepare(
      "SELECT status,error_code,completed_at FROM operations WHERE id=?",
    )
      .bind(removed.operation.id)
      .first();
  expect((await runCron(env)).failed).toBe(0);
  expect(await operation()).toEqual({
    status: "pending",
    error_code: null,
    completed_at: null,
  });
  expect(
    await env.DB.prepare(
      "SELECT desired_state,observed_state FROM databases WHERE id=?",
    )
      .bind(id)
      .first(),
  ).toEqual({ desired_state: "deleted", observed_state: "ready" });

  // Retrying the intent returns the same operation; only the node's completed cleanup ends it.
  const retry = DatabaseWithOperation.parse(
    await (await request(`/v1/databases/${id}`, f.integrator, "DELETE")).json(),
  );
  expect(retry.operation.id).toBe(removed.operation.id);
  expect(retry.operation.status).toBe("pending");
  expect((await report(f, id, 2, "deleted")).status).toBe(200);
  expect(await operation()).toMatchObject({
    status: "succeeded",
    error_code: null,
    completed_at: expect.any(String),
  });
});

it("uses the current power revision after a role configuration change", async () => {
  const f = await suspended();
  expect(
    (
      await request(
        `/v1/databases/${f.id}/roles/app/reset-password`,
        f.integrator,
        "POST",
        undefined,
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(200);
  expect((await runCron(env)).failed).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT desired_state,generation FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ desired_state: "running", generation: 4 });
  expect(
    await env.DB.prepare("SELECT error_code FROM operations WHERE id=?")
      .bind(f.operation)
      .first("error_code"),
  ).toBe("power_timeout");
});

it("does not compensate a superseded suspension", async () => {
  const f = await suspended();
  const resumed = DatabaseWithOperation.parse(
    await (
      await request(`/v1/databases/${f.id}/resume`, f.integrator, "POST")
    ).json(),
  );
  expect((await runCron(env)).failed).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT generation,power_operation FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ generation: 3, power_operation: resumed.operation.id });
});

it("pages timeout recovery and leaves the remaining owned suspension pending", async () => {
  const cohort = [];
  for (let i = 0; i < 9; i++) cohort.push(await suspended());
  expect((await runCron(env)).failed).toBe(8);
  const stillPending = await env.DB.prepare(
    "SELECT id FROM operations WHERE id IN(" +
      cohort.map(() => "?").join(",") +
      ") AND status='pending'",
  )
    .bind(...cohort.map((f) => f.operation))
    .all<{ id: string }>();
  expect(stillPending.results).toHaveLength(1);
  const remaining = cohort.find(
    (f) => f.operation === stillPending.results[0]!.id,
  )!;
  expect(
    await env.DB.prepare(
      "SELECT desired_state,generation FROM databases WHERE id=?",
    )
      .bind(remaining.id)
      .first(),
  ).toEqual({ desired_state: "suspended", generation: 2 });
  expect((await runCron(env)).failed).toBe(1);
  expect(
    await env.DB.prepare("SELECT error_code FROM operations WHERE id=?")
      .bind(remaining.operation)
      .first("error_code"),
  ).toBe("power_timeout");
  expect(
    await env.DB.prepare(
      "SELECT database_id FROM power_timeout_cursor WHERE singleton=1",
    ).first(),
  ).toEqual({ database_id: null });
}, 30_000);

/** A database that sleeps by hand, resumed, whose resume the node never carried out. */
async function resuming() {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  const id = created.database.id;
  await report(f, id, 1);
  await request(`/v1/databases/${id}/suspend`, f.integrator, "POST");
  await report(f, id, 2, "asleep");
  const result = DatabaseWithOperation.parse(
    await (
      await request(`/v1/databases/${id}/resume`, f.integrator, "POST")
    ).json(),
  );
  await env.DB.prepare("UPDATE operations SET updated_at=? WHERE id=?")
    .bind(new Date(Date.now() - 21 * 60_000).toISOString(), result.operation.id)
    .run();
  return { ...f, id, operation: result.operation.id };
}
type Resuming = Awaited<ReturnType<typeof resuming>>;
const state = (id: string) =>
  env.DB.prepare(
    "SELECT desired_state,suspension_reason,generation,observed_power FROM databases WHERE id=?",
  )
    .bind(id)
    .first();
const outcome = (operation: string) =>
  env.DB.prepare("SELECT status,error_code FROM operations WHERE id=?")
    .bind(operation)
    .first();

it("suspends a sleeping database again when its resume timed out, in pages like any power timeout", async () => {
  const cohort: Resuming[] = [];
  for (let i = 0; i < 9; i++) cohort.push(await resuming());
  expect((await runCron(env)).failed).toBe(8);
  const reverted: Resuming[] = [];
  const waiting: Resuming[] = [];
  for (const f of cohort) {
    const { desired_state } = (await state(f.id))!;
    (desired_state === "suspended" ? reverted : waiting).push(f);
  }
  expect(reverted).toHaveLength(8);
  // The ninth is not swept before its turn: its resume is still the operation that owns it.
  expect(waiting).toHaveLength(1);
  expect(await outcome(waiting[0]!.operation)).toEqual({
    status: "pending",
    error_code: null,
  });
  for (const f of reverted) {
    expect(await outcome(f.operation)).toEqual({
      status: "failed",
      error_code: "operation_timeout",
    });
    expect(await state(f.id)).toEqual({
      desired_state: "suspended",
      suspension_reason: "manual",
      generation: 4,
      observed_power: "hibernated",
    });
  }
  expect((await runCron(env)).failed).toBe(1);
  expect(await state(waiting[0]!.id)).toEqual({
    desired_state: "suspended",
    suspension_reason: "manual",
    generation: 4,
    observed_power: "hibernated",
  });
}, 30_000);

it("only fails the timed-out resume of a database that runs", async () => {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  await report(f, created.database.id, 1);
  await request(
    `/v1/databases/${created.database.id}/suspend`,
    f.integrator,
    "POST",
  );
  await report(f, created.database.id, 2, "ready", { refusal: "power_busy" });
  const made = await env.DB.prepare(
    "SELECT power_operation FROM databases WHERE id=?",
  )
    .bind(created.database.id)
    .first<{ power_operation: string }>();
  await env.DB.prepare("UPDATE operations SET updated_at=? WHERE id=?")
    .bind(
      new Date(Date.now() - 21 * 60_000).toISOString(),
      made!.power_operation,
    )
    .run();
  expect((await runCron(env)).failed).toBe(1);
  expect(await outcome(made!.power_operation)).toEqual({
    status: "failed",
    error_code: "operation_timeout",
  });
  expect(await state(created.database.id)).toEqual({
    desired_state: "running",
    suspension_reason: null,
    generation: 3,
    observed_power: "awake",
  });
});

const operationsOf = async (id: string) =>
  (
    await env.DB.prepare(
      "SELECT id,kind,status,error_code FROM operations WHERE database_id=? ORDER BY generation,id",
    )
      .bind(id)
      .all()
  ).results;
const epochOf = (id: string) =>
  env.DB.prepare(
    "SELECT admission_revision,route_revision,mutation_id FROM database_admission_epochs WHERE database_id=?",
  )
    .bind(id)
    .first();
/** What 21 quiet minutes do to the operations the database still waits for. */
const quiet = (id: string) =>
  env.DB.prepare(
    "UPDATE operations SET updated_at=? WHERE database_id=? AND status IN('pending','running')",
  )
    .bind(new Date(Date.now() - 21 * 60_000).toISOString(), id)
    .run();

it("reverts a timed-out resume once and then stops changing while the node never reports", async () => {
  const f = await resuming();
  // The resume times out and the database is suspended again: the one revert.
  expect((await runCron(env)).failed).toBe(1);
  const asleep = {
    desired_state: "suspended",
    suspension_reason: "manual",
    generation: 4,
    observed_power: "hibernated",
  };
  expect(await state(f.id)).toEqual(asleep);
  const operations = await operationsOf(f.id);
  const epoch = await epochOf(f.id);
  // The suspension it left is not proven either, but D1 knows the database asleep: nothing to
  // undo, so the suspension only fails and the database stays suspended, round after round.
  for (let round = 0; round < 4; round++) {
    await quiet(f.id);
    await runCron(env);
    expect(await state(f.id)).toEqual(asleep);
    expect(await operationsOf(f.id)).toHaveLength(operations.length);
    expect(await epochOf(f.id)).toEqual(epoch);
  }
  const final = await operationsOf(f.id);
  expect(final.at(-1)).toMatchObject({
    kind: "database.suspend",
    status: "failed",
    error_code: "operation_timeout",
  });
  expect(
    final.some((o) => o.status === "pending" || o.status === "running"),
  ).toBe(false);
  expect((await runCron(env)).failed).toBe(0);
});

it("keeps a hand-suspended idle sleeper suspended when the node never proves the suspension", async () => {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  const id = created.database.id;
  await report(f, id, 1);
  await report(f, id, 1, "asleep");
  const suspend = DatabaseWithOperation.parse(
    await (
      await request(`/v1/databases/${id}/suspend`, f.integrator, "POST")
    ).json(),
  );
  expect(await state(id)).toMatchObject({
    desired_state: "suspended",
    suspension_reason: "manual",
    observed_power: "hibernated",
  });
  const generation = (await state(id))!.generation;
  const operations = await operationsOf(id);
  const epoch = await epochOf(id);
  await quiet(id);
  expect((await runCron(env)).failed).toBe(1);
  expect(await outcome(suspend.operation.id)).toEqual({
    status: "failed",
    error_code: "operation_timeout",
  });
  expect(await state(id)).toMatchObject({
    desired_state: "suspended",
    suspension_reason: "manual",
    generation,
  });
  expect(await operationsOf(id)).toHaveLength(operations.length);
  expect(await epochOf(id)).toEqual(epoch);
});
