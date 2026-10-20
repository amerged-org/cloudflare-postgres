// SPDX-License-Identifier: Apache-2.0
// The ActorWarmer keeps every DatabaseActor's isolate loaded with a visit (`DatabaseActor.warm`)
// at least every ten seconds, so that the first admission after a quiet period does not pay for a
// cold actor. Real D1 and Durable Object harness: the visits are real RPCs to real actors and the
// alarms are the runtime's.
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { DatabaseWithOperation, newDatabaseId } from "@pgcf/contracts";
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  ACTOR_WARM_LEASE_MS,
  ARM_TIMEOUT_MS,
  ACTOR_WARM_LIST_TTL_MS,
  actorWarmRange,
  actorWarmer,
  armActorWarmers,
  warmCycle,
} from "../../src/domain/actor-warm.ts";
import { runCron } from "../../src/cron.ts";
import type { Env } from "../../src/env.ts";
import { cleanupFixtures, fixture } from "./fixtures.ts";

const INTERVAL = 8000;
const on = (change: Partial<Record<keyof Env, unknown>> = {}) =>
  ({
    ...env,
    DATABASE_ACTOR_WARM_INTERVAL_MS: String(INTERVAL),
    ...change,
  }) as Env;
const SHARDS_TO_CLEAN = 4;
async function reset() {
  for (let shard = 0; shard < SHARDS_TO_CLEAN; shard++)
    await runInDurableObject(
      actorWarmer(env, shard),
      async (instance, state) => {
        await state.storage.deleteAlarm();
        await state.storage.deleteAll();
        Reflect.set(instance, "config", undefined);
        Reflect.set(instance, "cache", {});
      },
    );
}
beforeEach(reset);
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
  await cleanupFixtures();
});

const alarmOf = (shard: number) =>
  runInDurableObject(actorWarmer(env, shard), (_i, state) =>
    state.storage.getAlarm(),
  );
const configOf = (shard: number) =>
  runInDurableObject(actorWarmer(env, shard), (_i, state) =>
    state.storage.get("config"),
  );
const actorKey = (database: string) =>
  env.DATABASE_ACTOR.idFromName(database).toString();
const keys = (databases: string[]) => new Set(databases.map(actorKey));

/** `count` databases in one project, which D1 lists as live. */
async function databases(count: number) {
  const f = await fixture();
  const ids: string[] = [];
  for (let index = 0; index < count; index++)
    ids.push(
      DatabaseWithOperation.parse(
        await (await f.create(`database-${index}`)).json(),
      ).database.id,
    );
  return ids;
}
/**
 * Records which actors a visit reaches (by the id of the object that answers it), and lets one
 * test make a visit fail or take long. The visit itself is the real RPC.
 */
