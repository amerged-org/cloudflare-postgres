// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { neonConfig } from "@neondatabase/serverless";

const sockets = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:sockets")
      return {
        url: "data:text/javascript,export function connect() { throw new Error('unexpected_socket_call'); }",
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const probe = await import("../probe/worker.ts");
sockets.deregister();

function environment(expiresAt?: string) {
  return {
    PROBE_BEARER: randomBytes(32).toString("base64url"),
    INTEGRATOR_KEY: randomBytes(32).toString("base64url"),
    DATABASE_ID: `d${randomBytes(10).toString("hex").slice(0, 19)}`,
    API_URL: `https://${["api", "test"].join(".")}`,
    ENDPOINT_HOST: ["edge", "test"].join("."),
    RUN_EXPIRES_AT: expiresAt,
  };
}

test("probe expires before any handler or authentication can cause side effects", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("unexpected_provider_call");
  };
  try {
    const env = environment(new Date(Date.now() - 1).toISOString());
    const request = (path: string, method = "POST") =>
      new Request(`https://${["probe", "test"].join(".")}${path}`, {
        method,
        headers: { Authorization: `Bearer ${env.PROBE_BEARER}` },
      });
    for (const path of [
      "/metadata",
      "/exercise",
      "/refusal",
      "/scan",
      "/canary-audit",
      "/integrator-trace",
      "/unknown",
    ]) {
      const reply = await probe.default.fetch(request(path), env);
      assert.equal(reply.status, 410, path);
      assert.deepEqual(await reply.json(), { code: "run_expired" });
    }
    const reply = await probe.default.fetch(request("/metadata", "GET"), env);
    assert.equal(reply.status, 410);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("probe rejects missing, invalid and overlong run expiry", async () => {
  for (const expiry of [
    undefined,
    "invalid",
    new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString(),
  ]) {
    const env = environment(expiry);
    const reply = await probe.default.fetch(
      new Request(`https://${["probe", "test"].join(".")}/metadata`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.PROBE_BEARER}` },
      }),
      env,
    );
    assert.equal(reply.status, 410);
  }
});

test("run expiry is canonical, strictly future and at most 24 hours", async () => {
  const { runActive } = await import("../src/run-expiry.ts");
  const now = Date.UTC(2026, 9, 2);
  const future = new Date(now + 60_000).toISOString();
  assert.equal(runActive(future, now), true);
  assert.equal(runActive(new Date(now + 86_400_000).toISOString(), now), true);
  assert.equal(runActive(new Date(now + 86_400_001).toISOString(), now), false);
  assert.equal(runActive(new Date(now).toISOString(), now), false);
  assert.equal(runActive(new Date(now - 1).toISOString(), now), false);
  assert.equal(runActive(future.replace(".000Z", "Z"), now), false);
  assert.equal(runActive(undefined, now), false);
  assert.equal(runActive("invalid", now), false);
  assert.equal(runActive(future, Number.NaN), false);
});

test("credential request carries one validated marker in its URL and header", () => {
  const env = environment();
  const marker = randomBytes(24).toString("hex");
  const incoming = new Request(`https://${["probe", "test"].join(".")}`, {
    headers: { "X-PGCF-E2E-Marker": marker },
  });
  assert.equal(probe.requestTraceMarker(incoming), marker);
  const request = probe.connectionRequest(env, marker);
  const url = new URL(request.url);
  assert.equal(url.searchParams.get("pgcf_trace"), marker);
  assert.equal(request.headers.get("X-PGCF-E2E-Marker"), marker);
  assert(
    request.headers.get("Authorization") === `Bearer ${env.INTEGRATOR_KEY}`,
  );
  assert.equal(url.pathname.endsWith("/roles/app/connection-uri"), true);
  assert.equal(url.pathname.includes(env.DATABASE_ID), true);
  assert.equal(url.searchParams.has("password"), false);
  assert.equal(request.redirect, "error");
  assert.equal(probe.requestTraceMarker(new Request(incoming.url)), undefined);
  assert.throws(
    () =>
      probe.requestTraceMarker(
        new Request(incoming.url, {
          headers: { "X-PGCF-E2E-Marker": "invalid" },
        }),
      ),
    { message: "invalid_trace_marker" },
  );
  assert.throws(() => probe.connectionRequest(env, "invalid"), {
    message: "invalid_trace_marker",
  });
});

test("native Pool clients keep concurrent trace markers on separate WebSocket URLs", async () => {
  const env = environment();
  const password = randomBytes(32).toString("base64url");
  const uri = `postgres://app:${password}@${env.ENDPOINT_HOST}/${env.DATABASE_ID}`;
  const first = randomBytes(24).toString("hex");
  const second = randomBytes(24).toString("hex");
  const globalProxy = neonConfig.wsProxy;
  const a = probe.probePool(uri, first);
  const b = probe.probePool(uri, second);
  const plain = probe.probePool(uri);
  try {
    const clientA = new a.Client({ connectionString: uri });
    const clientB = new b.Client({ connectionString: uri });
    const clientPlain = new plain.Client({ connectionString: uri });
    const urlA = new URL(
      `wss://${clientA.neonConfig.wsProxyAddrForHost(env.ENDPOINT_HOST, 5432)}`,
    );
    const urlB = new URL(
      `wss://${clientB.neonConfig.wsProxyAddrForHost(env.ENDPOINT_HOST, 5432)}`,
    );
    assert.equal(urlA.searchParams.get("pgcf_trace"), first);
    assert.equal(urlB.searchParams.get("pgcf_trace"), second);
    assert.equal(urlA.pathname, "/v2");
    assert.equal(urlB.pathname, "/v2");
    assert.equal(neonConfig.wsProxy, globalProxy);
    assert.equal(clientPlain.neonConfig.wsProxy, globalProxy);
    assert.equal(clientA.neonConfig.useSecureWebSocket, true);
    assert.equal(clientA.neonConfig.pipelineConnect, false);
    assert.equal(clientA.neonConfig.forceDisablePgSSL, true);
  } finally {
    await Promise.all([a.end(), b.end(), plain.end()]);
  }
});

test("integrator trace uses the credential URI request and returns only safe metadata", async () => {
  const env = environment(new Date(Date.now() + 60_000).toISOString());
  const password = randomBytes(32).toString("base64url");
  const uri = `postgres://app:${password}@${env.ENDPOINT_HOST}/${env.DATABASE_ID}`;
  const marker = randomBytes(24).toString("hex");
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls++;
    assert(input instanceof Request);
    assert.equal(new URL(input.url).searchParams.get("pgcf_trace"), marker);
    assert.equal(input.headers.get("X-PGCF-E2E-Marker"), marker);
    assert(
      input.headers.get("Authorization") === `Bearer ${env.INTEGRATOR_KEY}`,
    );
    return Response.json({ uri, includes_password: true });
  };
  try {
    const request = (withMarker: boolean) =>
      new Request(`https://${["probe", "test"].join(".")}/integrator-trace`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.PROBE_BEARER}`,
          ...(withMarker ? { "X-PGCF-E2E-Marker": marker } : {}),
        },
      });
    const missing = await probe.default.fetch(request(false), env);
    assert.equal(missing.status, 400);
    assert.equal(calls, 0);
    const reply = await probe.default.fetch(request(true), env);
    assert.equal(reply.status, 200);
    const text = await reply.text();
    assert(!text.includes(password));
    assert(!text.includes(env.INTEGRATOR_KEY));
    assert(!text.includes(uri));
    assert.deepEqual(JSON.parse(text), {
      includes_password: true,
      host_matches: true,
      database_matches: true,
    });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
