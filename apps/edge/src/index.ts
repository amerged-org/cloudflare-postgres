// SPDX-License-Identifier: Apache-2.0
// Specific modules, never the contracts barrel: a cold isolate evaluates only what it imports.
import { isDatabaseId, isRoleName } from "@pgcf/contracts/ids";
import { encodeErrorResponse } from "@pgcf/contracts/pg-wire";
import {
  parseRouteKeyring,
  signLegacyRouteToken,
  signRouteToken,
  signWakeRouteToken,
} from "@pgcf/contracts/route-token";
import type { DatabaseWakeAdmission, Env } from "./env.ts";
import { decoyResponse } from "./decoy.ts";
import { connectGateway } from "./gateway.ts";
import { ADMISSION_DEADLINE_MS, connectionRateKey } from "./session-policy.ts";

interface Hints {
  readonly database: string;
  readonly user: string;
}

/** Milliseconds of each admission stage that ran, logged with the admission. */
interface Timings {
  /** Both limiters, which run in parallel with the Actor's admission. */
  limiters_ms?: number;
  admit_ms?: number;
  /** The route token version signed: v5 for a wake ticket. */
  route?: "v5" | "v4" | "v3" | "v2";
  token_ms?: number;
  gateway_connect_ms?: number;
}

class AdmissionFailure extends Error {
  readonly sqlstate: string;
  readonly decoy: boolean;
  constructor(sqlstate: string, message: string, decoy = false) {
    super(message);
    this.sqlstate = sqlstate;
    this.decoy = decoy;
  }
}

function routingHints(url: URL): Hints {
  const databases = url.searchParams.getAll("database");
  const users = url.searchParams.getAll("user");
  if (databases.length > 1 || users.length > 1)
    throw new AdmissionFailure("08P01", "duplicate connection admission hint");
  if (databases.length !== 1 || !isDatabaseId(databases[0]))
    throw new AdmissionFailure("3D000", "database does not exist");
  if (users.length !== 1 || !isRoleName(users[0]))
    throw new AdmissionFailure("28P01", "authentication failed");
  return { database: databases[0], user: users[0] };
}

async function admit(
  request: Request,
  env: Env,
  hints: Hints,
  cid: string,
  signal: AbortSignal,
  deadline: number,
  ctx: ExecutionContext,
  timings: Timings,
): Promise<{ socket: WebSocket; region: string }> {
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
  const key = JSON.stringify([hints.database, hints.user, network]);
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
            hints.database,
            "database connection rate limit exceeded",
          ],
        ];
  // The API creates each database's Actor at the same hint; an existing one never moves.
  const hint = env.DATABASE_ACTOR_LOCATION_HINT;
  const actor = env.DATABASE_ACTOR.get(
    env.DATABASE_ACTOR.idFromName(hints.database),
    hint ? { locationHint: hint as DurableObjectLocationHint } : undefined,
  );
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
        throw new AdmissionFailure(
          "28P01",
          "password authentication failed",
          true,
        );
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
        throw new AdmissionFailure("08006", "gateway connection failed");
    }
  }
  const route = admitted.region;
  const connection = {
    keyring: parseRouteKeyring(env.ROUTE_MASTER_KEYS),
    region: route.id,
    db: hints.database,
    user: hints.user,
    cid,
  };
  // A wake ticket is signed as route v5: the gateway holds the connection until its wake is
  // released. The gateway dials only an admitted verified target. Temporary rollout compatibility
  // (route-token.ts): an admission without a verified target still receives a v2 route.
  const tokenStarted = Date.now();
  let token: string;
  if ("wake" in admitted) {
    timings.route = "v5";
    token = await signWakeRouteToken({ ...connection, wake: admitted.wake });
  } else if (admitted.target) {
    timings.route = admitted.target.route_revision === undefined ? "v3" : "v4";
    token = await signRouteToken({ ...connection, target: admitted.target });
  } else {
    timings.route = "v2";
    token = await signLegacyRouteToken(connection);
  }
  timings.token_ms = Date.now() - tokenStarted;
  check();
  const gatewayStarted = Date.now();
  const socket = await connectGateway(route, token, env, signal);
  timings.gateway_connect_ms = Date.now() - gatewayStarted;
  if (signal.aborted) {
    try {
      socket.accept({ allowHalfOpen: true });
      socket.close(1000, "connection admission interrupted");
    } catch {
      // An upgrade already torn down by the transport needs no further close.
    }
    check();
  }
  return { socket, region: route.id };
}

async function boundedAdmission(
  request: Request,
  env: Env,
  hints: Hints,
  cid: string,
  ctx: ExecutionContext,
  timings: Timings,
): Promise<{ socket: WebSocket; region: string }> {
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
  const admission = Promise.race([
    interrupted,
    admit(request, env, hints, cid, controller.signal, deadline, ctx, timings),
  ]);
  ctx.waitUntil(
    admission.then(
      () => undefined,
      () => undefined,
    ),
  );
  try {
    return await admission;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", refuse);
  }
}

function refused(failure: AdmissionFailure): Response {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].send(encodeErrorResponse(failure.sqlstate, failure.message));
  pair[1].close(1000, "connection refused");
  return new Response(null, { status: 101, webSocket: pair[0] });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz")
      return Response.json({ status: "ok" });
    if (url.pathname !== "/v2")
      return new Response("Not found", { status: 404 });
    if (
      request.method !== "GET" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    )
      return new Response("WebSocket upgrade required", { status: 426 });
    const started = Date.now();
    const cid = crypto.randomUUID();
    const timings: Timings = {};
    let hints: Hints | null = null;
    let region: string | null = null;
    let outcome = "accepted";
    try {
      hints = routingHints(url);
      const upstream = await boundedAdmission(
        request,
        env,
        hints,
        cid,
        ctx,
        timings,
      );
      region = upstream.region;
      // Attaching an unopened socket delegates the stream to the runtime.
      return new Response(null, { status: 101, webSocket: upstream.socket });
    } catch (error) {
      const failure =
        error instanceof AdmissionFailure
          ? error
          : new AdmissionFailure("08006", "gateway connection failed");
      outcome = failure.sqlstate;
      return failure.decoy && hints
        ? decoyResponse(hints, env.ROUTE_MASTER_KEYS, request.signal, ctx)
        : refused(failure);
    } finally {
      console.log(
        JSON.stringify({
          event: "conn_admission",
          // The gateway receives the same cid in the route token.
          cid,
          // The Cloudflare location that admitted the connection; none on a service binding.
          colo: request.cf?.colo ?? null,
          database_id: hints?.database ?? null,
          user: hints?.user ?? null,
          region_id: region,
          duration_ms: Math.max(0, Date.now() - started),
          // Where an admission spent its time; each key is present only for a stage that ran.
          ...timings,
          outcome,
        }),
      );
    }
  },
} satisfies ExportedHandler<Env>;
