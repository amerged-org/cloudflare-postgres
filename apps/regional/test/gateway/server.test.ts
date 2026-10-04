// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { createConnection } from "node:net";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { newDatabaseId } from "@pgcf/contracts";
import { encodeStartup } from "@pgcf/contracts/pg-wire";
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
  start,
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
  const startup = await start(socket);
  const payload = randomBytes(10 * 1024 * 1024);
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
  assert.equal(logs[0]?.bytes_in, payload.length + startup.length);
  assert.equal(logs[0]?.bytes_out, payload.length + startup.length);
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
  await start(socket);
  assert.equal(await rejection(port, route), 403);
  assert.equal(await rejection(port, await token()), 429);
  assert.equal(postgres.handshakes(), 1);
  const closed = once(socket, "close");
  socket.close();
  await closed;
  assert.equal(await rejection(port, route), 403);
});

test("a full database replay partition still admits another verified database", async (t) => {
  const postgres = await postgresServer();
  const targets: string[] = [];
  const ca = new DatabaseCaCache(async () => validCertificate.cert);
  const actualDial = createPostgresDial(ca, {
    tcpConnect: () => createConnection({ host: loopback, port: postgres.port }),
  });
  const { gateway, port } = await gatewayFor(postgres.port, {
    replayCache: new ReplayCache(1),
    dial: (target, signal) => {
      targets.push(target.host);
      // Test backend is one real TLS server; target identity is separately asserted.
      return actualDial(databaseTarget(database), signal);
    },
  });
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const first = await open(port);
  await start(first);
  assert.equal(await rejection(port, await token()), 429);
  assert.equal(gateway.metrics.activeConnections, 1);
  const secondDatabase = newDatabaseId();
  const second = await open(port, await token({ db: secondDatabase }));
  await start(second, { user: "app", database: secondDatabase });
  assert.deepEqual(targets, [
    databaseTarget(database).host,
    databaseTarget(secondDatabase).host,
  ]);
  assert.equal(postgres.handshakes(), 2);
  const closed = [once(first, "close"), once(second, "close")];
  first.close();
  second.close();
  await Promise.all(closed);
});

test("capacity denials do not consume fresh routing tokens", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port, events } = await gatewayFor(postgres.port, {
    databaseLimit: 1,
  });
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const first = await open(port);
  await start(first);
  const retry = await token();
  assert.equal(await rejection(port, retry), 429);
  const released = once(events, "conn_close");
  const closed = once(first, "close");
  first.close();
  await closed;
  await released;
  const second = await open(port, retry);
  await start(second);
  assert.equal(postgres.handshakes(), 2);
  const secondClosed = once(second, "close");
  second.close();
  await secondClosed;
});

test("total capacity denials also leave routing tokens available for a later admission", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port, events } = await gatewayFor(postgres.port, {
    totalLimit: 1,
    databaseLimit: 2,
  });
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const first = await open(port);
  await start(first);
  const retry = await token();
  assert.equal(await rejection(port, retry), 503);
  const released = once(events, "conn_close");
  const closed = once(first, "close");
  first.close();
  await closed;
  await released;
  const second = await open(port, retry);
  await start(second);
  assert.equal(postgres.handshakes(), 2);
  const secondClosed = once(second, "close");
  second.close();
  await secondClosed;
});

test("verification and replay admission share one clock at the expiry boundary", async (t) => {
  const postgres = await postgresServer();
  const now = Date.now();
  const exp = Math.floor(now / 1000);
  const boundary = (exp + 5) * 1000;
  class ObservedReplay extends ReplayCache {
    readonly times: (number | undefined)[] = [];
    override use(...args: Parameters<ReplayCache["use"]>) {
      this.times.push(args[3]);
      return super.use(...args);
    }
  }
  const replayCache = new ObservedReplay();
  const { gateway, port } = await gatewayFor(postgres.port, { replayCache });
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const route = await signedClaims({ iat: exp - 30, exp });
  replayCache.use(
    database,
    JSON.parse(Buffer.from(route.split(".")[1]!, "base64url").toString()).cid,
    exp,
    boundary,
  );
  replayCache.times.length = 0;
  let reads = 0;
  t.mock.method(Date, "now", () => (reads++ === 0 ? boundary : boundary + 1));
  assert.equal(await rejection(port, route), 403);
  assert.deepEqual(replayCache.times, [boundary]);
  assert.equal(postgres.handshakes(), 0);
});

