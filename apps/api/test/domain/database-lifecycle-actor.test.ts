// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import {
  DatabaseWithOperation,
  newDatabaseId,
  newOperationId,
} from "@pgcf/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { readDatabasePresence } from "../../src/domain/database-actor-sync.ts";
import {
  cleanupFixtures,
  fixture,
  request,
  observation,
  observedBody,
} from "./fixtures.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
});
const actor = (id: string) =>
  env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id));
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
  await actor(id).seed((await readDatabasePresence(env.DB, id))!);
  return { ...f, id };
}
async function idle(f: Awaited<ReturnType<typeof ready>>) {
  await env.DB.prepare(
    "UPDATE size_classes SET sleep_after_seconds=60 WHERE id=?",
  )
    .bind(f.size)
    .run();
  const now = new Date().toISOString();
  expect(
    await actor(f.id).recordActivity(f.id, {
      revision: 1,
      observed_at: now,
      last_activity_at: new Date(Date.now() - 120_000).toISOString(),
      active_connections: 0,
    }),
  ).toBe(true);
  const result = await actor(f.id).requestIdle(f.id, 1);
  expect(result.ok).toBe(true);
  const row = await env.DB.prepare(
    "SELECT generation,power_operation FROM databases WHERE id=?",
  )
    .bind(f.id)
    .first<{ generation: number; power_operation: string }>();
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(f.id, row!.generation, "hibernated"),
        power: {
          operation: row!.power_operation,
          revision: row!.generation,
          state: "hibernated",
        },
      },
    ]),
  );
}
async function untilWake(id: string, generation = 3) {
  for (let i = 0; i < 100; i++) {
    const row = await env.DB.prepare(
      "SELECT generation,power_operation,desired_state FROM databases WHERE id=?",
    )
      .bind(id)
      .first<{
        generation: number;
        power_operation: string;
        desired_state: string;
      }>();
    if (row?.desired_state === "running" && row.generation === generation)
      return row;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("wake_not_started");
}

async function registered(id: string, waiterId: string) {
  for (let i = 0; i < 200; i++) {
    if (
      await runInDurableObject(actor(id), (instance) =>
        Reflect.get(instance, "waiters").has(waiterId),
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waiter_not_registered");
}
/** Waits until the shared wake loop sleeps, then cancels its fallback timer: only a push resumes it. */
async function parkPolling(id: string) {
  for (let i = 0; i < 200; i++) {
    const parked = await runInDurableObject(actor(id), (instance) => {
      const timer = Reflect.get(instance, "pollTimer");
      if (timer === undefined) return false;
      clearTimeout(timer);
      return true;
    });
    if (parked) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("polling_not_parked");
}
/**
 * Counts the wake loop's readiness reads; with `hold`, each executed read's result waits for
 * `release`. The gates are created here, outside the actor, which may only await them.
 */
async function pollReads(id: string, hold = false) {
  let reads = 0,
    executed = 0,
    released = 0;
  const gates = Array.from({ length: 4 }, () => {
    let open!: () => void;
    const gate = new Promise<void>((done) => {
      open = done;
    });
    return { gate, open };
  });
  await runInDurableObject(actor(id), (instance) => {
    const db = (instance as unknown as { env: { DB: D1Database } }).env.DB;
    const original = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((query: string) => {
      const statement = original(query);
      if (!query.startsWith("SELECT d.generation,d.power_operation"))
        return statement;
      reads++;
      if (!hold) return statement;
      const bind = statement.bind.bind(statement);
      vi.spyOn(statement, "bind").mockImplementation((...values) => {
        const bound = bind(...values);
        const first = bound.first.bind(bound);
        vi.spyOn(bound, "first").mockImplementation(async (...columns) => {
          const result = await first(...columns);
          await gates[executed++]!.gate;
          return result;
        });
        return bound;
      });
      return statement;
    });
  });
  const executedAll = async (count: number) => {
    for (let i = 0; i < 200 && executed < count; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(executed).toBe(count);
  };
  return {
    reads: () => reads,
    /** Waits until `count` reads have executed and are held. */
    executed: executedAll,
    /** Returns the oldest held read's result to the loop. */
    release: async () => {
      await executedAll(released + 1);
      gates[released++]!.open();
    },
  };
}
function awake(f: Awaited<ReturnType<typeof ready>>, operation: string) {
  return request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(f.id, 3),
        power: { operation, revision: 3, state: "awake" },
      },
    ]),
  );
}

it("a committed ready observation releases a waiting wake at once, without its fallback read", async () => {
  const f = await ready();
  await idle(f);
  const waiterId = crypto.randomUUID();
  const pending = actor(f.id).ensureAwake(f.id, "app", {
    waiterId,
    deadline: Date.now() + 3000,
  });
  const row = await untilWake(f.id);
  await registered(f.id, waiterId);
  await parkPolling(f.id);
  await awake(f, row.power_operation);
  expect(await pending).toMatchObject({ ok: true });
});

it("only the waiting wake's push reads D1 at once, and a push ahead of the commit keeps waiting", async () => {
  const f = await ready();
  await idle(f);
  const waiterId = crypto.randomUUID();
  let settled = false;
  const pending = actor(f.id)
    .ensureAwake(f.id, "app", { waiterId, deadline: Date.now() + 3000 })
    .finally(() => {
      settled = true;
    });
  const row = await untilWake(f.id);
  await registered(f.id, waiterId);
  await parkPolling(f.id);
  const { reads } = await pollReads(f.id);
  for (const [revision, operation] of [
    [2, row.power_operation],
    [3, newOperationId()],
    [3, null],
  ] as const)
    expect(await actor(f.id).observedReady(f.id, revision, operation)).toBe(
      false,
    );
  expect(reads()).toBe(0);
  // The exact push reads D1 at once; readiness is not committed there yet, so the waiter waits.
  expect(await actor(f.id).observedReady(f.id, 3, row.power_operation)).toBe(
    true,
  );
  await parkPolling(f.id);
  expect(reads()).toBe(1);
  expect(settled).toBe(false);
  expect(
    await runInDurableObject(actor(f.id), (instance) =>
      Reflect.get(instance, "waiters").has(waiterId),
    ),
  ).toBe(true);
  await awake(f, row.power_operation);
  expect(await pending).toMatchObject({ ok: true });
  expect(reads()).toBe(2);
});

it("a push during the loop's not-ready read makes it read again without sleeping", async () => {
  const f = await ready();
  await idle(f);
  const waiterId = crypto.randomUUID();
  const pending = actor(f.id).ensureAwake(f.id, "app", {
    waiterId,
    deadline: Date.now() + 3000,
  });
  const row = await untilWake(f.id);
  await registered(f.id, waiterId);
  await parkPolling(f.id);
  const poll = await pollReads(f.id, true);
  const push = () => actor(f.id).observedReady(f.id, 3, row.power_operation);
  expect(await push()).toBe(true);
  await poll.executed(1);
  // Readiness commits and its push arrives while the first read still holds the older row.
  await env.DB.prepare(
    "UPDATE databases SET observed_state='ready',observed_power='awake',observed_generation=generation WHERE id=?",
  )
    .bind(f.id)
    .run();
  expect(await push()).toBe(true);
  await poll.release();
  const timer = () =>
    runInDurableObject(actor(f.id), (instance) =>
      Reflect.get(instance, "pollTimer"),
    );
  for (let i = 0; i < 200 && poll.reads() < 2 && !(await timer()); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(poll.reads()).toBe(2);
  expect(await timer()).toBeUndefined();
  await poll.release();
  expect(await pending).toMatchObject({ ok: true });
});

it("the bounded fallback read still releases a waiter whose push was lost", async () => {
  const f = await ready();
  await idle(f);
  const waiterId = crypto.randomUUID();
  const pending = actor(f.id).ensureAwake(f.id, "app", {
    waiterId,
    deadline: Date.now() + 4000,
  });
  await untilWake(f.id);
  await registered(f.id, waiterId);
  await env.DB.prepare(
    "UPDATE databases SET observed_state='ready',observed_power='awake',observed_generation=generation WHERE id=?",
  )
    .bind(f.id)
    .run();
  expect(await pending).toMatchObject({ ok: true });
});

it("admits an already-ready route with one fresh authoritative read", async () => {
  const f = await ready();
  const prepare = vi.spyOn(Object.getPrototypeOf(env.DB), "prepare");
  expect(await actor(f.id).ensureAwake(f.id, "app")).toEqual({
    ok: true,
    region: {
      id: f.region,
      gateway_url: `https://${["gateway", "invalid"].join(".")}`,
      gateway_binding: null,
    },
  });
  expect(prepare).toHaveBeenCalledTimes(1);
});

it("does not wake for a role revoked after the authorization read", async () => {
  const f = await ready();
  await idle(f);
  const prototype = Object.getPrototypeOf(env.DB) as D1Database;
  const original = prototype.prepare;
  let reads = 0;
  vi.spyOn(prototype, "prepare").mockImplementation(function (
    this: D1Database,
    sql: string,
  ) {
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === "bind")
            return (...values: unknown[]) => wrap(target.bind(...values));
          if (property === "first" && sql.includes("r.name role_name"))
            return async (...args: unknown[]) => {
              const result = await Reflect.apply(target.first, target, args);
              if (++reads === 2) {
                const now = new Date().toISOString();
                await env.DB.batch([
                  original
                    .call(
                      env.DB,
                      "UPDATE roles SET deleted_at=? WHERE database_id=? AND name='app'",
                    )
                    .bind(now, f.id),
                  original
                    .call(
                      env.DB,
                      "UPDATE databases SET generation=generation+1,updated_at=? WHERE id=?",
                    )
                    .bind(now, f.id),
                ]);
              }
              return result;
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    return wrap(original.call(this, sql));
  });
  expect(
    await actor(f.id).ensureAwake(f.id, "app", { deadline: Date.now() + 1000 }),
    // The barrier's trusted publication now removes the revoked role from presence too.
  ).toEqual({ ok: false, sqlstate: "28P01" });
  expect(
    await env.DB.prepare(
      "SELECT desired_state,generation FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ desired_state: "suspended", generation: 3 });
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM operations WHERE database_id=? AND kind='database.wake'",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(0);
});

it("rejects a duplicate waiter without cancelling its original connection", async () => {
  const f = await ready();
  await idle(f);
  const waiterId = crypto.randomUUID();
  const first = actor(f.id).ensureAwake(f.id, "app", {
    waiterId,
    deadline: Date.now() + 4000,
  });
  const row = await untilWake(f.id);
  for (let i = 0; i < 100; i++) {
    if (
      await runInDurableObject(actor(f.id), (instance) =>
        Reflect.get(instance, "waiters").has(waiterId),
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(
    await runInDurableObject(actor(f.id), (instance) =>
      Reflect.get(instance, "waiters").has(waiterId),
    ),
  ).toBe(true);
  expect(
    await actor(f.id).ensureAwake(f.id, "app", {
      waiterId,
      deadline: Date.now() + 4000,
    }),
  ).toEqual({ ok: false, sqlstate: "57P03" });
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(f.id, 3),
        power: { operation: row.power_operation, revision: 3, state: "awake" },
      },
    ]),
  );
  expect((await first).ok).toBe(true);
});

it("coalesces ten idle wake waiters into one durable operation and hint, releasing only exact readiness", async () => {
  const f = await ready();
  await idle(f);
  const notify = await runInDurableObject(
    env.REGION_LINK.get(env.REGION_LINK.idFromName(f.region)),
    (instance) => vi.spyOn(Object.getPrototypeOf(instance), "notify"),
  );
  const waits = Array.from({ length: 10 }, () =>
    actor(f.id).ensureAwake(f.id, "app", { deadline: Date.now() + 4000 }),
  );
  const row = await untilWake(f.id);
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([observation(f.id, 3)]),
  );
  expect(
    await env.DB.prepare("SELECT observed_state FROM databases WHERE id=?")
      .bind(f.id)
      .first("observed_state"),
  ).toBe("provisioning");
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(f.id, 3),
        power: { operation: row.power_operation, revision: 3, state: "awake" },
      },
    ]),
  );
  expect((await Promise.all(waits)).every((value) => value.ok)).toBe(true);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM operations WHERE database_id=? AND kind='database.wake'",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(1);
  const stored = await runInDurableObject(actor(f.id), (_instance, state) =>
    state.storage.sql.exec("SELECT * FROM database_wake").toArray(),
  );
  expect(stored[0]!.operation).toBe(row.power_operation);
});

