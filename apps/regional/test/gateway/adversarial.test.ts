// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { test } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import type { WebSocket } from "ws";
import { newDatabaseId } from "@pgcf/contracts";
import { encodeStartup } from "@pgcf/contracts/pg-wire";
import { DatabaseCaCache } from "../../src/gateway/ca.ts";
import {
  createPostgresDial,
  databaseTarget,
} from "../../src/gateway/postgres.ts";
import { MAX_PAYLOAD_BYTES } from "../../src/gateway/server.ts";
import {
  client,
  database,
  gatewayFor,
  listen,
  loopback,
  open,
  postgresServer,
  rejection,
  token,
  start,
  validCertificate,
  certificate,
} from "./helpers.ts";

function announce(socket: WebSocket, length: number): void {
  const header = Buffer.alloc(14);
  header[0] = 0x82;
  header[1] = 0xff;
  header.writeBigUInt64BE(BigInt(length), 2);
  crypto.getRandomValues(header.subarray(10));
  (socket as unknown as { _socket: Socket })._socket.write(header);
}
async function until(predicate: () => boolean): Promise<void> {
  for (let count = 0; count < 10_000; count++) {
    if (predicate()) return;
    await turn();
  }
  throw new Error("condition_not_reached");
}
function echo(socket: WebSocket, expected: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const timer = setTimeout(() => finish(new Error("echo_timeout")), 5_000);
    const closed = () => finish(new Error("echo_closed"));
    const message = (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
      length += chunk.length;
      if (length >= expected.length) {
        try {
          assert.deepEqual(Buffer.concat(chunks), expected);
          finish();
        } catch (error) {
          finish(error);
        }
      }
    };
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      socket.removeListener("message", message);
      socket.removeListener("close", closed);
      if (error) reject(error);
      else resolve();
    };
    socket.on("message", message);
    socket.once("close", closed);
    socket.send(expected);
  });
}

test("two pre-startup 32 MiB headers leave healthy 1 MiB messages and 200-byte queries usable in the same and another database", async (t) => {
  const postgres = await postgresServer();
  const otherDatabase = newDatabaseId();
  const otherCredentials = certificate(databaseTarget(otherDatabase).host);
  const otherPostgres = await postgresServer(otherCredentials);
  let contacts = 0;
  postgres.server.on("connection", () => contacts++);
  otherPostgres.server.on("connection", () => contacts++);
  const actualDial = createPostgresDial(
    new DatabaseCaCache(async (name) =>
      name === `ca-${database}` ? validCertificate.cert : otherCredentials.cert,
    ),
    {
      tcpConnect: (target) =>
        createConnection({
          host: loopback,
          port:
            target.host === databaseTarget(database).host
              ? postgres.port
              : otherPostgres.port,
        }),
    },
  );
  const { gateway, port } = await gatewayFor(postgres.port, {
    dial: actualDial,
  });
  const sockets: WebSocket[] = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.terminate());
    await gateway.drain();
    await postgres.close();
    await otherPostgres.close();
  });
  let closed = 0;
  const first = await open(port);
  sockets.push(first);
  first.on("close", () => closed++);
  announce(first, MAX_PAYLOAD_BYTES);
  await until(
    () => gateway.metrics.memoryBytes >= MAX_PAYLOAD_BYTES * 2 || closed > 0,
  );
  const second = await open(port);
  sockets.push(second);
  second.on("close", () => closed++);
  announce(second, MAX_PAYLOAD_BYTES);
  await until(() => closed > 0);
  assert.equal(
    contacts,
    0,
    "announced lengths cannot contact PostgreSQL before verified Startup",
  );
  const same = await open(port);
  sockets.push(same);
  await start(same);
  const other = await open(port, await token({ db: otherDatabase }));
  sockets.push(other);
  await start(other, { user: "app", database: otherDatabase });
  await echo(same, Buffer.alloc(1024 * 1024, 7));
  await echo(same, Buffer.alloc(200, 9));
  await echo(other, Buffer.alloc(1024 * 1024, 11));
  await echo(other, Buffer.alloc(200, 13));
  assert.equal(postgres.handshakes(), 1);
  assert.equal(otherPostgres.handshakes(), 1);
});

