// SPDX-License-Identifier: Apache-2.0
/**
 * The admission every database request takes, a WebSocket connection (`index.ts`) and an HTTP
 * query (`sql.ts`) alike: the Edge limiters and the DatabaseActor's admission, and an admitted
 * request is signed its route to the node's gateway. Both count the source network first
 * (`limitSource`), before any Actor is got. Then the limiters count the request (`limitRoute`) and
 * only an admitted request reaches the Actor's admission, which may wake the database: a WebSocket
 * upgrade counts there before its admission, an HTTP query counts before its body is read and takes
 * the Actor's admission after the body is understood.
 */
import {
  parseRouteKeyring,
  signNodeRouteToken,
  signWakeRouteToken,
} from "@pgcf/contracts/route-token-core";
import {
  CONNECTION_REFUSALS,
  refusalMessage,
  type ConnectionRefusalReason,
} from "@pgcf/contracts/connection-refusals";
import type { DatabaseWakeAdmission, Env } from "./env.ts";
import type { GatewayRegion } from "./gateway.ts";
import { ADMISSION_DEADLINE_MS, connectionRateKey } from "./session-policy.ts";

export interface Hints {
  readonly database: string;
  readonly user: string;
}

/** Milliseconds of each admission stage that ran, logged with the admission. */
export interface AdmissionTimings {
  /**
   * The limiters: the source limiter first and alone, then the others in parallel with each other,
   * for both kinds of request, before the Actor's admission begins (and, for an HTTP query, ahead
   * of the body). The stage is the longest of its limiters' waits, not their sum.
   */
  limiters_ms?: number;
  admit_ms?: number;
  /** A thrown RPC and an Actor's generic failure are distinct; never log exception text. */
  admit_error?: "rpc_exception" | "actor_failure";
  /** Cloudflare's exception flags, accepted only as booleans. No retry is implied. */
  admit_retryable?: boolean;
  admit_overloaded?: boolean;
  admit_remote?: boolean;
  /** The route token version signed: v6 for an awake database, v5 for a wake ticket. */
  route?: "v6" | "v5";
  token_ms?: number;
}

let isolateRequests = 0;
/**
 * Counts one database request (a WebSocket upgrade or an HTTP query) taken by this isolate, this
 * one included. The first of an isolate pays for what the later ones find cached.
 */
export function nextIsolateRequest(): number {
  return ++isolateRequests;
}

/**
 * What the Edge itself spent on a request: all of `duration` but the `waits` that were another's,
 * the client's upload and the gateway's answer (plan 3.1 bounds it at about 150 ms at p95).
 * Network transit and the node are not in it.
 */
export function edgeShare(duration: number, ...waits: (number | undefined)[]) {
  return Math.max(
    0,
    duration - waits.reduce<number>((sum, wait) => sum + (wait ?? 0), 0),
  );
}

export class AdmissionFailure extends Error {
  readonly sqlstate: string;
  /** The refusal is answered as an unknown database or role is: by the decoy. */
  readonly decoy: boolean;
  constructor(sqlstate: string, message: string, decoy = false) {
    super(message);
    this.sqlstate = sqlstate;
    this.decoy = decoy;
  }
}

/** A refusal with its closed reason appended to the message; see `CONNECTION_REFUSALS`. */
export function refusal(
  reason: ConnectionRefusalReason,
  decoy = false,
): AdmissionFailure {
  return new AdmissionFailure(
    CONNECTION_REFUSALS[reason].sqlstate,
    refusalMessage(reason),
    decoy,
  );
}

/** The DatabaseActor, got at the location hint the API creates it at; an existing one never moves. */
export function databaseActor(env: Env, database: string) {
  const hint = env.DATABASE_ACTOR_LOCATION_HINT;
  return env.DATABASE_ACTOR.get(
    env.DATABASE_ACTOR.idFromName(database),
    hint ? { locationHint: hint as DurableObjectLocationHint } : undefined,
  );
}

type Limit = readonly [
  limiter: RateLimit,
  key: string,
  refusal: ConnectionRefusalReason,
];

/**
 * The limiters a request counts in, keyed by what is known before any body: the database and role
 * of the hints and the caller's network. `scope` prefixes the keys, so that a kind of request
 * (HTTP queries: `["sql"]`) counts in buckets of its own of the same limiters.
 */
