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
//   under too). A cycle makes one call per database of its shard (`actorWarmShardSize` is 78 at
//   the default interval, give or take 11 % at one standard deviation for a random range of the ID
//   space) and, when it reads its list, one D1 query per 1,000 databases of its own range, once
//   per `ACTOR_WARM_LIST_TTL_MS`. D1 therefore sees about one query of about 78 rows per warmer
//   and minute, and every row of `databases` is read by one warmer only.
// - Six simultaneous outgoing connections for each request, alarm and message. The Durable Objects
//   limits page lists "Simultaneous outgoing connections/request: 6 (same as Workers)" for every
//   Durable Object (https://developers.cloudflare.com/durable-objects/platform/limits/, read
//   2026-10-20). The Workers limits page (https://developers.cloudflare.com/workers/platform/limits/,
//   read 2026-10-20) says a seventh connection waiting for response headers is queued until one of
//   the six gets them, and lists fetch, KV, Cache, R2, Queues and TCP among those that count, not
//   calls to Durable Object stubs. The design relies on the first page: a cycle keeps six calls in
//   flight (`ACTOR_WARM_CONCURRENCY`). If the second page is the whole truth and stubs are not
//   counted, six is only slower than the runtime allows, and the shard size, which assumes six,
//   still holds. The first design kept 16 in flight: no faster if the limit applies, and every
//   visit's time then included its wait in the queue.
// - The live Dev API Worker (2026-10-20, 167 databases, one warmer, 16 in flight) took a median of
//   9.0 s a cycle (6.7 to 15.2 s), about 300 ms for each visit at six in flight, where 50 ms were
//   expected. Whether that is the warmer's distance to the actors (the minute cron created it
//   wherever that invocation ran, with a location hint only if DATABASE_ACTOR_LOCATION_HINT was
//   set) or something else is read from the new fields of the cycle line (`visit_p50_ms`,
//   `visit_max_ms`, `concurrency`) and from the colo of the line `actor_warmer_placed`. Until a read
//   says otherwise a shard is sized for those 300 ms (`ACTOR_WARM_VISIT_PLAN_MS`):
//   `actorWarmShardSize`.
import type { ActorWarmerShape } from "../actor-warmer.ts";
import type { Env } from "../env.ts";
import { cronErrorCode } from "./cron-health.ts";
import { databaseActor } from "./database-actor-sync.ts";

/** The milliseconds between two visits of an actor. A visit every 10 s or faster keeps it warm (plan 11.1); 8 s leaves room for the jitter of an alarm. */
export const ACTOR_WARM_INTERVAL_MS = 8_000;
const ACTOR_WARM_MIN_INTERVAL_MS = 1_000;
const ACTOR_WARM_MAX_INTERVAL_MS = 300_000;
/**
 * Visits in flight at once in one cycle: the six simultaneous outgoing connections a Durable
 * Object has for one invocation (see the header). If the limit applies, more would wait in the
 * runtime's queue and the wait would show as the time of the visits.
 */
export const ACTOR_WARM_CONCURRENCY = 6;
/**
 * The time one visit is planned to take, in milliseconds: what the live cycles of 2026-10-20
 * implied (167 visits, six in flight, a median cycle of 9.0 s). Lower it to the `visit_p50_ms` of the cycle
 * lines once the warmers are placed near the actors and a read shows it; the shards then grow.
 */
export const ACTOR_WARM_VISIT_PLAN_MS = 300;
/** A cycle of an average shard should take at most this share of the interval; the rest is margin for a shard larger than average and for a slow visit. */
const ACTOR_WARM_CYCLE_SHARE = 0.5;
/** The name of the warmer objects: raise it to have every warmer created again (a location hint places only a new object); the warmers of the earlier name are not armed any more and stop when their lease runs out. */
export const ACTOR_WARMER_NAME_VERSION = "v2";
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
  /** The warmer has logged where it runs (`reportPlacement`). */
  placed?: true;
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
  /** Visits in flight at once. */
  concurrency: number;
  /** The median and the longest time of a visit of this cycle in milliseconds (a failed one counts with the time it took), or null for a cycle that visited nothing. */
  visit_p50_ms: number | null;
  visit_max_ms: number | null;
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

/**
 * The databases one warmer visits, on average, for `interval` milliseconds between two visits:
 * as many rounds of `ACTOR_WARM_CONCURRENCY` visits as fit `ACTOR_WARM_CYCLE_SHARE` of the
 * interval at `ACTOR_WARM_VISIT_PLAN_MS` for a visit (78 at 8 s). A shard is a random range of the
 * ID space and holds this many give or take its square root, so a shard of twice the average
 * still ends its cycle within the interval.
 */
