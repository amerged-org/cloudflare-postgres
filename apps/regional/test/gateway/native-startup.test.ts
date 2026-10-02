// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { WebSocket } from "ws";
import { once } from "node:events";
import { test } from "node:test";
import { newDatabaseId } from "@pgcf/contracts";
import { encodeSslRequest, encodeStartup } from "@pgcf/contracts/pg-wire";
import {
  database,
  loopback,
  rejection,
  start,
  validCertificate,
  gatewayFor,
  open,
  postgresServer,
  token,
} from "./helpers.ts";
import { DatabaseCaCache } from "../../src/gateway/ca.ts";
import { createPostgresDial } from "../../src/gateway/postgres.ts";
import { MAX_STARTUP_BUFFER_BYTES } from "../../src/gateway/server.ts";

test("an authenticated WebSocket reserves capacity without dialing before startup", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port, events } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port);
  assert.equal(gateway.metrics.activeConnections, 1);
  assert.equal(postgres.handshakes(), 0);
  const released = once(events, "conn_close");
  const closed = once(socket, "close");
  socket.close();
  await Promise.all([closed, released]);
  assert.equal(gateway.metrics.activeConnections, 0);
  assert.equal(postgres.handshakes(), 0);
});

test("an SSL prelude is declined without opening PostgreSQL", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port);
  const reply = once(socket, "message");
  socket.send(encodeSslRequest());
  assert.deepEqual(Buffer.from((await reply)[0]), Buffer.from("N"));
  assert.equal(postgres.handshakes(), 0);
});

test("startup database and role must match the signed route before a PostgreSQL dial", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const wrongDatabase = await open(port, await token());
  const databaseError = once(wrongDatabase, "message");
  const databaseClosed = once(wrongDatabase, "close");
  wrongDatabase.send(encodeStartup({ user: "app", database: newDatabaseId() }));
  assert.match(Buffer.from((await databaseError)[0]).toString(), /28000/);
  await databaseClosed;
  assert.equal(postgres.handshakes(), 0);
  const wrongRole = await open(port, await token());
  const roleError = once(wrongRole, "message");
  const roleClosed = once(wrongRole, "close");
  wrongRole.send(encodeStartup({ user: "other", database }));
  assert.match(Buffer.from((await roleError)[0]).toString(), /28000/);
  await roleClosed;
  assert.equal(postgres.handshakes(), 0);
  assert.equal(gateway.metrics.activeConnections, 0);
});

test("fragmented GSS and SSL preludes are declined before an exact raw startup is forwarded", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port);
  const gss = Buffer.from(encodeSslRequest());
  gss.writeUInt32BE(80877104, 4);
  const first = once(socket, "message");
  socket.send(gss.subarray(0, 3));
  socket.send(gss.subarray(3));
  assert.deepEqual(Buffer.from((await first)[0]), Buffer.from("N"));
  assert.equal(postgres.handshakes(), 0);
  const raw = Buffer.from(
    encodeStartup(
      new Map([
        ["user", "app"],
        ["database", database],
        ["options", "-c search_path=public"],
        ["_pq_.extension", "preserved"],
      ]),
      2,
    ),
  );
  const messages: Buffer[] = [];
  const done = new Promise<void>((resolve) =>
    socket.on("message", (data) => {
      messages.push(Buffer.from(data as Buffer));
      if (messages.length === 2) resolve();
    }),
  );
  socket.send(
    Buffer.concat([Buffer.from(encodeSslRequest()), raw.subarray(0, 7)]),
  );
  socket.send(raw.subarray(7));
  await done;
  assert.deepEqual(messages, [Buffer.from("N"), raw]);
  assert.equal(postgres.handshakes(), 1);
});

test("duplicate encryption preludes fail with the parser SQLSTATE without dialing", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port);
  const messages: Buffer[] = [];
  const closed = once(socket, "close");
  socket.on("message", (data) => messages.push(Buffer.from(data as Buffer)));
  socket.send(
    Buffer.concat([
      Buffer.from(encodeSslRequest()),
      Buffer.from(encodeSslRequest()),
    ]),
  );
  await closed;
  assert.deepEqual(messages[0], Buffer.from("N"));
  assert.match(messages[1]!.toString(), /08P01/);
  assert.equal(postgres.handshakes(), 0);
});