async function recordVisits(
  anyDatabase: string,
  behave: (database: string) => Promise<void> | undefined = () => undefined,
) {
  const visited: string[] = [];
  const byKey = new Map<string, string>();
  await runInDurableObject(
    env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(anyDatabase)),
    (instance) => {
      const prototype = Object.getPrototypeOf(instance) as {
        warm(): void;
      };
      vi.spyOn(prototype, "warm").mockImplementation(function (this: {
        ctx: DurableObjectState;
      }) {
        const key = this.ctx.id.toString();
        visited.push(key);
        return behave(byKey.get(key) ?? key) as unknown as void;
      });
    },
  );
  return {
    visited,
    /** Names the databases whose visits `behave` may judge. */
    know: (ids: string[]) => ids.forEach((id) => byKey.set(actorKey(id), id)),
  };
}
const cycleLines = (log: MockInstance) =>
  log.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes("actor_warm"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const d1Lists = (prepare: MockInstance) =>
  prepare.mock.calls.filter((call) => String(call[0]).includes("SELECT d.id"))
    .length;

/** Whether `id` is in shard `shard` of `shards`. */
const inShard = (id: string, shard: number, shards: number) => {
  const { after, upto } = actorWarmRange(shard, shards);
  return id > after && (upto === null || id <= upto);
};

it("splits the id space into ranges that follow each other with no gap and no overlap, so every id is in exactly one shard, and spreads random ids evenly", () => {
  expect(actorWarmRange(0, 1)).toEqual({ after: "", upto: null });
  for (const shards of [2, 3, 7, 40, 200]) {
    const ranges = Array.from({ length: shards }, (_unused, shard) =>
      actorWarmRange(shard, shards),
    );
    expect(ranges[0]!.after).toBe("");
    expect(ranges.at(-1)!.upto).toBeNull();
    for (let shard = 1; shard < shards; shard++) {
      // The upper end of a range is the lower end of the next: no id falls between them.
      expect(ranges[shard - 1]!.upto).toBe(ranges[shard]!.after);
      // And they increase, in the byte order of D1's index.
      expect(ranges[shard]!.after > ranges[shard - 1]!.after).toBe(true);
    }
  }
  const ids = Array.from({ length: 7000 }, newDatabaseId);
  const counts = new Array<number>(7).fill(0);
  for (const id of ids) {
    const shards = [0, 1, 2, 3, 4, 5, 6].filter((shard) =>
      inShard(id, shard, 7),
    );
    expect(shards).toHaveLength(1);
    counts[shards[0]!]!++;
  }
  for (const count of counts) expect(Math.abs(count - 1000)).toBeLessThan(150);
  // The first and the last id of the alphabet, and the ids next to a boundary.
  const edges = [
    "a" + "0".repeat(19),
    "z" + "z".repeat(19),
    ...[3, 40].flatMap((shards) =>
      Array.from({ length: shards - 1 }, (_unused, k) => {
        const boundary = actorWarmRange(k + 1, shards).after;
        return [boundary + "0".repeat(17), boundary + "z".repeat(17)];
      }).flat(),
    ),
  ];
  for (const id of edges)
    for (const shards of [3, 40])
      expect(
        Array.from({ length: shards }, (_unused, shard) => shard).filter(
          (shard) => inShard(id, shard, shards),
        ),
      ).toHaveLength(1);
  // Every shard of 200 holds ids of the whole 7000: no range is empty, none holds a tenth of them.
  const wide = new Array<number>(200).fill(0);
  for (const id of Array.from({ length: 20000 }, newDatabaseId))
    for (let shard = 0; shard < 200; shard++)
      if (inShard(id, shard, 200)) wide[shard]!++;
  expect(wide.reduce((sum, count) => sum + count, 0)).toBe(20000);
  expect(Math.min(...wide)).toBeGreaterThan(50);
  expect(Math.max(...wide)).toBeLessThan(160);
});

it("a cycle visits every database of its shard once, and no other, within the interval, and logs one line", async () => {
  const ids = await databases(4);
  const log = vi.spyOn(console, "log");
  const visits = await recordVisits(ids[0]!);
  const seen: string[] = [];
  for (let shard = 0; shard < 3; shard++) {
    visits.visited.length = 0;
    const expected = ids.filter((id) => inShard(id, shard, 3));
    const result = await warmCycle(
      env,
      { shard, shards: 3, interval_ms: INTERVAL },
      {},
      Date.now(),
    );
    expect([...visits.visited].sort()).toEqual([...keys(expected)].sort());
    expect(result).toMatchObject({
      shard,
      shards: 3,
      databases: expected.length,
      visited: expected.length,
      failed: 0,
      overrun: false,
      list_error: null,
    });
    expect(result.cycle_ms).toBeLessThan(INTERVAL);
    seen.push(...expected);
  }
  // Every database was in exactly one shard.
  expect([...seen].sort()).toEqual([...ids].sort());
  // One line per cycle, never one per visit.
  const lines = cycleLines(log);
  expect(lines.map((line) => line.event)).toEqual([
    "actor_warm_cycle",
    "actor_warm_cycle",
    "actor_warm_cycle",
  ]);
  expect(lines[0]).toEqual({
    event: "actor_warm_cycle",
    shard: 0,
    shards: 3,
    databases: expect.any(Number),
    visited: expect.any(Number),
    failed: 0,
    cycle_ms: expect.any(Number),
    interval_ms: INTERVAL,
    overrun: false,
    list_error: null,
  });
});

it("reads the list of databases again only after its time to live, and a deleted database or project stops being visited", async () => {
  const [kept, deleted] = await databases(2);
  const [orphan] = await databases(1);
  const at = Date.now();
  const prepare = vi.spyOn(Object.getPrototypeOf(env.DB), "prepare");
  const visits = await recordVisits(kept!);
  const cache = {};
  const cycle = async (now: number) => {
    visits.visited.length = 0;
    await warmCycle(
      env,
      { shard: 0, shards: 1, interval_ms: INTERVAL },
      cache,
      now,
    );
    return new Set(visits.visited);
  };
  const everything = keys([kept!, deleted!, orphan!]);
  const listsBefore = d1Lists(prepare);
  expect(await cycle(at)).toEqual(everything);
  expect(d1Lists(prepare) - listsBefore).toBe(1);
  const when = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE databases SET desired_state='deleted',deleted_at=? WHERE id=?",
    ).bind(when, deleted!),
    env.DB.prepare(
      "UPDATE projects SET deleted_at=? WHERE id=(SELECT project_id FROM databases WHERE id=?)",
    ).bind(when, orphan!),
  ]);
  // Within the time to live the cached list is visited and D1 is not read.
  const reads = d1Lists(prepare);
  expect(await cycle(at + ACTOR_WARM_LIST_TTL_MS - 1)).toEqual(everything);
  expect(d1Lists(prepare)).toBe(reads);
  // After it the list is read again, and only the live database of a live project is visited.
  expect(await cycle(at + ACTOR_WARM_LIST_TTL_MS)).toEqual(keys([kept!]));
  expect(d1Lists(prepare)).toBe(reads + 1);
});

