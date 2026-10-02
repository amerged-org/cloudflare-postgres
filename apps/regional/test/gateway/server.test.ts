// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ReplayCache } from "@pgcf/contracts/route-token";
import { DatabaseCaCache } from "../../src/gateway/ca.ts";
import {
  createPostgresDial,
  databaseTarget,
} from "../../src/gateway/postgres.ts";
import {
  MAX_FRAME_BYTES,
  MAX_PAYLOAD_BYTES,
} from "../../src/gateway/server.ts";
import {
  database,
  gatewayFor,
  loopback,
  open,
  otherCertificate,
  postgresServer,
  rejection,
  signedClaims,
  token,
  validCertificate,
} from "./helpers.ts";

test("rejects malformed upgrade, missing/bad token and wrong region before dial", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  assert.equal(await rejection(port, await token(), "/other"), 400);
  assert.equal(await rejection(port, undefined), 401);
  assert.equal(await rejection(port, `v1.${randomUUID()}`), 401);
  assert.equal(
    await rejection(port, await token({ region: `other-region` })),
    401,
  );
  assert.equal(
    await rejection(port, await signedClaims({ rg: "other-region" })),
    403,
  );
  assert.equal(
    await rejection(port, await token({ now: Date.now() - 60_000 })),
    401,
  );
  assert.equal(
    await rejection(port, await signedClaims({ db: "../invalid" })),
    401,
  );
  assert.equal(postgres.handshakes(), 0);
  const malformed = await new Promise<number>((resolve, reject) => {
    const req = request(
      {
        host: loopback,
        port,
        path: "/pg",
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Key": Buffer.alloc(16).toString("base64"),
          "Sec-WebSocket-Version": "12",
          "X-PGCF-Route": "invalid",
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(malformed, 400);
  const plain = await fetch(`http://${loopback}:${port}/pg`);
  assert.equal(plain.status, 400);
  assert.equal((await fetch(`http://${loopback}:${port}/healthz`)).status, 200);
  assert.equal((await fetch(`http://${loopback}:${port}/readyz`)).status, 200);
});

test("relays ten megabytes both directions through SSLRequest and verified TLS in bounded frames", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port, logs, events } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port);
  const payload = Buffer.alloc(10 * 1024 * 1024, 37);
  const chunks: Buffer[] = [];
  let received = 0;
  const echoed = new Promise<void>((resolve, reject) => {
    socket.on("message", (data, binary) => {
      assert.equal(binary, true);
      const chunk = Buffer.from(data as Buffer);
      assert.ok(chunk.length <= MAX_FRAME_BYTES);
      chunks.push(chunk);
      received += chunk.length;
      if (received === payload.length) resolve();
    });
    socket.once("error", reject);
  });
  socket.send(payload);
  await echoed;
  assert.deepEqual(Buffer.concat(chunks), payload);
  assert.equal(postgres.handshakes(), 1);
  const closed = once(socket, "close");
  const released = once(events, "conn_close");
  socket.close();
  await closed;
  await released;
  assert.equal(gateway.metrics.activeConnections, 0);
  assert.ok(
    gateway.metrics.peakBufferedBytes <= MAX_PAYLOAD_BYTES + MAX_FRAME_BYTES,
  );
  assert.equal(logs[0]?.bytes_in, payload.length);
  assert.equal(logs[0]?.bytes_out, payload.length);
});

test("checks replay before dialing and fails closed when replay storage is full", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port, {
    replayCache: new ReplayCache(1),
  });
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const route = await token();
  const socket = await open(port, route);
  assert.equal(await rejection(port, route), 403);
  assert.equal(await rejection(port, await token()), 503);
  assert.equal(postgres.handshakes(), 1);
  const closed = once(socket, "close");
  socket.close();
  await closed;
  assert.equal(await rejection(port, route), 403);
});

test("reserves per-database and total caps before dialing and releases them after close", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port, {
    databaseLimit: 1,
    totalLimit: 1,
  });
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port);
  assert.equal(await rejection(port, await token()), 429);
  const { newDatabaseId } = await import("@pgcf/contracts");
  assert.equal(
    await rejection(port, await token({ db: newDatabaseId() })),
    503,
  );
  assert.equal(postgres.handshakes(), 1);
  const closed = once(socket, "close");
  socket.close();
  await closed;
  const next = await open(port);
  const nextClosed = once(next, "close");
  next.close();
  await nextClosed;
  assert.equal(postgres.handshakes(), 2);
});

test("derives target only from verified database and ignores query and host header", async (t) => {
  const postgres = await postgresServer();
  const targets: string[] = [];
  const ca = new DatabaseCaCache(async () => validCertificate.cert);
  const dial = createPostgresDial(ca, {
    tcpConnect: (target) => {
      targets.push(`${target.host}:${target.port}`);
      return createConnection({ host: loopback, port: postgres.port });
    },
  });
  const { gateway, port } = await gatewayFor(postgres.port, { dial });
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(
    port,
    await token(),
    `/pg?host=${encodeURIComponent(randomUUID())}&port=1&database=${randomUUID()}`,
    { Host: randomUUID() },
  );
  assert.deepEqual(targets, [`${databaseTarget(database).host}:5432`]);
  const closed = once(socket, "close");
  socket.close();
  await closed;
  assert.throws(() => databaseTarget("../invalid"));
});

