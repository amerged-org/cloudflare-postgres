// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { newDatabaseId } from "@pgcf/contracts";
import { encodeSslRequest, encodeStartup } from "@pgcf/contracts/pg-wire";
import {
  database,
  gatewayFor,
  open,
  postgresServer,
  token,
} from "./helpers.ts";

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
