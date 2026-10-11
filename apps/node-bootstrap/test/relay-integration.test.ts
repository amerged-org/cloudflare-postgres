// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import net, { type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import type { Duplex } from "node:stream";
import { test, type TestContext } from "node:test";
import { WebSocket } from "ws";
import {
  BOOTSTRAP_RELAY_HEADER,
  BOOTSTRAP_RELAY_PATH,
  signBootstrapRelay,
  type BootstrapCryptoKey,
} from "@pgcf/contracts/bootstrap-relay";
import { createBootstrapRelay } from "../../regional/src/bootstrap-relay.ts";
import { inputHash } from "../src/bootstrap.ts";
import {
  LOOPBACK,
  openCapability,
  openPooledRelay,
  relayGrantPool,
  relayGrants,
  startCapabilityProxy,
} from "../src/proxy-command.ts";
import { fixture } from "./fixture.ts";

async function localRelay(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-relay-tls-"));
  const identity = join(directory, "tls-identity");
  const certificate = join(directory, "tls-certificate");
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ed25519",
      "-nodes",
      "-keyout",
      identity,
      "-out",
      certificate,
      "-days",
      "1",
      "-subj",
      `/CN=${LOOPBACK}`,
      "-addext",
      `subjectAltName=IP:${LOOPBACK}`,
    ],
    { timeout: 60_000, encoding: "utf8" },
  );
  assert.equal(generated.status, 0);
  const cert = await readFile(certificate, "utf8");
  const key = await readFile(identity, "utf8");
  const originalCA = getCACertificates("default");
  setDefaultCACertificates([...originalCA, cert]);
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as { privateKey: BootstrapCryptoKey; publicKey: BootstrapCryptoKey };
  const keys = new Map([["current", pair.publicKey]]);
  const sockets = new Set<Socket>();
  let backendConnections = 0;
  const backend = net.createServer((socket) => {
    backendConnections++;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.pipe(socket);
  });
  backend.listen(6443, LOOPBACK);
  await once(backend, "listening");
  const input = fixture();
  const spec = {
    ...input.spec,
    hardware: { ...input.spec.hardware, ipv4: LOOPBACK },
    cluster_endpoint: `https://${LOOPBACK}:6443/`,
  };
  const config = {
    spec,
    input_hash: inputHash(spec),
    callback: input.callback,
  };
  const relayConfig = {
    region:
      spec.transport.mode === "relay"
        ? spec.transport.issuer_region_id
        : spec.region_id,
    issuerRegion:
      spec.transport.mode === "relay"
        ? spec.transport.issuer_region_id
        : spec.region_id,
    allowedTargetRegions: [spec.region_id],
    host: LOOPBACK,
    port: 0,
    keys,
  };
  let relay = createBootstrapRelay(relayConfig);
  const tlsSockets = new Set<Duplex>();
  const publicRelayPath = `/internal/v1/node-bootstrap/${spec.operation_id}/relay`;
  let upgrades = 0;
  const listener = createHttpsServer({ cert, key });
  listener.on("connection", (socket) => {
    tlsSockets.add(socket);
    socket.once("close", () => tlsSockets.delete(socket));
  });
  listener.on("upgrade", (request, socket, head) => {
    upgrades++;
    if (
      request.url !== publicRelayPath ||
      request.headers.authorization !== `Bearer ${config.callback.bearer}`
    ) {
      socket.end(
        "HTTP/1.1 401 Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      return;
    }
    delete request.headers.authorization;
    request.url = BOOTSTRAP_RELAY_PATH;
    relay.server.emit("upgrade", request, socket, head);
  });
  listener.listen(0, LOOPBACK);
  await once(listener, "listening");
  const port = (listener.address() as net.AddressInfo).port;
  config.callback = {
    ...config.callback,
    url: `https://${LOOPBACK}:${port}/internal/v1/node-bootstrap/${spec.operation_id}`,
  };
  const websocket_url = `wss://${LOOPBACK}:${port}${publicRelayPath}`;
  const token = (epoch = relay.identity.relay_epoch) =>
    signBootstrapRelay({
      privateKey: pair.privateKey,
      kid: "current",
      operation: spec.operation_id,
      node: spec.node_id,
      region: spec.region_id,
      issuer_region: relay.identity.issuer_region,
      relay_epoch: epoch,
      revision: spec.inventory_revision,
      capability: "kubernetes_api",
      address: LOOPBACK,
    });
  t.after(async () => {
    await relay.close();
    for (const socket of tlsSockets) socket.destroy();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    setDefaultCACertificates(originalCA);
    await rm(directory, { recursive: true, force: true });
  });
  return {
    config,
    websocket_url,
    token,
    upgrades: () => upgrades,
    backendConnections: () => backendConnections,
    restart: async () => {
      const previous = relay.identity.relay_epoch;
      await relay.close();
      relay = createBootstrapRelay(relayConfig);
      return previous;
    },
  };
}