it("a visit that fails or times out does not stop the cycle", async () => {
  const ids = await databases(3);
  const visits = await recordVisits(ids[0]!, (database) => {
    if (database === ids[0]) throw new Error("actor_unreachable");
    if (database === ids[1])
      return new Promise<void>((resolve) => setTimeout(resolve, 1500));
    return undefined;
  });
  visits.know(ids);
  const result = await warmCycle(
    env,
    { shard: 0, shards: 1, interval_ms: INTERVAL },
    {},
    Date.now(),
    { visitTimeoutMs: 200 },
  );
  // All three were tried; the one that threw and the one that hung are failures, the third a visit.
  expect(new Set(visits.visited)).toEqual(keys(ids));
  expect(result).toMatchObject({ databases: 3, visited: 1, failed: 2 });
  expect(result.cycle_ms).toBeLessThan(1200);
});

it("keeps visiting the last list it read when D1 cannot be read, and visits nothing when it never had one", async () => {
  const ids = await databases(2);
  const visits = await recordVisits(ids[0]!);
  const cache = {};
  const target = { shard: 0, shards: 1, interval_ms: INTERVAL };
  const at = Date.now();
  await warmCycle(env, target, cache, at);
  expect(new Set(visits.visited)).toEqual(keys(ids));
  visits.visited.length = 0;
  vi.spyOn(Object.getPrototypeOf(env.DB), "prepare").mockImplementation(() => {
    throw new Error("d1_unavailable");
  });
  const stale = await warmCycle(
    env,
    target,
    cache,
    at + ACTOR_WARM_LIST_TTL_MS,
  );
  expect(new Set(visits.visited)).toEqual(keys(ids));
  expect(stale).toMatchObject({
    visited: 2,
    failed: 0,
    list_error: "d1_unavailable",
  });
  visits.visited.length = 0;
  const none = await warmCycle(env, target, {}, at);
  expect(visits.visited).toEqual([]);
  expect(none).toMatchObject({ databases: 0, list_error: "d1_unavailable" });
});

const ONE_SHARD = { shard: 0, shards: 1, interval_ms: INTERVAL };

it("a cycle with fewer workers than databases still visits every database exactly once", async () => {
  const ids = await databases(7);
  const visits = await recordVisits(ids[0]!);
  for (const concurrency of [1, 2, 3, 6, 7, 16]) {
    visits.visited.length = 0;
    const result = await warmCycle(env, ONE_SHARD, {}, Date.now(), {
      concurrency,
    });
    // Sorted lists, so that a skipped id and a repeated one both fail.
    expect([...visits.visited].sort()).toEqual([...keys(ids)].sort());
    expect(result).toMatchObject({ databases: 7, visited: 7, failed: 0 });
  }
});

it("reads a list longer than a page in pages and visits every database of every page once", async () => {
  const ids = await databases(5);
  const prepare = vi.spyOn(Object.getPrototypeOf(env.DB), "prepare");
  const visits = await recordVisits(ids[0]!);
  const before = d1Lists(prepare);
  const result = await warmCycle(env, ONE_SHARD, {}, Date.now(), {
    listPage: 2,
  });
  // Pages of 2, 2 and 1: the short page ends the list.
  expect(d1Lists(prepare) - before).toBe(3);
  expect([...visits.visited].sort()).toEqual([...keys(ids)].sort());
  expect(result).toMatchObject({ databases: 5, visited: 5, failed: 0 });
});

