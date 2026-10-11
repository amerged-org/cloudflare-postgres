// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { test } from "node:test";
import {
  RELAY_GRANT_BATCH_MAX,
  type NodeBootstrapTransport,
} from "@pgcf/contracts/node-bootstrap";
import {
  RELAY_GRANT_LOW_WATER,
  RELAY_GRANT_USABLE_MS,
  capabilityTarget,
  openCapability,
  relayGrantPool,
  relayGrants,
  startNativeProxy,
} from "../src/proxy-command.ts";
import { fixture } from "./fixture.ts";

const relayUrl =
  "wss://api.invalid/internal/v1/fleet-patches/op_aaaaaaaaaaaaaaaaaaaa/relay";
const grantBatch = (label: string) =>
  relayGrants({
    websocket_url: relayUrl,
    expectedTarget: { ip: "192.0.2.18", port: 6443 },
    tokens: Array.from({ length: RELAY_GRANT_BATCH_MAX }, (_, index) =>
      `${label}-${index}-`.padEnd(32, "x"),
    ),
  });
function deferredGrants() {
  const requests: {
    count: number;
    resolve: (grants: NodeBootstrapTransport[]) => void;
  }[] = [];
  return {
    requests,
    request: (_key: "kubernetes_api", count: number) =>
      new Promise<NodeBootstrapTransport[]>((resolve) =>
        requests.push({ count, resolve }),
      ),
  };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));

test("pooled relay grants expire at fifteen seconds local age and a fresh batch replaces them", async () => {
  let clock = 1000;
  const requested: number[] = [];
  const pool = relayGrantPool(
    async (_key: "kubernetes_api", count) => {
      requested.push(count);
      return grantBatch(`batch${requested.length}`);
    },
    new AbortController().signal,
    () => clock,
  );
  assert.ok((await pool.take("kubernetes_api")).token.startsWith("batch1-0-"));
  clock += RELAY_GRANT_USABLE_MS - 1;
  assert.ok((await pool.take("kubernetes_api")).token.startsWith("batch1-1-"));
  clock += 1;
  assert.ok((await pool.take("kubernetes_api")).token.startsWith("batch2-0-"));
  assert.deepEqual(requested, [RELAY_GRANT_BATCH_MAX, RELAY_GRANT_BATCH_MAX]);
});

test("concurrent connections share one in-flight batch and refill once at four remaining grants", async () => {
  const { requests, request } = deferredGrants(),
    pool = relayGrantPool(request, new AbortController().signal),
    waiting = Array.from({ length: 3 }, () => pool.take("kubernetes_api"));
  await turn();
  assert.equal(requests.length, 1);
  requests[0]!.resolve(grantBatch("first"));
  const taken = await Promise.all(waiting);
  assert.equal(requests.length, 1);
  taken.push(await pool.take("kubernetes_api"));
  assert.equal(requests.length, 2);
  for (let index = 0; index < RELAY_GRANT_LOW_WATER; index++)
    taken.push(await pool.take("kubernetes_api"));
  const ninth = pool.take("kubernetes_api");
  await turn();
  assert.equal(requests.length, 2);
  requests[1]!.resolve(grantBatch("second"));
  taken.push(await ninth);
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map((value) => value.count),
    [RELAY_GRANT_BATCH_MAX, RELAY_GRANT_BATCH_MAX],
  );
  assert.equal(new Set(taken.map((grant) => grant.token)).size, 9);
  assert.ok(taken[8]!.token.startsWith("second-0-"));
});

