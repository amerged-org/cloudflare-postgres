// SPDX-License-Identifier: Apache-2.0
import { isDatabaseId, isRoleName } from "@pgcf/contracts";
import { encodeErrorResponse } from "@pgcf/contracts/pg-wire";
import { parseRouteKeyring, signRouteToken } from "@pgcf/contracts/route-token";
import type { Env } from "./env.ts";
import { connectGateway, type GatewayRegion } from "./gateway.ts";
import { ADMISSION_DEADLINE_MS, connectionRateKey } from "./session-policy.ts";

interface RouteRow extends GatewayRegion {
  readonly role_name: string | null;
  readonly desired_state: string;
  readonly observed_state: string;
}
interface Hints {
  readonly database: string;
  readonly user: string;
}

// Credentials never enter the data plane's read-only admission query.
const ROUTE_QUERY = `
  SELECT d.desired_state, d.observed_state,
         roles.name AS role_name, regions.id, regions.gateway_url,
         regions.gateway_binding
    FROM databases d
    JOIN regions ON regions.id = d.region_id
    LEFT JOIN roles ON roles.database_id = d.id AND roles.name = ?
                   AND roles.deleted_at IS NULL
   WHERE d.id = ? AND d.deleted_at IS NULL
   LIMIT 1`;

class AdmissionFailure extends Error {
  readonly sqlstate: string;
  constructor(sqlstate: string, message: string) {
    super(message);
    this.sqlstate = sqlstate;
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
  let connectionAllowed: boolean;
  let databaseAllowed: boolean;
  try {
    connectionAllowed = (await env.CONNECTION_RATE_LIMITER.limit({ key }))
      .success;
    check();
    if (!connectionAllowed)
      throw new AdmissionFailure("53300", "connection rate limit exceeded");
    databaseAllowed = (
      await env.DATABASE_CONNECTION_RATE_LIMITER.limit({ key: hints.database })
    ).success;
  } catch (error) {
    if (error instanceof AdmissionFailure) throw error;
    throw new AdmissionFailure("53300", "connection admission unavailable");
  }
  check();
  if (!databaseAllowed)
    throw new AdmissionFailure(
      "53300",
      "database connection rate limit exceeded",
    );
  const route = await env.DB.prepare(ROUTE_QUERY)
    .bind(hints.user, hints.database)
    .first<RouteRow>();
  check();
  if (route === null)
    throw new AdmissionFailure("3D000", "database does not exist");
  if (route.role_name === null)
    throw new AdmissionFailure("28P01", "authentication failed");
  if (route.desired_state !== "running" || route.observed_state !== "ready")
    throw new AdmissionFailure(
      "57P03",
      "database is not accepting connections",
    );
  const token = await signRouteToken({
    keyring: parseRouteKeyring(env.ROUTE_MASTER_KEYS),
    region: route.id,
    db: hints.database,
    user: hints.user,
    cid,
  });
  check();
  const socket = await connectGateway(route, token, env, signal);
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
): Promise<{ socket: WebSocket; region: string }> {
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
  const timer = setTimeout(abort, ADMISSION_DEADLINE_MS);
  const admission = Promise.race([
    interrupted,
    admit(request, env, hints, cid, controller.signal),
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
    let hints: Hints | null = null;
    let region: string | null = null;
    let outcome = "accepted";
    try {
      hints = routingHints(url);
      const upstream = await boundedAdmission(request, env, hints, cid, ctx);
      region = upstream.region;
      // Attaching an unopened socket delegates the stream to the runtime.
      return new Response(null, { status: 101, webSocket: upstream.socket });
    } catch (error) {
      const failure =
        error instanceof AdmissionFailure
          ? error
          : new AdmissionFailure("08006", "gateway connection failed");
      outcome = failure.sqlstate;
      return refused(failure);
    } finally {
      console.log(
        JSON.stringify({
          event: "conn_admission",
          cid,
          database_id: hints?.database ?? null,
          user: hints?.user ?? null,
          region_id: region,
          duration_ms: Math.max(0, Date.now() - started),
          outcome,
        }),
      );
    }
  },
} satisfies ExportedHandler<Env>;