test("fragmented CancelRequest at the protocol bound closes without dialing", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const cancel = randomBytes(268);
  cancel.writeUInt32BE(cancel.length, 0);
  cancel.writeUInt32BE(80877102, 4);
  const socket = await open(port);
  const closed = once(socket, "close");
  let messages = 0;
  socket.on("message", () => messages++);
  socket.send(cancel.subarray(0, 5));
  socket.send(cancel.subarray(5));
  assert.equal((await closed)[0], 1000);
  assert.equal(messages, 0);
  assert.equal(postgres.handshakes(), 0);
  const tooLarge = randomBytes(269);
  tooLarge.writeUInt32BE(tooLarge.length, 0);
  tooLarge.writeUInt32BE(80877102, 4);
  const invalid = await open(port);
  const error = once(invalid, "message");
  const invalidClosed = once(invalid, "close");
  invalid.send(tooLarge);
  assert.match(Buffer.from((await error)[0]).toString(), /08P01/);
  await invalidClosed;
  assert.equal(postgres.handshakes(), 0);
});

test("invalid startup length preserves SQLSTATE 08P01 and never dials", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port);
  const error = once(socket, "message");
  const closed = once(socket, "close");
  const packet = Buffer.alloc(4);
  packet.writeUInt32BE(7);
  socket.send(packet);
  assert.match(Buffer.from((await error)[0]).toString(), /08P01/);
  await closed;
  assert.equal(postgres.handshakes(), 0);
});

test("unsupported startup protocol preserves SQLSTATE 0A000 and never dials", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port);
  const error = once(socket, "message");
  const closed = once(socket, "close");
  const packet = Buffer.alloc(8);
  packet.writeUInt32BE(8);
  packet.writeUInt32BE(4 << 16, 4);
  socket.send(packet);
  assert.match(Buffer.from((await error)[0]).toString(), /0A000/);
  await closed;
  assert.equal(postgres.handshakes(), 0);
});

test("missing startup user preserves SQLSTATE 28000 and never dials", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port);
  const error = once(socket, "message");
  const closed = once(socket, "close");
  socket.send(encodeStartup({ database }));
  assert.match(Buffer.from((await error)[0]).toString(), /28000/);
  await closed;
  assert.equal(postgres.handshakes(), 0);
});

test("duplicate startup users cannot change the signed routing identity", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port);
  const error = once(socket, "message");
  const closed = once(socket, "close");
  const body = Buffer.from(`user\0app\0user\0other\0database\0${database}\0\0`);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length);
  header.writeUInt32BE(3 << 16, 4);
  socket.send(Buffer.concat([header, body]));
  assert.match(Buffer.from((await error)[0]).toString(), /08P01/);
  await closed;
  assert.equal(postgres.handshakes(), 0);
});

test("text and malformed WebSocket frames close without a PostgreSQL dial", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const text = await open(port);
  const textClosed = once(text, "close");
  text.send("not binary");
  assert.equal((await textClosed)[0], 1003);
  const malformed = await open(port);
  const malformedClosed = once(malformed, "close");
  // An actual unmasked client frame violates the WebSocket framing rules.
  (malformed as unknown as { _socket: Socket })._socket.write(
    Buffer.from([0x82, 0]),
  );
  assert.equal((await malformedClosed)[0], 1002);
  assert.equal(postgres.handshakes(), 0);
  assert.equal(gateway.metrics.activeConnections, 0);
});

test("slow startup bytes cannot reset the absolute deadline or consume a database connection", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port, events } = await gatewayFor(postgres.port, {
    startupTimeoutMs: 150,
  });
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port);
  const error = once(socket, "message");
  const closed = once(socket, "close");
  const released = once(events, "conn_close");
  const raw = encodeStartup({ user: "app", database });
  let offset = 0;
  const timer = setInterval(
    () => socket.send(raw.subarray(offset, ++offset)),
    40,
  );
  t.after(() => clearInterval(timer));
  assert.match(Buffer.from((await error)[0]).toString(), /08006/);
  await Promise.all([closed, released]);
  clearInterval(timer);
  assert.equal(postgres.handshakes(), 0);
  assert.equal(gateway.metrics.activeConnections, 0);
});

