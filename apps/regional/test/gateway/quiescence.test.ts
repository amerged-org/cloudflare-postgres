// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { TLSSocket } from "node:tls";
import { test } from "node:test";
import type { WebSocket } from "ws";
import { newDatabaseId, newOperationId } from "@pgcf/contracts";
import { encodeStartup } from "@pgcf/contracts/pg-wire";
import { DatabaseCaCache } from "../../src/gateway/ca.ts";
import {
  createPostgresDial,
  databaseTarget,
} from "../../src/gateway/postgres.ts";
import {
  database,
  gatewayFor,
  loopback,
  open,
  postgresServer,
  rejection,
  token,
  validCertificate,
} from "./helpers.ts";

function frame(type: string, body = Buffer.alloc(0)): Buffer {
  const out = Buffer.alloc(5 + body.length);
  out[0] = type.charCodeAt(0);
  out.writeUInt32BE(4 + body.length, 1);
  body.copy(out, 5);
  return out;
}
const auth = frame("R", Buffer.alloc(4));
const ready = (state = "I") => frame("Z", Buffer.from(state));
const query = () => frame("Q", Buffer.from("SELECT 1\0"));
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("socket condition not reached");
    await delay(1);
  }
}
async function backend() {
  const peers: { socket: TLSSocket; bytes: Buffer[] }[] = [];
  const server = await postgresServer(validCertificate, (socket) => {
    const peer = { socket, bytes: [] as Buffer[] };
    peers.push(peer);
    let startup = Buffer.alloc(0);
    let started = false;
    socket.on("data", (chunk: Buffer) => {
      if (started) {
        peer.bytes.push(chunk);
        return;
      }
      startup = Buffer.concat([startup, chunk]);
      if (startup.length < 4 || startup.length < startup.readUInt32BE(0))
        return;
      const length = startup.readUInt32BE(0);
      started = true;
      if (startup.length > length) peer.bytes.push(startup.subarray(length));
      socket.write(Buffer.concat([auth, ready()]));
    });
  });
  return { ...server, peers };
}
async function session(
  port: number,
  db = database,
): Promise<{ socket: WebSocket; chunks: Buffer[] }> {
  const socket = await open(port, await token({ db }));
  const chunks: Buffer[] = [];
  socket.on("message", (value) => chunks.push(Buffer.from(value as Buffer)));
  socket.send(Buffer.from(encodeStartup({ database: db, user: "app" })));
  await until(() =>
    Buffer.concat(chunks).equals(Buffer.concat([auth, ready()])),
  );
  chunks.length = 0;
  return { socket, chunks };
}

test("quiescence isolates one database, refuses stale routes and preserves queued bytes on release", async (t) => {
  const postgres = await backend();
  const actual = createPostgresDial(
    new DatabaseCaCache(async () => validCertificate.cert),
    {
      tcpConnect: () =>
        createConnection({ host: loopback, port: postgres.port }),
    },
  );
  const { gateway, port } = await gatewayFor(postgres.port, {
    dial: (_target, signal) => actual(databaseTarget(database), signal),
  });
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const target = await session(port);
  const otherId = newDatabaseId();
  const other = await session(port, otherId);
  const stale = await token();
  const operation = newOperationId();
  assert.equal(
    (await gateway.beginQuiesce(database, operation)).status,
    "idle",
  );
  assert.equal(await rejection(port, stale), 503);
  const queued = Buffer.concat([query(), query()]);
  target.socket.send(queued);
  other.socket.send(query());
  await until(() => Buffer.concat(postgres.peers[1]!.bytes).equals(query()));
  postgres.peers[1]!.socket.write(ready());
  await until(() => Buffer.concat(other.chunks).equals(ready()));
  await until(
    () => gateway.quiesceStatus(database, operation).status === "busy",
  );
  assert.equal(Buffer.concat(postgres.peers[0]!.bytes).length, 0);
  assert.equal(
    (await gateway.closeQuiesced(database, operation)).status,
    "busy",
  );
  assert.throws(() => gateway.releaseQuiesce(database, newOperationId()));
  gateway.releaseQuiesce(database, operation);
  await until(() => Buffer.concat(postgres.peers[0]!.bytes).equals(queued));
  postgres.peers[0]!.socket.write(Buffer.concat([ready(), ready()]));
  await until(() =>
    Buffer.concat(target.chunks).equals(Buffer.concat([ready(), ready()])),
  );
  assert.equal(postgres.handshakes(), 2);
  assert.equal(
    (await gateway.beginQuiesce(database, operation)).status,
    "idle",
  );
  assert.equal(
    (await gateway.closeQuiesced(database, operation)).status,
    "closed",
  );
  assert.equal(gateway.metrics.activeConnections, 1);
  assert.equal(await rejection(port, await token()), 503);
  gateway.releaseQuiesce(database, operation);
});