/**
 * Wraps the list statements of the warmers: records each one's SQL and bound values, and the
 * rows D1 says it read for it. The statement itself is the real one.
 */
function meterLists() {
  const lists: { sql: string; values: unknown[]; rowsRead: number }[] = [];
  const database = Object.getPrototypeOf(env.DB) as D1Database;
  const prepare = database.prepare;
  const meter = (
    statement: D1PreparedStatement,
    sql: string,
    values: unknown[],
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(inner, key) {
        if (key === "bind")
          return (...bound: unknown[]) =>
            meter(inner.bind(...bound), sql, bound);
        if (key === "all")
          return async () => {
            const result = await inner.all();
            lists.push({ sql, values, rowsRead: result.meta.rows_read });
            return result;
          };
        const member = Reflect.get(inner, key) as unknown;
        return typeof member === "function"
          ? (member as () => unknown).bind(inner)
          : member;
      },
    });
  vi.spyOn(database, "prepare").mockImplementation(function (
    this: D1Database,
    sql: string,
  ) {
    const statement = prepare.call(this, sql);
    return sql.includes("SELECT d.id") ? meter(statement, sql, []) : statement;
  });
  return lists;
}

it("each warmer reads only its own share of D1, so all warmers together read the databases once, by the id index", async () => {
  const ids = await databases(8);
  // A deleted database is read by the range that holds it, as every row of the id index is.
  await env.DB.prepare(
    "UPDATE databases SET desired_state='deleted',deleted_at=? WHERE id=?",
  )
    .bind(new Date().toISOString(), ids[7]!)
    .run();
  const lists = meterLists();
  const rows = async (shards: number, listPage?: number) => {
    lists.length = 0;
    let counted = 0;
    for (let shard = 0; shard < shards; shard++)
      counted += (
        await warmCycle(
          env,
          { shard, shards, interval_ms: INTERVAL },
          {},
          Date.now(),
          { listPage },
        )
      ).databases;
    return {
      counted,
      rowsRead: lists.reduce((sum, list) => sum + list.rowsRead, 0),
      statements: lists.slice(),
    };
  };
  const whole = await rows(1);
  expect(whole.counted).toBe(7);
  expect(whole.rowsRead).toBeGreaterThan(0);
  for (const shards of [2, 3, 5]) {
    const split = await rows(shards, 2);
    // Every live database was listed once and every row read once, however many warmers: the
    // index scan of a range reads at most the first key beyond it, so a statement costs at most
    // one row more. Listing the whole table in every warmer would read `shards` times as much.
    expect(split.counted).toBe(7);
    expect(split.rowsRead).toBeGreaterThanOrEqual(whole.rowsRead);
    expect(split.rowsRead).toBeLessThanOrEqual(
      whole.rowsRead + split.statements.length,
    );
    // The statement is a search of the id index, never a scan.
    for (const { sql, values } of split.statements) {
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...values)
        .all<{ detail: string }>();
      const details = plan.results.map((row) => row.detail).join("\n");
      expect(details).toMatch(
        /SEARCH d USING INDEX sqlite_autoindex_databases_1/,
      );
      expect(details).not.toMatch(/SCAN d/);
    }
  }
});

it("reaches the actors and the warmers by the namespace, the name and the location hint the Edge uses", async () => {
  const ids = await databases(2);
  // Both namespaces are one class of binding, so one spy sees every `get`.
  const get = vi.spyOn(Object.getPrototypeOf(env.DATABASE_ACTOR), "get");
  const hinted = on({ DATABASE_ACTOR_LOCATION_HINT: "weur" });
  await armActorWarmers(hinted);
  expect(get).toHaveBeenCalled();
  expect(get.mock.calls.map((call) => call[1])).toEqual(
    get.mock.calls.map(() => ({ locationHint: "weur" })),
  );
  get.mockClear();
  await warmCycle(
    hinted,
    { shard: 0, shards: 1, interval_ms: INTERVAL },
    {},
    Date.now(),
  );
  expect(get.mock.calls.map((call) => call[1])).toEqual(
    get.mock.calls.map(() => ({ locationHint: "weur" })),
  );
  const named = new Set(
    get.mock.calls.map((call) => (call[0] as DurableObjectId).toString()),
  );
  for (const id of ids) expect(named.has(actorKey(id))).toBe(true);
  get.mockClear();
  await warmCycle(
    env,
    { shard: 0, shards: 1, interval_ms: INTERVAL },
    {},
    Date.now(),
  );
  expect(get.mock.calls.length).toBeGreaterThanOrEqual(ids.length);
  expect(get.mock.calls.map((call) => call[1])).toEqual(
    get.mock.calls.map(() => undefined),
  );
});