test("clearing the pool drops pooled grants and discards a batch requested before the refusal", async () => {
  const { requests, request } = deferredGrants(),
    pool = relayGrantPool(request, new AbortController().signal),
    first = pool.take("kubernetes_api");
  await turn();
  requests[0]!.resolve(grantBatch("old"));
  await first;
  for (let index = 0; index < 3; index++) await pool.take("kubernetes_api");
  assert.equal(requests.length, 2);
  pool.clear();
  const fresh = pool.take("kubernetes_api");
  await turn();
  assert.equal(requests.length, 3);
  requests[1]!.resolve(grantBatch("stale"));
  requests[2]!.resolve(grantBatch("new"));
  const grants = [await fresh];
  for (let index = 1; index < RELAY_GRANT_BATCH_MAX; index++)
    grants.push(await pool.take("kubernetes_api"));
  assert.ok(grants.every((grant) => grant.token.startsWith("new-")));
});

test("an older API's single grant is a batch of one and duplicate batch tokens are refused", async () => {
  const single = {
    websocket_url: relayUrl,
    token: "legacy".padEnd(32, "x"),
    expectedTarget: { ip: "192.0.2.18", port: 6443 as const },
  };
  assert.deepEqual(relayGrants(single), [single]);
  assert.throws(() =>
    relayGrants({
      websocket_url: relayUrl,
      expectedTarget: single.expectedTarget,
      tokens: [single.token, single.token],
    }),
  );
  let requested = 0;
  const pool = relayGrantPool<"kubernetes_api">(
    async () =>
      relayGrants({
        ...single,
        token: `legacy-${++requested}-`.padEnd(32, "x"),
      }),
    new AbortController().signal,
  );
  const first = await pool.take("kubernetes_api");
  await turn();
  const second = await pool.take("kubernetes_api");
  assert.notEqual(first.token, second.token);
  assert.equal(requested, 3);
});

test("relay capability refuses a callback target that differs from immutable provider identity", async () => {
  const input = fixture();
  let requests = 0;
  const config = {
    spec: input.spec,
    input_hash: input.input_hash,
    callback: input.callback,
  };
  await assert.rejects(
    openCapability(
      config,
      "rescue_ssh",
      AbortSignal.timeout(1000),
      async (_url, options) => {
        requests++;
        assert.equal(
          new Headers(options?.headers).get("authorization"),
          `Bearer ${input.callback.bearer}`,
        );
        return Response.json({
          websocket_url: `wss://${randomUUID()}.invalid/relay`,
          token: randomUUID(),
          expectedTarget: { ip: [192, 0, 2, 18].join("."), port: 22 },
        });
      },
    ),
    /transport_target_mismatch/,
  );
  assert.equal(requests, 1);
  assert.equal(capabilityTarget(config, "talos_api").port, 50000);
  assert.equal(
    capabilityTarget(config, "kubernetes_api").ip,
    new URL(input.spec.cluster_endpoint).hostname,
  );
});

test("native CONNECT proxy denies public PostgreSQL and unapproved host requests before relay admission", async () => {
  const input = fixture();
  const abort = new AbortController();
  const proxy = await startNativeProxy(
    {
      spec: input.spec,
      input_hash: input.input_hash,
      callback: input.callback,
    },
    abort.signal,
  );
  try {
    const response = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(proxy.url, {
        method: "CONNECT",
        path: `${input.spec.hardware.ipv4}:5432`,
      });
      const timer = setTimeout(() => {
        request.destroy();
        resolve(0);
      }, 1500);
      request.once("connect", (response, socket) => {
        clearTimeout(timer);
        socket.destroy();
        resolve(response.statusCode!);
      });
      request.once("error", reject);
      request.end();
    });
    assert.equal(response, 403);
  } finally {
    await proxy.close();
  }
});