function routeLimits(
  request: Request,
  env: Env,
  hints: Hints,
  scope: readonly string[],
): Limit[] {
  const network = connectionRateKey(request.headers.get("CF-Connecting-IP"));
  if (network === null) throw refusal("rate_limited");
  // Shared proxy networks must not couple unrelated database/role routes.
  // These untrusted hints scope admission; PostgreSQL authenticates the user.
  const key = JSON.stringify([...scope, hints.database, hints.user, network]);
  // A same-account Worker on a service binding has a budget of its own per database and role; it
  // never drains, or is drained by, the public buckets.
  return network === "binding"
    ? [[env.BINDING_CONNECTION_RATE_LIMITER, key, "rate_limited"]]
    : [
        [env.CONNECTION_RATE_LIMITER, key, "rate_limited"],
        [
          env.DATABASE_CONNECTION_RATE_LIMITER,
          scope.length === 0
            ? hints.database
            : JSON.stringify([...scope, hints.database]),
          "database_rate_limited",
        ],
      ];
}

/** Counts the request in every limiter at once; `limiters_ms` is the slowest one's wait. */
function countLimits(
  limits: readonly Limit[],
  timings: AdmissionTimings,
  started: number,
): Promise<RateLimitOutcome>[] {
  return limits.map(async ([limiter, key]) =>
    limiter.limit({ key }).finally(() => {
      timings.limiters_ms = Math.max(
        timings.limiters_ms ?? 0,
        Date.now() - started,
      );
    }),
  );
}

/**
 * The source limiter: one coarse bucket per source network across every database and route, so
 * that fresh database identities cannot escape the limits below. A caller on a service binding (no
 * `CF-Connecting-IP`) keeps its own budget and never counts here; a malformed address is refused by
 * the connection limiters that `routeLimits` checks.
 */
async function limitSource(
  request: Request,
  env: Env,
  timings: AdmissionTimings,
): Promise<void> {
  const network = connectionRateKey(request.headers.get("CF-Connecting-IP"));
  if (network === null || network === "binding") return;
  const limits: Limit[] = [[env.SOURCE_RATE_LIMITER, network, "rate_limited"]];
  const outcomes = await Promise.allSettled(
    countLimits(limits, timings, Date.now()),
  );
  refuseLimited(limits, outcomes);
}

/** Refuses with 53300 when a limiter failed or said no. */
function refuseLimited(
  limits: readonly Limit[],
  outcomes: PromiseSettledResult<RateLimitOutcome>[],
): void {
  if (outcomes.some((outcome) => outcome.status === "rejected"))
    throw refusal("admission_unavailable");
  for (const [index, [, , reason]] of limits.entries())
    if (
      !(outcomes[index] as PromiseFulfilledResult<RateLimitOutcome>).value
        .success
    )
      throw refusal(reason);
}

/**
 * The limiters alone: for a request whose body is read after, so that a client over its budget is
 * refused before the Edge takes a byte of the body, and a body that is never understood still
 * counts. `admitRoute` then takes `counted` and does not count the request again.
 */
export async function limitRoute(
  request: Request,
  env: Env,
  hints: Hints,
  timings: AdmissionTimings,
  scope: readonly string[],
): Promise<void> {
  const check = () => {
    if (request.signal.aborted) throw refusal("admission_interrupted");
  };
  check();
  await limitSource(request, env, timings);
  const limits = routeLimits(request, env, hints, scope);
  const outcomes = await Promise.allSettled(
    countLimits(limits, timings, Date.now()),
  );
  check();
  refuseLimited(limits, outcomes);
}

/**
 * Admits `hints` and signs its route. `scope` prefixes the limiter keys (see `routeLimits`);
 * `counted` says that `limitRoute` has counted the request already.
 */
