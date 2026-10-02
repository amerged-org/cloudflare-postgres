// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { test } from "node:test";
import { encodeStartup } from "@pgcf/contracts/pg-wire";
import { DatabaseCaCache } from "../../src/gateway/ca.ts";
import { createPostgresDial } from "../../src/gateway/postgres.ts";
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
} from "./helpers.ts";

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
