// SPDX-License-Identifier: Apache-2.0
import { isDatabaseId, isRoleName } from "@pgcf/contracts";
import {
  DEFAULT_MAX_BUFFERED,
  StartupReader,
  encodeEncryptionDeclined,
  encodeErrorResponse,
  type StartupEvent,
} from "@pgcf/contracts/pg-wire";
import { parseRouteKeyring, signRouteToken } from "@pgcf/contracts/route-token";
import type { Env } from "./env.ts";
import { connectGateway, type GatewayRegion } from "./gateway.ts";

export const STARTUP_DEADLINE_MS = 10_000;
const MAX_FRAME_BYTES = 64 * 1024;
const EMPTY = new Uint8Array(0);

interface RouteRow extends GatewayRegion {
  readonly role_name: string | null;
  readonly desired_state: string;
  readonly observed_state: string;
  readonly generation: number;
  readonly observed_generation: number;
}

// One read-only query retains the distinction between an absent database and
// an absent live role; role credentials are never selected by the data plane.
const ROUTE_QUERY = `
  SELECT d.desired_state, d.observed_state, d.generation, d.observed_generation,
         roles.name AS role_name, regions.id, regions.gateway_url,
         regions.gateway_binding
    FROM databases d
    JOIN regions ON regions.id = d.region_id
    LEFT JOIN roles ON roles.database_id = d.id AND roles.name = ?
                   AND roles.deleted_at IS NULL
   WHERE d.id = ? AND d.deleted_at IS NULL
   LIMIT 1`;

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz")
      return Response.json({ status: "ok" });
    if (
      request.method !== "GET" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    )
      return new Response("WebSocket upgrade required", { status: 426 });

    const pair = new WebSocketPair();
    const session = new EdgeSession(pair[1], env, ctx);
    const ip = request.headers.get("CF-Connecting-IP");
    session.checkRateLimit(ip);
    return new Response(null, { status: 101, webSocket: pair[0] });
  },
} satisfies ExportedHandler<Env>;

class EdgeSession {
  readonly #client: WebSocket;
  readonly #env: Env;
  readonly #ctx: ExecutionContext;
  readonly #reader = new StartupReader();
  readonly #started = Date.now();
  readonly #cid = crypto.randomUUID();
  readonly #abort = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #startupDone: () => void;
  #upstream: WebSocket | null = null;
  #stage: "startup" | "connecting" | "streaming" | "closed" = "startup";
  #queue: Uint8Array[] = [];
  #queuedBytes = 0;
  #rateAllowed: Promise<boolean> = Promise.resolve(false);
  #database: string | null = null;
  #bytesIn = 0;
  #bytesOut = 0;