it("keeps the negative filter and manual suspension refusal without any wake", async () => {
  const id = newDatabaseId();
  const prepare = vi.spyOn(Object.getPrototypeOf(env.DB), "prepare");
  expect(await actor(id).ensureAwake(id, "app")).toEqual({
    ok: false,
    sqlstate: "3D000",
  });
  expect(prepare).not.toHaveBeenCalled();
  prepare.mockRestore();
  const f = await ready();
  const count = vi.spyOn(Object.getPrototypeOf(env.DB), "prepare");
  expect(await actor(f.id).ensureAwake(f.id, "unknown")).toEqual({
    ok: false,
    sqlstate: "28P01",
  });
  expect(count).not.toHaveBeenCalled();
  count.mockRestore();
  await request(`/v1/databases/${f.id}/suspend`, f.integrator, "POST");
  expect(await actor(f.id).ensureAwake(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM operations WHERE database_id=? AND kind='database.wake'",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(0);
});

it("recovers the persisted wake after eviction without duplicating the operation or hint", async () => {
  const f = await ready();
  await idle(f);
  expect(
    await actor(f.id).ensureAwake(f.id, "app", { deadline: Date.now() + 25 }),
  ).toEqual({ ok: false, sqlstate: "57P03" });
  const waiterId = crypto.randomUUID();
  const priming = actor(f.id).ensureAwake(f.id, "app", {
    deadline: Date.now() + 3000,
    waiterId,
  });
  const row = await untilWake(f.id);
  await actor(f.id).cancelWakeWaiter(f.id, waiterId);
  expect(await priming).toEqual({ ok: false, sqlstate: "57P03" });
  await evictDurableObject(actor(f.id));
  const pending = actor(f.id).ensureAwake(f.id, "app", {
    deadline: Date.now() + 3000,
  });
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(f.id, 3),
        power: { operation: row.power_operation, revision: 3, state: "awake" },
      },
    ]),
  );
  expect((await pending).ok).toBe(true);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM operations WHERE database_id=? AND kind='database.wake'",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(1);
});

