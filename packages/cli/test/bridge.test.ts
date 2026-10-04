// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { once } from "node:events";
import { connect } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { setImmediate as turn } from "node:timers/promises";
import test from "node:test";
import type { TestContext } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { newDatabaseId } from "@pgcf/contracts";
import {
  CLIENT_LIMIT,
  FRAGMENT_LIMIT,
  MESSAGE_BYTES,
  STREAM_BYTES,
  startBridge,
  connectUpstream,
  UPSTREAM_OPTIONS,
} from "../src/bridge.ts";
import type { Bridge, Session } from "../src/bridge.ts";
import {
  parseArgs,
  instructions,
  upstreamUrl,
  validateOptions,
} from "../src/options.ts";
import type { ConnectOptions } from "../src/options.ts";

const loopback = [127, 0, 0, 1].join(".");
function options(): ConnectOptions {
  return {
    endpoint: `wss://${["edge", "test", "invalid"].join(".")}`,
    database: newDatabaseId(),
    user: "app",
    port: 0,
  };
}
async function until(predicate: () => boolean): Promise<void> {
  for (let count = 0; count < 5000; count++) {
    if (predicate()) return;
    await turn();
  }
  throw new Error("condition_not_reached");
}
async function local(bridge: Bridge): Promise<Socket> {
  const socket = connect({ host: bridge.host, port: bridge.port });
  socket.on("error", () => {});
  await once(socket, "connect");
  return socket;
}
async function fixture(
  context: TestContext,
  onConnection: (peer: WebSocket) => void,
  requested = options(),
) {
  const server = new WebSocketServer({
    host: loopback,
    port: 0,
    perMessageDeflate: false,
  });
  await once(server, "listening");
  const peers: WebSocket[] = [];
  const sessions: Session[] = [];
  const admitted: URL[] = [];
  let connections = 0;
  let disconnections = 0;
  server.on("connection", (peer, request) => {
    peer.on("error", () => {});
    peers.push(peer);
    const url = new URL(request.url!, `ws://${loopback}`);
    admitted.push(url);
    assert.equal(url.pathname, "/v2");
    assert.deepEqual(url.searchParams.getAll("database"), [requested.database]);
    assert.deepEqual(url.searchParams.getAll("user"), [requested.user]);
    onConnection(peer);
  });
  const bridge = await startBridge(requested, {
    connect: (url) => {
      connections++;
      const target = new URL(url);
      assert.equal(target.protocol, "wss:");
      target.protocol = "ws:";
      target.hostname = loopback;
      target.port = String((server.address() as AddressInfo).port);
      return new WebSocket(target, UPSTREAM_OPTIONS);
    },
    session: (value) => sessions.push(value),
    disconnected: () => disconnections++,
  });
  context.after(async () => {
    await bridge.close();
    for (const peer of peers) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    bridge,
    server,
    peers,
    sessions,
    admitted,
    connections: () => connections,
    disconnections: () => disconnections,
  };
}
async function collect(socket: Socket, expected: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  return new Promise((resolve, reject) => {
    const data = (chunk: Buffer) => {
      chunks.push(chunk);
      length += chunk.length;
      if (length === expected) {
        socket.removeListener("data", data);
        resolve(Buffer.concat(chunks));
      } else if (length > expected) reject(new Error("unexpected_bytes"));
    };
    socket.on("data", data);
    socket.once("error", reject);
    socket.once("end", () => {
      if (length !== expected) reject(new Error("truncated_bytes"));
    });
  });
}

test("options reject endpoint overrides, secrets, reserved identities and invalid ports before listen", async () => {
  const value = options();
  assert.equal(validateOptions(value).port, 0);
  const secret = randomBytes(32).toString("base64url");
  for (const endpoint of [
    `ws://${["edge", "test"].join(".")}`,
    `${value.endpoint}/v2`,
    `${value.endpoint}/?x=${secret}`,
    `${value.endpoint}/#${secret}`,
    value.endpoint.replace("wss://", `wss://${secret}@`),
    `${value.endpoint}/?`,
    `${value.endpoint}/#`,
  ]) {
    await assert.rejects(
      startBridge({ ...value, endpoint }),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "invalid_endpoint" &&
        !String(error).includes(secret),
    );
  }
  await assert.rejects(
    startBridge({ ...value, database: "invalid" }),
    /invalid_database/,
  );
  await assert.rejects(
    startBridge({ ...value, user: "pg_admin" }),
    /invalid_user/,
  );
  await assert.rejects(startBridge({ ...value, port: 65536 }), /invalid_port/);
  await assert.rejects(startBridge({ ...value, port: -1 }), /invalid_port/);
  assert.throws(
    () => parseArgs(["connect", "--password", secret]),
    /invalid_arguments/,
  );
  assert.throws(
    () =>
      parseArgs([
        "connect",
        "--endpoint",
        value.endpoint,
        "--endpoint",
        value.endpoint,
      ]),
    /invalid_arguments/,
  );
  assert.throws(() => parseArgs(["connect", "--port", "1e3"]), /invalid_port/);
  assert.deepEqual(
    parseArgs([
      "connect",
      "--endpoint",
      value.endpoint,
      "--database",
      value.database,
      "--user",
      value.user,
    ]),
    validateOptions(value),
  );
  assert.equal(parseArgs(["--help"]), "help");
  assert.equal(instructions(12345).includes(secret), false);
  assert.match(instructions(12345), /sslmode=disable/);
  assert.equal(new URL(upstreamUrl(validateOptions(value))).pathname, "/v2");
});

test("actual TCP and WebSocket peers preserve every byte and ignore empty binary messages", async (context) => {
  const sample = await fixture(context, (peer) =>
    peer.on("message", (data, binary) => {
      assert.equal(binary, true);
      peer.send(Buffer.alloc(0));
      peer.send(data, { binary: true });
    }),
  );
  assert.equal(sample.bridge.host, loopback);
  const socket = await local(sample.bridge);
  const payload = Buffer.alloc(512 * 1024);
  for (let index = 0; index < payload.length; index++)
    payload[index] = index % 256;
  const read = collect(socket, payload.length);
  socket.write(Buffer.alloc(0));
  socket.write(payload.subarray(0, 17));
  socket.write(payload.subarray(17));
  assert.deepEqual(await read, payload);
  assert.equal(sample.connections(), 1);
  socket.destroy();
  await until(() => sample.bridge.clients === 0);
  assert.equal(sample.disconnections(), 1);
});

test("concurrent clients use isolated one-to-one sessions", async (context) => {
  const sample = await fixture(context, (peer) =>
    peer.on("message", (data) => peer.send(data, { binary: true })),
  );
  const a = await local(sample.bridge);
  const b = await local(sample.bridge);
  const left = randomBytes(128 * 1024);
  const right = randomBytes(96 * 1024);
  const readA = collect(a, left.length);
  const readB = collect(b, right.length);
  a.write(left);
  b.write(right);
  assert.deepEqual(await readA, left);
  assert.deepEqual(await readB, right);
  assert.equal(sample.connections(), 2);
  assert.equal(sample.bridge.clients, 2);
  a.destroy();
  b.destroy();
  await until(() => sample.bridge.clients === 0);
});

test("oversized fragmented aggregate closes once without reconnecting", async (context) => {
  const sample = await fixture(context, (peer) => {
    peer.send(Buffer.alloc(MESSAGE_BYTES / 2), { binary: true, fin: false });
    peer.send(Buffer.alloc(MESSAGE_BYTES / 2 + 1), { binary: true, fin: true });
  });
  const socket = await local(sample.bridge);
  const closed = once(socket, "close");
  socket.resume();
  await closed;
  await until(() => sample.bridge.clients === 0);
  assert.equal(sample.connections(), 1);
  assert.equal(sample.disconnections(), 1);
});

test("fragment metadata has a finite bound even for empty frames", async (context) => {
  const sample = await fixture(context, (peer) => {
    peer.send(Buffer.alloc(0), { binary: true, fin: false });
    for (let index = 0; index < FRAGMENT_LIMIT; index++)
      peer.send(Buffer.alloc(0), { binary: true, fin: false });
  });
  const socket = await local(sample.bridge);
  socket.resume();
  await once(socket, "close");
  await until(() => sample.bridge.clients === 0);
  assert.equal(sample.connections(), 1);
  assert.equal(sample.disconnections(), 1);
});

test("secure upstream defaults cannot disable verification, redirect or add credentials", () => {
  assert.equal(UPSTREAM_OPTIONS.rejectUnauthorized, true);
  assert.equal(UPSTREAM_OPTIONS.followRedirects, false);
  assert.equal(UPSTREAM_OPTIONS.perMessageDeflate, false);
  assert.equal(UPSTREAM_OPTIONS.headers, undefined);
  assert.equal(UPSTREAM_OPTIONS.ca, undefined);
  assert.equal(UPSTREAM_OPTIONS.autoPong, false);
  assert.equal(UPSTREAM_OPTIONS.maxPayload, MESSAGE_BYTES);
  assert.equal(Object.isFrozen(UPSTREAM_OPTIONS), true);
  assert.throws(() => connectUpstream(`ws://${loopback}`), /invalid_endpoint/);
});

test("default WSS transport rejects an untrusted local certificate before upgrade", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "pgcf-cli-tls-"));
  const key = resolve(directory, "key-fixture");
  const certificate = resolve(directory, "certificate-fixture");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${loopback}`,
      "-addext",
      `subjectAltName=IP:${loopback}`,
      "-keyout",
      key,
      "-out",
      certificate,
    ],
    { stdio: "ignore", timeout: 20_000 },
  );
  const upstream = createHttpsServer({
    key: await readFile(key),
    cert: await readFile(certificate),
  });
  let upgrades = 0;
  upstream.on("upgrade", (_request, socket) => {
    upgrades++;
    socket.destroy();
  });
  upstream.on("tlsClientError", () => {});
  upstream.listen(0, loopback);
  await once(upstream, "listening");
  const value = {
    ...options(),
    endpoint: `wss://${loopback}:${(upstream.address() as AddressInfo).port}`,
  };
  const bridge = await startBridge(value);
  context.after(async () => {
    await bridge.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const socket = await local(bridge);
  socket.resume();
  await once(socket, "close");
  assert.equal(upgrades, 0);
  await until(() => bridge.clients === 0);
});