test("startup and queued post-startup bytes retain exact ordering while TLS dial completes", async (t) => {
  const raw = Buffer.from(encodeStartup({ user: "app", database }));
  const first = randomBytes(37);
  const second = randomBytes(73);
  const expected = Buffer.concat([raw, first, second]);
  let received = Buffer.alloc(0);
  const postgres = await postgresServer(validCertificate, (socket) =>
    socket.on("data", (bytes: Buffer) => {
      received = Buffer.concat([received, bytes]);
      if (received.length === expected.length) socket.write(received);
    }),
  );
  const ca = new DatabaseCaCache(async () => validCertificate.cert);
  const actualDial = createPostgresDial(ca, {
    tcpConnect: () => createConnection({ host: loopback, port: postgres.port }),
  });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: () => void;
  const dialed = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const { gateway, port } = await gatewayFor(postgres.port, {
    dial: async (target, signal) => {
      const socket = await actualDial(target, signal);
      ready();
      await barrier;
      return socket;
    },
  });
  t.after(async () => {
    release();
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port);
  const echo = once(socket, "message");
  socket.send(raw.subarray(0, 7));
  socket.send(Buffer.concat([raw.subarray(7), first]));
  await dialed;
  socket.send(Buffer.alloc(0));
  socket.send(second);
  const pong = once(socket, "pong");
  socket.ping(randomUUID());
  await pong;
  assert.equal(received.length, 0);
  release();
  assert.deepEqual(Buffer.from((await echo)[0]), expected);
  assert.deepEqual(received, expected);
  assert.equal(postgres.handshakes(), 1);
});

test("connecting queue overflow closes once and destroys a late TLS dial result without forwarding", async (t) => {
  let received = 0;
  const postgres = await postgresServer(validCertificate, (socket) =>
    socket.on("data", (bytes: Buffer) => {
      received += bytes.length;
    }),
  );
  const ca = new DatabaseCaCache(async () => validCertificate.cert);
  const actualDial = createPostgresDial(ca, {
    tcpConnect: () => createConnection({ host: loopback, port: postgres.port }),
  });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: () => void;
  const dialed = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let upstream: Awaited<ReturnType<typeof actualDial>> | undefined;
  const { gateway, port, logs } = await gatewayFor(postgres.port, {
    dial: async (target, signal) => {
      upstream = await actualDial(target, signal);
      ready();
      await barrier;
      return upstream;
    },
  });
  t.after(async () => {
    release();
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port);
  socket.send(encodeStartup({ user: "app", database }));
  await dialed;
  const error = once(socket, "message");
  const closed = once(socket, "close");
  socket.send(randomBytes(MAX_STARTUP_BUFFER_BYTES));
  assert.match(Buffer.from((await error)[0]).toString(), /08P01/);
  assert.equal((await closed)[0], 1013);
  assert.equal(gateway.metrics.activeConnections, 0);
  assert.equal(logs.length, 1);
  const destroyed = once(upstream!, "close");
  release();
  await destroyed;
  assert.equal(received, 0);
  assert.equal(postgres.handshakes(), 1);
  assert.equal(logs.length, 1);
});

test("drain cancels pending startup and pending PostgreSQL negotiation without forwarding", async (t) => {
  let ready!: () => void;
  const requestReached = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const peers = new Set<Socket>();
  const { createServer } = await import("node:net");
  const postgres = createServer((socket) => {
    peers.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => peers.delete(socket));
    socket.once("data", () => ready());
  });
  const { listen } = await import("./helpers.ts");
  const postgresPort = await listen(postgres);
  const ca = new DatabaseCaCache(async () => validCertificate.cert);
  const { gateway, port } = await gatewayFor(postgresPort, {
    dial: createPostgresDial(ca, {
      tcpConnect: () =>
        createConnection({ host: loopback, port: postgresPort }),
      timeoutMs: 5000,
    }),
  });
  t.after(async () => {
    await gateway.drain();
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => postgres.close(() => resolve()));
  });
  const idle = await open(port);
  const connecting = await open(port);
  const idleClosed = once(idle, "close");
  const connectingClosed = once(connecting, "close");
  connecting.send(encodeStartup({ user: "app", database }));
  await requestReached;
  const drained = gateway.drain();
  assert.equal((await idleClosed)[0], 1012);
  assert.equal((await connectingClosed)[0], 1012);
  await drained;
  assert.equal(gateway.metrics.activeConnections, 0);
});

