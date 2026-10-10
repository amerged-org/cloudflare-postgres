// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { neonConfig } from "@neondatabase/serverless";
import { WebSocket, WebSocketServer } from "ws";
import { once } from "node:events";
import { StartupReader, encodeErrorResponse } from "@pgcf/contracts/pg-wire";
import { safeProbeError } from "../src/transport.ts";

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

test("deleted-database refusal completes SCRAM with a generated password before accepting PostgreSQL rejection", async () => {
  const env = environment(new Date(Date.now() + 60_000).toISOString());
  const server = new WebSocketServer({
    host: [127, 0, 0, 1].join("."),
    port: 0,
  });
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const original = neonConfig.webSocketConstructor;
  let finalResponses = 0;
  const auth = (code: number, text: string) => {
    const body = Buffer.from(text),
      out = Buffer.alloc(body.length + 9);
    out[0] = 82;
    out.writeUInt32BE(out.length - 1, 1);
    out.writeUInt32BE(code, 5);
    body.copy(out, 9);
    return out;
  };
  server.on("connection", (socket) => {
    let phase = "startup";
    const reader = new StartupReader();
    socket.on("message", (bytes) => {
      const data = Buffer.from(bytes as Buffer);
      if (phase === "startup") {
        const event = reader.push(data);
        assert.equal(event.kind, "startup");
        phase = "first";
        socket.send(auth(10, "SCRAM-SHA-256\0\0"));
      } else if (phase === "first") {
        const body = data.subarray(5),
          end = body.indexOf(0);
        const first = body.subarray(end + 5).toString();
        const nonce = first
          .split(",")
          .find((field) => field.startsWith("r="))!
          .slice(2);
        phase = "final";
        socket.send(
          auth(
            11,
            `r=${nonce}${randomBytes(12).toString("base64")},s=${randomBytes(16).toString("base64")},i=4096`,
          ),
        );
      } else {
        finalResponses++;
        socket.send(
          encodeErrorResponse("28P01", "password authentication failed"),
        );
      }
    });
  });
  class LocalSocket extends WebSocket {
    constructor() {
      super(`ws://${[127, 0, 0, 1].join(".")}:${port}`);
    }
  }
  neonConfig.webSocketConstructor =
    LocalSocket as typeof neonConfig.webSocketConstructor;
  try {
    const response = await probe.default.fetch(
      new Request(`https://${["probe", "test"].join(".")}/refusal`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.PROBE_BEARER}` },
      }),
      env,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { pass: true });
    assert.equal(finalResponses, 1);
  } finally {
    neonConfig.webSocketConstructor = original;
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

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
      "/read-only",
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

test("read-only probe diagnostics retain standardized codes without exception credentials", () => {
  const secret = randomBytes(32).toString("base64url");
  const failure = Object.assign(new Error(`postgres://app:${secret}@host/db`), {
    name: "DatabaseError",
    code: "08006",
    detail: secret,
    cause: { password: secret },
  });
  assert.deepEqual(safeProbeError(failure), {
    error_class: "DatabaseError",
    sqlstate: "08006",
    errno: null,
  });
  const unexpected = safeProbeError({
    name: secret,
    code: secret,
    message: secret,
  });
  assert.deepEqual(unexpected, {
    error_class: "unknown",
    sqlstate: null,
    errno: null,
  });
  assert.equal(JSON.stringify(unexpected).includes(secret), false);
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
  assert.equal(request.redirect, "manual");
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

test("segmented markers retain exactly one request hint and strict input validation", () => {
  const env = environment();
  const entropy = randomBytes(24).toString("hex");
  const marker = `${entropy.slice(0, 16)}.${entropy.slice(16, 32)}.${entropy.slice(32)}`;
  const incoming = new Request(`https://${["probe", "test"].join(".")}`, {
    headers: { "X-PGCF-E2E-Marker": marker },
  });
  assert.equal(probe.requestTraceMarker(incoming), marker);
  const request = probe.connectionRequest(env, marker);
  assert.deepEqual(new URL(request.url).searchParams.getAll("pgcf_trace"), [
    marker,
  ]);
  assert.equal(request.headers.get("X-PGCF-E2E-Marker"), marker);
  assert.equal(
    request.headers.get("Authorization"),
    `Bearer ${env.INTEGRATOR_KEY}`,
  );
  assert.equal(request.redirect, "manual");
  assert.equal(request.signal.aborted, false);
  assert.throws(() => probe.connectionRequest(env, marker + "."), {
    message: "invalid_trace_marker",
  });
  assert.throws(
    () => probe.connectionRequest(env, marker.replaceAll(".", "_")),
    { message: "invalid_trace_marker" },
  );
});

test("native Pool clients keep interleaved database, role and trace hints separate", async () => {
  const env = environment();
  const other = environment();
  const role = `r${randomBytes(8).toString("hex")}`;
  const password = randomBytes(32).toString("base64url");
  const uri = `postgres://app:${password}@${env.ENDPOINT_HOST}/${env.DATABASE_ID}`;
  const otherUri = `postgres://${role}:${password}@${env.ENDPOINT_HOST}/${other.DATABASE_ID}`;
  const first = randomBytes(24).toString("hex");
  const second = randomBytes(24).toString("hex");
  const globalProxy = neonConfig.wsProxy;
  const a = probe.probePool(uri, first);
  const b = probe.probePool(otherUri, second);
  const plain = probe.probePool(uri);
  try {
    const clientA = new a.Client({ connectionString: uri });
    const clientB = new b.Client({ connectionString: otherUri });
    const clientPlain = new plain.Client({ connectionString: uri });
    const urlA = new URL(
      `wss://${clientA.neonConfig.wsProxyAddrForHost(env.ENDPOINT_HOST, 5432)}`,
    );
    const urlB = new URL(
      `wss://${clientB.neonConfig.wsProxyAddrForHost(env.ENDPOINT_HOST, 5432)}`,
    );
    const urlPlain = new URL(
      `wss://${clientPlain.neonConfig.wsProxyAddrForHost(env.ENDPOINT_HOST, 5432)}`,
    );
    assert.equal(urlA.searchParams.get("pgcf_trace"), first);
    assert.equal(urlB.searchParams.get("pgcf_trace"), second);
    assert.equal(urlA.searchParams.get("database"), env.DATABASE_ID);
    assert.equal(urlA.searchParams.get("user"), "app");
    assert.equal(urlB.searchParams.get("database"), other.DATABASE_ID);
    assert.equal(urlB.searchParams.get("user"), role);
    assert.equal(urlPlain.searchParams.get("database"), env.DATABASE_ID);
    assert.equal(urlPlain.searchParams.get("user"), "app");
    assert.equal(urlPlain.searchParams.has("pgcf_trace"), false);
    assert.equal(urlA.pathname, "/v2");
    assert.equal(urlB.pathname, "/v2");
    assert.equal(neonConfig.wsProxy, globalProxy);
    assert.equal(neonConfig.wsProxy, globalProxy);
    assert.equal(clientA.neonConfig.useSecureWebSocket, true);
    assert.equal(clientA.neonConfig.pipelineConnect, false);
    assert.equal(clientA.neonConfig.forceDisablePgSSL, true);
  } finally {
    await Promise.all([a.end(), b.end(), plain.end()]);
  }
});

test("probe Pool refuses an implicit database instead of letting the driver default it", () => {
  const env = environment();
  assert.throws(() => probe.probePool(`postgres://app@${env.ENDPOINT_HOST}/`), {
    message: "connection_metadata_invalid",
  });
});

test("probe Pool refuses an implicit user instead of letting the driver default it", () => {
  const env = environment();
  assert.throws(
    () => probe.probePool(`postgres://${env.ENDPOINT_HOST}/${env.DATABASE_ID}`),
    { message: "connection_metadata_invalid" },
  );
});

test("probe Pool refuses connection-option overrides and URI fragments", () => {
  const env = environment();
  const uri = `postgres://app@${env.ENDPOINT_HOST}/${env.DATABASE_ID}`;
  const changed = new URL(uri);
  changed.searchParams.set("host", ["other", "test"].join("."));
  assert.throws(() => probe.probePool(changed.href), {
    message: "connection_metadata_invalid",
  });
  changed.search = "";
  changed.hash = "route";
  assert.throws(() => probe.probePool(changed.href), {
    message: "connection_metadata_invalid",
  });
});

test("encoded URI identities produce decoded hints without password or credential fields", async () => {
  const env = environment();
  const password = `${randomBytes(16).toString("base64url")}:&?=${randomBytes(16).toString("base64url")}`;
  const uri = `postgres://%61%70%70:${encodeURIComponent(password)}@${env.ENDPOINT_HOST}/%64${env.DATABASE_ID.slice(1)}`;
  const marker = randomBytes(24).toString("hex");
  const pool = probe.probePool(uri, marker);
  try {
    const client = new pool.Client({ connectionString: uri });
    const url = new URL(
      `wss://${client.neonConfig.wsProxyAddrForHost(env.ENDPOINT_HOST, 5432)}`,
    );
    assert.equal(url.searchParams.get("database"), env.DATABASE_ID);
    assert.equal(url.searchParams.get("user"), "app");
    assert.deepEqual([...url.searchParams.keys()].sort(), [
      "database",
      "pgcf_trace",
      "user",
    ]);
    assert.equal(client.database, url.searchParams.get("database"));
    assert.equal(client.user, url.searchParams.get("user"));
    assert.equal(url.username, "");
    assert.equal(url.password, "");
    assert(!url.href.includes(password));
    assert(!url.href.includes(encodeURIComponent(password)));
  } finally {
    await pool.end();
  }
});

test("a reset password keeps the same role hint and cannot leak into its WebSocket URL", async () => {
  const env = environment();
  const oldPassword = randomBytes(32).toString("base64url");
  const newPassword = randomBytes(32).toString("base64url");
  const oldUri = `postgres://app:${oldPassword}@${env.ENDPOINT_HOST}/${env.DATABASE_ID}`;
  const newUri = `postgres://app:${newPassword}@${env.ENDPOINT_HOST}/${env.DATABASE_ID}`;
  const oldPool = probe.probePool(oldUri);
  const newPool = probe.probePool(newUri);
  try {
    const oldClient = new oldPool.Client({ connectionString: oldUri });
    const newClient = new newPool.Client({ connectionString: newUri });
    const oldAddress = oldClient.neonConfig.wsProxyAddrForHost(
      env.ENDPOINT_HOST,
      5432,
    );
    const newAddress = newClient.neonConfig.wsProxyAddrForHost(
      env.ENDPOINT_HOST,
      5432,
    );
    assert.equal(oldAddress, newAddress);
    assert.equal(
      new URL(`wss://${newAddress}`).searchParams.get("user"),
      "app",
    );
    assert(!newAddress.includes(oldPassword));
    assert(!newAddress.includes(newPassword));
  } finally {
    await Promise.all([oldPool.end(), newPool.end()]);
  }
});

test("a Pool client and proxy cannot redirect the bound connection identity", async () => {
  const env = environment();
  const other = environment();
  const uri = `postgres://app@${env.ENDPOINT_HOST}/${env.DATABASE_ID}`;
  const pool = probe.probePool(uri);
  try {
    assert.throws(
      () =>
        new pool.Client({
          connectionString: `postgres://app@${env.ENDPOINT_HOST}/${other.DATABASE_ID}`,
        }),
      { message: "connection_metadata_invalid" },
    );
    const client = new pool.Client({ connectionString: uri });
    assert.throws(
      () =>
        client.neonConfig.wsProxyAddrForHost(["other", "test"].join("."), 5432),
      { message: "connection_metadata_invalid" },
    );
  } finally {
    await pool.end();
  }
});

async function refusedMetadata(transform: (uri: URL) => void): Promise<void> {
  const env = environment(new Date(Date.now() + 60_000).toISOString());
  const password = randomBytes(32).toString("base64url");
  const uri = new URL(
    `postgres://app:${password}@${env.ENDPOINT_HOST}/${env.DATABASE_ID}`,
  );
  transform(uri);
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ uri: uri.href, includes_password: true });
  try {
    const reply = await probe.default.fetch(
      new Request(`https://${["probe", "test"].join(".")}/metadata`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.PROBE_BEARER}` },
      }),
      env,
    );
    assert.equal(reply.status, 500);
    assert.deepEqual(await reply.json(), { code: "probe_failed" });
  } finally {
    globalThis.fetch = original;
  }
}

test("connection metadata refuses a different database in the returned URI", async () => {
  await refusedMetadata((uri) => {
    uri.pathname = `/${environment().DATABASE_ID}`;
  });
});

test("connection metadata refuses a different role in the returned URI", async () => {
  await refusedMetadata((uri) => {
    uri.username = `r${randomBytes(8).toString("hex")}`;
  });
});

test("connection metadata refuses a different endpoint in the returned URI", async () => {
  await refusedMetadata((uri) => {
    uri.hostname = ["other", "test"].join(".");
  });
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

test("named startup mismatch pools keep admitted hints while changing only actual startup identity", async () => {
  const env = environment();
  const password = `${randomBytes(16).toString("base64url")}:&?=${randomBytes(16).toString("base64url")}`;
  const uri = `postgres://app:${encodeURIComponent(password)}@${env.ENDPOINT_HOST}/${env.DATABASE_ID}`;
  const marker = randomBytes(24).toString("hex");
  const globalProxy = neonConfig.wsProxy;
  const database = probe.startupMismatchPool(uri, "database", marker);
  const user = probe.startupMismatchPool(uri, "user", marker);
  const ordinary = probe.probePool(uri, marker);
  try {
    for (const [mode, pool] of [
      ["database", database],
      ["user", user],
    ] as const) {
      const client = new pool.Client(pool.options);
      const url = new URL(
        `wss://${client.neonConfig.wsProxyAddrForHost(env.ENDPOINT_HOST, 5432)}`,
      );
      assert.equal(client.host, env.ENDPOINT_HOST);
      assert.equal(client.password, password);
      assert.equal(url.searchParams.get("database"), env.DATABASE_ID);
      assert.equal(url.searchParams.get("user"), "app");
      assert.equal(url.searchParams.get("pgcf_trace"), marker);
      assert.equal(url.pathname, "/v2");
      assert(typeof client.database === "string");
      assert(typeof client.user === "string");
      if (mode === "database") {
        assert.notEqual(client.database, env.DATABASE_ID);
        assert.match(client.database, /^d[a-f0-9]{19}$/);
        assert.equal(client.user, "app");
      } else {
        assert.equal(client.database, env.DATABASE_ID);
        assert.notEqual(client.user, "app");
        assert.match(client.user, /^r[a-f0-9]{19}$/);
      }
      assert.deepEqual([...url.searchParams.keys()].sort(), [
        "database",
        "pgcf_trace",
        "user",
      ]);
      assert.equal(url.username, "");
      assert.equal(url.password, "");
      assert(!url.href.includes(password));
      assert(!url.href.includes(encodeURIComponent(password)));
      assert.equal(client.neonConfig.useSecureWebSocket, true);
      assert.equal(client.neonConfig.pipelineConnect, false);
      assert.equal(client.neonConfig.forceDisablePgSSL, true);
      assert.throws(() => new pool.Client({ connectionString: uri }), {
        message: "connection_metadata_invalid",
      });
      assert.throws(
        () =>
          client.neonConfig.wsProxyAddrForHost(
            ["other", "test"].join("."),
            5432,
          ),
        { message: "connection_metadata_invalid" },
      );
    }
    const normalClient = new ordinary.Client({ connectionString: uri });
    assert.equal(normalClient.database, env.DATABASE_ID);
    assert.equal(normalClient.user, "app");
    assert.throws(() => new ordinary.Client(database.options), {
      message: "connection_metadata_invalid",
    });
    assert.equal(neonConfig.wsProxy, globalProxy);
  } finally {
    await Promise.all([database.end(), user.end(), ordinary.end()]);
  }
});

test("startup mismatch mode must be named and retain strict URI and marker validation", () => {
  const env = environment();
  const uri = `postgres://app@${env.ENDPOINT_HOST}/${env.DATABASE_ID}`;
  const marker = randomBytes(24).toString("hex");
  assert.throws(
    () => probe.startupMismatchPool(uri, "password" as "database", marker),
    { message: "invalid_startup_mismatch_mode" },
  );
  assert.throws(() => probe.startupMismatchPool(uri, "database", "invalid"), {
    message: "invalid_trace_marker",
  });
  assert.throws(() => probe.startupMismatchPool(uri, "database"), {
    message: "invalid_trace_marker",
  });
  const override = new URL(uri);
  override.searchParams.set("host", ["other", "test"].join("."));
  assert.throws(
    () => probe.startupMismatchPool(override.href, "database", marker),
    { message: "connection_metadata_invalid" },
  );
});

test("startup mismatch proof requires the exact Gateway SQLSTATE and error message", () => {
  const gatewayError = Object.assign(
    new Error("startup does not match the authorized route"),
    { code: "28000" },
  );
  assert.deepEqual(probe.startupMismatchRejection(gatewayError), {
    sqlstate: "28000",
    gateway_outcome: "startup_route_mismatch",
  });
  for (const error of [
    Object.assign(new Error(gatewayError.message), { code: "28P01" }),
    Object.assign(new Error(gatewayError.message), { code: "3D000" }),
    Object.assign(new Error("another rejection"), { code: "28000" }),
    new Error("network timeout"),
    undefined,
  ]) {
    assert.throws(() => probe.startupMismatchRejection(error), {
      message: "startup_mismatch_not_rejected_by_gateway",
    });
  }
});

test("negative authentication acceptance requires exactly 28P01", () => {
  assert.equal(typeof probe.passwordAuthenticationRejection, "function");
  assert.doesNotThrow(() =>
    probe.passwordAuthenticationRejection(
      Object.assign(new Error("authentication rejected"), { code: "28P01" }),
    ),
  );
  assert.throws(
    () =>
      probe.passwordAuthenticationRejection(
        Object.assign(new Error("database absent"), { code: "3D000" }),
      ),
    { message: "negative_not_rejected_by_postgres" },
  );
  assert.throws(
    () =>
      probe.passwordAuthenticationRejection(
        Object.assign(new Error("database unavailable"), { code: "57P03" }),
      ),
    { message: "negative_not_rejected_by_postgres" },
  );
});

test("named startup mismatch handlers require authentication and a trace marker before metadata", async () => {
  const env = environment(new Date(Date.now() + 60_000).toISOString());
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("unexpected_metadata_call");
  };
  try {
    for (const path of [
      "/startup-database-mismatch",
      "/startup-user-mismatch",
    ]) {
      const url = `https://${["probe", "test"].join(".")}${path}`;
      const anonymous = await probe.default.fetch(
        new Request(url, { method: "POST" }),
        env,
      );
      assert.equal(anonymous.status, 401);
      const missingMarker = await probe.default.fetch(
        new Request(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${env.PROBE_BEARER}` },
        }),
        env,
      );
      assert.equal(missingMarker.status, 400);
      assert.deepEqual(await missingMarker.json(), {
        code: "invalid_trace_marker",
      });
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("credential request uses manual redirects and refuses an upstream redirect", async (context) => {
  const env = environment(new Date(Date.now() + 60_000).toISOString());
  const outgoing = probe.connectionRequest(env);
  assert.equal(outgoing.redirect, "manual");
  let calls = 0;
  context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    calls++;
    assert.ok(input instanceof Request);
    assert.equal(input.redirect, "manual");
    return new Response(null, {
      status: 302,
      headers: {
        Location: `https://${["redirect", "test", "invalid"].join(".")}`,
      },
    });
  });
  const reply = await probe.default.fetch(
    new Request(`https://${["probe", "test"].join(".")}/metadata`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.PROBE_BEARER}` },
    }),
    env,
  );
  assert.equal(reply.status, 500);
  assert.deepEqual(await reply.json(), { code: "probe_failed" });
  assert.equal(calls, 1);
});
