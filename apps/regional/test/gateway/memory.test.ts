// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import type { WebSocket } from "ws";
import { newDatabaseId } from "@pgcf/contracts";
import { DatabaseCaCache } from "../../src/gateway/ca.ts";
import {
  createPostgresDial,
  databaseTarget,
} from "../../src/gateway/postgres.ts";
import { createConnection } from "node:net";
import {
  database,
  gatewayFor,
  loopback,
  open,
  postgresServer,
  start,
  token,
  validCertificate,
} from "./helpers.ts";

test("an unfinished fragmented message exhausts only its database before ws assembly", async (t) => {
  const postgres = await postgresServer();
  const actualDial = createPostgresDial(
    new DatabaseCaCache(async () => validCertificate.cert),
    {
      tcpConnect: () =>
        createConnection({ host: loopback, port: postgres.port }),
    },
  );
  const { gateway, port } = await gatewayFor(postgres.port, {
    memoryLimitBytes: 8 * 1024 * 1024,
    databaseMemoryLimitBytes: 4 * 1024 * 1024,
    dial: (_target, signal) => actualDial(databaseTarget(database), signal),
  });
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const attacker = await open(port);
  await start(attacker);
  const healthyDatabase = newDatabaseId();
  const healthy = await open(port, await token({ db: healthyDatabase }));
  await start(healthy, { user: "app", database: healthyDatabase });
  const signal = AbortSignal.timeout(5_000);
  const result = Promise.race([
    once(attacker, "close", { signal }).then(() => "closed"),
    once(attacker, "pong", { signal }).then(() => "pong"),
  ]);
  const fragment = Buffer.alloc(1024 * 1024);
  attacker.send(fragment, { fin: false });
  attacker.send(fragment, { fin: false });
  attacker.send(fragment, { fin: false });
  attacker.ping();
  assert.equal(
    await result,
    "closed",
    "incomplete frames must be budgeted before message delivery",
  );
  const echoed = once(healthy, "message", { signal });
  const small = Buffer.from("healthy-tenant");
  healthy.send(small);
  assert.deepEqual(Buffer.from((await echoed)[0]), small);
  assert.equal(gateway.metrics.activeConnections, 1);
});

test("fifty small connections share real TLS relays without reserving maximum message capacity", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port);
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await gateway.drain();
    await postgres.close();
  });
  for (let index = 0; index < 50; index++) sockets.push(await open(port));
  assert.equal(gateway.metrics.activeConnections, 50);
  assert.ok(gateway.metrics.memoryBytes < 1024 * 1024);
  await Promise.all(sockets.map((socket) => start(socket)));
  await Promise.all(
    sockets.map(async (socket, index) => {
      const expected = Buffer.from(`small-query-${index}`);
      const reply = once(socket, "message", {
        signal: AbortSignal.timeout(5_000),
      });
      socket.send(expected);
      assert.deepEqual(Buffer.from((await reply)[0]), expected);
    }),
  );
  assert.equal(postgres.handshakes(), 50);
  await gateway.drain();
  assert.equal(gateway.metrics.activeConnections, 0);
  assert.equal(gateway.metrics.memoryBytes, 0);
});

test("a complete 32 MiB message and a longer stream retain exact bytes and release ingress reservations", async (t) => {
  const { createHash, randomBytes } = await import("node:crypto");
  const { MAX_PAYLOAD_BYTES } = await import("../../src/gateway/server.ts");
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port);
  await start(socket);
  const block = randomBytes(1024 * 1024);
  const large = Buffer.alloc(MAX_PAYLOAD_BYTES);
  for (let offset = 0; offset < large.length; offset += block.length)
    block.copy(large, offset);
  const expected = createHash("sha256");
  const actual = createHash("sha256");
  const streamLength = large.length + block.length * 64;
  let received = 0;
  const complete = new Promise<void>((resolve, reject) => {
    socket.on("message", (data) => {
      const chunk = Buffer.from(data as Buffer);
      received += chunk.length;
      actual.update(chunk);
      if (received === streamLength) resolve();
    });
    socket.once("error", reject);
    socket.once("close", () => {
      if (received !== streamLength)
        reject(new Error("large stream closed early"));
    });
  });
  expected.update(large);
  socket.send(large);
  for (let index = 0; index < 64; index++) {
    const watermark = large.length + index * block.length;
    while (received < watermark)
      await once(socket, "message", { signal: AbortSignal.timeout(5_000) });
    expected.update(block);
    socket.send(block);
  }
  await complete;
  assert.equal(actual.digest("hex"), expected.digest("hex"));
  assert.equal(received, streamLength);
  const closed = once(socket, "close");
  socket.close();
  await closed;
  assert.equal(gateway.metrics.memoryBytes, 0);
});

