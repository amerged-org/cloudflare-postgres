// SPDX-License-Identifier: Apache-2.0
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  ReplayCache,
  ROUTE_TOKEN_HEADER,
  verifyRouteToken,
  type RouteKeyring,
  type RouteTokenClaims,
} from "@pgcf/contracts/route-token";
import {
  StartupReader,
  encodeEncryptionDeclined,
  encodeErrorResponse,
} from "@pgcf/contracts/pg-wire";
import { databaseTarget, type PostgresDial } from "./postgres.ts";
import {
  BudgetedWebSocketSocket,
  GatewayMemoryBudget,
  DEFAULT_MEMORY_LIMIT_BYTES,
  DEFAULT_DATABASE_MEMORY_LIMIT_BYTES,
  type MemoryLease,
} from "./frame-budget.ts";

export const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_STARTUP_BUFFER_BYTES = 64 * 1024;
export {
  DEFAULT_MEMORY_LIMIT_BYTES,
  DEFAULT_DATABASE_MEMORY_LIMIT_BYTES,
} from "./frame-budget.ts";

export interface GatewayOptions {
  readonly region: string;
  readonly keyring: RouteKeyring;
  readonly dial: PostgresDial;
  readonly databaseLimit?: number;
  readonly totalLimit?: number;
  readonly memoryLimitBytes?: number;
  readonly databaseMemoryLimitBytes?: number;
  readonly replayCache?: ReplayCache;
  readonly heartbeatMs?: number;
  readonly drainMs?: number;
  readonly startupTimeoutMs?: number;
  readonly log?: (event: Readonly<Record<string, string | number>>) => void;
}

export interface Gateway {
  readonly server: Server;
  readonly metrics: {
    activeConnections: number;
    peakBufferedBytes: number;
    readonly memoryBytes: number;
    readonly peakMemoryBytes: number;
  };
  drain(): Promise<void>;
}

