// SPDX-License-Identifier: Apache-2.0
// Specific modules, never the contracts barrel: a cold isolate evaluates only what it imports.
import { isDatabaseId, isRoleName } from "@pgcf/contracts/ids";
import { encodeErrorResponse } from "@pgcf/contracts/pg-wire";
import {
  AdmissionFailure,
  admitRoute,
  bounded,
  type AdmissionTimings,
  type Hints,
} from "./admission.ts";
import type { Env } from "./env.ts";
import { decoyResponse } from "./decoy.ts";
import { connectGateway } from "./gateway.ts";

/** Milliseconds of each admission stage that ran, logged with the admission. */
interface Timings extends AdmissionTimings {
  gateway_connect_ms?: number;
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

/** Admits the connection and opens its WebSocket to the region's gateway. */
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
  const { region, token } = await admitRoute(
    request,
    env,
    hints,
    cid,
    signal,
    deadline,
    ctx,
    timings,
  );
  const gatewayStarted = Date.now();
  const socket = await connectGateway(region, token, env, signal);
  timings.gateway_connect_ms = Date.now() - gatewayStarted;
  if (signal.aborted) {
    try {
      socket.accept({ allowHalfOpen: true });
      socket.close(1000, "connection admission interrupted");
    } catch {
      // An upgrade already torn down by the transport needs no further close.
    }
    throw new AdmissionFailure("08006", "connection admission interrupted");
  }
  return { socket, region: region.id };
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
    if (url.pathname === "/sql")
      return (await import("./sql.ts")).serveSql(request, env, ctx);
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
      const routed = (hints = routingHints(url));
      const upstream = await bounded(request, ctx, (signal, deadline) =>
        admit(request, env, routed, cid, signal, deadline, ctx, timings),
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
