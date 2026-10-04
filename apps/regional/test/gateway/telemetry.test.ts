// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { newDatabaseId, newOperationId } from "@pgcf/contracts";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import { createConnection } from "node:net";
import type { TLSSocket } from "node:tls";
import { encodeStartup } from "@pgcf/contracts/pg-wire";
import {
  GATEWAY_ACTIVITY_HEADER,
  GATEWAY_ACTIVITY_PATH,
  gatewayActivityReportSchema,
  signGatewayActivity,
} from "@pgcf/contracts/gateway-activity";
import {
  GATEWAY_FENCE_LABEL,
  gatewayFenceName,
  signGatewayControl,
} from "@pgcf/contracts/gateway-control";
import { GatewayMeasurements } from "../../src/gateway/telemetry.ts";
import { createGatewayControl } from "../../src/gateway/control.ts";
import { GatewayFenceStore } from "../../src/gateway/fences.ts";
import { DatabaseCaCache } from "../../src/gateway/ca.ts";
import { createPostgresDial } from "../../src/gateway/postgres.ts";
import {
  database,
  derived,
  gatewayFor,
  loopback,
  open,
  postgresServer,
  region,
  rejection,
  token,
  validCertificate,
} from "./helpers.ts";

function frame(type: string, body = Buffer.alloc(0)) {
  const value = Buffer.alloc(5 + body.length);
  value[0] = type.charCodeAt(0);
  value.writeUInt32BE(4 + body.length, 1);
  body.copy(value, 5);
  return value;
}
const authReady = Buffer.concat([
  frame("R", Buffer.alloc(4)),
  frame("Z", Buffer.from("I")),
]);
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("measurement condition did not settle");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("real WebSocket PG payload counts distinguish idle, query, transaction, pipeline and closed sessions", async (t) => {
  let backend: TLSSocket | undefined,
    incoming = 0;
  const postgres = await postgresServer(undefined, (socket) => {
    backend = socket;
    let first = true;
    socket.on("data", (chunk) => {
      incoming += chunk.length;
      if (first) {
        first = false;
        socket.write(authReady);
      }
    });
  });
  const { gateway, port } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const client = await open(port),
    startup = Buffer.from(encodeStartup({ user: "app", database }));
  const response = once(client, "message");
  client.send(startup);
  await response;
  await until(() => gateway.activity(database).busyConnections === 0);
  let report = gateway.activity(database);
  assert.equal(report.connections, 1);
  assert.equal(report.authenticatedConnections, 1);
  assert.equal(report.ingressBytes, startup.length);
  assert.equal(report.egressBytes, authReady.length);
  const idleActivity = report.lastActivityAt;
  const pong = once(client, "pong");
  client.ping(Buffer.from("heartbeat"));
  await pong;
  await fetch(`http://${loopback}:${port}/healthz`);
  assert.equal(gateway.activity(database).lastActivityAt, idleActivity);
  assert.equal(gateway.activity(database).ingressBytes, startup.length);
  const query = frame("Q", Buffer.from("SELECT 1\0"));
  client.send(query);
  await until(() => incoming === startup.length + query.length);
  assert.equal(gateway.activity(database).busyConnections, 1);
  let received = once(client, "message");
  backend!.write(frame("Z", Buffer.from("T")));
  await received;
  assert.equal(gateway.activity(database).busyConnections, 1);
  client.send(query);
  await until(() => incoming === startup.length + 2 * query.length);
  received = once(client, "message");
  backend!.write(frame("Z", Buffer.from("I")));
  await received;
  await until(() => gateway.activity(database).busyConnections === 0);
  client.send(Buffer.concat([query, query]));
  await until(() => incoming === startup.length + 4 * query.length);
  received = once(client, "message");
  backend!.write(frame("Z", Buffer.from("I")));
  await received;
  assert.equal(gateway.activity(database).busyConnections, 1);
  received = once(client, "message");
  backend!.write(frame("Z", Buffer.from("I")));
  await received;
  await until(() => gateway.activity(database).busyConnections === 0);
  report = gateway.activity(database);
  assert.equal(report.ingressBytes, startup.length + 4 * query.length);
  assert.equal(
    report.egressBytes,
    authReady.length + 4 * frame("Z", Buffer.from("I")).length,
  );
  assert.equal(report.totalConnections, 1);
  const closed = once(client, "close");
  client.close();
  await closed;
  await until(() => gateway.activity(database).connections === 0);
  const final = gateway.activity(database);
  assert.equal(final.busyConnections, 0);
  assert.equal(final.totalConnections, 1);
  assert.equal(final.ingressBytes, report.ingressBytes);
  assert.equal(final.egressBytes, report.egressBytes);
  assert.equal(final.authenticatedConnections, 0);
});