test("fails closed on wrong CA and mismatched certificate name with one refresh", async (t) => {
  const postgres = await postgresServer(otherCertificate);
  let reads = 0;
  const ca = new DatabaseCaCache(async () => {
    reads++;
    return validCertificate.cert;
  });
  const { gateway, port } = await gatewayFor(postgres.port, {
    dial: createPostgresDial(ca, {
      tcpConnect: () =>
        createConnection({ host: loopback, port: postgres.port }),
    }),
  });
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  assert.equal(await rejection(port, await token()), 502);
  assert.equal(reads, 2);
  assert.equal(postgres.handshakes(), 2);
  const trustedWrongName = new DatabaseCaCache(
    async () => otherCertificate.cert,
  );
  const otherGateway = await gatewayFor(postgres.port, {
    dial: createPostgresDial(trustedWrongName, {
      tcpConnect: () =>
        createConnection({ host: loopback, port: postgres.port }),
    }),
  });
  t.after(() => otherGateway.gateway.drain());
  assert.equal(await rejection(otherGateway.port, await token()), 502);
  assert.equal(otherGateway.gateway.metrics.activeConnections, 0);
});

test("refreshes a rotated CA once and establishes the connection", async (t) => {
  const postgres = await postgresServer();
  let reads = 0;
  const ca = new DatabaseCaCache(async () =>
    ++reads === 1 ? otherCertificate.cert : validCertificate.cert,
  );
  const { gateway, port } = await gatewayFor(postgres.port, {
    dial: createPostgresDial(ca, {
      tcpConnect: () =>
        createConnection({ host: loopback, port: postgres.port }),
    }),
  });
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port);
  assert.equal(reads, 2);
  assert.equal(postgres.handshakes(), 2);
  const closed = once(socket, "close");
  socket.close();
  await closed;
});

test("rejects unreachable PostgreSQL before upgrade", async (t) => {
  const postgres = await postgresServer();
  const portUnused = postgres.port;
  await postgres.close();
  const { gateway, port } = await gatewayFor(portUnused);
  t.after(() => gateway.drain());
  assert.equal(await rejection(port, await token()), 502);
  assert.equal(gateway.metrics.activeConnections, 0);
});

test("propagates PostgreSQL close and rejects text frames", async (t) => {
  const postgres = await postgresServer(validCertificate, (socket) =>
    socket.on("data", () => socket.end()),
  );
  const { gateway, port } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port);
  const closed = once(socket, "close", { signal: AbortSignal.timeout(2_000) });
  socket.send(Buffer.from([1]));
  assert.equal((await closed)[0], 1000);
  const text = await open(port);
  const textClosed = once(text, "close", {
    signal: AbortSignal.timeout(2_000),
  });
  text.send("text");
  assert.equal((await textClosed)[0], 1003);
});

test("propagates a WebSocket close to the PostgreSQL TLS socket", async (t) => {
  let secureClosed: Promise<unknown[]> | undefined;
  const postgres = await postgresServer(validCertificate, (socket) => {
    secureClosed = once(socket, "close", {
      signal: AbortSignal.timeout(2_000),
    });
    socket.on("data", (data: Buffer) => socket.write(data));
  });
  const { gateway, port } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port);
  const echoed = once(socket, "message");
  socket.send(Buffer.from([1]));
  await echoed;
  assert.ok(secureClosed);
  const closed = once(socket, "close");
  socket.close();
  await closed;
  await secureClosed;
});

test("rejects a message over 32 MiB with the payload close code before forwarding", async (t) => {
  let received = 0;
  const postgres = await postgresServer(validCertificate, (socket) =>
    socket.on("data", (chunk: Buffer) => {
      received += chunk.length;
    }),
  );
  const { gateway, port, events } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port);
  const closed = once(socket, "close");
  const released = once(events, "conn_close");
  socket.send(Buffer.alloc(MAX_PAYLOAD_BYTES + 1));
  assert.equal((await closed)[0], 1009);
  await released;
  assert.equal(received, 0);
  assert.equal(gateway.metrics.activeConnections, 0);
});

test("marks readiness false, rejects new connections and drains existing connections with 1012", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port, { drainMs: 100 });
  t.after(() => postgres.close());
  const socket = await open(port);
  const closed = once(socket, "close");
  const drain = gateway.drain();
  assert.equal((await fetch(`http://${loopback}:${port}/readyz`)).status, 503);
  assert.equal((await fetch(`http://${loopback}:${port}/healthz`)).status, 200);
  assert.equal(await rejection(port, await token()), 503);
  assert.equal((await closed)[0], 1012);
  await drain;
  assert.equal(gateway.metrics.activeConnections, 0);
});

test("bounds relay buffering for a paused slow WebSocket reader", async (t) => {
  const payload = Buffer.alloc(10 * 1024 * 1024, 53);
  const postgres = await postgresServer(validCertificate, (socket) =>
    socket.on("data", () => socket.write(payload)),
  );
  const { gateway, port } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port);
  socket.pause();
  socket.send(Buffer.from([1]));
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  assert.ok(
    gateway.metrics.peakBufferedBytes <= MAX_PAYLOAD_BYTES + MAX_FRAME_BYTES,
  );
  let bytes = 0;
  const received = new Promise<void>((resolve) =>
    socket.on("message", (data) => {
      bytes += (data as Buffer).length;
      if (bytes === payload.length) resolve();
    }),
  );
  socket.resume();
  await received;
  const closed = once(socket, "close");
  socket.close();
  await closed;
});
