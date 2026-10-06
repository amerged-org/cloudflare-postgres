// SPDX-License-Identifier: Apache-2.0
import { createServer, type IncomingMessage } from "node:http";
import net, { type Socket } from "node:net";
import { createSocket } from "node:dgram";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import {
  BOOTSTRAP_RELAY_HEADER,
  BOOTSTRAP_RELAY_PATH,
  BOOTSTRAP_RELAY_IDENTITY_PATH,
  BOOTSTRAP_RELAY_PROBE_PATH,
  bootstrapRelayProbeSchema,
  bootstrapRelayIdentitySchema,
  bootstrapCapabilitySchema,
  bootstrapLiteralIpSchema,
  importBootstrapVerificationKeys,
  verifyBootstrapRelay,
  type BootstrapVerificationKeys,
} from "@pgcf/contracts/bootstrap-relay";
import {
  GatewayMemoryBudget,
  BudgetedWebSocketSocket,
  type MemoryLease,
} from "./gateway/frame-budget.ts";

export const BOOTSTRAP_RELAY_LIMITS = Object.freeze({
  frameBytes: 64 * 1024,
  connectionMemoryBytes: 512 * 1024,
  memoryBytes: 32 * 1024 * 1024,
  connections: 32,
  nonceEntries: 4096,
  queuedMessages: 32,
  incomingFrames: 65536,
  totalBytes: 1024 * 1024 * 1024,
  controlFrames: 128,
  connectMs: 5000,
  sessionMs: 600000,
});
export interface BootstrapRelayConfiguration {
  region: string;
  issuerRegion: string;
  allowedTargetRegions: readonly string[];
  host: string;
  port: number;
  keys: BootstrapVerificationKeys;
  memoryBytes?: number;
  connectionMemoryBytes?: number;
  connections?: number;
  sessionMs?: number;
}
function invalid(): never {
  throw new Error("bootstrap_relay_configuration_invalid");
}
function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    invalid();
  return value;
}
export async function readBootstrapRelayConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): Promise<BootstrapRelayConfiguration> {
  const names = [
    "PGCF_BOOTSTRAP_RELAY_REGION",
    "PGCF_BOOTSTRAP_RELAY_ISSUER_REGION",
    "PGCF_BOOTSTRAP_RELAY_HOST",
    "PGCF_BOOTSTRAP_RELAY_PORT",
    "PGCF_BOOTSTRAP_RELAY_PUBLIC_KEYS",
    "PGCF_BOOTSTRAP_RELAY_ALLOWED_TARGET_REGIONS",
  ];
  if (
    Object.keys(env).some(
      (name) =>
        name.startsWith("PGCF_BOOTSTRAP_RELAY_") && !names.includes(name),
    ) ||
    names.some((name) => typeof env[name] !== "string" || !env[name])
  )
    invalid();
  const host = bootstrapLiteralIpSchema.parse(env.PGCF_BOOTSTRAP_RELAY_HOST);
  if (!/^[1-9][0-9]{0,4}$/.test(env.PGCF_BOOTSTRAP_RELAY_PORT!)) invalid();
  const port = boundedInteger(Number(env.PGCF_BOOTSTRAP_RELAY_PORT), 1, 65535);
  if (env.PGCF_BOOTSTRAP_RELAY_ALLOWED_TARGET_REGIONS!.length > 2048) invalid();
  const identity = bootstrapRelayIdentitySchema.parse({
    v: 1,
    region: env.PGCF_BOOTSTRAP_RELAY_REGION,
    issuer_region: env.PGCF_BOOTSTRAP_RELAY_ISSUER_REGION,
    relay_epoch: randomUUID(),
    allowed_target_regions: JSON.parse(
      env.PGCF_BOOTSTRAP_RELAY_ALLOWED_TARGET_REGIONS!,
    ),
    capabilities: bootstrapCapabilitySchema.options,
  });
  if (env.PGCF_BOOTSTRAP_RELAY_PUBLIC_KEYS!.length > 2048) invalid();
  const keys = await importBootstrapVerificationKeys(
    JSON.parse(env.PGCF_BOOTSTRAP_RELAY_PUBLIC_KEYS!),
  );
  return {
    region: identity.region,
    issuerRegion: identity.issuer_region,
    allowedTargetRegions: identity.allowed_target_regions,
    host,
    port,
    keys,
  };
}
function reject(socket: Socket, status: 401 | 404 | 503): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  const timer = setTimeout(() => socket.destroy(), 500);
  timer.unref();
  socket.once("close", () => clearTimeout(timer));
}
function singleToken(request: IncomingMessage): string | undefined {
  const header = BOOTSTRAP_RELAY_HEADER.toLowerCase();
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2)
    if (request.rawHeaders[index]!.toLowerCase() === header) count++;
  const value = request.headers[header];
  return count === 1 && typeof value === "string" ? value : undefined;
}
async function probeSource(address: string, port: number): Promise<string> {
  const socket = createSocket(net.isIP(address) === 4 ? "udp4" : "udp6");
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("probe_route_unavailable")),
        1000,
      );
      socket.once("error", () => {
        clearTimeout(timer);
        reject(new Error("probe_route_unavailable"));
      });
      socket.connect(port, address, () => {
        clearTimeout(timer);
        const source = socket.address().address;
        if (!net.isIP(source)) reject(new Error("probe_route_unavailable"));
        else resolve(source);
      });
    });
  } finally {
    try {
      socket.close();
    } catch {
      /* No route was established. */
    }
  }
}
export function createBootstrapRelay(
  configuration: BootstrapRelayConfiguration,
) {
  if (
    Object.keys(configuration).some(
      (name) =>
        ![
          "region",
          "issuerRegion",
          "allowedTargetRegions",
          "host",
          "port",
          "keys",
          "memoryBytes",
          "connectionMemoryBytes",
          "connections",
          "sessionMs",
        ].includes(name),
    )
  )
    invalid();
  const identity = bootstrapRelayIdentitySchema.parse({
    v: 1,
    region: configuration.region,
    issuer_region: configuration.issuerRegion,
    relay_epoch: randomUUID(),
    allowed_target_regions: configuration.allowedTargetRegions,
    capabilities: bootstrapCapabilitySchema.options,
  });
  bootstrapLiteralIpSchema.parse(configuration.host);
  boundedInteger(configuration.port, 0, 65535);
  if (
    !(configuration.keys instanceof Map) ||
    configuration.keys.size < 1 ||
    configuration.keys.size > 8
  )
    invalid();
  for (const [kid, key] of configuration.keys)
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(kid) ||
      key.type !== "public" ||
      key.algorithm.name !== "Ed25519" ||
      !key.usages.includes("verify")
    )
      invalid();
  const keys = new Map(configuration.keys);
  const connections = boundedInteger(
    configuration.connections ?? BOOTSTRAP_RELAY_LIMITS.connections,
    1,
    BOOTSTRAP_RELAY_LIMITS.connections,
  );
  const memoryBytes = boundedInteger(
    configuration.memoryBytes ?? BOOTSTRAP_RELAY_LIMITS.memoryBytes,
    256 * 1024,
    BOOTSTRAP_RELAY_LIMITS.memoryBytes,
  );
  const connectionMemoryBytes = boundedInteger(
    configuration.connectionMemoryBytes ??
      BOOTSTRAP_RELAY_LIMITS.connectionMemoryBytes,
    128 * 1024,
    Math.min(memoryBytes, BOOTSTRAP_RELAY_LIMITS.connectionMemoryBytes),
  );
  const sessionMs = boundedInteger(
    configuration.sessionMs ?? BOOTSTRAP_RELAY_LIMITS.sessionMs,
    50,
    BOOTSTRAP_RELAY_LIMITS.sessionMs,
  );
  const memory = new GatewayMemoryBudget(memoryBytes, connectionMemoryBytes),
    nonces = new Map<string, number>();
  const rawSockets = new Set<Socket>(),
    handshakeTimers = new Map<Socket, NodeJS.Timeout>(),
    active = new Set<() => void>();
  let pending = 0,
    closing = false;
  const probeStops = new Set<() => void>();
  const takeNonce = (nonce: string, expires: number): boolean => {
    for (const [value, expiry] of nonces)
      if (expiry <= Date.now() / 1000) nonces.delete(value);
    if (nonces.has(nonce) || nonces.size >= BOOTSTRAP_RELAY_LIMITS.nonceEntries)
      return false;
    nonces.set(nonce, expires);
    return true;
  };
  const server = createServer({ maxHeaderSize: 4096 }, (request, response) => {
    if (
      !closing &&
      request.method === "GET" &&
      request.url === BOOTSTRAP_RELAY_IDENTITY_PATH
    ) {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        Connection: "close",
      });
      response.end(JSON.stringify(identity));
    } else if (
      !closing &&
      request.method === "GET" &&
      request.url === BOOTSTRAP_RELAY_PROBE_PATH
    ) {
      if (pending + active.size >= connections) {
        response.writeHead(503, { Connection: "close", "Content-Length": "0" });
        response.end();
        return;
      }
      pending++;
      void (async () => {
        const checked = await verifyBootstrapRelay(singleToken(request), {
          keys,
          region: identity.region,
          issuer_region: identity.issuer_region,
          relay_epoch: identity.relay_epoch,
          allowedTargetRegions: identity.allowed_target_regions,
        });
        if (
          !checked.ok ||
          request.headers["transfer-encoding"] ||
          (request.headers["content-length"] !== undefined &&
            request.headers["content-length"] !== "0") ||
          !takeNonce(checked.claims.nonce, checked.claims.exp)
        ) {
          response.writeHead(401, {
            Connection: "close",
            "Content-Length": "0",
          });
          response.end();
          return;
        }
        const claims = checked.claims,
          source = await probeSource(claims.target.address, claims.target.port);
        if (closing || response.destroyed || Date.now() / 1000 >= claims.exp)
          throw new Error("probe_closed");
        const owner = memory.owner(claims.nonce),
          baseline = owner.lease();
        if (!baseline.grow(16 * 1024)) {
          owner.close();
          throw new Error("probe_capacity");
        }
        let stop: (() => void) | undefined;
        try {
          const outcome = await new Promise<
            "connected" | "refused" | "timed_out"
          >((resolve, reject) => {
            const socket = net.connect({
              host: claims.target.address,
              port: claims.target.port,
              localAddress: source,
              family: net.isIP(source),
              autoSelectFamily: false,
            });
            let settled = false;
            const finish = (value?: "connected" | "refused" | "timed_out") => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              socket.destroy();
              if (value) resolve(value);
              else reject(new Error("probe_inconclusive"));
            };
            const timer = setTimeout(() => finish("timed_out"), 3000);
            stop = () => finish();
            probeStops.add(stop);
            response.once("close", stop);
            socket.once("connect", () => {
              if (socket.localAddress !== source) finish();
              else finish("connected");
            });
            socket.once("error", (error: NodeJS.ErrnoException) =>
              finish(error.code === "ECONNREFUSED" ? "refused" : undefined),
            );
          });
          const value = bootstrapRelayProbeSchema.parse({
            version: 1,
            relay_epoch: identity.relay_epoch,
            operation_id: claims.operation,
            node_id: claims.node,
            region_id: claims.region,
            revision: claims.revision,
            address: claims.target.address,
            source,
            port: claims.target.port,
            outcome,
            observed_at: new Date().toISOString(),
          });
          response.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            Connection: "close",
          });
          response.end(JSON.stringify(value));
        } finally {
          if (stop) {
            probeStops.delete(stop);
            response.off("close", stop);
          }
          owner.close();
        }
      })()
        .catch(() => {
          if (!response.destroyed && !response.headersSent) {
            response.writeHead(503, {
              Connection: "close",
              "Content-Length": "0",
            });
            response.end();
          }
        })
        .finally(() => {
          pending--;
        });
    } else {
      response.writeHead(closing ? 503 : 404, {
        "Content-Length": "0",
        Connection: "close",
      });
      response.end();
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxConnections = connections * 2;
  server.on("connection", (socket) => {
    rawSockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), 5000);
    timer.unref();
    handshakeTimers.set(socket, timer);
    socket.once("close", () => {
      rawSockets.delete(socket);
      clearTimeout(timer);
      handshakeTimers.delete(socket);
    });
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  const websockets = new WebSocketServer({
    noServer: true,
    maxPayload: BOOTSTRAP_RELAY_LIMITS.frameBytes,
    perMessageDeflate: false,
    autoPong: false,
  });
  server.on("upgrade", (request, raw, head) => {
    const socket = raw as Socket;
    socket.on("error", () => {});
    if (
      closing ||
      request.method !== "GET" ||
      request.url !== BOOTSTRAP_RELAY_PATH
    ) {
      reject(socket, 404);
      return;
    }
    if (pending + active.size >= connections) {
      reject(socket, 503);
      return;
    }
    pending++;
    void (async () => {
      const checked = await verifyBootstrapRelay(singleToken(request), {
        keys,
        region: identity.region,
        issuer_region: identity.issuer_region,
        relay_epoch: identity.relay_epoch,
        allowedTargetRegions: identity.allowed_target_regions,
      });
      if (!checked.ok) {
        reject(socket, 401);
        return;
      }
      const nonce = checked.claims.nonce;
      if (!takeNonce(nonce, checked.claims.exp)) {
        reject(socket, 401);
        return;
      }
      if (closing || socket.destroyed) return;
      clearTimeout(handshakeTimers.get(socket));
      handshakeTimers.delete(socket);
      const owner = memory.owner(nonce),
        baseline = owner.lease();
      if (!baseline.grow(16 * 1024)) {
        owner.close();
        reject(socket, 503);
        return;
      }
      const ingress = new BudgetedWebSocketSocket(
        socket,
        owner,
        BOOTSTRAP_RELAY_LIMITS.frameBytes,
        head,
      );
      socket.once("close", () => owner.close());
      ingress.once("rejected", () => ingress.destroy());
      try {
        websockets.handleUpgrade(
          request,
          ingress,
          Buffer.alloc(0),
          (client) => {
            client.binaryType = "nodebuffer";
            const upstream = net.connect({
              host: checked.claims.target.address,
              port: checked.claims.target.port,
              family: net.isIP(checked.claims.target.address),
              autoSelectFamily: false,
            });
            const queue: { bytes: Buffer; lease: MemoryLease }[] = [];
            let stopped = false,
              connected = false,
              writing = false,
              sending = false,
              remoteEnded = false,
              incomingFrames = 0,
              controlFrames = 0,
              totalBytes = 0;
            const stop = () => {
              if (stopped) return;
              stopped = true;
              clearTimeout(dialTimer);
              clearTimeout(lifetime);
              clearTimeout(closeTimer);
              queue.length = 0;
              upstream.destroy();
              client.terminate();
              ingress.destroy();
              owner.close();
              active.delete(stop);
            };
            active.add(stop);
            const dialTimer = setTimeout(
                stop,
                BOOTSTRAP_RELAY_LIMITS.connectMs,
              ),
              lifetime = setTimeout(stop, sessionMs);
            dialTimer.unref();
            lifetime.unref();
            let closeTimer: NodeJS.Timeout | undefined;
            const finish = () => {
              if (stopped || !remoteEnded || sending) return;
              client.close(1000);
              closeTimer ??= setTimeout(stop, 1000);
              closeTimer.unref();
            };
            const pump = () => {
              if (stopped || !connected || writing || queue.length === 0)
                return;
              const next = queue.shift()!;
              writing = true;
              client.pause();
              upstream.write(next.bytes, (error) => {
                next.lease.release();
                writing = false;
                if (error) {
                  stop();
                  return;
                }
                if (stopped) return;
                if (queue.length) pump();
                else client.resume();
              });
            };
            upstream.once("connect", () => {
              connected = true;
              clearTimeout(dialTimer);
              pump();
            });
            upstream.on("error", stop);
            upstream.once("end", () => {
              remoteEnded = true;
              finish();
            });
            upstream.once("close", () => {
              if (!remoteEnded) stop();
            });
            upstream.on("data", (bytes: Buffer) => {
              if (stopped) return;
              upstream.pause();
              sending = true;
              totalBytes += bytes.length;
              const lease = owner.lease();
              if (
                bytes.length > BOOTSTRAP_RELAY_LIMITS.frameBytes ||
                totalBytes > BOOTSTRAP_RELAY_LIMITS.totalBytes ||
                !lease.grow(bytes.length * 2 + 256)
              ) {
                lease.release();
                stop();
                return;
              }
              client.send(bytes, { binary: true, compress: false }, (error) => {
                lease.release();
                sending = false;
                if (error) {
                  stop();
                  return;
                }
                if (stopped) return;
                if (remoteEnded) finish();
                else upstream.resume();
              });
            });
            client.on("message", (bytes, binary) => {
              const lease = ingress.takeMessage();
              if (!lease) {
                stop();
                return;
              }
              incomingFrames++;
              totalBytes += Buffer.isBuffer(bytes) ? bytes.length : 0;
              if (
                stopped ||
                !binary ||
                !Buffer.isBuffer(bytes) ||
                incomingFrames > BOOTSTRAP_RELAY_LIMITS.incomingFrames ||
                totalBytes > BOOTSTRAP_RELAY_LIMITS.totalBytes ||
                queue.length >= BOOTSTRAP_RELAY_LIMITS.queuedMessages
              ) {
                lease.release();
                stop();
                return;
              }
              queue.push({ bytes, lease });
              pump();
            });
            client.on("ping", (bytes) => {
              if (++controlFrames > BOOTSTRAP_RELAY_LIMITS.controlFrames) {
                stop();
                return;
              }
              client.pong(bytes, undefined, (error) => {
                if (error) stop();
              });
            });
            client.on("pong", () => {
              if (++controlFrames > BOOTSTRAP_RELAY_LIMITS.controlFrames)
                stop();
            });
            client.once("close", stop);
            client.on("error", stop);
          },
        );
      } catch {
        ingress.destroy();
        owner.close();
      }
    })()
      .catch(() => reject(socket, 401))
      .finally(() => {
        pending--;
      });
  });
  return {
    server,
    identity,
    snapshot: () => ({
      connections: active.size,
      pending,
      nonces: nonces.size,
      memoryUsed: memory.used,
      memoryPeak: memory.peak,
    }),
    close: async () => {
      closing = true;
      for (const stop of [...active]) stop();
      for (const stop of [...probeStops]) stop();
      for (const socket of rawSockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => websockets.close(() => resolve())),
      ]);
    },
  };
}