test("pending real PostgreSQL dials stay busy and contribute no authenticated usage", async (t) => {
  const postgres = await postgresServer(undefined, (socket) =>
    socket.once("data", () => socket.write(authReady)),
  );
  let releaseDial!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseDial = resolve;
  });
  const dial = createPostgresDial(
    new DatabaseCaCache(async () => validCertificate.cert),
    {
      tcpConnect: () =>
        createConnection({ host: loopback, port: postgres.port }),
      timeoutMs: 2000,
    },
  );
  const { gateway, port } = await gatewayFor(postgres.port, {
    dial: async (target, signal) => {
      await gate;
      return dial(target, signal);
    },
  });
  t.after(async () => {
    releaseDial();
    await gateway.drain();
    await postgres.close();
  });
  const client = await open(port);
  client.send(Buffer.from(encodeStartup({ user: "app", database })));
  await until(() => gateway.activity(database).pendingDials === 1);
  const pending = gateway.activity(database);
  assert.equal(pending.connections, 1);
  assert.equal(pending.busyConnections, 1);
  assert.equal(pending.authenticatedConnections, 0);
  assert.equal(pending.totalConnections, 0);
  assert.equal(pending.ingressBytes, 0);
  assert.equal(postgres.handshakes(), 0);
  const response = once(client, "message");
  releaseDial();
  await response;
  await until(() => gateway.activity(database).busyConnections === 0);
  assert.equal(gateway.activity(database).pendingDials, 0);
  assert.equal(gateway.activity(database).authenticatedConnections, 1);
  const closed = once(client, "close");
  client.close();
  await closed;
});

test("private activity HTTP reads require one purpose/Pod/revision-bound token and no body", async (t) => {
  const postgres = await postgresServer(),
    pod = randomUUID();
  const { gateway, port } = await gatewayFor(postgres.port, {
    control: (req, res) => controls?.(req, res) ?? false,
  });
  const store = new GatewayFenceStore(gateway),
    controls = createGatewayControl({
      gateway,
      store,
      pod,
      region,
      keyring: derived,
    });
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const operation = newOperationId();
  const signed = (overrides = {}) =>
    signGatewayActivity({
      keyring: derived,
      region,
      database,
      revision: 1,
      pod,
      ...overrides,
    });
  const call = async (value?: string, overrides: RequestInit = {}) => {
    const response = await fetch(
      `http://${loopback}:${port}${GATEWAY_ACTIVITY_PATH}`,
      {
        method: "POST",
        ...(value ? { headers: { [GATEWAY_ACTIVITY_HEADER]: value } } : {}),
        ...overrides,
      },
    );
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  assert.equal((await call()).status, 401);
  assert.equal((await call(await token())).status, 401);
  const value = await signed();
  assert.equal((await call(value)).status, 503);
  store.load([
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: gatewayFenceName(database),
        namespace: "pgcf-system",
        uid: randomUUID(),
        resourceVersion: "1",
        labels: {
          [GATEWAY_FENCE_LABEL]: "true",
          "pgcf.io/database-id": database,
        },
      },
      data: {
        "intent.json": JSON.stringify({
          database,
          operation,
          revision: 1,
          mode: "running",
        }),
      },
    },
  ]);
  store.connected();
  const result = await call(value);
  assert.equal(result.status, 200);
  const report = gatewayActivityReportSchema.parse(result.body);
  assert.equal(report.history, "current_process_absence");
  assert.equal(report.lastActivityAt, null);
  assert.equal((await call(value)).body.error, "activity_replayed");
  assert.equal((await call(await signed({ pod: randomUUID() }))).status, 401);
  assert.equal((await call(await signed({ revision: 2 }))).status, 409);
  assert.equal(
    (await call(await signed({ database: newDatabaseId() }))).status,
    409,
  );
  assert.equal(
    (await call(await signed({ now: Date.now() - 60_000 }))).status,
    401,
  );
  const control = await signGatewayControl({
    keyring: derived,
    region,
    database,
    revision: 1,
    pod,
    operation,
    action: "status",
  });
  assert.equal((await call(control)).status, 401);
  assert.equal(await rejection(port, await signed()), 401);
  assert.equal((await call(await signed(), { method: "GET" })).status, 405);
  assert.equal((await call(await signed(), { body: "x" })).status, 400);
  const duplicate = await signed();
  const duplicateStatus = await new Promise<number>((resolve, reject) => {
    const req = request(
      `http://${loopback}:${port}${GATEWAY_ACTIVITY_PATH}`,
      {
        method: "POST",
        headers: {
          [GATEWAY_ACTIVITY_HEADER]: [duplicate, duplicate],
          "Content-Length": "0",
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode!);
      },
    );
    req.once("error", reject);
    req.end();
  });
  assert.equal(duplicateStatus, 401);
  assert.equal(gateway.activity(database).totalConnections, 0);
  assert.equal(postgres.handshakes(), 0);
});

