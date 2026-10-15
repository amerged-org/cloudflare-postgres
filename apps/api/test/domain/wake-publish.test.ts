// SPDX-License-Identifier: Apache-2.0
// The wake's last hop: a committed ready observation, its admission publish and the push that
// releases the waiting connection. Real D1 and Durable Object harness; no live evidence.
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.ts";
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
});
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
  const response = createApp().fetch(
    new Request(
      `https://${["api", "invalid"].join(".")}/agent/v1/observations`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${f.agent}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(readyBody(f, row.power_operation)),
      },
    ),
    { ...env, DB_ENDPOINT_HOST: ["db", "invalid"].join(".") },
    context,
  );
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
  const response = createApp().fetch(
    new Request(
      `https://${["api", "invalid"].join(".")}/agent/v1/observations`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${f.agent}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(readyBody(f, row.power_operation)),
      },
    ),
    { ...env, DB_ENDPOINT_HOST: ["db", "invalid"].join(".") },
    context,
  );
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