test("rejected upgrades close half-open TCP peers and release raw connection capacity", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port, { totalLimit: 1 });
  const accepted = once(gateway.server, "connection");
  const peer = createConnection({ host: loopback, port, allowHalfOpen: true });
  peer.on("error", () => {});
  t.after(async () => {
    peer.destroy();
    await gateway.drain();
    await postgres.close();
  });
  const [raw] = await accepted;
  const rawClosed = once(raw, "close", { signal: AbortSignal.timeout(750) });
  let response = "";
  peer.on("data", (chunk: Buffer) => {
    response += chunk.toString("ascii");
  });
  const ended = once(peer, "end", { signal: AbortSignal.timeout(750) });
  peer.write(
    `GET /pg HTTP/1.1\r\nHost: ${loopback}:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n\r\n`,
  );
  await ended;
  assert.match(response, /^HTTP\/1\.1 401 /);
  await rawClosed;
  const connections = await new Promise<number>((resolve, reject) =>
    gateway.server.getConnections((error, count) =>
      error ? reject(error) : resolve(count),
    ),
  );
  assert.equal(connections, 0);
  assert.equal((await fetch(`http://${loopback}:${port}/healthz`)).status, 200);
  assert.equal(postgres.handshakes(), 0);
});

test("drain destroys incomplete HTTP headers within the shutdown deadline without peer FIN", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port, { drainMs: 100 });
  const accepted = once(gateway.server, "connection");
  const peer = createConnection({ host: loopback, port, allowHalfOpen: true });
  peer.on("error", () => {});
  t.after(async () => {
    peer.destroy();
    await gateway.drain();
    await postgres.close();
  });
  const [raw] = await accepted;
  const rawClosed = once(raw, "close", { signal: AbortSignal.timeout(750) });
  peer.write(`GET /healthz HTTP/1.1\r\nHost: ${loopback}:${port}\r\n`);
  const drain = gateway.drain();
  await Promise.all([within(drain, 750), rawClosed]);
  assert.equal(gateway.server.listening, false);
});

test("rejects all subprotocol headers before consuming tokens, reserving capacity or dialing", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port, events } = await gatewayFor(postgres.port, {
    totalLimit: 1,
  });
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const route = await token();
  assert.equal(
    await rejection(port, route, "/pg", {
      "Sec-WebSocket-Protocol": "relay, relay",
    }),
    400,
  );
  assert.equal(postgres.handshakes(), 0);
  assert.equal(gateway.metrics.activeConnections, 0);
  assert.equal(
    await rejection(port, route, "/pg", {
      "Sec-WebSocket-Protocol": "bad protocol",
    }),
    400,
  );
  assert.equal(
    await rejection(port, route, "/pg", { "Sec-WebSocket-Protocol": "relay" }),
    400,
  );
  assert.equal(postgres.handshakes(), 0);
  const socket = await open(port, route);
  await start(socket);
  assert.equal(postgres.handshakes(), 1);
  const released = once(events, "conn_close");
  const closed = once(socket, "close");
  socket.close();
  await closed;
  await released;
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
  await start(socket);
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
  await start(next);
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
  await start(socket);
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
  const failed = await open(port);
  const failedMessage = once(failed, "message");
  const failedClosed = once(failed, "close");
  failed.send(encodeStartup({ user: "app", database }));
  assert.match(Buffer.from((await failedMessage)[0]).toString(), /08006/);
  await failedClosed;
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
  const wrongName = await open(otherGateway.port);
  const wrongNameMessage = once(wrongName, "message");
  const wrongNameClosed = once(wrongName, "close");
  wrongName.send(encodeStartup({ user: "app", database }));
  assert.match(Buffer.from((await wrongNameMessage)[0]).toString(), /08006/);
  await wrongNameClosed;
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
  await start(socket);
  assert.equal(reads, 2);
  assert.equal(postgres.handshakes(), 2);
  const closed = once(socket, "close");
  socket.close();
  await closed;
});