it("expires or cancels waiters and stops shared polling when the final waiter leaves", async () => {
  const f = await ready();
  await idle(f);
  const waiterId = crypto.randomUUID();
  const pending = actor(f.id).ensureAwake(f.id, "app", {
    deadline: Date.now() + 3000,
    waiterId,
  });
  await untilWake(f.id);
  expect(await actor(f.id).cancelWakeWaiter(f.id, waiterId)).toBe(true);
  expect(await pending).toEqual({ ok: false, sqlstate: "57P03" });
  expect(
    await actor(f.id).ensureAwake(f.id, "app", { deadline: Date.now() - 1 }),
  ).toEqual({ ok: false, sqlstate: "57P03" });
  await runInDurableObject(actor(f.id), (instance) =>
    expect(
      (instance as unknown as { waiters: Map<string, unknown> }).waiters.size,
    ).toBe(0),
  );
});

it("requires fresh authenticated zero-connection activity and an enabled idle threshold", async () => {
  const f = await ready();
  expect(await actor(f.id).requestIdle(f.id, 1)).toEqual({
    ok: false,
    reason: "activity_unavailable",
  });
  const now = new Date().toISOString();
  expect(
    await actor(f.id).recordActivity(f.id, {
      revision: 2,
      observed_at: now,
      last_activity_at: now,
      active_connections: 0,
    }),
  ).toBe(false);
  expect(
    await actor(f.id).recordActivity(f.id, {
      revision: 1,
      observed_at: new Date(Date.now() - 60_000).toISOString(),
      last_activity_at: now,
      active_connections: 0,
    }),
  ).toBe(false);
  expect(
    await actor(f.id).recordActivity(f.id, {
      revision: 1,
      observed_at: now,
      last_activity_at: now,
      active_connections: 1,
    }),
  ).toBe(true);
  expect(await actor(f.id).requestIdle(f.id, 1)).toEqual({
    ok: false,
    reason: "not_idle",
  });
  expect(
    await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
      .bind(f.id)
      .first("generation"),
  ).toBe(1);
});

