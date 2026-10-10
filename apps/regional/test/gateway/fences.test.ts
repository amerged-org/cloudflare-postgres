// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createServer, request, type ServerResponse } from "node:http";
import { once } from "node:events";
import { createServer as createHttpsServer } from "node:https";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { KubeConfig } from "@kubernetes/client-node";
import { test } from "node:test";
import { newDatabaseId, newOperationId } from "@pgcf/contracts";
import {
  gatewayFenceName,
  GATEWAY_FENCE_LABEL,
} from "@pgcf/contracts/gateway-control";
import {
  GatewayFenceStore,
  clusterFenceRequest,
  watchGatewayFences,
  type FenceRequest,
  MAX_FENCE_EVENT_BYTES,
} from "../../src/gateway/fences.ts";
import {
  database,
  certificate,
  gatewayFor,
  loopback,
  open,
  postgresServer,
  rejection,
  token,
} from "./helpers.ts";

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error("bounded condition unavailable");
    await delay(1);
  }
}
function resource(
  db = database,
  operation = newOperationId(),
  revision = 1,
  mode = "quiesce",
  uid = randomUUID(),
) {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: gatewayFenceName(db),
      namespace: "pgcf-system",
      uid,
      resourceVersion: "1",
      labels: { [GATEWAY_FENCE_LABEL]: "true", "pgcf.io/database-id": db },
    },
    data: {
      "intent.json": JSON.stringify({
        database: db,
        operation,
        revision,
        mode,
      }),
    },
  };
}

