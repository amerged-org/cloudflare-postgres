// SPDX-License-Identifier: Apache-2.0
// The keep-warm of the DatabaseActors (ULTRA plan 11.1, "Keep-warm for the DatabaseActor", and
// D14 part b). The ActorWarmer Durable Objects (`actor-warmer.ts`) run `warmCycle`; the minute
// cron runs `armActorWarmers`. Loaded by the first alarm and by the cron, never by a cold actor.
//
// The limits this is sized for (Cloudflare's documented ones for Workers Paid, which this
// installation already runs on):
// - A Durable Object alarm may run 15 minutes of wall time and 30 s of CPU. A cycle spends its
//   time waiting for the actors; its own CPU is the creation of the stubs and the calls, well under
//   a second for a shard.
// - An invocation may make up to 10,000 subrequests (1,000 on the older plans, which this stays
//   under too). A cycle makes one call per database of its shard (`ACTOR_WARM_SHARD_SIZE` is 250
//   on average; a random range of the ID space holds that many, give or take 6 % at one
//   standard deviation)
//   and, when it reads its list, one D1 query per 1,000 databases of its own range, once per
//   `ACTOR_WARM_LIST_TTL_MS`. D1 therefore sees about one query of about 250 rows per warmer and
//   minute, and every row of `databases` is read by one warmer only.
// - The six-connection limit is listed for fetch, KV, R2 and the like, not for calls to Durable
//   Objects; the cron already runs 8 at a time (`ACTOR_RECONCILE_CONCURRENCY`), and a cycle runs
//   `ACTOR_WARM_CONCURRENCY`. If the runtime did queue calls beyond six, the visits would wait,
//   not fail: a shard of 250 warm actors (about 50 ms a visit) would take about two seconds, which
//   the cycle line shows as `cycle_ms`, and `overrun` says when a cycle outlasts its interval.
//   A shard of cold actors (up to 600 ms a visit) takes about 10 s once, after a deploy.
import type { ActorWarmerShape } from "../actor-warmer.ts";
import type { Env } from "../env.ts";
import { cronErrorCode } from "./cron-health.ts";
import { databaseActor } from "./database-actor-sync.ts";

/** The milliseconds between two visits of an actor. A visit every 10 s or faster keeps it warm (plan 11.1); 8 s leaves room for the jitter of an alarm. */
export const ACTOR_WARM_INTERVAL_MS = 8_000;
const ACTOR_WARM_MIN_INTERVAL_MS = 1_000;
const ACTOR_WARM_MAX_INTERVAL_MS = 300_000;
/** The databases one warmer visits, on average: the cron arms one warmer for each. */
export const ACTOR_WARM_SHARD_SIZE = 250;
/** Visits in flight at once in one cycle. */
export const ACTOR_WARM_CONCURRENCY = 16;
/** A visit that takes longer is counted as failed; the cycle goes on. */
export const ACTOR_WARM_VISIT_TIMEOUT_MS = 3_000;
/** How long a warmer keeps the list of its databases before it reads D1 again. */
export const ACTOR_WARM_LIST_TTL_MS = 60_000;
/** The cron renews the lease every minute; a warmer it no longer arms stops after three missed minutes. */
export const ACTOR_WARM_LEASE_MS = 180_000;
/** The cron waits this long for a warmer to be armed; a warmer that takes longer fails the step. */
export const ARM_TIMEOUT_MS = 2_000;
const LIST_PAGE = 1_000;
/** The databases an actor can admit: the presence of the actor says deleted for every other. */
const LIVE =
  "FROM databases d JOIN projects p ON p.id=d.project_id WHERE d.deleted_at IS NULL AND p.deleted_at IS NULL";

/** The warmer's list of its databases, kept between its cycles while the object is in memory. */
export interface WarmCache {
  list?: { shard: number; shards: number; at: number; ids: string[] };
}
export interface WarmCycle {
  shard: number;
  shards: number;
  databases: number;
  visited: number;
  failed: number;
  cycle_ms: number;
  interval_ms: number;
  overrun: boolean;
  list_error: string | null;
}