test("pending heartbeat failure releases capacity while the route remains replay-protected", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port, {
    heartbeatMs: 50,
    databaseLimit: 1,
  });
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const route = await token();
  const socket = new WebSocket(`ws://${loopback}:${port}/pg`, {
    autoPong: false,
    headers: { "X-PGCF-Route": route },
  });
  socket.on("error", () => {});
  await once(socket, "open");
  const closed = once(socket, "close", { signal: AbortSignal.timeout(5000) });
  assert.equal(await rejection(port, await token()), 429);
  await closed;
  assert.equal(gateway.metrics.activeConnections, 0);
  assert.equal(await rejection(port, route), 403);
  const next = await open(port);
  await start(next);
  assert.equal(postgres.handshakes(), 1);
});

test("a maximum-length fragmented startup is preserved and the next byte fails before another dial", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const params = { user: "app", database, options: "" };
  params.options = "x".repeat(10000 - encodeStartup(params).length);
  const raw = Buffer.from(encodeStartup(params));
  assert.equal(raw.length, 10000);
  const socket = await open(port);
  const echo = once(socket, "message");
  socket.send(raw.subarray(0, 4));
  socket.send(raw.subarray(4, 5000));
  socket.send(raw.subarray(5000));
  assert.deepEqual(Buffer.from((await echo)[0]), raw);
  assert.equal(postgres.handshakes(), 1);
  const invalid = await open(port);
  const error = once(invalid, "message");
  const closed = once(invalid, "close");
  const tooLarge = Buffer.concat([raw, Buffer.alloc(1)]);
  tooLarge.writeUInt32BE(tooLarge.length);
  invalid.send(tooLarge);
  assert.match(Buffer.from((await error)[0]).toString(), /08P01/);
  await closed;
  assert.equal(postgres.handshakes(), 1);
});

test("database fallback to the startup user must still exactly match both signed identities", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port, await token({ user: database }));
  await start(socket, { user: database });
  assert.equal(postgres.handshakes(), 1);
});

test("replication and invalid UTF-8 startup fields are refused by the shared parser before dialing", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const replication = await open(port);
  const replicationError = once(replication, "message");
  const replicationClosed = once(replication, "close");
  replication.send(
    encodeStartup({ user: "app", database, replication: "database" }),
  );
  assert.match(Buffer.from((await replicationError)[0]).toString(), /0A000/);
  await replicationClosed;
  const malformed = await open(port);
  const error = once(malformed, "message");
  const closed = once(malformed, "close");
  const raw = Buffer.from(encodeStartup({ user: "app", database }));
  raw[13] = 0xff;
  malformed.send(raw);
  assert.match(Buffer.from((await error)[0]).toString(), /08P01/);
  await closed;
  assert.equal(postgres.handshakes(), 0);
});

test("startup plus excessive queued bytes are refused before any PostgreSQL connection", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port);
  const error = once(socket, "message");
  const closed = once(socket, "close");
  socket.send(
    Buffer.concat([
      Buffer.from(encodeStartup({ user: "app", database })),
      randomBytes(MAX_STARTUP_BUFFER_BYTES),
    ]),
  );
  assert.match(Buffer.from((await error)[0]).toString(), /08P01/);
  await closed;
  assert.equal(postgres.handshakes(), 0);
  assert.equal(gateway.metrics.activeConnections, 0);
});

test("the absolute startup deadline aborts an unfinished TLS dial without forwarding or retry", async (t) => {
  let ready!: () => void;
  const requestReached = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const peers = new Set<Socket>();
  let connections = 0;
  const { createServer } = await import("node:net");
  const postgres = createServer((socket) => {
    connections++;
    peers.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => peers.delete(socket));
    socket.once("data", () => ready());
  });
  const { listen } = await import("./helpers.ts");
  const postgresPort = await listen(postgres);
  const ca = new DatabaseCaCache(async () => validCertificate.cert);
  const { gateway, port, logs } = await gatewayFor(postgresPort, {
    startupTimeoutMs: 200,
    dial: createPostgresDial(ca, {
      tcpConnect: () =>
        createConnection({ host: loopback, port: postgresPort }),
      timeoutMs: 5000,
    }),
  });
  t.after(async () => {
    await gateway.drain();
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => postgres.close(() => resolve()));
  });
  const socket = await open(port);
  const error = once(socket, "message");
  const closed = once(socket, "close");
  socket.send(encodeStartup({ user: "app", database }));
  await requestReached;
  assert.match(Buffer.from((await error)[0]).toString(), /08006/);
  await closed;
  assert.equal(gateway.metrics.activeConnections, 0);
  assert.equal(connections, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.outcome, "startup_timeout");
});