test("CONNECT accounting admits sixty-four clients once and frees closed or failed-grant reservations", async () => {
  // Isolate the actual proxy with controlled upstream streams; local HTTP sockets remain real.
  const source = await readFile(
    new URL("../src/proxy-command.ts", import.meta.url),
    "utf8",
  );
  const tree = ts.createSourceFile(
    "proxy",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = tree.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) && node.name?.text === "startNativeProxy",
  )!;
  const sharedDeclaration = tree.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "startCapabilityProxy",
  )!;
  const limit = tree.statements.find(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (value) => value.name.getText(tree) === "MAX_NATIVE_PROXY_CONNECTIONS",
      ),
  )!;
  const code = ts.transpileModule(
    limit.getText(tree) +
      "\n" +
      declaration.getText(tree).replace(/^export /, "") +
      "\n" +
      sharedDeclaration.getText(tree).replace(/^export /, "") +
      "\nglobalThis.start = startNativeProxy;",
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const streams: PassThrough[] = [];
  let failNext = false;
  let delayNext = false;
  let resolveLate!: (stream: PassThrough) => void;
  let pendingReached!: () => void;
  let pendingFailed!: (error: Error) => void;
  const pendingStarted = new Promise<void>((resolve, reject) => {
    pendingReached = resolve;
    pendingFailed = reject;
  });
  const scope = {
    createServer,
    capabilityTarget,
    LOOPBACK: "127.0.0.1",
    openCapability: async () => {
      if (delayNext) {
        delayNext = false;
        return new Promise<PassThrough>((resolve) => {
          resolveLate = resolve;
          pendingReached();
        });
      }
      if (failNext) {
        failNext = false;
        throw new Error("grant_refused");
      }
      const stream = new PassThrough();
      streams.push(stream);
      return stream;
    },
    start: undefined as unknown as typeof startNativeProxy,
  };
  runInNewContext(code, scope);
  const input = fixture(),
    abort = new AbortController(),
    clients: import("node:stream").Duplex[] = [];
  const proxy = await scope.start(
    {
      spec: input.spec,
      input_hash: input.input_hash,
      callback: input.callback,
    },
    abort.signal,
  );
  const connect = () =>
    new Promise<number>((resolve) => {
      const request = httpRequest(proxy.url, {
        method: "CONNECT",
        path: `${capabilityTarget({ spec: input.spec, input_hash: input.input_hash, callback: input.callback }, "kubernetes_api").ip}:6443`,
      });
      const timer = setTimeout(() => {
        request.destroy();
        resolve(0);
      }, 1500);
      request.once("connect", (response, socket) => {
        clearTimeout(timer);
        if (response.statusCode === 200) clients.push(socket);
        else socket.destroy();
        resolve(response.statusCode!);
      });
      request.once("error", () => {
        clearTimeout(timer);
        resolve(0);
      });
      request.end();
    });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  let pending: ReturnType<typeof httpRequest> | undefined;
  try {
    for (let client = 0; client < 64; client++)
      assert.equal(await connect(), 200);
    assert.notEqual(await connect(), 200);
    for (const client of clients.splice(0)) client.destroy();
    await settle();
    delayNext = true;
    pending = httpRequest(proxy.url, {
      method: "CONNECT",
      path: `${capabilityTarget({ spec: input.spec, input_hash: input.input_hash, callback: input.callback }, "kubernetes_api").ip}:6443`,
    });
    pending.on("error", pendingFailed);
    pending.end();
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pendingStarted,
        new Promise<never>((_resolve, reject) => {
          pendingTimer = setTimeout(
            () => reject(new Error("pending_grant_not_reached")),
            1500,
          );
        }),
      ]);
    } finally {
      clearTimeout(pendingTimer);
    }
    pending.destroy();
    await settle();
    const late = new PassThrough();
    streams.push(late);
    resolveLate(late);
    await settle();
    assert.equal(late.destroyed, true);
    assert.equal(await connect(), 200);
    clients.shift()!.destroy();
    await settle();
    assert.equal(await connect(), 200);
    for (const client of clients.splice(0)) client.destroy();
    await settle();
    failNext = true;
    assert.notEqual(await connect(), 200);
    await settle();
    for (let client = 0; client < 64; client++)
      assert.equal(await connect(), 200);
    assert.notEqual(await connect(), 200);
  } finally {
    pending?.destroy();
    for (const client of clients) client.destroy();
    abort.abort();
    await proxy.close();
  }
  assert.ok(streams.every((stream) => stream.destroyed));
});