it("current role revocation rejects a waiting caller even after an exact ready observation", async () => {
  const f = await ready();
  await idle(f);
  const pending = actor(f.id).ensureAwake(f.id, "app", {
    deadline: Date.now() + 3000,
  });
  const row = await untilWake(f.id);
  await env.DB.prepare(
    "UPDATE roles SET deleted_at=? WHERE database_id=? AND name='app'",
  )
    .bind(new Date().toISOString(), f.id)
    .run();
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(f.id, 3),
        power: { operation: row.power_operation, revision: 3, state: "awake" },
      },
    ]),
  );
  expect(await pending).toEqual({ ok: false, sqlstate: "28P01" });
});

it("a superseding configuration generation cannot release an old wake", async () => {
  const f = await ready();
  await idle(f);
  const pending = actor(f.id).ensureAwake(f.id, "app", {
    deadline: Date.now() + 3000,
  });
  const row = await untilWake(f.id);
  await env.DB.prepare(
    "UPDATE databases SET generation=generation+1,observed_state='ready',observed_generation=generation+1 WHERE id=?",
  )
    .bind(f.id)
    .run();
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(f.id, 3),
        power: { operation: row.power_operation, revision: 3, state: "awake" },
      },
    ]),
  );
  expect(await pending).toEqual({ ok: false, sqlstate: "57P03" });
  expect(
    await env.DB.prepare("SELECT status FROM operations WHERE id=?")
      .bind(row.power_operation)
      .first("status"),
  ).toBe("pending");
});