test("text messages are rejected before bytes enter local PostgreSQL traffic", async (context) => {
  const sample = await fixture(context, (peer) =>
    peer.send("unexpected-text", { binary: false }),
  );
  const socket = await local(sample.bridge);
  let bytes = 0;
  socket.on("data", (value: Buffer) => {
    bytes += value.length;
  });
  await once(socket, "close");
  assert.equal(bytes, 0);
  assert.equal(sample.connections(), 1);
  assert.equal(sample.disconnections(), 1);
});

test("upstream close flushes admitted bytes and then closes the local connection", async (context) => {
  const payload = randomBytes(64 * 1024);
  const sample = await fixture(context, (peer) => {
    peer.send(payload, () => peer.close());
  });
  const socket = await local(sample.bridge);
  const closed = once(socket, "close");
  const bytes = await collect(socket, payload.length);
  assert.deepEqual(bytes, payload);
  await closed;
  assert.equal(sample.connections(), 1);
  await until(() => sample.disconnections() === 1);
});

test("local close and upstream failure release one session without replay", async (context) => {
  let received = 0;
  const sample = await fixture(context, (peer) =>
    peer.on("message", () => {
      received++;
      peer.terminate();
    }),
  );
  const first = await local(sample.bridge);
  first.destroy();
  await until(() => sample.bridge.clients === 0);
  const second = await local(sample.bridge);
  const closed = once(second, "close");
  second.write(randomBytes(128));
  await closed;
  await until(() => sample.bridge.clients === 0);
  assert.equal(received, 1);
  assert.equal(sample.connections(), 2);
  assert.equal(sample.disconnections(), 2);
});