it("arms one warmer for every shard-size databases, each with its shape, a lease and one alarm, and renews them", async () => {
  await databases(3);
  const live = (await env.DB.prepare(
    "SELECT count(*) n FROM databases WHERE deleted_at IS NULL",
  ).first<{ n: number }>())!.n;
  const size = Math.ceil(live / 2);
  const before = Date.now();
  expect(await armActorWarmers(on(), size)).toEqual({ shards: 2 });
  const first = [await alarmOf(0), await alarmOf(1)];
  expect(first.every((alarm) => alarm !== null)).toBe(true);
  expect(await alarmOf(2)).toBeNull();
  expect(await configOf(1)).toEqual({
    shard: 1,
    shards: 2,
    interval_ms: INTERVAL,
    lease_until: expect.any(Number),
  });
  const lease = ((await configOf(1)) as { lease_until: number }).lease_until;
  expect(lease).toBeGreaterThanOrEqual(before + ACTOR_WARM_LEASE_MS);
  // Arming again, some time later, moves the lease on by that time and keeps the alarm that is
  // pending: a lease that were kept would end every warmer three minutes after its first arming.
  await new Promise((resolve) => setTimeout(resolve, 30));
  await armActorWarmers(on(), size);
  expect([await alarmOf(0), await alarmOf(1)]).toEqual(first);
  const renewed = ((await configOf(1)) as { lease_until: number }).lease_until;
  expect(renewed).toBeGreaterThanOrEqual(lease + 25);
  expect(renewed).toBeLessThan(lease + 5000);
});

it("a warmer that rejects and one that hangs past the arm timeout fail the step, after the others were armed", async () => {
  await databases(4);
  const live = (await env.DB.prepare(
    "SELECT count(*) n FROM databases WHERE deleted_at IS NULL",
  ).first<{ n: number }>())!.n;
  // One shard per database: shard 0 rejects, shard 1 hangs, every other shard is armed for real.
  expect(live).toBe(4);
  const hung: Promise<void>[] = [];
  await runInDurableObject(actorWarmer(env, 0), (instance) => {
    const prototype = Object.getPrototypeOf(instance) as {
      arm(shape: { shard: number }, leaseMs: number): Promise<void>;
    };
    const real = prototype.arm;
    vi.spyOn(prototype, "arm").mockImplementation(function (
      this: unknown,
      shape,
      leaseMs,
    ) {
      if (shape.shard === 0)
        return Promise.reject(new Error("warmer_unreachable"));
      if (shape.shard === 1) {
        const pending = new Promise<void>((resolve) =>
          setTimeout(resolve, ARM_TIMEOUT_MS + 500),
        );
        hung.push(pending);
        return pending;
      }
      return real.call(this, shape, leaseMs);
    });
  });
  const started = Date.now();
  await expect(armActorWarmers(on(), 1)).rejects.toThrow(
    "actor_warmer_arm_failed",
  );
  // The step waited for the hanging warmer's timeout, not for the warmer.
  expect(Date.now() - started).toBeGreaterThanOrEqual(ARM_TIMEOUT_MS - 100);
  expect(Date.now() - started).toBeLessThan(ARM_TIMEOUT_MS + 400);
  // Neither failed warmer holds an alarm; both others were armed with their shape and lease.
  expect(await alarmOf(0)).toBeNull();
  expect(await alarmOf(1)).toBeNull();
  for (const shard of [2, 3]) {
    expect(await alarmOf(shard)).not.toBeNull();
    expect(await configOf(shard)).toEqual({
      shard,
      shards: 4,
      interval_ms: INTERVAL,
      lease_until: expect.any(Number),
    });
  }
  // And the minute cron reports the step as failing, as it does for a missing binding.
  const cron = await runCron(on());
  expect(cron.step_failures).toContainEqual({
    step: "actor_warmers",
    error_code: "actor_warmer_arm_failed",
  });
  expect(cron.step_failures).toHaveLength(1);
  await Promise.all(hung);
});