  constructor(client: WebSocket, env: Env, ctx: ExecutionContext) {
    this.#client = client;
    this.#env = env;
    this.#ctx = ctx;
    let done!: () => void;
    ctx.waitUntil(
      new Promise<void>((resolve) => {
        done = resolve;
      }),
    );
    this.#startupDone = done;
    client.binaryType = "arraybuffer";
    client.accept({ allowHalfOpen: true });
    this.#timer = setTimeout(
      () => this.#fatal("08P01", "startup deadline exceeded"),
      STARTUP_DEADLINE_MS,
    );
    client.addEventListener("message", (event) => this.#fromClient(event));
    client.addEventListener("close", (event) =>
      this.#close(event.code, "client_closed"),
    );
    client.addEventListener("error", () => this.#close(1011, "client_error"));
  }

  checkRateLimit(ip: string | null): void {
    this.#rateAllowed = (async () => {
      try {
        const result =
          ip === null
            ? { success: false }
            : await this.#env.CONNECTION_RATE_LIMITER.limit({ key: ip });
        if (!result.success)
          this.#fatal("53300", "connection rate limit exceeded");
        return result.success;
      } catch {
        this.#fatal("53300", "connection admission unavailable");
        return false;
      }
    })();
    this.#ctx.waitUntil(this.#rateAllowed);
  }

  #fromClient(event: MessageEvent): void {
    if (this.#stage === "closed") return;
    if (typeof event.data === "string") {
      this.#close(1003, "text_frame");
      return;
    }
    if (!(event.data instanceof ArrayBuffer)) {
      this.#close(1003, "non_binary_frame");
      return;
    }
    const bytes = new Uint8Array(event.data);
    this.#bytesIn += bytes.length;
    if (this.#stage === "streaming") {
      try {
        this.#send(this.#upstream!, bytes);
      } catch {
        this.#close(1011, "gateway_send_error");
      }
      return;
    }
    if (this.#stage === "connecting") {
      this.#buffer(bytes);
      return;
    }
    let result = this.#reader.push(bytes);
    while (result.kind === "ssl" || result.kind === "gss") {
      try {
        this.#toClient(encodeEncryptionDeclined());
      } catch {
        this.#close(1011, "client_send_error");
        return;
      }
      result = this.#reader.push(EMPTY);
    }
    if (result.kind === "need-more") return;
    if (result.kind === "cancel") {
      this.#close(1000, "cancel");
      return;
    }
    if (result.kind === "error") {
      this.#fatal(result.sqlstate, result.message);
      return;
    }
    this.#stage = "connecting";
    if (!this.#buffer(result.raw) || !this.#buffer(result.rest)) return;
    this.#ctx.waitUntil(this.#route(result));
  }

  #buffer(bytes: Uint8Array): boolean {
    if (bytes.length > DEFAULT_MAX_BUFFERED - this.#queuedBytes) {
      this.#fatal("08P01", "too much data before gateway connection");
      return false;
    }
    if (bytes.length > 0) {
      this.#queue.push(bytes);
      this.#queuedBytes += bytes.length;
    }
    return true;
  }

  async #route(
    startup: Extract<StartupEvent, { kind: "startup" }>,
  ): Promise<void> {
    try {
      if (!(await this.#rateAllowed) || this.#isClosed()) return;
      if (!isDatabaseId(startup.database)) {
        this.#fatal("3D000", "database does not exist");
        return;
      }
      if (!isRoleName(startup.user)) {
        this.#fatal("28P01", "authentication failed");
        return;
      }
      const route = await this.#env.DB.prepare(ROUTE_QUERY)
        .bind(startup.user, startup.database)
        .first<RouteRow>();
      if (this.#isClosed()) return;
      if (route === null) {
        this.#fatal("3D000", "database does not exist");
        return;
      }
      if (route.role_name === null) {
        this.#fatal("28P01", "authentication failed");
        return;
      }
      if (
        route.desired_state !== "running" ||
        route.observed_state !== "ready" ||
        route.observed_generation !== route.generation
      ) {
        this.#fatal("57P03", "database is not accepting connections");
        return;
      }
      this.#database = startup.database;
      const token = await signRouteToken({
        keyring: parseRouteKeyring(this.#env.ROUTE_MASTER_KEYS),
        region: route.id,
        db: startup.database,
        cid: this.#cid,
      });
      if (this.#isClosed()) return;
      const upstream = await connectGateway(
        route,
        token,
        this.#env,
        this.#abort.signal,
      );
      if (this.#isClosed()) {
        upstream.accept({ allowHalfOpen: true });
        upstream.close(1000, "connection closed");
        return;
      }
      this.#upstream = upstream;
      upstream.binaryType = "arraybuffer";
      upstream.addEventListener("message", (event) => this.#fromGateway(event));
      upstream.addEventListener("close", (event) =>
        this.#close(event.code, "gateway_closed"),
      );
      upstream.addEventListener("error", () =>
        this.#close(1011, "gateway_error"),
      );
      upstream.accept({ allowHalfOpen: true });
      this.#stage = "streaming";
      // The flush is synchronous, so subsequent client events cannot overtake it.
      for (const bytes of this.#queue) this.#send(upstream, bytes);
      this.#queue = [];
      this.#queuedBytes = 0;
      clearTimeout(this.#timer);
      this.#startupDone();
    } catch {
      if (!this.#isClosed()) this.#fatal("08006", "gateway connection failed");
    }
  }

  #isClosed(): boolean {
    return this.#stage === "closed";
  }

  #fromGateway(event: MessageEvent): void {
    if (this.#stage !== "streaming") return;
    if (!(event.data instanceof ArrayBuffer)) {
      this.#close(1003, "gateway_text_frame");
      return;
    }
    try {
      this.#toClient(new Uint8Array(event.data));
    } catch {
      this.#close(1011, "client_send_error");
    }
  }

  #toClient(bytes: Uint8Array): void {
    this.#send(this.#client, bytes);
    this.#bytesOut += bytes.length;
  }

  #send(socket: WebSocket, bytes: Uint8Array): void {
    // Workers exposes neither drain nor a writable bufferedAmount. There is no
    // application queue after startup, but runtime transport buffering must be
    // measured by S2; frame slicing is not a backpressure guarantee.
    for (let offset = 0; offset < bytes.length; offset += MAX_FRAME_BYTES)
      socket.send(bytes.subarray(offset, offset + MAX_FRAME_BYTES));
  }

  #fatal(sqlstate: string, message: string): void {
    if (this.#isClosed()) return;
    try {
      this.#toClient(encodeErrorResponse(sqlstate, message));
    } catch {
      /* A disconnected client cannot receive the error. */
    }
    this.#close(1000, sqlstate);
  }

  #close(code: number, outcome: string): void {
    if (this.#isClosed()) return;
    this.#stage = "closed";
    clearTimeout(this.#timer);
    this.#abort.abort();
    this.#startupDone();
    this.#queue = [];
    this.#queuedBytes = 0;
    const safeCode = normalizeCloseCode(code);
    for (const socket of [this.#client, this.#upstream]) {
      try {
        socket?.close(safeCode, "connection closed");
      } catch {
        /* The other peer still needs its close. */
      }
    }
    console.log(
      JSON.stringify({
        event: "conn_close",
        cid: this.#cid,
        database_id: this.#database,
        ingress_bytes: this.#bytesIn,
        egress_bytes: this.#bytesOut,
        duration_ms: Math.max(0, Date.now() - this.#started),
        outcome,
      }),
    );
  }
}

export function normalizeCloseCode(code: number): number {
  if (code === 1005) return 1000;
  if (code === 1006 || code === 1015) return 1011;
  if (
    code === 1000 ||
    (code >= 1001 && code <= 1014 && code !== 1004) ||
    (code >= 3000 && code <= 4999)
  )
    return code;
  return 1011;
}
