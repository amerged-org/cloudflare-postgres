// SPDX-License-Identifier: Apache-2.0
// The wake's last hop: a committed ready observation, its admission publish and the push that
// releases the waiting connection. Real D1 and Durable Object harness; no live evidence.
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { DatabaseRuntime, newOperationId } from "@pgcf/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { publishDatabaseAdmission } from "../../src/domain/database-admission-snapshot.ts";
import { admissionSnapshotFixture } from "./admission-snapshot-fixture.ts";
import {
  cleanupFixtures,
  nodeRequest,
  observationOf,
  report,
  reportBody,
} from "./fixtures.ts";
import {
  actor,
  parkPolling,
  registered,
  sleep,
  sleeping,
  untilWake,
} from "./wake-fixture.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
});
/** The node reports a database ready, without waiting for the work it leaves in the context. */
async function observe(
  f: Parameters<typeof nodeRequest>[0] & { id: string },
  generation: number,
  context: ExecutionContext,
): Promise<Response> {
  return nodeRequest(f, "/node/v1/observations", {
    method: "POST",
    body: reportBody([await observationOf(f.id, generation)]),
    context,
  });
}

/**
 * Holds every execution of the admission snapshot read (the publish's first D1 read) until
 * `release`, on every D1 binding of the isolate (the API request's and the Actor's alike).
 */
function holdSnapshotReads() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let held = 0,
    active = false;
  const prototype = Object.getPrototypeOf(env.DB) as D1Database;
  const original = prototype.prepare;
  vi.spyOn(prototype, "prepare").mockImplementation(function (
    this: D1Database,
    sql: string,
  ) {
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === "bind")
            return (...values: unknown[]) => wrap(target.bind(...values));
          if (
            property === "first" &&
            sql.startsWith("SELECT d.*,p.deleted_at project_deleted_at")
          )
            return async (...args: unknown[]) => {
              if (active) {
                held++;
                await gate;
              }
              return Reflect.apply(target.first, target, args);
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    return wrap(original.call(this, sql));
  });
  return {
    arm: () => {
      active = true;
    },
    held: () => held,
    release: () => open(),
  };
}

it("a transient read failure in the wake loop does not fail the waiting connection", async () => {
  const f = await sleeping();
  const waiterId = crypto.randomUUID();
  const waiting = actor(f.id).ensureAwake(f.id, "app", {
    waiterId,
    deadline: Date.now() + 15_000,
  });
  const row = await untilWake(f.id);
  await registered(f.id, waiterId);
  await parkPolling(f.id);
  // The next readiness read fails once, as a transient D1 error does; the wake is still in progress.
  const prototype = Object.getPrototypeOf(env.DB) as D1Database;
  const original = prototype.prepare;
  let failed = 0;
  vi.spyOn(prototype, "prepare").mockImplementation(function (
    this: D1Database,
    sql: string,
  ) {
    if (
      failed === 0 &&
      sql.startsWith("SELECT d.generation,d.power_operation")
    ) {
      failed++;
      throw new Error("D1_ERROR: Network connection lost");
    }
    return original.call(this, sql);
  });
  expect(await actor(f.id).observedReady(f.id, 3, row.power_operation)).toBe(
    true,
  );
  expect(
    await Promise.race([
      waiting.then(() => "settled"),
      sleep(400).then(() => "waiting"),
    ]),
  ).toBe("waiting");
  expect(failed).toBe(1);
  expect((await report(f, f.id, row.generation)).status).toBe(200);
  expect(await waiting).toMatchObject({ ok: true });
}, 30_000);

it("a ready observation is answered while its admission publish is still running", async () => {
  const f = await sleeping();
  const waiterId = crypto.randomUUID();
  const waiting = actor(f.id).ensureAwake(f.id, "app", {
    waiterId,
    deadline: Date.now() + 15_000,
  });
  const row = await untilWake(f.id);
  await registered(f.id, waiterId);
  const hold = holdSnapshotReads();
  hold.arm();
  const context = createExecutionContext();
  const response = observe(f, row.generation, context);
  const answered = await Promise.race([
    response.then((value) => value.status),
    sleep(3000).then(() => "stalled"),
  ]);
  expect(hold.held()).toBeGreaterThan(0);
  hold.release();
  await waitOnExecutionContext(context);
  expect(answered).toBe(200);
  expect(await waiting).toMatchObject({ ok: true });
}, 30_000);