test("counts successful authenticated sessions exactly without mutating reads", () => {
  let now = Date.now();
  const measurements = new GatewayMeasurements({
      now: () => now,
      maxRecords: 2,
    }),
    id = newDatabaseId();
  const session = measurements.begin(id);
  session.ingress(10);
  session.egress(20);
  assert.equal(measurements.read(id).ingressBytes, 0);
  session.authenticate();
  session.ingress(7);
  session.egress(11);
  session.clientActivity();
  now += 1000;
  assert.equal(measurements.read(id).ingressBytes, 17);
  assert.equal(measurements.read(id).egressBytes, 31);
  assert.equal(measurements.read(id).totalConnections, 1);
  assert.equal(measurements.read(id).connectionMilliseconds, 1000);
  const before = measurements.read(id);
  assert.deepEqual(measurements.read(id), before);
  session.close();
  now += 1000;
  assert.equal(measurements.read(id).connectionMilliseconds, 1000);
  const failed = measurements.begin(id);
  failed.ingress(100);
  failed.egress(200);
  failed.close();
  assert.equal(measurements.read(id).ingressBytes, 17);
  assert.equal(measurements.read(id).totalConnections, 1);
});
test("bounds records, reads never allocate, and eviction/restarts do not invent history", () => {
  const measurements = new GatewayMeasurements({ maxRecords: 2 }),
    ids = [newDatabaseId(), newDatabaseId(), newDatabaseId()];
  assert.equal(measurements.read(ids[0]!).history, "current_process_absence");
  assert.equal(measurements.size, 0);
  for (let index = 0; index < 100; index++) measurements.read(newDatabaseId());
  assert.equal(measurements.size, 0);
  for (const id of ids) {
    const session = measurements.begin(id);
    session.authenticate();
    session.close();
  }
  assert.equal(measurements.size, 2);
  assert.equal(measurements.read(ids[0]!).history, "unavailable");
  assert.equal(measurements.read(ids[0]!).totalConnections, null);
  const recreated = measurements.begin(ids[0]!);
  recreated.authenticate();
  recreated.close();
  assert.equal(measurements.read(ids[0]!).history, "partial");
  const restarted = new GatewayMeasurements();
  assert.notEqual(restarted.epoch, measurements.epoch);
  assert.equal(restarted.read(ids[0]!).history, "current_process_absence");
});

test("active record saturation remains explicitly unavailable without evicting another live database", () => {
  const measurements = new GatewayMeasurements({ maxRecords: 1 }),
    firstId = newDatabaseId(),
    secondId = newDatabaseId();
  const first = measurements.begin(firstId);
  first.authenticate();
  first.ingress(11);
  const second = measurements.begin(secondId);
  second.authenticate();
  second.ingress(22);
  assert.equal(measurements.size, 1);
  assert.equal(measurements.read(firstId).ingressBytes, 11);
  assert.equal(measurements.read(secondId).history, "unavailable");
  assert.equal(measurements.read(secondId).ingressBytes, null);
  first.close();
  second.close();
  assert.equal(measurements.read(secondId).totalConnections, null);
});