it("interval 0 schedules nothing and calls no warmer; an unset interval is eight seconds; an invalid one is refused", async () => {
  await databases(1);
  const getWarmer = vi.spyOn(Object.getPrototypeOf(env.ACTOR_WARMER), "get");
  expect(
    await armActorWarmers(on({ DATABASE_ACTOR_WARM_INTERVAL_MS: "0" })),
  ).toEqual({ shards: 0 });
  for (const bad of ["abc", "", "-1", "999", "300001", "8.5"])
    await expect(
      armActorWarmers(on({ DATABASE_ACTOR_WARM_INTERVAL_MS: bad })),
    ).rejects.toThrow("invalid_actor_warm_interval");
  expect(getWarmer).not.toHaveBeenCalled();
  getWarmer.mockRestore();
  expect(await alarmOf(0)).toBeNull();
  expect(
    await armActorWarmers(on({ DATABASE_ACTOR_WARM_INTERVAL_MS: undefined })),
  ).toEqual({ shards: 1 });
  expect(await configOf(0)).toMatchObject({ interval_ms: 8000 });
});

it("the minute cron re-arms a shard whose alarm is missing, and reports a missing binding as a failing step", async () => {
  await databases(1);
  const result = await runCron(on());
  expect(result.step_failures).toEqual([]);
  expect(await alarmOf(0)).not.toBeNull();
  await runInDurableObject(actorWarmer(env, 0), (_i, state) =>
    state.storage.deleteAlarm(),
  );
  expect(await alarmOf(0)).toBeNull();
  expect((await runCron(on())).step_failures).toEqual([]);
  expect(await alarmOf(0)).not.toBeNull();
  const missing = await runCron(on({ ACTOR_WARMER: undefined }));
  expect(missing.step_failures).toContainEqual({
    step: "actor_warmers",
    error_code: "actor_warmer_binding_missing",
  });
  // The other steps still ran.
  expect(missing.step_failures).toHaveLength(1);
});

it("each alarm sets the next one a full interval ahead, visits its shard and goes on when a cycle fails", async () => {
  const ids = await databases(2);
  expect(await armActorWarmers(on(), 1000)).toEqual({ shards: 1 });
  const visits = await recordVisits(ids[0]!);
  const before = Date.now();
  expect(await runDurableObjectAlarm(actorWarmer(env, 0))).toBe(true);
  expect(new Set(visits.visited)).toEqual(keys(ids));
  const next = (await alarmOf(0))!;
  expect(next).toBeGreaterThanOrEqual(before + INTERVAL);
  expect(next).toBeLessThan(Date.now() + INTERVAL + 1000);
  // A cycle that cannot even list its databases does not end the loop.
  vi.spyOn(Object.getPrototypeOf(env.DB), "prepare").mockImplementation(() => {
    throw new Error("d1_unavailable");
  });
  await runInDurableObject(actorWarmer(env, 0), (instance) => {
    Reflect.set(instance, "cache", {});
  });
  const failed = Date.now();
  expect(await runDurableObjectAlarm(actorWarmer(env, 0))).toBe(true);
  expect((await alarmOf(0))!).toBeGreaterThanOrEqual(failed + INTERVAL);
});

it("an alarm after the lease ran out visits nothing, sets no alarm, forgets its shape and says so", async () => {
  const ids = await databases(1);
  await armActorWarmers(on(), 1000);
  await runInDurableObject(actorWarmer(env, 0), async (instance, state) => {
    const config = (await state.storage.get("config")) as object;
    await state.storage.put("config", {
      ...config,
      lease_until: Date.now() - 1,
    });
    Reflect.set(instance, "config", undefined);
  });
  const visits = await recordVisits(ids[0]!);
  const log = vi.spyOn(console, "log");
  await runDurableObjectAlarm(actorWarmer(env, 0));
  expect(visits.visited).toEqual([]);
  expect(await alarmOf(0)).toBeNull();
  expect(await configOf(0)).toBeUndefined();
  expect(cycleLines(log)).toEqual([{ event: "actor_warm_stopped", shard: 0 }]);
});
