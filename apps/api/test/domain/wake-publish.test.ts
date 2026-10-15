// SPDX-License-Identifier: Apache-2.0
// The wake's last hop: a committed ready observation, its admission publish and the push that
// releases the waiting connection. Real D1 and Durable Object harness; no live evidence.
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { newOperationId } from "@pgcf/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.ts";
import { publishDatabaseAdmission } from "../../src/domain/database-admission-snapshot.ts";
import {
  admissionFixtureReleases,
  admissionSnapshotFixture,
} from "./admission-snapshot-fixture.ts";
import { cleanupFixtures, request } from "./fixtures.ts";
import {
  actor,
  parkPolling,
  readyBody,
  registered,
  sleep,
  sleeping,
  untilWake,
} from "./wake-fixture.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
  for (const id of admissionFixtureReleases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
/** Posts an observation without waiting for the work it leaves in the execution context. */
async function observe(
  agent: string,
  body: unknown,
  context: ExecutionContext,
): Promise<Response> {
  return createApp().fetch(
    new Request(
      `https://${["api", "invalid"].join(".")}/agent/v1/observations`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${agent}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    ),
    { ...env, DB_ENDPOINT_HOST: ["db", "invalid"].join(".") },
    context,
  );
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
  expect(
    (
      await request(
        "/agent/v1/observations",
        f.agent,
        "POST",
        readyBody(f, row.power_operation),
      )
    ).status,
  ).toBe(200);
  expect(await waiting).toMatchObject({ ok: true });
}, 30_000);

it("the push releases a waiting connection while the admission publish is still running", async () => {
  const f = await sleeping();
  const waiterId = crypto.randomUUID();
  const waiting = actor(f.id).ensureAwake(f.id, "app", {
    waiterId,
    deadline: Date.now() + 15_000,
  });
  const row = await untilWake(f.id);
  await registered(f.id, waiterId);
  await parkPolling(f.id);
  const hold = holdSnapshotReads();
  hold.arm();
  const context = createExecutionContext();
  const response = observe(f.agent, readyBody(f, row.power_operation), context);
  // The ready state is committed and the snapshot read is held: the Actor's readiness read alone
  // (this region has no snapshot cache) releases the connection, and it needs only the push.
  const released = await Promise.race([
    waiting.then((value) => value),
    sleep(2500).then(() => "held"),
  ]);
  // The publish reaches its held read right after the connection has been released.
  for (let i = 0; i < 400 && hold.held() === 0; i++) await sleep(5);
  expect(hold.held()).toBeGreaterThan(0);
  hold.release();
  await response;
  await waitOnExecutionContext(context);
  expect(released).toMatchObject({ ok: true });
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
  const response = observe(f.agent, readyBody(f, row.power_operation), context);
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
    sleepGeneration = f.proof.generation + 1,
    at = new Date().toISOString();
  // Controlled committed regional sleep metadata, followed by the real Actor wake writer.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at,completed_at) VALUES(?,'database.hibernate','succeeded',?,?,?,?,?,?)",
    ).bind(sleepOperation, f.project, f.id, sleepGeneration, at, at, at),
    env.DB.prepare(
      "UPDATE databases SET desired_state='suspended',suspension_reason='idle',generation=?,observed_state='provisioning',observed_power='hibernated',observed_generation=?,power_operation=?,runtime_attestation_json=NULL WHERE id=?",
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
  const epoch = (await env.DB.prepare(
    "SELECT admission_revision,route_revision FROM database_admission_epochs WHERE database_id=?",
  )
    .bind(f.id)
    .first<{ admission_revision: number; route_revision: number }>())!;
  const observedAt = Date.now();
  const proof = {
    ...f.proof,
    generation: row.generation,
    admission_epoch: epoch.admission_revision,
    route_revision: epoch.route_revision,
    pod_uid: crypto.randomUUID(),
    container_id: "b".repeat(64),
    observed_at: observedAt,
    observation: {
      ...f.proof.observation,
      verified_at: observedAt,
      expires_at: observedAt + 60000,
      watch_epoch: f.proof.observation.watch_epoch + 1,
    },
  };
  await env.DB.prepare(
    "UPDATE databases SET observed_state='ready',observed_power='awake',observed_generation=generation,runtime_attestation_json=? WHERE id=?",
  )
    .bind(JSON.stringify(proof), f.id)
    .run();
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  const released = await Promise.race([
    waiting,
    sleep(2500).then(() => "held"),
  ]);
  expect(released).toMatchObject({
    ok: true,
    target: { revision: row.generation, pod_uid: proof.pod_uid },
  });
}, 30_000);
