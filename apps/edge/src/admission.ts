// SPDX-License-Identifier: Apache-2.0
/**
 * The admission every database request takes, a WebSocket connection (`index.ts`) and an HTTP
 * query (`sql.ts`) alike: the Edge limiters and the DatabaseActor's admission run together, and
 * an admitted request is signed its route to the node's gateway.
 */
import {
  parseRouteKeyring,
  signNodeRouteToken,
  signWakeRouteToken,
} from "@pgcf/contracts/route-token-core";
import type { DatabaseWakeAdmission, Env } from "./env.ts";
import type { GatewayRegion } from "./gateway.ts";
import { ADMISSION_DEADLINE_MS, connectionRateKey } from "./session-policy.ts";

export interface Hints {
  readonly database: string;
  readonly user: string;
}

/** Milliseconds of each admission stage that ran, logged with the admission. */
export interface AdmissionTimings {
  /** The limiters, which run in parallel with the Actor's admission. */
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

/** The DatabaseActor, got at the location hint the API creates it at; an existing one never moves. */
export function databaseActor(env: Env, database: string) {
  const hint = env.DATABASE_ACTOR_LOCATION_HINT;
  return env.DATABASE_ACTOR.get(
    env.DATABASE_ACTOR.idFromName(database),
    hint ? { locationHint: hint as DurableObjectLocationHint } : undefined,
  );
}

/**
 * Admits `hints` and signs its route. `scope` prefixes the limiter keys, so that a kind of
 * request (HTTP queries: `["sql"]`) counts in buckets of its own of the same limiters.
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
): Promise<{ region: GatewayRegion; token: string }> {
  const check = () => {
    if (signal.aborted)
      throw new AdmissionFailure("08006", "connection admission interrupted");
  };
  check();
  const network = connectionRateKey(request.headers.get("CF-Connecting-IP"));
  if (network === null)
    throw new AdmissionFailure("53300", "connection rate limit exceeded");
  // Shared proxy networks must not couple unrelated database/role routes.
  // These untrusted hints scope admission; PostgreSQL authenticates the user.
  const key = JSON.stringify([...scope, hints.database, hints.user, network]);
  // A same-account Worker on a service binding has a budget of its own per database and role; it
  // never drains, or is drained by, the public buckets.
  const limits: [RateLimit, string, string][] =
    network === "binding"
      ? [
          [
            env.BINDING_CONNECTION_RATE_LIMITER,
            key,
            "connection rate limit exceeded",
          ],
        ]
      : [
          [env.CONNECTION_RATE_LIMITER, key, "connection rate limit exceeded"],
          [
            env.DATABASE_CONNECTION_RATE_LIMITER,
            scope.length === 0
              ? hints.database
              : JSON.stringify([...scope, hints.database]),
            "database connection rate limit exceeded",
          ],
        ];
  const actor = databaseActor(env, hints.database);
  const cancel = () =>
    ctx.waitUntil(
      Promise.resolve()
        .then(() => actor.cancelWakeWaiter(hints.database, cid))
        .catch(() => false),
    );
  signal.addEventListener("abort", cancel, { once: true });
  // The limiters and the Actor's admission run together: none of them waits for another. The
  // per-database bucket therefore also counts connects that admission refuses.
  const started = Date.now();
  const limited = async (limiter: RateLimit, limitKey: string) =>
    limiter.limit({ key: limitKey }).finally(() => {
      timings.limiters_ms = Math.max(
        timings.limiters_ms ?? 0,
        Date.now() - started,
      );
    });
  let admission: PromiseSettledResult<DatabaseWakeAdmission>;
  let outcomes: PromiseSettledResult<RateLimitOutcome>[];
  try {
    check();
    [admission, ...outcomes] = await Promise.allSettled([
      actor
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
        })
        .finally(() => {
          timings.admit_ms = Date.now() - started;
        }),
      ...limits.map(([limiter, limitKey]) => limited(limiter, limitKey)),
    ]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  check();
  if (outcomes.some((outcome) => outcome.status === "rejected"))
    throw new AdmissionFailure("53300", "connection admission unavailable");
  for (const [index, [, , message]] of limits.entries())
    if (
      !(outcomes[index] as PromiseFulfilledResult<RateLimitOutcome>).value
        .success
    )
      throw new AdmissionFailure("53300", message);
  if (admission.status === "rejected") throw admission.reason;
  const admitted = admission.value;
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
        throw new AdmissionFailure(
          "57P03",
          "database is not accepting connections",
        );
      case "53300":
        throw new AdmissionFailure(
          "53300",
          "database connection rate limit exceeded",
        );
      default:
        timings.admit_error = "actor_failure";
        throw new AdmissionFailure("08006", "gateway connection failed");
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
 * Runs `admission` until its deadline (60 s) or the client's abort, whichever comes first; either
 * refuses with 08006 and aborts the signal `admission` was given.
 */
export async function bounded<T>(
  request: Request,
  ctx: ExecutionContext,
  admission: (signal: AbortSignal, deadline: number) => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + ADMISSION_DEADLINE_MS;
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  let refuse!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    refuse = () =>
      reject(new AdmissionFailure("08006", "connection admission interrupted"));
    if (controller.signal.aborted) refuse();
    else controller.signal.addEventListener("abort", refuse, { once: true });
  });
  const timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
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