test("an isolated real gateway bounds RSS under a multi-tenant fragmented attack while fifty small relays remain usable", async (t) => {
  const { fork } = await import("node:child_process");
  const { WebSocket } = await import("ws");
  const { derived, region } = await import("./helpers.ts");
  const { DEFAULT_MEMORY_LIMIT_BYTES } =
    await import("../../src/gateway/server.ts");
  const postgres = await postgresServer();
  const worker = fork(new URL("./memory-probe.ts", import.meta.url), [], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const exited = once(worker, "exit");
  const peers: import("ws").WebSocket[] = [];
  let errorOutput = "";
  worker.stderr?.on("data", (chunk: Buffer) => {
    errorOutput += chunk.toString();
  });
  t.after(async () => {
    for (const socket of peers) socket.terminate();
    if (worker.connected) worker.send({ kind: "stop" });
    if (worker.exitCode === null && worker.signalCode === null) {
      const timer = setTimeout(() => worker.kill(), 5_000);
      await exited;
      clearTimeout(timer);
    }
    await postgres.close();
  });
  const ready = once(worker, "message", {
    signal: AbortSignal.timeout(10_000),
  });
  worker.send({
    kind: "start",
    region,
    active: derived.active,
    keys: [...derived.keys].map(([kid, key]) => [
      kid,
      Buffer.from(key).toString("base64url"),
    ]),
    postgresPort: postgres.port,
    ca: validCertificate.cert,
  });
  const [listening] = (await ready) as [{ port: number; baselineRss: number }];
  const healthy = [];
  for (let index = 0; index < 50; index++) {
    const socket = await open(listening.port);
    peers.push(socket);
    healthy.push(socket);
  }
  await Promise.all(healthy.map((socket) => start(socket)));
  const attackers = [];
  for (let tenant = 0; tenant < 4; tenant++) {
    const attackingDatabase = newDatabaseId();
    for (let index = 0; index < 3; index++) {
      const socket = await open(
        listening.port,
        await token({ db: attackingDatabase }),
      );
      socket.on("error", () => {});
      peers.push(socket);
      attackers.push(socket);
    }
  }
  let rejected = 0;
  for (const socket of attackers) socket.once("close", () => rejected++);
  const fragment = Buffer.alloc(1024 * 1024);
  for (let round = 0; round < 16; round++) {
    for (const socket of attackers) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const pending = new AbortController();
      const signal = AbortSignal.any([
        pending.signal,
        AbortSignal.timeout(5_000),
      ]);
      const responded = Promise.race([
        once(socket, "pong", { signal }),
        once(socket, "close", { signal }),
      ]);
      socket.send(fragment, { fin: false });
      socket.ping();
      try {
        await responded;
      } finally {
        pending.abort();
      }
    }
  }
  assert.ok(rejected > 0, "budget must reject offending connections");
  const rejectedDuringAttack = rejected;
  const roundTripsStarted = performance.now();
  await Promise.all(
    healthy.map(async (socket, index) => {
      for (let request = 0; request < 100; request++) {
        const expected = Buffer.from(
          `healthy-after-attack-${index}-${request}`,
        );
        const reply = once(socket, "message", {
          signal: AbortSignal.timeout(5_000),
        });
        socket.send(expected);
        assert.deepEqual(Buffer.from((await reply)[0]), expected);
      }
    }),
  );
  const roundTripsMs = performance.now() - roundTripsStarted;
  const sampled = once(worker, "message", {
    signal: AbortSignal.timeout(5_000),
  });
  worker.send({ kind: "sample" });
  const [during] = (await sampled) as [
    {
      memoryBytes: number;
      peakMemoryBytes: number;
      baselineRss: number;
      peakRss: number;
    },
  ];
  assert.ok(during.memoryBytes <= DEFAULT_MEMORY_LIMIT_BYTES);
  assert.ok(during.peakMemoryBytes <= DEFAULT_MEMORY_LIMIT_BYTES);
  assert.ok(
    during.peakRss < 512 * 1024 * 1024,
    "real gateway RSS must fit the existing 512 MiB pod limit",
  );
  const stopped = once(worker, "message", {
    signal: AbortSignal.timeout(5_000),
  });
  worker.send({ kind: "stop" });
  const [after] = (await stopped) as [
    {
      activeConnections: number;
      memoryBytes: number;
      peakMemoryBytes: number;
      baselineRss: number;
      peakRss: number;
    },
  ];
  assert.equal(after.activeConnections, 0);
  assert.equal(after.memoryBytes, 0);
  const [exitCode, signal] = await exited;
  assert.equal(exitCode, 0, errorOutput);
  assert.equal(signal, null);
  t.diagnostic(
    JSON.stringify({
      gatewayRssBaselineBytes: after.baselineRss,
      gatewayRssPeakBytes: after.peakRss,
      gatewayRssGrowthBytes: after.peakRss - after.baselineRss,
      peakReservedBytes: after.peakMemoryBytes,
      rejectedAttackers: rejectedDuringAttack,
      echoRoundTrips: healthy.length * 100,
      echoRoundTripsMs: roundTripsMs,
      echoRoundTripsPerSecond: (healthy.length * 100 * 1000) / roundTripsMs,
      attackers: attackers.length,
      healthyRelays: healthy.length,
      configuredMemoryBytes: DEFAULT_MEMORY_LIMIT_BYTES,
      podMemoryBytes: 512 * 1024 * 1024,
    }),
  );
});