/** Presents a token once more; a relay that admits it fails the caller. */
function refusalStatus(
  relay: Awaited<ReturnType<typeof localRelay>>,
  token: string,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const client = new WebSocket(relay.websocket_url, {
      headers: {
        [BOOTSTRAP_RELAY_HEADER]: token,
        authorization: `Bearer ${relay.config.callback.bearer}`,
      },
    });
    client.on("error", () => {});
    client.once("open", () => {
      client.terminate();
      reject(new Error("refused relay grant admitted"));
    });
    client.once("unexpected-response", (request, response) => {
      const status = response.statusCode!;
      response.destroy();
      request.destroy();
      client.terminate();
      resolve(status);
    });
  });
}

/** Batched callback: the real relay signs each token for its current epoch. */
function relayBatches(relay: Awaited<ReturnType<typeof localRelay>>) {
  const issued: string[][] = [];
  return {
    issued,
    request: async (_key: "kubernetes_api", count: number) => {
      const tokens = await Promise.all(
        Array.from({ length: count }, () => relay.token()),
      );
      issued.push(tokens);
      return relayGrants({
        websocket_url: relay.websocket_url,
        expectedTarget: { ip: LOOPBACK, port: 6443 },
        tokens,
      });
    },
  };
}

/** CONNECT with the payload in its head: the proxy forwards it only into an opened relay stream. */
async function tunnel(proxy: string, payload: Buffer) {
  const socket = net.connect(Number(new URL(proxy).port), LOOPBACK),
    established = Buffer.from("HTTP/1.1 200 Connection Established\r\n\r\n");
  socket.setTimeout(10_000, () => socket.destroy(new Error("tunnel_timeout")));
  await once(socket, "connect");
  socket.write(
    Buffer.concat([
      Buffer.from(
        `CONNECT ${LOOPBACK}:6443 HTTP/1.1\r\nHost: ${LOOPBACK}:6443\r\n\r\n`,
      ),
      payload,
    ]),
  );
  let received = Buffer.alloc(0);
  try {
    for await (const chunk of socket as AsyncIterable<Buffer>) {
      received = Buffer.concat([received, chunk]);
      if (received.length >= established.length + payload.length) break;
    }
  } finally {
    socket.destroy();
  }
  assert.deepEqual(received.subarray(0, established.length), established);
  return received.subarray(established.length);
}

test("native capability bridges bytes through an authenticated TLS API front and the real raw-token relay", async (t) => {
  const relay = await localRelay(t);
  const abort = new AbortController();
  const bridge = await openCapability(
    relay.config,
    "kubernetes_api",
    abort.signal,
    async () =>
      Response.json({
        websocket_url: relay.websocket_url,
        token: await relay.token(),
        expectedTarget: { ip: LOOPBACK, port: 6443 },
      }),
  );
  try {
    const expected = randomBytes(4096);
    const response = once(bridge, "data");
    bridge.write(expected);
    const [received] = await response;
    assert.deepEqual(received, expected);
  } finally {
    bridge.destroy();
    abort.abort();
  }
});

