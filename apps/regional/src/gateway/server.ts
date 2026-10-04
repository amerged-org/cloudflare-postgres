// SPDX-License-Identifier: Apache-2.0
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { isDatabaseId, isOperationId } from "@pgcf/contracts";
import { PostgresActivity, WebSocketInputActivity } from "./activity.ts";
import { GatewayMeasurements, type MeasurementSession } from "./telemetry.ts";
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
  readonly fenceSynchronization?: {
    readonly ready: boolean;
    readonly epoch: number;
  };
  readonly control?: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => boolean;
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
  readonly activityRecordLimit?: number;
  readonly log?: (event: Readonly<Record<string, string | number>>) => void;
}

/** Local transport acknowledgement; SQL transaction/prepared-work and WAL checks remain mandatory. */
export interface QuiesceReport {
  readonly database: string;
  readonly operation: string;
  readonly status: "idle" | "busy" | "closed";
  readonly connections: number;
  readonly busyConnections: number;
  readonly pendingDials: number;
}

interface SessionControl {
  readonly database: string;
  pause(): void;
  resume(): void;
  busy(): boolean;
  pendingDial(): boolean;
  authenticated(): boolean;
  close(): Promise<void>;
}

export interface Gateway {
  readonly server: Server;
  readonly metrics: {
    activeConnections: number;
    peakBufferedBytes: number;
    readonly memoryBytes: number;
    readonly peakMemoryBytes: number;
  };
  quiesceStatus(database: string, operation: string): QuiesceReport;
  beginQuiesce(database: string, operation: string): QuiesceReport;
  releaseQuiesce(database: string, operation: string): void;
  closeQuiesced(database: string, operation: string): Promise<QuiesceReport>;
  beginRetirement(database: string, operation: string): void;
  retirementStatus(database: string, operation: string): QuiesceReport;
  forgetRetirement(database: string, operation: string): void;
  activity(database: string): ReturnType<GatewayMeasurements["read"]> & {
    connections: number;
    authenticatedConnections: number;
    busyConnections: number;
    pendingDials: number;
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
  const measurements = new GatewayMeasurements({
    maxRecords: options.activityRecordLimit,
  });
  const replay = options.replayCache ?? new ReplayCache();
  const log =
    options.log ??
    ((event) => process.stdout.write(`${JSON.stringify(event)}\n`));
  const counts = new Map<string, number>();
  const pending = new Set<AbortController>();
  const sessions = new Map<WebSocket, SessionControl>();
  const fences = new Map<
    string,
    { operation: string; retired?: boolean; closing?: Promise<QuiesceReport> }
  >();
  const fenceEpochs = new Map<string, number>();
  let fenceEpoch = 0;
  const fenced = (database: string) => fences.has(database);
  const validateFence = (database: string, operation: string) => {
    if (!isDatabaseId(database) || !isOperationId(operation))
      throw new RangeError("invalid quiescence identity");
  };
  const matchingFence = (database: string, operation: string) => {
    validateFence(database, operation);
    const fence = fences.get(database);
    if (!fence || fence.operation !== operation)
      throw new Error("quiescence fence mismatch");
    return fence;
  };
  const report = (database: string, operation: string): QuiesceReport => {
    const owned = [...sessions.values()].filter(
      (session) => session.database === database,
    );
    const busyConnections = owned.filter((session) => session.busy()).length;
    return {
      database,
      operation,
      status: busyConnections === 0 ? "idle" : "busy",
      connections: owned.length,
      busyConnections,
      pendingDials: owned.filter((session) => session.pendingDial()).length,
    };
  };
  const closeClient = (client: WebSocket): Promise<void> =>
    new Promise((resolve) => {
      if (client.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      const deadline = setTimeout(() => client.terminate(), 500);
      client.once("close", () => {
        clearTimeout(deadline);
        resolve();
      });
      if (client.readyState === WebSocket.OPEN)
        client.close(1000, "database sleeping");
      else client.terminate();
    });
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
  const synchronized = () => options.fenceSynchronization?.ready ?? true;
  const server = createServer((request, response) => {
    if (options.control?.(request, response)) return;
    const path = request.url?.split("?", 1)[0];
    if (
      request.method === "GET" &&
      (path === "/healthz" || path === "/readyz")
    ) {
      response.writeHead(
        path === "/readyz" && (draining || !synchronized()) ? 503 : 200,
        {
          "Content-Type": "text/plain",
          "Cache-Control": "no-store",
        },
      );
      response.end(
        path === "/readyz" && draining
          ? "draining\n"
          : path === "/readyz" && !synchronized()
            ? "unsynchronized\n"
            : "ok\n",
      );
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
    if (draining || !synchronized()) {
      rejectUpgrade(socket, 503);
      return;
    }
    const value = request.headers[ROUTE_TOKEN_HEADER.toLowerCase()];
    const token = typeof value === "string" ? value : undefined;
    const now = Date.now();
    const admissionEpoch = fenceEpoch;
    const synchronizationEpoch = options.fenceSynchronization?.epoch;
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
    if (
      draining ||
      !synchronized() ||
      options.fenceSynchronization?.epoch !== synchronizationEpoch ||
      fenced(claims.db) ||
      (fenceEpochs.get(claims.db) ?? 0) > admissionEpoch
    ) {
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
      MAX_STARTUP_BUFFER_BYTES,
      head,
    );
    const wire = new WebSocketInputActivity();
    ingress.prependListener("data", (chunk: Buffer) => wire.observe(chunk));
    try {
      websockets.handleUpgrade(request, ingress, Buffer.alloc(0), (client) => {
        accepted = true;
        clients.add(client);
        client.binaryType = "fragments";
        startup(client, ingress, request, claims, release, wire);
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
    wire: WebSocketInputActivity,
  ): void {
    const abort = new AbortController();
    const reader = new StartupReader(MAX_STARTUP_BUFFER_BYTES);
    const started = Date.now();
    const measurement = measurements.begin(claims.db);
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
      sessions.delete(client);
      measurement.close();
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
      if (packet) {
        bytesOut += packet.byteLength;
        measurement.egress(packet.byteLength);
      }
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
      if (fenced(claims.db)) return;
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
    const parkedFailure = () =>
      close(1000, "postgres_connect_error", {
        sqlstate: "08006",
        message: "database connection failed",
      });
    const handoff = () => {
      if (!postgres) return;
      if (
        finished ||
        draining ||
        !synchronized() ||
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
      if (fenced(claims.db)) return;
      postgres.removeListener("error", parkedFailure);
      postgres.removeListener("close", parkedFailure);
      socket.setMaxPayload(MAX_PAYLOAD_BYTES);
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
        wire,
        measurement,
      );
    };
    const connect = async () => {
      try {
        if (!synchronized()) {
          parkedFailure();
          return;
        }
        postgres = await options.dial(databaseTarget(claims.db), abort.signal);
        postgres.once("error", parkedFailure);
        postgres.once("close", parkedFailure);
        handoff();
      } catch {
        close(1000, "postgres_connect_error", {
          sqlstate: "08006",
          message: "database connection failed",
        });
      }
    };
    sessions.set(client, {
      database: claims.db,
      pause: () => client.pause(),
      resume: () => {
        alive = true;
        if (postgres) handoff();
        if (!finished && !handedOff) client.resume();
      },
      busy: () => true,
      pendingDial: () => connecting && !postgres,
      authenticated: () => measurement.authenticated,
      close: () => closeClient(client),
    });
    const message = (data: RawData, binary: boolean) => {
      const lease = socket.takeMessage();
      wire.consumeMessage();
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
      measurement.ingress(chunk.length);
      if (chunk.length !== 0) measurement.clientActivity();
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
          measurement.egress(packet.byteLength);
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
      close(
        code,
        code === 1013 ? "memory_limit" : "payload_limit",
        code === 1009
          ? {
              sqlstate: "08P01",
              message: "too much data before database connection",
            }
          : undefined,
      );
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
    else if (fenced(claims.db)) client.pause();
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
    wire: WebSocketInputActivity,
    measurement: MeasurementSession,
  ): void {
    const activity = new PostgresActivity();
    const held: { chunks: readonly Buffer[]; lease?: MemoryLease }[] = [];
    let heldBytes = 0;
    let pendingWrites = 0;
    let outbound = 0;
    let bytesIn = 0;
    let bytesOut = initialBytesOut;
    let alive = true;
    let finished = false;
    let outcome = "closed";
    const heartbeat = setInterval(() => {
      if (fenced(database)) return;
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
      sessions.delete(client);
      measurement.close();
      for (const entry of held) entry.lease?.release();
      held.length = 0;
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
      pendingWrites += chunks.length;
      for (const chunk of chunks) {
        postgres.write(chunk, (error) => {
          pendingWrites--;
          if (--remaining === 0) lease?.release();
          if (error) {
            outcome = "postgres_error";
            client.terminate();
          }
        });
      }
      if (!postgres.writableNeedDrain && !fenced(database)) client.resume();
      buffered();
    };
    client.on("message", (data: RawData, binary: boolean) => {
      const lease = ingress.takeMessage();
      wire.consumeMessage();
      if (!binary) {
        lease?.release();
        outcome = "text_frame";
        postgres.destroy();
        client.close(1003, "binary frames required");
        return;
      }
      const chunks = toBuffers(data);
      const receivedBytes = chunks.reduce(
        (sum, chunk) => sum + chunk.length,
        0,
      );
      measurement.ingress(receivedBytes);
      if (receivedBytes !== 0) measurement.clientActivity();
      for (const chunk of chunks) activity.observeFrontend(chunk);
      if (fenced(database)) {
        const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        if (length > MAX_PAYLOAD_BYTES - heldBytes) {
          lease?.release();
          ingress.rejectMemory();
          return;
        }
        heldBytes += length;
        held.push({ chunks, lease });
        client.pause();
      } else forward(chunks, lease);
    });
    postgres.on("drain", () => {
      if (client.readyState === WebSocket.OPEN && !fenced(database))
        client.resume();
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
      activity.observeBackend(chunk);
      if (activity.authenticated) measurement.authenticate();
      outbound++;
      postgres.pause();
      const lease = ingress.memory.lease();
      if (
        !lease.grow(
          chunk.length * 2 + 256,
          chunk.length <= 1024 * 1024 ? chunk.length * 2 : 0,
        )
      ) {
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
          outbound--;
          lease.release();
          postgres.resume();
          return;
        }
        const frame = chunk.subarray(offset, offset + MAX_FRAME_BYTES);
        offset += frame.length;
        bytesOut += frame.length;
        measurement.egress(frame.length);
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
    sessions.set(client, {
      database,
      // Keep consuming until a complete post-fence message is retained, so partial input remains visible.
      pause: () => {},
      resume: () => {
        alive = true;
        for (const entry of held.splice(0)) forward(entry.chunks, entry.lease);
        heldBytes = 0;
        if (!postgres.writableNeedDrain && !finished) client.resume();
      },
      busy: () =>
        activity.busy ||
        wire.busy ||
        held.length !== 0 ||
        pendingWrites !== 0 ||
        outbound !== 0 ||
        ingress.readableLength !== 0 ||
        postgres.writableLength !== 0 ||
        client.bufferedAmount !== 0,
      pendingDial: () => false,
      authenticated: () => measurement.authenticated,
      close: () => closeClient(client),
    });
    for (const chunk of initial.slice(1)) activity.observeFrontend(chunk);
    forward(initial, initialMemory);
    postgres.resume();
  }

  return {
    server,
    metrics,
    activity(database) {
      const value = measurements.read(database);
      const owned = [...sessions.values()].filter(
        (session) => session.database === database,
      );
      return {
        ...value,
        connections: owned.length,
        authenticatedConnections: owned.filter((session) =>
          session.authenticated(),
        ).length,
        busyConnections: owned.filter((session) => session.busy()).length,
        pendingDials: owned.filter((session) => session.pendingDial()).length,
      };
    },
    quiesceStatus(database, operation) {
      validateFence(database, operation);
      if (fenced(database)) matchingFence(database, operation);
      return report(database, operation);
    },
    beginQuiesce(database, operation) {
      validateFence(database, operation);
      const current = fences.get(database);
      if (current && (current.retired || current.operation !== operation))
        throw new Error("quiescence fence mismatch");
      if (!current) {
        fences.set(database, { operation });
        fenceEpochs.set(database, ++fenceEpoch);
      }
      for (const session of sessions.values())
        if (session.database === database) session.pause();
      return report(database, operation);
    },
    releaseQuiesce(database, operation) {
      const current = matchingFence(database, operation);
      if (current.retired || current.closing)
        throw new Error("quiescence close in progress");
      fences.delete(database);
      for (const session of sessions.values())
        if (session.database === database) session.resume();
    },
    closeQuiesced(database, operation) {
      const current = matchingFence(database, operation);
      if (current.closing) return current.closing;
      const snapshot = report(database, operation);
      if (snapshot.status === "busy") return Promise.resolve(snapshot);
      current.closing = (async () => {
        await Promise.all(
          [...sessions.values()]
            .filter((session) => session.database === database)
            .map((session) => session.close()),
        );
        return { ...report(database, operation), status: "closed" as const };
      })();
      void current.closing.then(
        () => {
          current.closing = undefined;
        },
        () => {
          current.closing = undefined;
        },
      );
      return current.closing;
    },
    beginRetirement(database, operation) {
      validateFence(database, operation);
      const prior = fences.get(database);
      if (prior?.retired && prior.operation !== operation)
        throw new Error("retirement fence mismatch");
      if (!prior?.retired) {
        fences.set(database, { operation, retired: true });
        fenceEpochs.set(database, ++fenceEpoch);
      }
      // Keep reading transport closure/control frames; the terminal fence blocks frontend forwarding and dials.
    },
    retirementStatus(database, operation) {
      const fence = matchingFence(database, operation);
      if (!fence.retired) throw new Error("retirement fence mismatch");
      const value = report(database, operation);
      const connections = Math.max(
        value.connections,
        counts.get(database) ?? 0,
      );
      return {
        ...value,
        connections,
        status:
          connections === 0 && value.pendingDials === 0 ? "closed" : "busy",
      };
    },
    forgetRetirement(database, operation) {
      const fence = matchingFence(database, operation);
      const value = report(database, operation);
      if (
        !fence.retired ||
        (counts.get(database) ?? 0) !== 0 ||
        value.connections !== 0 ||
        value.pendingDials !== 0
      )
        throw new Error("retirement sessions remain");
      fences.delete(database);
      fenceEpochs.delete(database);
    },
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