test("reports unreachable PostgreSQL after an authorized startup", async (t) => {
  const postgres = await postgresServer();
  const portUnused = postgres.port;
  await postgres.close();
  const { gateway, port } = await gatewayFor(portUnused);
  t.after(() => gateway.drain());
  const failed = await open(port);
  const failedMessage = once(failed, "message");
  const failedClosed = once(failed, "close");
  failed.send(encodeStartup({ user: "app", database }));
  assert.match(Buffer.from((await failedMessage)[0]).toString(), /08006/);
  await failedClosed;
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
  socket.send(encodeStartup({ user: "app", database }));
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
  await start(socket);
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

test("an established relay rejects an oversized WebSocket message without forwarding its payload", async (t) => {
  let received = 0;
  const postgres = await postgresServer(validCertificate, (socket) =>
    socket.on("data", (chunk: Buffer) => {
      received += chunk.length;
      socket.write(chunk);
    }),
  );
  const { gateway, port, events } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port);
  const startup = await start(socket);
  const closed = once(socket, "close");
  const released = once(events, "conn_close");
  socket.send(Buffer.alloc(MAX_PAYLOAD_BYTES + 1));
  assert.equal((await closed)[0], 1009);
  await released;
  assert.equal(received, startup.length);
  assert.equal(postgres.handshakes(), 1);
  assert.equal(gateway.metrics.activeConnections, 0);
});

test("marks readiness false, rejects new connections and drains existing connections with 1012", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port, { drainMs: 100 });
  let timersEnabled = false;
  t.after(async () => {
    if (timersEnabled) t.mock.timers.runAll();
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port);
  await start(socket);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  timersEnabled = true;
  const closed = once(socket, "close");
  const drain = gateway.drain();
  assert.equal((await fetch(`http://${loopback}:${port}/readyz`)).status, 503);
  assert.equal((await fetch(`http://${loopback}:${port}/healthz`)).status, 200);
  assert.equal(await rejection(port, await token()), 503);
  t.mock.timers.tick(75);
  assert.equal((await closed)[0], 1012);
  await drain;
  assert.equal(gateway.metrics.activeConnections, 0);
});

test("bounds relay buffering for a paused slow WebSocket reader", async (t) => {
  const payload = randomBytes(48 * 1024 * 1024);
  const expected = createHash("sha256").update(payload).digest("hex");
  let bytesWritten = 0;
  let started: (() => void) | undefined;
  const writing = new Promise<void>((resolve) => {
    started = resolve;
  });
  let producer: Promise<void> | undefined;
  const postgres = await postgresServer(validCertificate, (socket) =>
    socket.once("data", () => {
      producer = (async () => {
        for (
          let offset = 0;
          offset < payload.length;
          offset += MAX_FRAME_BYTES
        ) {
          const chunk = payload.subarray(offset, offset + MAX_FRAME_BYTES);
          const ready = socket.write(chunk);
          bytesWritten += chunk.length;
          started?.();
          if (!ready) await once(socket, "drain");
        }
      })();
    }),
  );
  const { gateway, port, events } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port);
  socket.pause();
  socket.send(encodeStartup({ user: "app", database }));
  await writing;
  await new Promise<void>((resolve) => setTimeout(resolve, 200));
  assert.ok(bytesWritten < payload.length);
  assert.ok(
    gateway.metrics.peakBufferedBytes <= MAX_PAYLOAD_BYTES + MAX_FRAME_BYTES,
  );
  let bytes = 0;
  const hash = createHash("sha256");
  const received = new Promise<void>((resolve) =>
    socket.on("message", (data, binary) => {
      assert.equal(binary, true);
      const chunk = data as Buffer;
      assert.ok(chunk.length <= MAX_FRAME_BYTES);
      hash.update(chunk);
      bytes += chunk.length;
      if (bytes === payload.length) resolve();
    }),
  );
  socket.resume();
  await received;
  await producer;
  assert.equal(bytesWritten, payload.length);
  assert.equal(hash.digest("hex"), expected);
  assert.ok(gateway.metrics.peakBufferedBytes > 0);
  assert.ok(
    gateway.metrics.peakBufferedBytes <= MAX_PAYLOAD_BYTES + MAX_FRAME_BYTES,
  );
  const closed = once(socket, "close");
  const released = once(events, "conn_close");
  socket.close();
  await closed;
  await released;
});

async function within<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("shutdown deadline exceeded")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