test("a relay restart rejects its old audience while the immutable job requests a fresh capability without an epoch", async (t) => {
  const relay = await localRelay(t);
  const originalHash = relay.config.input_hash;
  const oldToken = await relay.token();
  await relay.restart();
  assert.equal(await refusalStatus(relay, oldToken), 401);
  const abort = new AbortController();
  const bridge = await openCapability(
    relay.config,
    "kubernetes_api",
    abort.signal,
    async (_url, request) => {
      const message = JSON.parse(String(request?.body)) as {
        payload: unknown;
        input_hash: string;
      };
      assert.deepEqual(message.payload, { capability: "kubernetes_api" });
      assert.equal(message.input_hash, originalHash);
      return Response.json({
        websocket_url: relay.websocket_url,
        token: await relay.token(),
        expectedTarget: { ip: LOOPBACK, port: 6443 },
      });
    },
  );
  try {
    const expected = randomBytes(128);
    const response = once(bridge, "data");
    bridge.write(expected);
    assert.deepEqual((await response)[0], expected);
  } finally {
    bridge.destroy();
    abort.abort();
  }
  assert.equal(relay.config.input_hash, originalHash);
});

test("native capability rejects a different WebSocket origin or operation path before opening a socket", async (t) => {
  const relay = await localRelay(t);
  const response: typeof fetch = async () =>
    Response.json({
      websocket_url: relay.websocket_url,
      token: await relay.token(),
      expectedTarget: { ip: LOOPBACK, port: 6443 },
    });
  const config = {
    ...relay.config,
    callback: { ...relay.config.callback, url: fixture().callback.url },
  };
  await assert.rejects(
    openCapability(
      config,
      "kubernetes_api",
      AbortSignal.timeout(1000),
      response,
    ),
    /transport_endpoint_mismatch/,
  );
  assert.equal(relay.upgrades(), 0);
  const pathResponse: typeof fetch = async () =>
    Response.json({
      websocket_url: `${new URL(relay.websocket_url).origin}/internal/v1/node-bootstrap/${fixture().spec.operation_id}/relay`,
      token: await relay.token(),
      expectedTarget: { ip: LOOPBACK, port: 6443 },
    });
  await assert.rejects(
    openCapability(
      relay.config,
      "kubernetes_api",
      AbortSignal.timeout(1000),
      pathResponse,
    ),
    /transport_endpoint_mismatch/,
  );
  assert.equal(relay.upgrades(), 0);
});

test("one batched callback opens eight relay streams and each grant is admitted once", async (t) => {
  const relay = await localRelay(t),
    abort = new AbortController(),
    batches = relayBatches(relay),
    pool = relayGrantPool(batches.request, abort.signal);
  t.after(() => abort.abort());
  const streams = await Promise.all(
    Array.from({ length: 8 }, () =>
      openPooledRelay(
        pool,
        "kubernetes_api",
        relay.config.callback.bearer,
        abort.signal,
      ),
    ),
  );
  try {
    for (const stream of streams) {
      const expected = randomBytes(256),
        response = once(stream, "data");
      stream.write(expected);
      assert.deepEqual((await response)[0], expected);
    }
  } finally {
    for (const stream of streams) stream.destroy();
  }
  assert.equal(relay.upgrades(), 8);
  assert.equal(relay.backendConnections(), 8);
  assert.equal(batches.issued[0]!.length, 8);
  for (const token of batches.issued[0]!)
    assert.equal(await refusalStatus(relay, token), 401);
});

test("a relay restart refuses a pooled grant and the unanswered CONNECT retries once with a fresh batch", async (t) => {
  const relay = await localRelay(t),
    abort = new AbortController(),
    batches = relayBatches(relay),
    pool = relayGrantPool(batches.request, abort.signal),
    proxy = await startCapabilityProxy(
      (authority) =>
        authority === `${LOOPBACK}:6443` ? "kubernetes_api" : undefined,
      () =>
        openPooledRelay(
          pool,
          "kubernetes_api",
          relay.config.callback.bearer,
          abort.signal,
        ),
      abort.signal,
    );
  t.after(async () => {
    abort.abort();
    await proxy.close();
  });
  const first = randomBytes(64);
  assert.deepEqual(await tunnel(proxy.url, first), first);
  await relay.restart();
  const second = randomBytes(64);
  assert.deepEqual(await tunnel(proxy.url, second), second);
  assert.equal(batches.issued.length, 2);
  assert.equal(relay.upgrades(), 3);
  assert.equal(relay.backendConnections(), 2);
});