export async function admitRoute(
  request: Request,
  env: Env,
  hints: Hints,
  cid: string,
  signal: AbortSignal,
  deadline: number,
  ctx: ExecutionContext,
  timings: AdmissionTimings,
  scope: readonly string[] = [],
  counted = false,
): Promise<{ region: GatewayRegion; token: string }> {
  const check = () => {
    if (signal.aborted) throw refusal("admission_interrupted");
  };
  check();
  // A request that `limitRoute` counted has passed the limiters already; any other request is
  // counted here, and only once the limiters admit it does the Actor run, so a refused connect
  // never wakes a database.
  if (!counted) await limitRoute(request, env, hints, timings, scope);
  check();
  const actor = databaseActor(env, hints.database);
  const cancel = () =>
    ctx.waitUntil(
      Promise.resolve()
        .then(() => actor.cancelWakeWaiter(hints.database, cid))
        .catch(() => false),
    );
  signal.addEventListener("abort", cancel, { once: true });
  const started = Date.now();
  let admitted: DatabaseWakeAdmission;
  try {
    check();
    admitted = await actor
      .admitWake(hints.database, hints.user, { deadline, waiterId: cid })
      .catch((reason: unknown) => {
        // A 12 s live stall returned 08006 without a matching Actor log. Keep the RPC's
        // diagnostic flags, not its message/name/cause/stack, so the next probe can distinguish
        // that failure from an Actor that ran and returned a refusal.
        const flags =
          typeof reason === "object" && reason !== null
            ? (reason as Record<string, unknown>)
            : {};
        timings.admit_error = "rpc_exception";
        timings.admit_retryable = flags.retryable === true;
        timings.admit_overloaded = flags.overloaded === true;
        timings.admit_remote = flags.remote === true;
        throw reason;
      });
  } finally {
    timings.admit_ms = Date.now() - started;
    signal.removeEventListener("abort", cancel);
  }
  check();
  if (!admitted.ok) {
    switch (admitted.sqlstate) {
      case "3D000":
      case "28P01":
        throw new AdmissionFailure(
          "28P01",
          "password authentication failed",
          true,
        );
      case "57P03":
        throw refusal("database_not_accepting");
      case "53300":
        throw refusal("database_rate_limited");
      default:
        timings.admit_error = "actor_failure";
        throw refusal("gateway_unavailable");
    }
  }
  const region = admitted.region;
  const connection = {
    keyring: parseRouteKeyring(env.ROUTE_MASTER_KEYS),
    region: region.id,
    db: hints.database,
    user: hints.user,
    cid,
  };
  // A wake ticket is signed as route v5: the gateway holds the request until its wake is
  // released. An awake database is signed as route v6, which names the unit the node reported.
  // Both are signed with the key of the node the database runs on.
  const tokenStarted = Date.now();
  let token: string;
  if ("wake" in admitted) {
    timings.route = "v5";
    token = await signWakeRouteToken({
      ...connection,
      node: admitted.node,
      wake: admitted.wake,
    });
  } else {
    timings.route = "v6";
    token = await signNodeRouteToken({
      ...connection,
      node: admitted.node,
      target: admitted.target,
    });
  }
  timings.token_ms = Date.now() - tokenStarted;
  check();
  return { region, token };
}

/**
 * Before a gateway connection starts, expiry is a retryable pre-execution refusal. Client
 * cancellation and an interrupted gateway connection retain their connection-failure meaning.
 */
export async function bounded<T>(
  request: Request,
  ctx: ExecutionContext,
  admission: (signal: AbortSignal, deadline: number) => Promise<T>,
  gatewayStarted: () => boolean = () => false,
): Promise<T> {
  const deadline = Date.now() + ADMISSION_DEADLINE_MS;
  const controller = new AbortController();
  const abort = () => controller.abort(refusal("admission_interrupted"));
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  let refuse!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    refuse = () => reject(controller.signal.reason);
    if (controller.signal.aborted) refuse();
    else controller.signal.addEventListener("abort", refuse, { once: true });
  });
  const timer = setTimeout(
    () => {
      controller.abort(
        gatewayStarted()
          ? refusal("admission_interrupted")
          : refusal("wake_deadline"),
      );
    },
    Math.max(0, deadline - Date.now()),
  );
  const admitted = Promise.race([
    interrupted,
    admission(controller.signal, deadline),
  ]);
  ctx.waitUntil(
    admitted.then(
      () => undefined,
      () => undefined,
    ),
  );
  try {
    return await admitted;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", refuse);
  }
}