it("reconciles a committed wake after its D1 response is lost without repeating the mutation", async () => {
  const f = await ready();
  await idle(f);
  await runInDurableObject(actor(f.id), async (instance) => {
    const db = (instance as unknown as { env: { DB: D1Database } }).env.DB;
    const original = db.batch.bind(db);
    const batch = vi
      .spyOn(db, "batch")
      .mockImplementationOnce(async (statements) => {
        await original(statements);
        throw new Error("lost_response");
      });
    try {
      expect(await instance.ensureAwake(f.id, "app")).toEqual({
        ok: false,
        sqlstate: "08006",
      });
    } finally {
      batch.mockRestore();
    }
  });
  const row = await untilWake(f.id);
  await evictDurableObject(actor(f.id));
  const pending = actor(f.id).ensureAwake(f.id, "app", {
    deadline: Date.now() + 3000,
  });
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(f.id, 3),
        power: { operation: row.power_operation, revision: 3, state: "awake" },
      },
    ]),
  );
  expect((await pending).ok).toBe(true);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM operations WHERE database_id=? AND kind='database.wake'",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(1);
});

it("a deadline bounds even a stalled authoritative read without manufacturing readiness", async () => {
  const f = await ready();
  await runInDurableObject(actor(f.id), async (instance) => {
    const db = (instance as unknown as { env: { DB: D1Database } }).env.DB;
    const original = db.prepare.bind(db);
    let resolve: (() => void) | undefined;
    const held = new Promise<void>((done) => {
      resolve = done;
    });
    const prepare = vi.spyOn(db, "prepare").mockImplementation((query) => {
      const statement = original(query);
      if (query.includes("role_name")) {
        const bind = statement.bind.bind(statement);
        vi.spyOn(statement, "bind").mockImplementation((...args) => {
          const bound = bind(...args);
          const first = bound.first.bind(bound);
          vi.spyOn(bound, "first").mockImplementation(async (...fields) => {
            await held;
            return first(...fields);
          });
          return bound;
        });
      }
      return statement;
    });
    try {
      expect(
        await instance.ensureAwake(f.id, "app", { deadline: Date.now() + 25 }),
      ).toEqual({ ok: false, sqlstate: "57P03" });
    } finally {
      resolve!();
      prepare.mockRestore();
    }
  });
});

