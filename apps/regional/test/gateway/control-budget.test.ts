// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { IncomingMessage } from "node:http";
import { once } from "node:events";
import { Duplex } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { newDatabaseId } from "@pgcf/contracts";
import {
  BudgetedWebSocketSocket,
  GatewayMemoryBudget,
} from "../../src/gateway/frame-budget.ts";

function maskedFrame(opcode: number, data = Buffer.alloc(0)): Buffer {
  assert.ok(data.length < 126);
  const mask = randomBytes(4);
  const frame = Buffer.alloc(6 + data.length);
  frame[0] = 0x80 | opcode;
  frame[1] = 0x80 | data.length;
  mask.copy(frame, 2);
  for (let byte = 0; byte < data.length; byte++)
    frame[6 + byte] = data[byte]! ^ mask[byte % 4]!;
  return frame;
}

function upgrade(budget: GatewayMemoryBudget, stall: boolean) {
  let writes = 0;
  const raw = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      if (++writes === 1 || !stall) callback();
    },
  });
  raw.on("error", () => {});
  const guard = new BudgetedWebSocketSocket(
    raw,
    budget.owner(newDatabaseId()),
    32 * 1024 * 1024,
    Buffer.alloc(0),
  );
  const server = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    allowSynchronousEvents: true,
  });
  const request = new IncomingMessage(raw as never);
  request.method = "GET";
  request.url = "/";
  request.headers = {
    upgrade: "websocket",
    "sec-websocket-version": "13",
    "sec-websocket-key": randomBytes(16).toString("base64"),
  };
  let client: WebSocket | undefined;
  server.handleUpgrade(request, guard, Buffer.alloc(0), (socket) => {
    client = socket;
    socket.on("error", () => {});
    socket.binaryType = "fragments";
    socket.on("message", () => guard.takeMessage()?.release());
  });
  assert.ok(client);
  return { raw, guard, server, client };
}

test("cumulative automatic pong queues reject only the offender and preserve fifty healthy streams", async (t) => {
  const budget = new GatewayMemoryBudget(1024 * 1024, 512 * 1024);
  const connections: ReturnType<typeof upgrade>[] = [];
  const healthy = budget.owner(newDatabaseId());
  t.after(async () => {
    for (const { guard, server } of connections) {
      guard.destroy();
      server.close();
    }
    healthy.close();
    await nextTurn();
    assert.equal(budget.used, 0);
  });
  const first = upgrade(budget, true);
  const offender = upgrade(budget, true);
  connections.push(first, offender);
  await nextTurn();
  first.raw.push(
    Buffer.concat(Array.from({ length: 900 }, () => maskedFrame(9))),
  );
  await nextTurn();
  offender.raw.push(
    Buffer.concat(Array.from({ length: 900 }, () => maskedFrame(9))),
  );
  await nextTurn();
  const queuedBytes = budget.used;
  let acceptedHealthy = 0;
  for (let index = 0; index < 50; index++) {
    if (healthy.lease().grow(Math.ceil(budget.smallTrafficReserve / 50)))
      acceptedHealthy++;
  }
  assert.equal(
    acceptedHealthy,
    50,
    "automatic pong queues must preserve the small-traffic headroom",
  );
  assert.ok(queuedBytes <= budget.limit - budget.smallTrafficReserve);
  assert.equal(first.guard.destroyed, false);
  assert.equal(first.client.readyState, WebSocket.OPEN);
  assert.equal(offender.guard.destroyed, true);
  assert.equal(offender.client.readyState, WebSocket.CLOSED);
  for (let index = 0; index < 50; index++) {
    const connection = upgrade(budget, false);
    connections.push(connection);
    const received = once(connection.client, "message");
    const payload = randomBytes(8);
    connection.raw.push(maskedFrame(2, payload));
    const [data, binary] = await received;
    assert.equal(binary, true);
    assert.deepEqual(Buffer.concat(data), payload);
    assert.equal(connection.client.readyState, WebSocket.OPEN);
  }
  t.diagnostic(
    JSON.stringify({
      queuedBytes,
      headroomBytes: budget.smallTrafficReserve,
      acceptedHealthy,
      offenderClosed: offender.guard.destroyed,
    }),
  );
});

test("partial outbound completion and late stalled callbacks return cumulative credit exactly once", async () => {
  const budget = new GatewayMemoryBudget(16384, 8192);
  const callbacks: ((error?: Error | null) => void)[] = [];
  const completed: [number, number, number] = [0, 0, 0];
  const raw = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callbacks.push(callback);
    },
  });
  raw.on("error", () => {});
  const owner = budget.owner(newDatabaseId());
  const guarded = new BudgetedWebSocketSocket(
    raw,
    owner,
    32 * 1024 * 1024,
    Buffer.alloc(0),
  );
  guarded.write(Buffer.alloc(1024), () => completed[0]++);
  guarded.write(Buffer.alloc(2048), () => completed[1]++);
  guarded.write(Buffer.alloc(4096), () => completed[2]++);
  assert.equal(budget.used, 7936);
  assert.equal(callbacks.length, 1);
  callbacks.shift()!();
  await nextTurn();
  assert.equal(budget.used, 6656);
  assert.deepEqual(completed, [1, 0, 0]);
  callbacks.shift()!();
  await nextTurn();
  assert.equal(budget.used, 6656);
  const closed = once(guarded, "close");
  guarded.destroy();
  await closed;
  assert.equal(budget.used, 0);
  callbacks.shift()!(new Error("socket closed"));
  await nextTurn();
  owner.close();
  assert.equal(budget.used, 0);
  assert.deepEqual(completed, [1, 1, 1]);
  assert.equal(owner.lease().grow(1), false);
});