/** The interval in milliseconds from `DATABASE_ACTOR_WARM_INTERVAL_MS`: 0 is off, unset is 8 s. */
export function actorWarmInterval(value: string | undefined): number {
  if (value === undefined) return ACTOR_WARM_INTERVAL_MS;
  const interval = /^\d{1,7}$/.test(value) ? Number(value) : NaN;
  if (
    interval !== 0 &&
    !(
      interval >= ACTOR_WARM_MIN_INTERVAL_MS &&
      interval <= ACTOR_WARM_MAX_INTERVAL_MS
    )
  )
    throw new Error("invalid_actor_warm_interval");
  return interval;
}

/** The ids that sort first among the lowercase letters and digits of a database ID (digits before letters, as bytes sort). */
const ID_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";
const ID_LETTERS = ID_DIGITS.slice(10);
/** The ID space as three positions: a letter, then two characters of letters and digits. */
const ID_BUCKETS = ID_LETTERS.length * ID_DIGITS.length ** 2;

/**
 * The ids of shard `shard` of `shards`: those greater than `after` and not greater than `upto`
 * (`null` is no upper end), in the byte order D1 sorts them in. A database ID is 20 random
 * characters, a letter and then letters and digits (`DATABASE_ID_PATTERN`), so equal slices of the
 * ID space hold about the same number of databases, and a warmer can read its share from the
 * primary key's index alone: the rows all warmers read together are the databases once, not
 * once for every warmer. The boundaries are the first three characters of the ID at k/shards of
 * the space; a database ID is longer, so none equals a boundary, and the ranges of the shards
 * follow each other with no gap and no overlap whatever the number of shards.
 */
export function actorWarmRange(
  shard: number,
  shards: number,
): { after: string; upto: string | null } {
  const boundary = (index: number): string => {
    const bucket = Math.floor((index * ID_BUCKETS) / shards);
    const second = Math.floor(bucket / ID_DIGITS.length) % ID_DIGITS.length;
    return (
      ID_LETTERS[Math.floor(bucket / ID_DIGITS.length ** 2)]! +
      ID_DIGITS[second]! +
      ID_DIGITS[bucket % ID_DIGITS.length]!
    );
  };
  return {
    after: shard === 0 ? "" : boundary(shard),
    upto: shard === shards - 1 ? null : boundary(shard + 1),
  };
}

/** The warmer of a shard, placed with the location hint of the actors it visits. */
export function actorWarmer(
  env: Pick<Env, "ACTOR_WARMER" | "DATABASE_ACTOR_LOCATION_HINT">,
  shard: number,
) {
  const warmers = env.ACTOR_WARMER;
  if (!warmers) throw new Error("actor_warmer_binding_missing");
  const hint = env.DATABASE_ACTOR_LOCATION_HINT;
  return warmers.get(
    warmers.idFromName(`shard-${shard}`),
    hint ? { locationHint: hint as DurableObjectLocationHint } : undefined,
  );
}

