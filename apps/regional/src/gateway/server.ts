// SPDX-License-Identifier: Apache-2.0
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  ReplayCache,
  ROUTE_TOKEN_HEADER,
  verifyRouteToken,
  type RouteKeyring,
} from "@pgcf/contracts/route-token";
import { databaseTarget, type PostgresDial } from "./postgres.ts";

export const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
export const MAX_FRAME_BYTES = 64 * 1024;

export interface GatewayOptions {
  readonly region: string;
  readonly keyring: RouteKeyring;
  readonly dial: PostgresDial;
  readonly databaseLimit?: number;
  readonly totalLimit?: number;
  readonly replayCache?: ReplayCache;
  readonly heartbeatMs?: number;
  readonly drainMs?: number;
  readonly log?: (event: Readonly<Record<string, string | number>>) => void;
}

export interface Gateway {
  readonly server: Server;
  readonly metrics: {
    activeConnections: number;
    peakBufferedBytes: number;
  };
  drain(): Promise<void>;
}

export function createGateway(options: GatewayOptions): Gateway {
  const databaseLimit = options.databaseLimit ?? 200;
  const totalLimit = options.totalLimit ?? 2_000;
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const drainMs = options.drainMs ?? 30_000;
  for (const limit of [databaseLimit, totalLimit, heartbeatMs, drainMs])
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError("invalid gateway limits");
  const replay = options.replayCache ?? new ReplayCache();
  const log =
    options.log ??
    ((event) => process.stdout.write(`${JSON.stringify(event)}\n`));
  const counts = new Map<string, number>();
  const pending = new Set<AbortController>();
  const clients = new Set<WebSocket>();
  const metrics = { activeConnections: 0, peakBufferedBytes: 0 };
  let draining = false;
  let drainPromise: Promise<void> | undefined;
  let empty: (() => void) | undefined;
  const websockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });
  const server = createServer((request, response) => {
    const path = request.url?.split("?", 1)[0];
    if (
      request.method === "GET" &&
      (path === "/healthz" || path === "/readyz")
    ) {
      response.writeHead(path === "/readyz" && draining ? 503 : 200, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
      });
      response.end(draining && path === "/readyz" ? "draining\n" : "ok\n");
    } else {
      response.writeHead(path === "/pg" ? 400 : 404, {
        "Content-Type": "text/plain",
      });
      response.end("WebSocket upgrade required\n");
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.maxConnections = totalLimit * 2;
  server.on("clientError", (_error, socket) => rejectUpgrade(socket, 400));
  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => {});
    void upgrade(request, socket, head).catch(() => rejectUpgrade(socket, 502));
  });

  const reserve = (database: string): (() => void) | undefined => {
    if (
      metrics.activeConnections >= totalLimit ||
      (counts.get(database) ?? 0) >= databaseLimit
    )
      return;
    counts.set(database, (counts.get(database) ?? 0) + 1);
    metrics.activeConnections++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (counts.get(database) ?? 1) - 1;
      if (remaining === 0) counts.delete(database);
      else counts.set(database, remaining);
      metrics.activeConnections--;
      if (metrics.activeConnections === 0) empty?.();
    };
  };

  async function upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    if (!validUpgrade(request) || head.length > MAX_FRAME_BYTES) {
      rejectUpgrade(socket, 400);
      return;
    }
    if (draining) {
      rejectUpgrade(socket, 503);
      return;
    }
    const value = request.headers[ROUTE_TOKEN_HEADER.toLowerCase()];
    const token = typeof value === "string" ? value : undefined;
    const verified = await verifyRouteToken(token, {
      region: options.region,
      keys: options.keyring.keys,
    });
    if (socket.destroyed) return;
    if (!verified.ok) {
      rejectUpgrade(socket, verified.reason === "wrong_region" ? 403 : 401);
      return;
    }
    const claims = verified.claims;
    const used = replay.use(claims.cid, claims.exp);
    if (used !== "fresh") {
      rejectUpgrade(socket, used === "replayed" ? 403 : 503);
      return;
    }
    if (draining) {
      rejectUpgrade(socket, 503);
      return;
    }
    const release = reserve(claims.db);
    if (!release) {
      rejectUpgrade(
        socket,
        (counts.get(claims.db) ?? 0) >= databaseLimit ? 429 : 503,
      );
      return;
    }
    const abort = new AbortController();
    const disconnected = () => abort.abort();
    socket.once("close", disconnected);
    pending.add(abort);
    let postgres: TLSSocket | undefined;
    let handedOff = false;
    try {
      postgres = await options.dial(databaseTarget(claims.db), abort.signal);
      if (socket.destroyed || draining || abort.signal.aborted) {
        postgres.destroy();
        if (!socket.destroyed) rejectUpgrade(socket, 503);
        return;
      }
      const upstream = postgres;
      websockets.handleUpgrade(request, socket, head, (client) => {
        handedOff = true;
        clients.add(client);
        relay(client, upstream, claims.db, claims.cid, release);
      });
    } catch {
      postgres?.destroy();
      if (!socket.destroyed) rejectUpgrade(socket, 502);
    } finally {
      pending.delete(abort);
      socket.removeListener("close", disconnected);
      if (!handedOff) {
        postgres?.destroy();
        release();
      }
    }
  }

  function relay(
    client: WebSocket,
    postgres: TLSSocket,
    database: string,
    connection: string,
    release: () => void,
  ): void {
    let bytesIn = 0;
    let bytesOut = 0;
    let alive = true;
    let finished = false;
    let outcome = "closed";
    const started = Date.now();
    const heartbeat = setInterval(() => {
      if (!alive) {
        outcome = "heartbeat_timeout";
        client.terminate();
        return;
      }
      alive = false;
      if (client.readyState === WebSocket.OPEN) client.ping();
    }, heartbeatMs);
    heartbeat.unref();
    const buffered = (additional = 0) => {
      metrics.peakBufferedBytes = Math.max(
        metrics.peakBufferedBytes,
        postgres.writableLength + client.bufferedAmount + additional,
      );
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      postgres.destroy();
      clients.delete(client);
      release();
      log({
        event: "conn_close",
        database,
        connection,
        bytes_in: bytesIn,
        bytes_out: bytesOut,
        duration_ms: Date.now() - started,
        outcome,
      });
    };
    client.on("pong", () => {
      alive = true;
    });
    client.on("error", () => {
      outcome = "websocket_error";
      postgres.destroy();
      if (client.readyState === WebSocket.OPEN)
        client.close(1011, "relay connection failed");
    });
    client.once("close", finish);
    client.on("message", (data: RawData, binary: boolean) => {
      if (!binary) {
        outcome = "text_frame";
        postgres.destroy();
        client.close(1003, "binary frames required");
        return;
      }
      if (postgres.destroyed || client.readyState !== WebSocket.OPEN) return;
      const chunk = toBuffer(data);
      if (postgres.writableLength + chunk.length > MAX_PAYLOAD_BYTES) {
        outcome = "backpressure_limit";
        postgres.destroy();
        client.close(1013, "relay buffer full");
        return;
      }
      bytesIn += chunk.length;
      client.pause();
      if (postgres.write(chunk)) client.resume();
      buffered();
    });
    postgres.on("drain", () => {
      if (client.readyState === WebSocket.OPEN) client.resume();
    });
    postgres.on("error", () => {
      outcome = "postgres_error";
      client.close(1011, "database connection closed");
    });
    postgres.on("end", () => {
      client.close(1000);
    });
    postgres.on("close", () => {
      if (client.readyState === WebSocket.OPEN) client.close(1000);
    });
    postgres.on("data", (chunk: Buffer) => {
      postgres.pause();
      let offset = 0;
      const send = () => {
        if (client.readyState !== WebSocket.OPEN || postgres.destroyed) return;
        if (offset === chunk.length) {
          postgres.resume();
          return;
        }
        const frame = chunk.subarray(offset, offset + MAX_FRAME_BYTES);
        offset += frame.length;
        bytesOut += frame.length;
        client.send(frame, { binary: true }, (error) => {
          if (error) {
            outcome = "websocket_error";
            postgres.destroy();
            client.terminate();
          } else send();
        });
        buffered(chunk.length - offset);
      };
      send();
    });
    postgres.resume();
  }

  return {
    server,
    metrics,
    drain() {
      if (drainPromise) return drainPromise;
      draining = true;
      for (const attempt of pending) attempt.abort();
      drainPromise = (async () => {
        if (metrics.activeConnections !== 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, drainMs);
            empty = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          empty = undefined;
        }
        for (const client of clients) client.close(1012, "gateway restarting");
        if (clients.size !== 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              for (const client of clients) client.terminate();
              resolve();
            }, 500);
            empty = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          empty = undefined;
        }
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        websockets.close();
      })();
      return drainPromise;
    },
  };
}

function validUpgrade(request: IncomingMessage): boolean {
  const key = request.headers["sec-websocket-key"];
  let tokenHeaders = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2)
    if (
      request.rawHeaders[i]?.toLowerCase() === ROUTE_TOKEN_HEADER.toLowerCase()
    )
      tokenHeaders++;
  return (
    request.method === "GET" &&
    request.url?.split("?", 1)[0] === "/pg" &&
    request.headers.upgrade?.toLowerCase() === "websocket" &&
    request.headers.connection
      ?.toLowerCase()
      .split(/\s*,\s*/)
      .includes("upgrade") === true &&
    request.headers["sec-websocket-version"] === "13" &&
    typeof key === "string" &&
    /^[A-Za-z0-9+/]{22}==$/.test(key) &&
    Buffer.from(key, "base64").length === 16 &&
    tokenHeaders <= 1
  );
}

function rejectUpgrade(socket: Duplex, status: number): void {
  if (socket.destroyed) return;
  const reasons: Record<number, string> = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    429: "Too Many Requests",
    502: "Bad Gateway",
    503: "Service Unavailable",
  };
  socket.end(
    `HTTP/1.1 ${status} ${reasons[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