it("an idle connect supersedes an unknown pending shutdown without claiming it awake", async () => {
  const f = await ready();
  await env.DB.prepare(
    "UPDATE size_classes SET sleep_after_seconds=60 WHERE id=?",
  )
    .bind(f.size)
    .run();
  const now = new Date().toISOString();
  await actor(f.id).recordActivity(f.id, {
    revision: 1,
    observed_at: now,
    last_activity_at: new Date(Date.now() - 120000).toISOString(),
    active_connections: 0,
  });
  const sleep = await actor(f.id).requestIdle(f.id, 1);
  expect(sleep.ok).toBe(true);
  const pending = actor(f.id).ensureAwake(f.id, "app", {
    deadline: Date.now() + 3000,
  });
  const row = await untilWake(f.id);
  expect(
    await env.DB.prepare("SELECT observed_state FROM databases WHERE id=?")
      .bind(f.id)
      .first("observed_state"),
  ).toBe("provisioning");
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(f.id, 3),
        power: { operation: row.power_operation, revision: 3, state: "awake" },
      },
    ]),
  );
  expect((await pending).ok).toBe(true);
});

it("manual suspension can claim an already verified idle sleeper and keeps connect auto-wake disabled", async () => {
  const f = await ready();
  await idle(f);
  const response = await request(
    `/v1/databases/${f.id}/suspend`,
    f.integrator,
    "POST",
  );
  expect(response.status).toBe(202);
  const suspended = DatabaseWithOperation.parse(await response.json());
  expect(suspended.database.suspension_reason).toBe("manual");
  expect(suspended.database.generation).toBe(3);
  expect(await actor(f.id).ensureAwake(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
});

it("a current password revision on an idle sleeper advances configuration without disabling wake", async () => {
  const f = await ready();
  await idle(f);
  expect(
    (
      await request(
        `/v1/databases/${f.id}/roles/app/reset-password`,
        f.integrator,
        "POST",
      )
    ).status,
  ).toBe(200);
  expect(
    await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
      .bind(f.id)
      .first("generation"),
  ).toBe(3);
  const pending = actor(f.id).ensureAwake(f.id, "app", {
    deadline: Date.now() + 3000,
  });
  const row = await untilWake(f.id, 4);
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(f.id, 4),
        power: { operation: row.power_operation, revision: 4, state: "awake" },
      },
    ]),
  );
  expect((await pending).ok).toBe(true);
});

it("wake_timing_events_name_the_database_and_the_wake_operation", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const f = await ready();
  await idle(f);
  const waiterId = crypto.randomUUID();
  const pending = actor(f.id).ensureAwake(f.id, "app", {
    waiterId,
    deadline: Date.now() + 3000,
  });
  const row = await untilWake(f.id);
  await registered(f.id, waiterId);
  await awake(f, row.power_operation);
  expect(await pending).toMatchObject({ ok: true });
  expect((await request("/agent/v1/desired", f.agent)).status).toBe(200);
  const events = log.mock.calls.flatMap(([value]) => {
    try {
      return typeof value === "string"
        ? [JSON.parse(value) as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });
  const named = (event: string) => events.filter((e) => e.event === event);
  const key = { database_id: f.id, operation: row.power_operation };
  expect(named("actor_claim")).toEqual([
    expect.objectContaining({
      ...key,
      revision: row.generation,
      at_ms: expect.any(Number),
      claim_ms: expect.any(Number),
      hint_ms: expect.any(Number),
    }),
  ]);
  expect(
    named("observation_commit").find(
      (e) => e.state === "ready" && e.operation === row.power_operation,
    ),
  ).toMatchObject({
    ...key,
    at_ms: expect.any(Number),
    d1_ms: expect.any(Number),
    publish_ms: expect.any(Number),
    push_ms: expect.any(Number),
  });
  expect(named("actor_release")).toEqual([
    expect.objectContaining({
      ...key,
      at_ms: expect.any(Number),
      waited_ms: expect.any(Number),
      via: expect.stringMatching(/^(push|poll)$/),
    }),
  ]);
  expect(named("desired_page").at(-1)).toMatchObject({
    at_ms: expect.any(Number),
    elapsedMs: expect.any(Number),
    databases: expect.any(Number),
  });
  // The events never carry credentials or tokens.
  const serialized = JSON.stringify(events);
  expect(serialized).not.toContain(f.agent);
});