test("pending startup/dial closes under the fence and never redials or replays its original bytes", async (t) => {
  const postgres = await backend();
  const actual = createPostgresDial(
    new DatabaseCaCache(async () => validCertificate.cert),
    {
      tcpConnect: () =>
        createConnection({ host: loopback, port: postgres.port }),
    },
  );
  let dialed!: () => void;
  const begun = new Promise<void>((resolve) => {
    dialed = resolve;
  });
  let proceed!: () => void;
  const waiting = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  let calls = 0;
  const { gateway, port } = await gatewayFor(postgres.port, {
    dial: async (target, signal) => {
      calls++;
      const socket = await actual(target, signal);
      dialed();
      await waiting;
      return socket;
    },
  });
  t.after(async () => {
    proceed();
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port);
  const chunks: Buffer[] = [];
  socket.on("message", (value) => chunks.push(Buffer.from(value as Buffer)));
  socket.send(Buffer.from(encodeStartup({ database, user: "app" })));
  await begun;
  const operation = newOperationId();
  assert.equal(gateway.quiesceStatus(database, operation).pendingDials, 1);
  const result = await gateway.beginQuiesce(database, operation);
  assert.equal(result.pendingDials, 0);
  assert.equal(result.connections, 0);
  proceed();
  await until(() => postgres.peers.length === 1);
  await until(() => gateway.metrics.activeConnections === 0);
  assert.equal(chunks.length, 0);
  assert.equal(postgres.peers[0]!.bytes.length, 0);
  gateway.releaseQuiesce(database, operation);
  await delay(1);
  assert.equal(chunks.length, 0);
  assert.equal(calls, 1);
});

test("transactions, authentication and fragmented/pipelined input refuse closing", async (t) => {
  const postgres = await backend();
  const { gateway, port } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const client = await session(port);
  const operation = newOperationId();
  client.socket.send(query());
  await until(() => Buffer.concat(postgres.peers[0]!.bytes).equals(query()));
  postgres.peers[0]!.socket.write(ready("T"));
  await until(() => Buffer.concat(client.chunks).equals(ready("T")));
  assert.equal(
    (await gateway.beginQuiesce(database, operation)).status,
    "busy",
  );
  assert.equal(
    (await gateway.closeQuiesced(database, operation)).status,
    "busy",
  );
  gateway.releaseQuiesce(database, operation);
  client.chunks.length = 0;
  client.socket.send(query());
  await until(() =>
    Buffer.concat(postgres.peers[0]!.bytes).equals(
      Buffer.concat([query(), query()]),
    ),
  );
  postgres.peers[0]!.socket.write(ready());
  await until(() => Buffer.concat(client.chunks).equals(ready()));
  const packet = query();
  client.socket.send(packet.subarray(0, 1), { fin: false });
  await gateway.beginQuiesce(database, operation);
  await until(
    () => gateway.quiesceStatus(database, operation).status === "busy",
  );
  assert.equal(
    (await gateway.closeQuiesced(database, operation)).status,
    "busy",
  );
  gateway.releaseQuiesce(database, operation);
  client.socket.send(packet.subarray(1), { fin: true });
  await until(() =>
    Buffer.concat(postgres.peers[0]!.bytes).equals(
      Buffer.concat([query(), query(), query()]),
    ),
  );
  postgres.peers[0]!.socket.write(ready("T"));
  await until(() => gateway.activity(database).busyConnections === 1);
  const unauthenticated = await open(port);
  const otherOperation = newOperationId();
  assert.throws(() => gateway.beginQuiesce("invalid", otherOperation));
  assert.throws(() => gateway.beginQuiesce(database, "invalid"));
  assert.equal(
    (await gateway.beginQuiesce(database, operation)).status,
    "busy",
  );
  assert.equal(
    (await gateway.closeQuiesced(database, operation)).status,
    "busy",
  );
  unauthenticated.terminate();
});

test("an upgrade spanning begin/release cannot admit its pre-fence route", async (t) => {
  const postgres = await backend();
  const { gateway, port } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const route = await token();
  const sign = crypto.subtle.sign.bind(crypto.subtle);
  let verified!: () => void;
  const begun = new Promise<void>((resolve) => {
    verified = resolve;
  });
  let proceed!: () => void;
  const waiting = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  t.mock.method(
    crypto.subtle,
    "sign",
    async (...args: Parameters<typeof sign>) => {
      verified();
      await waiting;
      return sign(...args);
    },
  );
  const denied = rejection(port, route);
  await begun;
  const operation = newOperationId();
  await gateway.beginQuiesce(database, operation);
  gateway.releaseQuiesce(database, operation);
  proceed();
  assert.equal(await denied, 503);
  assert.equal(postgres.handshakes(), 0);
});

test("partial PG input in an otherwise complete WS message stays busy across stale readiness", async (t) => {
  const postgres = await backend();
  const { gateway, port } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const client = await session(port);
  const operation = newOperationId();
  const packet = query();
  client.socket.send(packet.subarray(0, 5));
  await until(() => Buffer.concat(postgres.peers[0]!.bytes).length === 5);
  assert.equal(
    (await gateway.beginQuiesce(database, operation)).status,
    "busy",
  );
  postgres.peers[0]!.socket.write(ready());
  await until(() => Buffer.concat(client.chunks).equals(ready()));
  gateway.releaseQuiesce(database, operation);
  client.socket.send(packet.subarray(5));
  await until(() => Buffer.concat(postgres.peers[0]!.bytes).equals(packet));
  await gateway.beginQuiesce(database, operation);
  assert.equal(
    (await gateway.closeQuiesced(database, operation)).status,
    "busy",
  );
});

test("a parked TLS result handles errors and releases its original reservation once", async (t) => {
  const postgres = await backend();
  const actual = createPostgresDial(
    new DatabaseCaCache(async () => validCertificate.cert),
    {
      tcpConnect: () =>
        createConnection({ host: loopback, port: postgres.port }),
    },
  );
  let heldSocket: TLSSocket | undefined;
  let proceed!: () => void;
  const waiting = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  const { gateway, port, logs } = await gatewayFor(postgres.port, {
    dial: async (target, signal) => {
      heldSocket = await actual(target, signal);
      await waiting;
      return heldSocket;
    },
  });
  t.after(async () => {
    proceed();
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port);
  socket.on("error", () => {});
  socket.send(Buffer.from(encodeStartup({ database, user: "app" })));
  await until(() => heldSocket !== undefined);
  const operation = newOperationId();
  await gateway.beginQuiesce(database, operation);
  proceed();
  await until(
    () => gateway.quiesceStatus(database, operation).pendingDials === 0,
  );
  await until(() => heldSocket!.listenerCount("error") > 0);
  assert.doesNotThrow(() =>
    heldSocket!.emit("error", new Error("fixture transport failure")),
  );
  await until(() => gateway.metrics.activeConnections === 0);
  assert.equal(logs.length, 1);
  assert.equal(postgres.peers[0]!.bytes.length, 0);
});

test("begin quiescence closes a held pre-auth transport and keeps raw counts until actual cleanup", async (t) => {
  const code = Buffer.alloc(4);
  code.writeUInt32BE(10);
  const challenge = frame(
    "R",
    Buffer.concat([code, Buffer.from("SCRAM-SHA-256\0\0")]),
  );
  const postgres = await postgresServer(undefined, (socket) =>
    socket.once("data", () => socket.write(challenge)),
  );
  const { gateway, port } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const client = await open(port),
    chunks: Buffer[] = [];
  client.on("message", (value) => chunks.push(Buffer.from(value as Buffer)));
  client.send(Buffer.from(encodeStartup({ database, user: "app" })));
  await until(() => Buffer.concat(chunks).equals(challenge));
  const operation = newOperationId(),
    pending = gateway.beginQuiesce(database, operation);
  assert.equal(gateway.quiesceStatus(database, operation).connections, 1);
  assert.throws(() => gateway.releaseQuiesce(database, operation));
  const result = await pending;
  assert.equal(result.connections, 0);
  assert.equal(result.busyConnections, 0);
  assert.equal(result.pendingDials, 0);
  assert.equal(gateway.metrics.activeConnections, 0);
  assert.equal(gateway.activity(database).totalConnections, 0);
  assert.equal(await rejection(port, await token()), 503);
  assert.throws(() => gateway.releaseQuiesce(database, newOperationId()));
  gateway.releaseQuiesce(database, operation);
});

test("lost pre-auth close acknowledgement is bounded and cannot bypass an operation-bound drain", async (t) => {
  const original = globalThis.setTimeout,
    timers: NodeJS.Timeout[] = [],
    deadlines: (() => void)[] = [];
  t.mock.method(
    globalThis,
    "setTimeout",
    (
      callback: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      if (ms === 500) {
        const timer = original(() => {}, 600000);
        timer.unref();
        timers.push(timer);
        deadlines.push(() => callback(...args));
        return timer;
      }
      return original(callback, ms, ...args);
    },
  );
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
  });
  const code = Buffer.alloc(4);
  code.writeUInt32BE(10);
  const challenge = frame(
    "R",
    Buffer.concat([code, Buffer.from("SCRAM-SHA-256\0\0")]),
  );
  const postgres = await postgresServer(undefined, (socket) =>
    socket.once("data", () => socket.write(challenge)),
  );
  const { gateway, port } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const client = await open(port),
    chunks: Buffer[] = [];
  client.on("message", (value) => chunks.push(Buffer.from(value as Buffer)));
  client.send(Buffer.from(encodeStartup({ database, user: "app" })));
  await until(() => Buffer.concat(chunks).equals(challenge));
  client.pause();
  const operation = newOperationId(),
    pending = gateway.beginQuiesce(database, operation);
  assert.equal(gateway.beginQuiesce(database, operation), pending);
  assert.equal(deadlines.length, 1);
  assert.equal(gateway.quiesceStatus(database, operation).connections, 1);
  assert.throws(() => gateway.releaseQuiesce(database, operation));
  assert.throws(() => gateway.beginQuiesce(database, newOperationId()));
  assert.equal(
    (await gateway.closeQuiesced(database, operation)).status,
    "busy",
  );
  deadlines[0]!();
  const result = await pending;
  assert.equal(result.connections, 0);
  assert.equal(result.pendingDials, 0);
  assert.equal(gateway.metrics.activeConnections, 0);
  client.resume();
  assert.throws(() => gateway.releaseQuiesce(database, newOperationId()));
  gateway.releaseQuiesce(database, operation);
});