test("fragment reservations are released after disconnect, framing error, cancel and gateway restart", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port, events } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const disconnected = await open(port);
  const pong = once(disconnected, "pong");
  disconnected.send(Buffer.alloc(1024), { fin: false });
  disconnected.ping();
  await pong;
  assert.ok(gateway.metrics.memoryBytes > 0);
  const released = once(events, "conn_close");
  disconnected.terminate();
  await released;
  assert.equal(gateway.metrics.memoryBytes, 0);

  const malformed = await open(port);
  const malformedClosed = once(malformed, "close");
  const malformedReleased = once(events, "conn_close");
  (
    malformed as unknown as { _socket: import("node:net").Socket }
  )._socket.write(Buffer.from([0x82, 0]));
  assert.equal((await malformedClosed)[0], 1002);
  await malformedReleased;
  assert.equal(gateway.metrics.memoryBytes, 0);

  const cancel = await open(port);
  const cancelClosed = once(cancel, "close");
  const cancelReleased = once(events, "conn_close");
  const packet = Buffer.alloc(16);
  packet.writeUInt32BE(packet.length, 0);
  packet.writeUInt32BE(80877102, 4);
  cancel.send(packet);
  assert.equal((await cancelClosed)[0], 1000);
  await cancelReleased;
  assert.equal(gateway.metrics.memoryBytes, 0);
  assert.equal(postgres.handshakes(), 0);

  const restarting = await open(port);
  const fragmented = once(restarting, "pong");
  restarting.send(Buffer.alloc(1024), { fin: false });
  restarting.ping();
  await fragmented;
  assert.ok(gateway.metrics.memoryBytes > 0);
  const restarted = once(restarting, "close");
  const drained = gateway.drain();
  assert.equal((await restarted)[0], 1012);
  await drained;
  assert.equal(gateway.metrics.memoryBytes, 0);
});

test("a startup timeout frees an unfinished frame assembly without a PostgreSQL dial", async (t) => {
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port, {
    startupTimeoutMs: 250,
  });
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const socket = await open(port);
  const closed = once(socket, "close");
  const error = once(socket, "message");
  const pong = once(socket, "pong");
  socket.send(Buffer.alloc(1024), { fin: false });
  socket.ping();
  await pong;
  assert.ok(gateway.metrics.memoryBytes > 0);
  assert.match(Buffer.from((await error)[0]).toString(), /08006/);
  await closed;
  assert.equal(gateway.metrics.memoryBytes, 0);
  assert.equal(postgres.handshakes(), 0);
});