test("a pre-startup 32 MiB announced header is rejected before reserving relay-sized memory or contacting PostgreSQL", async (t) => {
  const postgres = await postgresServer();
  let contacts = 0;
  postgres.server.on("connection", () => contacts++);
  const { gateway, port } = await gatewayFor(postgres.port);
  const socket = await open(port);
  t.after(async () => {
    socket.terminate();
    await gateway.drain();
    await postgres.close();
  });
  const closed = once(socket, "close", { signal: AbortSignal.timeout(12_000) });
  announce(socket, MAX_PAYLOAD_BYTES);
  assert.equal((await closed)[0], 1009);
  assert.ok(gateway.metrics.peakMemoryBytes < 1024 * 1024);
  assert.equal(contacts, 0);
  assert.equal(gateway.metrics.memoryBytes, 0);
});

test("medium header-only frames after verified TLS handoff retain metadata rather than unreceived payload credit", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port);
  const sockets: WebSocket[] = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.terminate());
    await gateway.drain();
    await postgres.close();
  });
  for (let index = 0; index < 4; index++) {
    const socket = await open(port);
    sockets.push(socket);
    await start(socket);
    announce(socket, 1024 * 1024);
  }
  await until(() => gateway.metrics.memoryBytes > 0);
  assert.equal(postgres.handshakes(), 4);
  assert.ok(
    gateway.metrics.memoryBytes < 64 * 1024,
    "declared but unreceived medium payloads cannot consume the healthy reserve",
  );
});

test("a concurrent replay storm cannot dial again or reclaim a live database slot", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port, events } = await gatewayFor(postgres.port, {
    databaseLimit: 1,
  });
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const route = await token();
  const socket = await open(port, route);
  await start(socket);
  const statuses = await Promise.all(
    Array.from({ length: 24 }, () => rejection(port, route)),
  );
  assert.deepEqual(new Set(statuses), new Set([429]));
  assert.equal(await rejection(port, await token()), 429);
  assert.equal(postgres.handshakes(), 1);
  assert.equal(gateway.metrics.activeConnections, 1);
  const released = once(events, "conn_close");
  const closed = once(socket, "close");
  socket.close();
  await closed;
  await released;
  assert.equal(gateway.metrics.activeConnections, 0);
  assert.equal(await rejection(port, route), 403);
  assert.equal(postgres.handshakes(), 1);
  const next = await open(port);
  await start(next);
  assert.equal(postgres.handshakes(), 2);
  const nextReleased = once(events, "conn_close");
  const nextClosed = once(next, "close");
  next.close();
  await nextClosed;
  await nextReleased;
  assert.equal(gateway.metrics.activeConnections, 0);
});

test("a client disconnect cancels a pending PostgreSQL SSLRequest and releases its reservation", async (t) => {
  let reached!: (socket: Socket) => void;
  const requestReached = new Promise<Socket>((resolve) => {
    reached = resolve;
  });
  const peers = new Set<Socket>();
  // A real TCP peer holds the SSLRequest reply to keep TLS negotiation pending.
  const postgres = createServer((socket) => {
    peers.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => peers.delete(socket));
    socket.once("data", (bytes: Buffer) => {
      assert.deepEqual(bytes, Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]));
      reached(socket);
    });
  });
  const postgresPort = await listen(postgres);
  const ca = new DatabaseCaCache(async () => validCertificate.cert);
  const { gateway, port } = await gatewayFor(postgresPort, {
    databaseLimit: 1,
    dial: createPostgresDial(ca, {
      tcpConnect: () =>
        createConnection({ host: loopback, port: postgresPort }),
      timeoutMs: 10_000,
    }),
  });
  const route = await token();
  const socket = client(port, route);
  socket.on("error", () => {});
  t.after(async () => {
    socket.terminate();
    await gateway.drain();
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => postgres.close(() => resolve()));
  });
  await once(socket, "open");
  socket.send(encodeStartup({ user: "app", database }));
  const peer = await requestReached;
  assert.equal(gateway.metrics.activeConnections, 1);
  assert.equal(await rejection(port, route), 429);
  assert.equal(await rejection(port, await token()), 429);
  const upstreamClosed = once(peer, "close", {
    signal: AbortSignal.timeout(2_000),
  });
  socket.terminate();
  await upstreamClosed;
  assert.equal(gateway.metrics.activeConnections, 0);
  assert.equal(await rejection(port, route), 403);
  assert.equal(gateway.metrics.activeConnections, 0);
});