test("pre-auth pipelined bytes have an unknown outcome, surface transport failure and are never replayed", async (t) => {
  const code = Buffer.alloc(4);
  code.writeUInt32BE(10);
  const challenge = frame(
    "R",
    Buffer.concat([code, Buffer.from("SCRAM-SHA-256\0\0")]),
  );
  const forwarded: Buffer[] = [];
  const postgres = await postgresServer(undefined, (socket) => {
    let first = true;
    socket.on("data", (bytes) => {
      if (first) {
        first = false;
        socket.write(challenge);
      } else forwarded.push(bytes);
    });
  });
  const { gateway, port } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const client = await open(port),
    chunks: Buffer[] = [];
  client.on("message", (value) => chunks.push(Buffer.from(value as Buffer)));
  client.send(Buffer.from(encodeStartup({ database, user: "app" })));
  await until(() => Buffer.concat(chunks).equals(challenge));
  const input = Buffer.concat([
    frame("p", Buffer.from("fixture-response")),
    query(),
  ]);
  client.send(input);
  await until(() => Buffer.concat(forwarded).equals(input));
  const close = new Promise<number>((resolve) =>
      client.once("close", (code) => resolve(code)),
    ),
    operation = newOperationId();
  const result = await gateway.beginQuiesce(database, operation);
  assert.equal(result.connections, 0);
  assert.equal(await close, 1012);
  gateway.releaseQuiesce(database, operation);
  await delay(1);
  assert.deepEqual(Buffer.concat(forwarded), input);
  assert.equal(postgres.handshakes(), 1);
  assert.equal(gateway.activity(database).totalConnections, 0);
});