it("a published snapshot of the wake's revision releases the waiting connection without another read", async () => {
  const f = await admissionSnapshotFixture();
  const sleepOperation = newOperationId(),
    sleepGeneration = f.generation + 1,
    at = new Date().toISOString();
  // Controlled committed sleep metadata, followed by the real Actor wake writer.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at,completed_at) VALUES(?,'database.hibernate','succeeded',?,?,?,?,?,?)",
    ).bind(sleepOperation, f.project, f.id, sleepGeneration, at, at, at),
    env.DB.prepare(
      "UPDATE databases SET desired_state='suspended',suspension_reason='idle',generation=?,observed_state='provisioning',observed_power='hibernated',observed_generation=?,power_operation=?,runtime_json=NULL WHERE id=?",
    ).bind(sleepGeneration, sleepGeneration, sleepOperation, f.id),
    env.DB.prepare(
      "UPDATE database_admission_epochs SET admission_revision=admission_revision+1,route_revision=route_revision+1 WHERE database_id=?",
    ).bind(f.id),
  ]);
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  const waiterId = crypto.randomUUID();
  const waiting = actor(f.id).ensureAwake(f.id, "reader", {
    waiterId,
    deadline: Date.now() + 15_000,
  });
  for (let i = 0; i < 400; i++) {
    const row = await env.DB.prepare(
      "SELECT d.desired_state,e.mutation_id FROM databases d JOIN database_admission_epochs e ON e.database_id=d.id WHERE d.id=?",
    )
      .bind(f.id)
      .first<{ desired_state: string; mutation_id: string | null }>();
    if (row?.desired_state === "running" && row.mutation_id === null) break;
    await sleep(5);
  }
  await registered(f.id, waiterId);
  await parkPolling(f.id);
  // The loop's next readiness read never returns: only the publish itself can release the waiter.
  const prototype = Object.getPrototypeOf(env.DB) as D1Database;
  const original = prototype.prepare;
  vi.spyOn(prototype, "prepare").mockImplementation(function (
    this: D1Database,
    sql: string,
  ) {
    const statement = original.call(this, sql);
    if (!sql.startsWith("SELECT d.generation,d.power_operation"))
      return statement;
    const wrap = (target: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(target, {
        get(inner, property) {
          if (property === "bind")
            return (...values: unknown[]) => wrap(inner.bind(...values));
          if (property === "first") return () => new Promise(() => undefined);
          const value = Reflect.get(inner, property);
          return typeof value === "function" ? value.bind(inner) : value;
        },
      });
    return wrap(statement);
  });
  const row = (await env.DB.prepare(
    "SELECT generation,power_operation FROM databases WHERE id=?",
  )
    .bind(f.id)
    .first<{ generation: number; power_operation: string }>())!;
  const runtime = DatabaseRuntime.parse({
    ...f.runtime,
    generation: row.generation,
    instance: crypto.randomUUID(),
    observed_at: Date.now(),
  });
  await env.DB.prepare(
    "UPDATE databases SET observed_state='ready',observed_power='awake',observed_generation=generation,runtime_json=? WHERE id=?",
  )
    .bind(JSON.stringify(runtime), f.id)
    .run();
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  const released = await Promise.race([
    waiting,
    sleep(2500).then(() => "held"),
  ]);
  expect(released).toMatchObject({
    ok: true,
    node: f.node,
    target: { revision: row.generation, instance: runtime.instance },
  });
}, 30_000);

it("a gate held for a second names its callback in the log", async () => {
  const f = await sleeping();
  // The claim's read of its sleeping intent stands for any slow read inside the Actor's gate.
  const read = holdRead(
    "SELECT id FROM operations WHERE id=? AND database_id=? AND project_id=? AND generation<=? AND kind='database.hibernate'",
  );
  const warnings: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...values: unknown[]) => {
    warnings.push(values.map(String).join(" "));
  });
  const waiting = actor(f.id).ensureAwake(f.id, "app", {
    deadline: Date.now() + 15_000,
  });
  for (let i = 0; i < 400 && read.held() === 0; i++) await sleep(5);
  expect(read.held()).toBe(1);
  // Another RPC that needs the gate waits behind the held callback.
  const waitStarted = Date.now();
  const victim = actor(f.id).repairAdmissionMutation();
  await sleep(1200);
  read.release();
  await victim;
  expect(Date.now() - waitStarted).toBeGreaterThanOrEqual(1000);
  const row = await untilWake(f.id);
  expect((await report(f, f.id, row.generation)).status).toBe(200);
  expect(await waiting).toMatchObject({ ok: true });
  const events = warnings
    .map((line) => {
      try {
        return JSON.parse(line) as {
          event: string;
          callback: string;
          ms: number;
        };
      } catch {
        return undefined;
      }
    })
    .filter((value) => value?.event === "actor_gate_held");
  expect(events).toEqual([
    expect.objectContaining({
      event: "actor_gate_held",
      callback: "claimWake",
    }),
  ]);
  expect(events[0]!.ms).toBeGreaterThanOrEqual(1000);
}, 30_000);

/** Holds every execution of one read until `release`, on every D1 binding of the isolate. */
function holdRead(prefix: string) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let held = 0;
  const prototype = Object.getPrototypeOf(env.DB) as D1Database;
  const original = prototype.prepare;
  vi.spyOn(prototype, "prepare").mockImplementation(function (
    this: D1Database,
    sql: string,
  ) {
    const statement = original.call(this, sql);
    if (!sql.startsWith(prefix)) return statement;
    const wrap = (target: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(target, {
        get(inner, property) {
          if (property === "bind")
            return (...values: unknown[]) => wrap(inner.bind(...values));
          if (property === "first")
            return async (...args: unknown[]) => {
              held++;
              await gate;
              return Reflect.apply(inner.first, inner, args);
            };
          const value = Reflect.get(inner, property);
          return typeof value === "function" ? value.bind(inner) : value;
        },
      });
    return wrap(statement);
  });
  return { held: () => held, release: () => open() };
}