export function createGateway(options: GatewayOptions): Gateway {
  const databaseLimit = options.databaseLimit ?? 200;
  const totalLimit = options.totalLimit ?? 2_000;
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const drainMs = options.drainMs ?? 30_000;
  const startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
  for (const limit of [
    databaseLimit,
    totalLimit,
    heartbeatMs,
    drainMs,
    startupTimeoutMs,
  ])
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError("invalid gateway limits");
  const memory = new GatewayMemoryBudget(
    options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES,
    options.databaseMemoryLimitBytes ?? DEFAULT_DATABASE_MEMORY_LIMIT_BYTES,
  );
  const replay = options.replayCache ?? new ReplayCache();
  const log =
    options.log ??
    ((event) => process.stdout.write(`${JSON.stringify(event)}\n`));
  const counts = new Map<string, number>();
  const pending = new Set<AbortController>();
  const clients = new Set<WebSocket>();
  const sockets = new Set<Socket>();
  const metrics = {
    activeConnections: 0,
    peakBufferedBytes: 0,
    get memoryBytes() {
      return memory.used;
    },
    get peakMemoryBytes() {
      return memory.peak;
    },
  };
  let draining = false;
  let closing = false;
  let drainPromise: Promise<void> | undefined;
  let empty: (() => void) | undefined;
  const websockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
    allowSynchronousEvents: true,
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
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    if (closing) socket.destroy();
  });
  server.on("clientError", (_error, socket) => rejectUpgrade(socket, 400));
  server.on("upgrade", (request, socket, head) => {
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
    const now = Date.now();
    const verified = await verifyRouteToken(token, {
      region: options.region,
      keys: options.keyring.keys,
      now,
    });
    if (socket.destroyed || socket.readableEnded || request.aborted) {
      socket.destroy();
      return;
    }
    if (!verified.ok) {
      rejectUpgrade(socket, verified.reason === "wrong_region" ? 403 : 401);
      return;
    }
    const claims = verified.claims;
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
    const used = replay.use(claims.db, claims.cid, claims.exp, now);
    if (used !== "fresh") {
      release();
      rejectUpgrade(socket, used === "replayed" ? 403 : 429);
      return;
    }
    let accepted = false;
    const ingress = new BudgetedWebSocketSocket(
      socket,
      memory.owner(claims.db),
      MAX_PAYLOAD_BYTES,
      head,
    );
    try {
      websockets.handleUpgrade(request, ingress, Buffer.alloc(0), (client) => {
        accepted = true;
        clients.add(client);
        client.binaryType = "fragments";
        startup(client, ingress, request, claims, release);
      });
    } finally {
      if (!accepted) {
        ingress.destroy();
        release();
      }
    }
  }

  function startup(
    client: WebSocket,
    socket: BudgetedWebSocketSocket,
    request: IncomingMessage,
    claims: RouteTokenClaims,
    release: () => void,
  ): void {
    const abort = new AbortController();
    const reader = new StartupReader(MAX_STARTUP_BUFFER_BYTES);
    const started = Date.now();
    const queue: Buffer[] = [];
    const startupMemory = socket.memory.lease();
    const queueMemory = socket.memory.lease();
    let queuedBytes = 0;
    let bytesOut = 0;
    let connecting = false;
    let finished = false;
    let handedOff = false;
    let alive = true;
    let postgres: TLSSocket | undefined;
    let closingDeadline: NodeJS.Timeout | undefined;
    pending.add(abort);

    const finish = (outcome: string) => {
      if (finished || handedOff) return;
      finished = true;
      clearTimeout(deadline);
      clearInterval(heartbeat);
      pending.delete(abort);
      abort.abort();
      postgres?.destroy();
      queue.length = 0;
      clients.delete(client);
      release();
      log({
        event: "conn_close",
        database: claims.db,
        connection: claims.cid,
        bytes_in: 0,
        bytes_out: bytesOut,
        duration_ms: Date.now() - started,
        outcome,
      });
    };
    const close = (
      code: number,
      outcome: string,
      error?: { sqlstate: string; message: string },
    ) => {
      if (finished || handedOff) return;
      const packet = error
        ? encodeErrorResponse(error.sqlstate, error.message)
        : undefined;
      if (packet) bytesOut += packet.byteLength;
      finish(outcome);
      closingDeadline = setTimeout(() => client.terminate(), 500);
      closingDeadline.unref();
      if (client.readyState !== WebSocket.OPEN) {
        client.terminate();
        return;
      }
      if (packet)
        client.send(packet, { binary: true }, (error) => {
          if (error) client.terminate();
          else client.close(code, "connection closed");
        });
      else client.close(code, "connection closed");
    };
    const disconnected = () => {
      finish("client_closed");
      client.terminate();
    };
    const clientClosed = () => {
      clearTimeout(closingDeadline);
      finish("client_closed");
    };
    const clientError = () => {
      if (finished || handedOff) return;
      finish("websocket_error");
      closingDeadline = setTimeout(() => client.terminate(), 500);
      closingDeadline.unref();
      if (client.readyState === WebSocket.OPEN)
        client.close(1011, "connection closed");
      socket.closeAfterFlush();
    };
    const pong = () => {
      alive = true;
    };
    const interrupted = () => close(1012, "gateway_draining");
    const deadline = setTimeout(
      () =>
        close(1000, "startup_timeout", {
          sqlstate: "08006",
          message: "database connection startup timed out",
        }),
      startupTimeoutMs,
    );
    deadline.unref();
    const heartbeat = setInterval(() => {
      if (!alive) {
        finish("heartbeat_timeout");
        client.terminate();
        return;
      }
      alive = false;
      if (client.readyState === WebSocket.OPEN) client.ping();
    }, heartbeatMs);
    heartbeat.unref();

    const enqueue = (chunk: Buffer): boolean => {
      if (chunk.length === 0) return true;
      if (chunk.length > MAX_STARTUP_BUFFER_BYTES - queuedBytes) {
        close(1013, "startup_buffer_full", {
          sqlstate: "08P01",
          message: "too much data before database connection",
        });
        return false;
      }
      if (!queueMemory.grow(chunk.length * 2 + 256)) {
        socket.rejectMemory();
        return false;
      }
      queuedBytes += chunk.length;
      queue.push(chunk);
      metrics.peakBufferedBytes = Math.max(
        metrics.peakBufferedBytes,
        queuedBytes,
      );
      return true;
    };
    const connect = async () => {
      try {
        postgres = await options.dial(databaseTarget(claims.db), abort.signal);
        if (
          finished ||
          draining ||
          abort.signal.aborted ||
          client.readyState !== WebSocket.OPEN ||
          socket.destroyed ||
          socket.readableEnded ||
          postgres.destroyed ||
          postgres.readableEnded
        ) {
          postgres.destroy();
          close(1012, "gateway_draining");
          return;
        }
        handedOff = true;
        pending.delete(abort);
        clearTimeout(deadline);
        clearInterval(heartbeat);
        abort.signal.removeEventListener("abort", interrupted);
        socket.removeListener("close", disconnected);
        socket.removeListener("end", disconnected);
        socket.removeListener("error", disconnected);
        request.removeListener("aborted", disconnected);
        client.removeListener("close", clientClosed);
        client.removeListener("error", clientError);
        client.removeListener("pong", pong);
        client.removeListener("message", message);
        socket.removeListener("rejected", rejected);
        startupMemory.release();
        const initial = queue.splice(0);
        relay(
          client,
          socket,
          postgres,
          claims.db,
          claims.cid,
          release,
          initial,
          queueMemory,
          started,
          bytesOut,
        );
      } catch {
        close(1000, "postgres_connect_error", {
          sqlstate: "08006",
          message: "database connection failed",
        });
      }
    };
    const message = (data: RawData, binary: boolean) => {
      const lease = socket.takeMessage();
      try {
        if (finished || handedOff) return;
        for (const chunk of toBuffers(data)) receive(chunk, binary);
      } finally {
        lease?.release();
      }
    };
    const receive = (chunk: Buffer, binary: boolean) => {
      if (finished || handedOff) return;
      if (!binary) {
        close(1003, "text_frame");
        return;
      }
      if (connecting) {
        enqueue(chunk);
        return;
      }
      if (!startupMemory.grow(chunk.length * 4 + 256)) {
        socket.rejectMemory();
        return;
      }
      let event = reader.push(chunk);
      for (;;) {
        if (event.kind === "need-more") return;
        if (event.kind === "ssl" || event.kind === "gss") {
          const packet = encodeEncryptionDeclined();
          bytesOut += packet.byteLength;
          client.send(packet, { binary: true }, (error) => {
            if (error) clientError();
          });
          event = reader.push(new Uint8Array(0));
          continue;
        }
        if (event.kind === "cancel") {
          close(1000, "cancel");
          return;
        }
        if (event.kind === "error") {
          close(1000, "startup_error", event);
          return;
        }
        if (event.database !== claims.db || event.user !== claims.user) {
          close(1000, "startup_route_mismatch", {
            sqlstate: "28000",
            message: "startup does not match the authorized route",
          });
          return;
        }
        if (
          !enqueue(Buffer.from(event.raw)) ||
          !enqueue(Buffer.from(event.rest))
        )
          return;
        connecting = true;
        void connect();
        return;
      }
    };
    const rejected = (code: number) =>
      close(code, code === 1013 ? "memory_limit" : "payload_limit");
    socket.on("rejected", rejected);
    socket.once("close", disconnected);
    socket.once("end", disconnected);
    socket.once("error", disconnected);
    request.once("aborted", disconnected);
    client.once("close", clientClosed);
    client.on("error", clientError);
    client.on("pong", pong);
    client.on("message", message);
    abort.signal.addEventListener("abort", interrupted, { once: true });
    if (draining) interrupted();
    else if (socket.destroyed || socket.readableEnded || request.aborted)
      disconnected();
  }

  function relay(
    client: WebSocket,
    ingress: BudgetedWebSocketSocket,
    postgres: TLSSocket,
    database: string,
    connection: string,
    release: () => void,
    initial: readonly Buffer[],
    initialMemory: MemoryLease,
    started: number,
    initialBytesOut: number,
  ): void {
    let bytesIn = 0;
    let bytesOut = initialBytesOut;
    let alive = true;
    let finished = false;
    let outcome = "closed";
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
      ingress.closeAfterFlush();
    });
    client.once("close", finish);
    ingress.on("rejected", (code: number) => {
      outcome = code === 1013 ? "memory_limit" : "payload_limit";
      postgres.destroy();
      client.close(code, "relay buffer full");
    });
    const forward = (chunks: readonly Buffer[], lease?: MemoryLease) => {
      if (postgres.destroyed || client.readyState !== WebSocket.OPEN) {
        lease?.release();
        return;
      }
      const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
      if (postgres.writableLength + length > MAX_PAYLOAD_BYTES) {
        lease?.release();
        outcome = "backpressure_limit";
        postgres.destroy();
        client.close(1013, "relay buffer full");
        return;
      }
      if (chunks.length === 0) {
        lease?.release();
        return;
      }
      bytesIn += length;
      client.pause();
      let remaining = chunks.length;
      for (const chunk of chunks) {
        postgres.write(chunk, (error) => {
          if (--remaining === 0) lease?.release();
          if (error) {
            outcome = "postgres_error";
            client.terminate();
          }
        });
      }
      if (!postgres.writableNeedDrain) client.resume();
      buffered();
    };
    client.on("message", (data: RawData, binary: boolean) => {
      const lease = ingress.takeMessage();
      if (!binary) {
        lease?.release();
        outcome = "text_frame";
        postgres.destroy();
        client.close(1003, "binary frames required");
        return;
      }
      forward(toBuffers(data), lease);
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
      const lease = ingress.memory.lease();
      if (!lease.grow(chunk.length * 2 + 256)) {
        lease.release();
        ingress.rejectMemory();
        return;
      }
      let offset = 0;
      const send = () => {
        if (client.readyState !== WebSocket.OPEN || postgres.destroyed) {
          lease.release();
          return;
        }
        if (offset === chunk.length) {
          lease.release();
          postgres.resume();
          return;
        }
        const frame = chunk.subarray(offset, offset + MAX_FRAME_BYTES);
        offset += frame.length;
        bytesOut += frame.length;
        client.send(frame, { binary: true }, (error) => {
          if (error) {
            outcome = "websocket_error";
            lease.release();
            postgres.destroy();
            client.terminate();
          } else send();
        });
        buffered(chunk.length - offset);
      };
      send();
    });
    forward(initial, initialMemory);
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
        let closed: Promise<void> | undefined;
        const stop = () => {
          closing = true;
          closed ??= new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
          for (const attempt of pending) attempt.abort();
          for (const client of clients) client.terminate();
          for (const socket of sockets) socket.destroy();
          empty?.();
        };
        const deadline = setTimeout(stop, drainMs);
        const graceMs = Math.min(500, Math.max(1, Math.floor(drainMs / 4)));
        const wait = async (milliseconds: number) => {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, milliseconds);
            empty = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          empty = undefined;
        };
        try {
          if (metrics.activeConnections !== 0) await wait(drainMs - graceMs);
          if (!closing) {
            for (const client of clients)
              client.close(1012, "gateway restarting");
            if (clients.size !== 0) await wait(graceMs);
          }
          stop();
          await closed;
          websockets.close();
        } finally {
          clearTimeout(deadline);
          empty = undefined;
        }
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
    request.headers["sec-websocket-protocol"] === undefined &&
    typeof key === "string" &&
    /^[A-Za-z0-9+/]{22}==$/.test(key) &&
    Buffer.from(key, "base64").length === 16 &&
    tokenHeaders <= 1
  );
}

function rejectUpgrade(socket: Duplex, status: number): void {
  if (socket.destroyed) return;
  const deadline = setTimeout(() => socket.destroy(), 500);
  deadline.unref();
  socket.once("close", () => clearTimeout(deadline));
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
    () => socket.destroy(),
  );
}

function toBuffers(data: RawData): readonly Buffer[] {
  if (Buffer.isBuffer(data)) return [data];
  if (Array.isArray(data)) return data;
  return [Buffer.from(data)];
}