export function actorWarmShardSize(interval: number): number {
  const rounds = Math.floor(
    (interval * ACTOR_WARM_CYCLE_SHARE) / ACTOR_WARM_VISIT_PLAN_MS,
  );
  return rounds * ACTOR_WARM_CONCURRENCY;
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

/**
 * Where a new warmer is placed: with the hint of the actors it visits, so that a visit does not
 * cross an ocean; else with `ACTOR_WARMER_LOCATION_HINT`, which the operator sets to where the
 * actors live when the installation gives the actors no hint (they were then created near
 * whoever called them first).
 */
function warmerLocationHint(
  env: Pick<Env, "DATABASE_ACTOR_LOCATION_HINT" | "ACTOR_WARMER_LOCATION_HINT">,
): string | undefined {
  return (
    env.DATABASE_ACTOR_LOCATION_HINT ||
    env.ACTOR_WARMER_LOCATION_HINT ||
    undefined
  );
}

/** The warmer of a shard, placed with `warmerLocationHint` when it is created. */
export function actorWarmer(
  env: Pick<
    Env,
    | "ACTOR_WARMER"
    | "DATABASE_ACTOR_LOCATION_HINT"
    | "ACTOR_WARMER_LOCATION_HINT"
  >,
  shard: number,
) {
  const warmers = env.ACTOR_WARMER;
  if (!warmers) throw new Error("actor_warmer_binding_missing");
  const hint = warmerLocationHint(env);
  return warmers.get(
    warmers.idFromName(`${ACTOR_WARMER_NAME_VERSION}:${shard}`),
    hint ? { locationHint: hint as DurableObjectLocationHint } : undefined,
  );
}

const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
const TRACE_TIMEOUT_MS = 2_000;

/**
 * Logs, once for each warmer object in memory, the colo it runs in (`actor_warmer_placed`) and the
 * location hint it was asked for: the warmer's distance to the actors is one of the two things
 * that decide how long a visit takes. The colo is the three-letter `colo` of Cloudflare's trace
 * for this request; nothing else of the trace (it holds the caller's address) is read into a log.
 * Never throws and gives up after `TRACE_TIMEOUT_MS`; `colo` is null when it is not known.
 */
export async function reportPlacement(
  env: Pick<Env, "DATABASE_ACTOR_LOCATION_HINT" | "ACTOR_WARMER_LOCATION_HINT">,
  { shard, shards }: Pick<ActorWarmerShape, "shard" | "shards">,
  cache: WarmCache,
): Promise<void> {
  if (cache.placed) return;
  cache.placed = true;
  const colo = await fetch(TRACE_URL, {
    signal: AbortSignal.timeout(TRACE_TIMEOUT_MS),
  })
    .then((response) => response.text())
    .then((trace) => /^colo=([A-Z]{3})$/m.exec(trace)?.[1] ?? null)
    .catch(() => null);
  console.log(
    JSON.stringify({
      event: "actor_warmer_placed",
      shard,
      shards,
      colo,
      location_hint: warmerLocationHint(env) ?? null,
    }),
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
  const timings: number[] = [];
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          limits.concurrency ?? ACTOR_WARM_CONCURRENCY,
          ids.length,
        ),
      },
      async () => {
        for (let index = next++; index < ids.length; index = next++) {
          const began = Date.now();
          try {
            await within(timeout, databaseActor(env, ids[index]!).warm());
            visited++;
          } catch {
            failed++;
          } finally {
            timings.push(Date.now() - began);
          }
        }
      },
    ),
  );
  const cycle_ms = Date.now() - started;
  timings.sort((a, b) => a - b);
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
    concurrency: limits.concurrency ?? ACTOR_WARM_CONCURRENCY,
    visit_p50_ms: timings[Math.floor(timings.length / 2)] ?? null,
    visit_max_ms: timings.at(-1) ?? null,
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
  shardSize?: number,
): Promise<{ shards: number }> {
  const interval = actorWarmInterval(env.DATABASE_ACTOR_WARM_INTERVAL_MS);
  if (interval === 0) return { shards: 0 };
  if (!env.ACTOR_WARMER) throw new Error("actor_warmer_binding_missing");
  const live = await env.DB.prepare(`SELECT count(*) n ${LIVE}`).first<number>(
    "n",
  );
  const shards = Math.ceil(
    (live ?? 0) / (shardSize ?? actorWarmShardSize(interval)),
  );
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