test("real Kubernetes typed-list entries omit their own apiVersion and kind", async (t) => {
  const upstream = await source();
  const map = resource();
  const entry = { metadata: map.metadata, data: map.data };
  const store = new GatewayFenceStore({
    beginQuiesce() {
      return {
        database,
        operation: JSON.parse(map.data["intent.json"]).operation,
        status: "idle",
        connections: 0,
        busyConnections: 0,
        pendingDials: 0,
      };
    },
    releaseQuiesce() {},
  });
  const watcher = watchGatewayFences(store, upstream.fetch);
  t.after(async () => {
    await watcher.stop();
    await upstream.close();
  });
  upstream.unblock([entry]);
  await until(() => store.ready);
  assert.equal(store.get(database)?.mode, "quiesce");
});
async function source() {
  let maps: unknown[] = [];
  let blocked = true;
  let listCalls = 0;
  const watchers: ServerResponse[] = [],
    lists: ServerResponse[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, `http://${loopback}`);
    assert.equal(
      url.searchParams.get("labelSelector"),
      `${GATEWAY_FENCE_LABEL}=true`,
    );
    if (url.searchParams.get("watch") === "true") {
      res.writeHead(200);
      res.flushHeaders();
      watchers.push(res);
    } else {
      listCalls++;
      if (blocked) lists.push(res);
      else
        res.end(
          JSON.stringify({
            apiVersion: "v1",
            kind: "ConfigMapList",
            metadata: { resourceVersion: "1" },
            items: maps,
          }),
        );
    }
  });
  server.listen(0, loopback);
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const fetch: FenceRequest = (query, signal) =>
    new Promise((resolve, reject) => {
      const req = request(
        `http://${loopback}:${address.port}/?${query}`,
        { signal },
        resolve,
      );
      req.once("error", reject);
      req.end();
    });
  return {
    fetch,
    watchers,
    lists,
    listCalls: () => listCalls,
    unblock(items: unknown[]) {
      maps = items;
      blocked = false;
      for (const res of lists.splice(0))
        res.end(
          JSON.stringify({
            apiVersion: "v1",
            kind: "ConfigMapList",
            metadata: { resourceVersion: "1" },
            items,
          }),
        );
    },
    block() {
      blocked = true;
    },
    async close() {
      for (const res of [...watchers, ...lists]) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("complete snapshot gates startup; watch loss blocks admission and recovery retains the fence", async (t) => {
  const postgres = await postgresServer();
  const sync = {
    get ready() {
      return store?.ready ?? false;
    },
    get epoch() {
      return store?.epoch ?? 0;
    },
  };
  const { gateway, port } = await gatewayFor(postgres.port, {
    fenceSynchronization: sync,
  });
  const store = new GatewayFenceStore(gateway);
  const api = await source();
  const watch = watchGatewayFences(store, api.fetch);
  t.after(async () => {
    await watch.stop();
    await gateway.drain();
    await postgres.close();
    await api.close();
  });
  const oldRoute = await token();
  assert.equal((await fetch(`http://${loopback}:${port}/healthz`)).status, 200);
  assert.equal((await fetch(`http://${loopback}:${port}/readyz`)).status, 503);
  assert.equal(await rejection(port, oldRoute), 503);
  await until(() => api.lists.length === 1);
  const map = resource();
  api.unblock([map]);
  await until(() => store.ready);
  assert.equal(await rejection(port, oldRoute), 503);
  const other = newDatabaseId();
  const socket = await open(port, await token({ db: other }));
  socket.terminate();
  assert.equal((await fetch(`http://${loopback}:${port}/readyz`)).status, 200);
  api.block();
  api.watchers[0]!.destroy();
  await until(() => !store.ready);
  assert.equal(await rejection(port, await token({ db: other })), 503);
  await until(() => api.listCalls() === 2);
  api.unblock([map]);
  await until(() => store.ready);
  assert.equal(await rejection(port, oldRoute), 503);
  api.watchers[1]!.write(
    JSON.stringify({
      type: "MODIFIED",
      object: { ...map, data: { "intent.json": "broken" } },
    }) + "\n",
  );
  await until(() => !store.ready);
  assert.equal((await fetch(`http://${loopback}:${port}/readyz`)).status, 503);
  await watch.stop();
  assert.equal(store.ready, false);
});

test("normal fence watch renewal preserves unchanged authority without admitting stale observations", async (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port, {
    fenceSynchronization: {
      get ready() {
        return store?.ready ?? false;
      },
      get epoch() {
        return store?.epoch ?? 0;
      },
    },
  });
  const store = new GatewayFenceStore(gateway);
  const api = await source();
  const watcher = watchGatewayFences(store, api.fetch);
  t.after(async () => {
    await watcher.stop();
    await gateway.drain();
    await postgres.close();
    await api.close();
  });
  const map = resource();
  api.unblock([map]);
  await until(() => store.ready);
  const epoch = store.epoch;
  clock = 55_000;
  api.block();
  api.watchers[0]!.end();
  await until(() => api.listCalls() === 2);
  assert.equal(store.ready, true);
  assert.equal(store.epoch, epoch);
  const other = newDatabaseId();
  const duringRenewal = await open(port, await token({ db: other }));
  duringRenewal.terminate();
  assert.equal(await rejection(port, await token()), 503);
  api.unblock([map]);
  await until(() => api.watchers.length === 2);
  assert.equal(store.ready, true);
  assert.equal(store.epoch, epoch);
  const running = resource(
    database,
    newOperationId(),
    2,
    "running",
    map.metadata.uid,
  );
  clock += 55_000;
  api.unblock([running]);
  api.watchers[1]!.end();
  await until(() => api.watchers.length === 3);
  assert.equal(store.get(database)?.mode, "running");
  const afterChange = await open(port, await token());
  afterChange.terminate();
  clock += 70_000;
  assert.equal(store.ready, false);
  assert.equal(await rejection(port, await token()), 503);
});

test("a clean fence watch EOF before its expected lifetime remains an authority loss", async (t) => {
  const postgres = await postgresServer();
  const { gateway } = await gatewayFor(postgres.port);
  const store = new GatewayFenceStore(gateway);
  const api = await source();
  const watcher = watchGatewayFences(store, api.fetch);
  t.after(async () => {
    await watcher.stop();
    await gateway.drain();
    await postgres.close();
    await api.close();
  });
  api.unblock([]);
  await until(() => store.ready);
  const epoch = store.epoch;
  api.block();
  api.watchers[0]!.end();
  await until(() => !store.ready);
  assert(store.epoch > epoch);
});

test("monotonic retained running records reject stale operations, rollback and disappearance", async (t) => {
  const postgres = await postgresServer();
  const { gateway } = await gatewayFor(postgres.port);
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const store = new GatewayFenceStore(gateway);
  const map = resource();
  store.load([map]);
  const intent = JSON.parse(map.data["intent.json"]);
  const running = resource(
    database,
    newOperationId(),
    2,
    "running",
    map.metadata.uid,
  );
  store.update(running);
  assert.equal(store.get(database)?.revision, 2);
  assert.throws(() => store.update(map));
  assert.throws(() => store.load([]));
  assert.throws(() =>
    store.update(
      resource(database, intent.operation, 2, "quiesce", map.metadata.uid),
    ),
  );
  assert.throws(() =>
    store.update(resource(database, intent.operation, 3, "quiesce")),
  );
});

test("a restarted gateway loads the persisted fence before accepting a still-valid token", async (t) => {
  const postgres = await postgresServer();
  const first = await gatewayFor(postgres.port, {
    fenceSynchronization: {
      get ready() {
        return firstStore?.ready ?? false;
      },
      get epoch() {
        return firstStore?.epoch ?? 0;
      },
    },
  });
  const firstStore = new GatewayFenceStore(first.gateway);
  const api = await source();
  const firstWatch = watchGatewayFences(firstStore, api.fetch);
  const second = await gatewayFor(postgres.port, {
    fenceSynchronization: {
      get ready() {
        return secondStore?.ready ?? false;
      },
      get epoch() {
        return secondStore?.epoch ?? 0;
      },
    },
  });
  const secondStore = new GatewayFenceStore(second.gateway);
  t.after(async () => {
    await firstWatch.stop();
    await secondWatch.stop();
    await first.gateway.drain();
    await second.gateway.drain();
    await postgres.close();
    await api.close();
  });
  const stale = await token();
  await until(() => api.lists.length === 1);
  api.unblock([resource()]);
  await until(() => firstStore.ready);
  const secondWatch = watchGatewayFences(secondStore, api.fetch);
  await until(() => secondStore.ready);
  assert.equal(await rejection(first.port, stale), 503);
  assert.equal(await rejection(second.port, stale), 503);
  assert.equal(postgres.handshakes(), 0);
  assert.equal(api.listCalls(), 2);
});

test("oversized or malformed watch input fails readiness without replacing the last fence", async (t) => {
  const postgres = await postgresServer();
  const { gateway } = await gatewayFor(postgres.port);
  const store = new GatewayFenceStore(gateway);
  const api = await source();
  const watch = watchGatewayFences(store, api.fetch);
  t.after(async () => {
    await watch.stop();
    await gateway.drain();
    await postgres.close();
    await api.close();
  });
  await until(() => api.lists.length === 1);
  const map = resource();
  api.unblock([map]);
  await until(() => store.ready);
  api.block();
  api.watchers[0]!.write("x".repeat(MAX_FENCE_EVENT_BYTES + 1));
  await until(() => !store.ready);
  assert.equal(store.get(database)?.revision, 1);
  const foreign = {
    ...map,
    metadata: {
      ...map.metadata,
      labels: {
        ...map.metadata.labels,
        "pgcf.io/database-id": newDatabaseId(),
      },
    },
  };
  assert.throws(() => store.update(foreign));
  assert.equal(store.ready, false);
  await watch.stop();
  const calls = api.listCalls();
  await delay(5);
  assert.equal(api.listCalls(), calls);
});

test("the real Kubernetes HTTPS transport authenticates, bounds one list/watch and reaps sockets", async (t) => {
  const host = ["local", "host"].join("");
  const credentials = certificate(host),
    credential = randomBytes(32).toString("base64url");
  const map = resource();
  const sockets = new Set<import("node:stream").Duplex>();
  let requests = 0;
  const api = createHttpsServer(credentials, (req, res) => {
    requests++;
    assert.equal(req.headers.authorization === `Bearer ${credential}`, true);
    const url = new URL(req.url!, `https://${host}`);
    assert.equal(url.pathname, "/api/v1/namespaces/pgcf-system/configmaps");
    assert.equal(
      url.searchParams.get("labelSelector"),
      `${GATEWAY_FENCE_LABEL}=true`,
    );
    if (url.searchParams.get("watch") === "true") {
      res.writeHead(200);
      res.flushHeaders();
    } else
      res.end(
        JSON.stringify({
          apiVersion: "v1",
          kind: "ConfigMapList",
          metadata: { resourceVersion: "4" },
          items: [map],
        }),
      );
  });
  api.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  api.listen(0, host);
  await once(api, "listening");
  const address = api.address();
  assert(address && typeof address === "object");
  const config = new KubeConfig();
  config.loadFromOptions({
    clusters: [
      {
        name: "fixture",
        server: `https://${host}:${address.port}`,
        caData: Buffer.from(credentials.cert).toString("base64"),
      },
    ],
    users: [{ name: "fixture", token: credential }],
    contexts: [{ name: "fixture", user: "fixture", cluster: "fixture" }],
    currentContext: "fixture",
  });
  const postgres = await postgresServer();
  const { gateway, port } = await gatewayFor(postgres.port, {
    fenceSynchronization: {
      get ready() {
        return store?.ready ?? false;
      },
      get epoch() {
        return store?.epoch ?? 0;
      },
    },
  });
  const store = new GatewayFenceStore(gateway);
  const watch = watchGatewayFences(store, clusterFenceRequest(config));
  t.after(async () => {
    await watch.stop();
    await gateway.drain();
    await postgres.close();
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });
  await until(() => store.ready);
  const stale = await token();
  assert.equal(await rejection(port, stale), 503);
  assert.equal(await rejection(port, stale), 503);
  assert.equal(requests, 2);
  assert.equal(postgres.handshakes(), 0);
  await watch.stop();
  await until(() => sockets.size === 0);
  assert.equal(store.ready, false);
});

test("a valid terminal retirement permits watch deletion and relist disappearance while regular loss remains fenced", () => {
  const events: string[] = [];
  const gateway = {
    beginQuiesce() {
      return {
        database,
        operation: newOperationId(),
        status: "idle" as const,
        connections: 0,
        busyConnections: 0,
        pendingDials: 0,
      };
    },
    releaseQuiesce() {},
    beginRetirement(db: string) {
      events.push(`retire:${db}`);
    },
    retirementStatus(db: string, operation: string) {
      return {
        database: db,
        operation,
        status: "closed" as const,
        connections: 0,
        busyConnections: 0,
        pendingDials: 0,
      };
    },
    forgetRetirement(db: string) {
      events.push(`forget:${db}`);
    },
  };
  const store = new GatewayFenceStore(gateway);
  const running = resource(database, newOperationId(), 1, "running");
  store.load([running]);
  store.connected();
  const retired = resource(
    database,
    newOperationId(),
    2,
    "retired",
    running.metadata.uid,
  );
  retired.data["retired-at" as "intent.json"] = new Date(
    Date.now() - 66_000,
  ).toISOString();
  store.update(retired);
  (store as unknown as { remove(value: unknown): void }).remove(retired);
  assert.equal(store.get(database), undefined);
  store.load([]);
  store.connected();
  assert.equal(store.ready, true);
  assert.deepEqual(events, [`retire:${database}`, `forget:${database}`]);
  const regular = resource(newDatabaseId(), newOperationId(), 1, "running");
  store.update(regular);
  assert.throws(() => store.load([]));
  assert.equal(store.ready, false);
});

test("terminal disappearance rejects premature age, replaced UID, stale intents and sessions; successful churn releases capacity", () => {
  let busy = false;
  const gateway = {
    beginQuiesce() {
      return {
        database,
        operation: newOperationId(),
        status: "idle" as const,
        connections: 0,
        busyConnections: 0,
        pendingDials: 0,
      };
    },
    releaseQuiesce() {},
    beginRetirement() {},
    retirementStatus(db: string, operation: string) {
      return {
        database: db,
        operation,
        status: busy ? ("busy" as const) : ("closed" as const),
        connections: busy ? 1 : 0,
        busyConnections: 0,
        pendingDials: 0,
      };
    },
    forgetRetirement() {},
  };
  const store = new GatewayFenceStore(gateway),
    regular = resource(database, newOperationId(), 1, "running");
  store.load([regular]);
  const terminal = {
    ...resource(database, newOperationId(), 2, "retired", regular.metadata.uid),
    data: { "intent.json": "", "retired-at": new Date().toISOString() },
  };
  terminal.data["intent.json"] = JSON.stringify({
    database,
    operation: newOperationId(),
    revision: 2,
    mode: "retired",
  });
  store.update(terminal);
  assert.throws(() => store.remove(terminal));
  assert.equal(store.ready, false);
  assert.throws(() => store.update(regular));
  assert.throws(() =>
    store.remove({
      ...terminal,
      metadata: { ...terminal.metadata, uid: randomUUID() },
    }),
  );
  const other = new GatewayFenceStore(gateway);
  for (let count = 0; count < 2100; count++) {
    const id = newDatabaseId(),
      map = resource(id, newOperationId(), 1, "running");
    other.update(map);
    const retired = {
      ...resource(id, newOperationId(), 2, "retired", map.metadata.uid),
      data: {
        "intent.json": "",
        "retired-at": new Date(Date.now() - 66_000).toISOString(),
      },
    };
    retired.data["intent.json"] = JSON.stringify({
      database: id,
      operation: newOperationId(),
      revision: 2,
      mode: "retired",
    });
    other.update(retired);
    if (count === 0) {
      busy = true;
      assert.throws(() => other.remove(retired));
      busy = false;
    }
    other.remove(retired);
    assert.equal(other.get(id), undefined);
  }
  other.load([]);
  other.connected();
  assert.equal(other.ready, true);
});

test("foreground deletion metadata stays synchronized only for a previously observed mature terminal", () => {
  const gateway = {
    beginQuiesce() {
      return {
        database,
        operation: newOperationId(),
        status: "idle" as const,
        connections: 0,
        busyConnections: 0,
        pendingDials: 0,
      };
    },
    releaseQuiesce() {},
    beginRetirement() {},
    retirementStatus(db: string, operation: string) {
      return {
        database: db,
        operation,
        status: "closed" as const,
        connections: 0,
        busyConnections: 0,
        pendingDials: 0,
      };
    },
    forgetRetirement() {},
  };
  const store = new GatewayFenceStore(gateway),
    base = resource(database, newOperationId(), 1, "running");
  store.load([base]);
  const terminal = {
    ...resource(database, newOperationId(), 2, "retired", base.metadata.uid),
    data: {
      "intent.json": "",
      "retired-at": new Date(Date.now() - 66_000).toISOString(),
    },
  };
  terminal.data["intent.json"] = JSON.stringify({
    database,
    operation: newOperationId(),
    revision: 2,
    mode: "retired",
  });
  store.update(terminal);
  store.connected();
  const dying = {
    ...terminal,
    metadata: {
      ...terminal.metadata,
      resourceVersion: "3",
      deletionTimestamp: new Date().toISOString(),
    },
  };
  store.update(dying);
  assert.equal(store.ready, true);
  store.load([dying]);
  store.connected();
  assert.equal(store.ready, true);
  store.remove(dying);
  assert.equal(store.get(database), undefined);
  const unknown = new GatewayFenceStore(gateway);
  assert.throws(() => unknown.load([dying]));
  assert.equal(unknown.ready, false);
});

test("an asynchronous quiescence-drain failure disconnects the fence observer without an unhandled rejection", async () => {
  const map = resource();
  const store = new GatewayFenceStore({
    beginQuiesce: () => Promise.reject(new Error("fixture close failure")),
    releaseQuiesce() {},
  });
  store.load([map]);
  store.connected();
  assert.equal(store.ready, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(store.ready, false);
  store.observe();
  assert.equal(store.ready, false);
  assert.equal(store.get(database)?.mode, "quiesce");
});