test("slow local readers bound WebSocket buffers and resume with exact bytes", async (context) => {
  const chunk = randomBytes(STREAM_BYTES);
  const count = 256;
  const sample = await fixture(context, (peer) => {
    let index = 0;
    const send = () => {
      if (index++ < count && peer.readyState === WebSocket.OPEN)
        peer.send(chunk, { binary: true }, send);
    };
    send();
  });
  const socket = await local(sample.bridge);
  socket.pause();
  await until(() => sample.sessions[0]?.upstream.isPaused === true);
  const session = sample.sessions[0]!;
  assert(session.stream.readableLength <= MESSAGE_BYTES + STREAM_BYTES);
  assert(session.local.writableLength <= MESSAGE_BYTES + STREAM_BYTES);
  const expected = createHash("sha256");
  for (let index = 0; index < count; index++) expected.update(chunk);
  const actual = createHash("sha256");
  let bytes = 0;
  const complete = new Promise<void>((resolve) =>
    socket.on("data", (value: Buffer) => {
      bytes += value.length;
      actual.update(value);
      if (bytes === count * chunk.length) resolve();
    }),
  );
  socket.resume();
  await complete;
  assert.equal(actual.digest("hex"), expected.digest("hex"));
  socket.destroy();
});

test("slow upstream readers propagate backpressure to local TCP", async (context) => {
  const sample = await fixture(context, (peer) => peer.pause());
  const socket = await local(sample.bridge);
  await until(() => sample.peers.length === 1);
  const chunk = Buffer.alloc(STREAM_BYTES);
  const writing = (async () => {
    for (let count = 0; count < 512 && !socket.destroyed; count++) {
      if (!socket.write(chunk))
        await new Promise<void>((resolve) => {
          const drained = () => {
            socket.removeListener("close", drained);
            socket.removeListener("drain", drained);
            resolve();
          };
          socket.once("drain", drained);
          socket.once("close", drained);
        });
    }
  })();
  await until(
    () =>
      sample.sessions[0]!.stream.writableNeedDrain &&
      sample.sessions[0]!.upstream.bufferedAmount > 0,
  );
  const session = sample.sessions[0]!;
  assert(session.stream.writableLength <= STREAM_BYTES * 2);
  assert(session.upstream.bufferedAmount <= STREAM_BYTES * 2);
  assert.equal(session.local.isPaused(), true);
  socket.destroy();
  await writing;
});

test("shutdown closes the listener and every owned client idempotently", async (context) => {
  const sample = await fixture(context, () => {});
  const a = await local(sample.bridge);
  const b = await local(sample.bridge);
  const closing = [once(a, "close"), once(b, "close")];
  await sample.bridge.close();
  await Promise.all(closing);
  assert.equal(sample.bridge.clients, 0);
  await sample.bridge.close();
  const refused = connect({ host: loopback, port: sample.bridge.port });
  await once(refused, "error");
  refused.destroy();
  assert.equal(sample.disconnections(), 2);
});

test("active client cap refuses excess sockets before opening another upstream", async (context) => {
  const sample = await fixture(context, () => {});
  const sockets: Socket[] = [];
  for (let index = 0; index < CLIENT_LIMIT; index++)
    sockets.push(await local(sample.bridge));
  await until(() => sample.bridge.clients === CLIENT_LIMIT);
  const excess = connect({ host: loopback, port: sample.bridge.port });
  excess.on("error", () => {});
  await once(excess, "close");
  assert.equal(sample.connections(), CLIENT_LIMIT);
  sockets.forEach((socket) => socket.destroy());
});