/** Rejects after `ms` unless `call` settles first; the call itself goes on and is not awaited. */
async function within<T>(ms: number, call: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("actor_warm_timeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The live databases of one shard, in id order: its range of the id index, read in keyset pages. */
async function listShard(
  db: D1Database,
  { shard, shards }: ActorWarmerShape,
  page: number,
): Promise<string[]> {
  const range = actorWarmRange(shard, shards);
  const bounded = range.upto === null ? "" : " AND d.id<=?";
  const ids: string[] = [];
  let after = range.after;
  for (;;) {
    const statement = db.prepare(
      `SELECT d.id ${LIVE} AND d.id>?${bounded} ORDER BY d.id LIMIT ?`,
    );
    const rows = await (
      range.upto === null
        ? statement.bind(after, page)
        : statement.bind(after, range.upto, page)
    ).all<{ id: string }>();
    for (const { id } of rows.results) ids.push(id);
    if (rows.results.length < page) return ids;
    after = rows.results.at(-1)!.id;
  }
}

/**
 * One cycle of a warmer: visits every database of its shard with `DatabaseActor.warm`, which
 * changes nothing the actor holds, and logs one line. The list of databases comes from `cache`
 * until it is `ACTOR_WARM_LIST_TTL_MS` old (judged at `now`); when D1 cannot be read the list of an
 * earlier cycle is visited again. A visit that throws or does not answer in time is a failed
 * visit and never stops the cycle.
 */
export async function warmCycle(
  env: Env,
  target: ActorWarmerShape,
  cache: WarmCache,
  now = Date.now(),
  limits: {
    concurrency?: number;
    visitTimeoutMs?: number;
    listPage?: number;
  } = {},
): Promise<WarmCycle> {
  const started = Date.now();
  const same = (list: WarmCache["list"]) =>
    list?.shard === target.shard && list.shards === target.shards;
  let listError: string | null = null;
  if (!same(cache.list) || now - cache.list!.at >= ACTOR_WARM_LIST_TTL_MS)
    try {
      cache.list = {
        shard: target.shard,
        shards: target.shards,
        at: now,
        ids: await listShard(env.DB, target, limits.listPage ?? LIST_PAGE),
      };
    } catch (error) {
      listError = cronErrorCode(error);
    }
  const ids = same(cache.list) ? cache.list!.ids : [];
  const timeout = limits.visitTimeoutMs ?? ACTOR_WARM_VISIT_TIMEOUT_MS;
  let next = 0,
    visited = 0,
    failed = 0;
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          limits.concurrency ?? ACTOR_WARM_CONCURRENCY,
          ids.length,
        ),
      },
      async () => {
        for (let index = next++; index < ids.length; index = next++)
          try {
            await within(timeout, databaseActor(env, ids[index]!).warm());
            visited++;
          } catch {
            failed++;
          }
      },
    ),
  );
  const cycle_ms = Date.now() - started;
  const result: WarmCycle = {
    shard: target.shard,
    shards: target.shards,
    databases: ids.length,
    visited,
    failed,
    cycle_ms,
    interval_ms: target.interval_ms,
    overrun: cycle_ms > target.interval_ms,
    list_error: listError,
  };
  console.log(JSON.stringify({ event: "actor_warm_cycle", ...result }));
  return result;
}

/**
 * The cron step: one warmer for every `shardSize` live databases, each told its shard, the shard
 * count and a lease, and each made to hold one alarm. Idempotent, so a warmer whose alarm is gone
 * (a deploy, a fault) is started again by the next minute. An interval of 0 arms nothing, and
 * the warmers that run stop when their lease ends. A warmer that cannot be reached fails the step
 * after the others were armed.
 */
export async function armActorWarmers(
  env: Env,
  shardSize = ACTOR_WARM_SHARD_SIZE,
): Promise<{ shards: number }> {
  const interval = actorWarmInterval(env.DATABASE_ACTOR_WARM_INTERVAL_MS);
  if (interval === 0) return { shards: 0 };
  if (!env.ACTOR_WARMER) throw new Error("actor_warmer_binding_missing");
  const live = await env.DB.prepare(`SELECT count(*) n ${LIVE}`).first<number>(
    "n",
  );
  const shards = Math.ceil((live ?? 0) / shardSize);
  const armed = await Promise.allSettled(
    Array.from({ length: shards }, (_unused, shard) =>
      within(
        ARM_TIMEOUT_MS,
        actorWarmer(env, shard).arm(
          { shard, shards, interval_ms: interval },
          ACTOR_WARM_LEASE_MS,
        ),
      ),
    ),
  );
  if (armed.some((result) => result.status === "rejected"))
    throw new Error("actor_warmer_arm_failed");
  return { shards };
}
