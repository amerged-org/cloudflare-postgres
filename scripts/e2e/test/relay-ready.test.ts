// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import type { TestContext } from "node:test";
import { ChaosRelay } from "./chaos-relay.ts";

function memoryState() {
  const values = new Map<string, unknown>();
  return {
    storage: {
      async get<T>(key: string): Promise<T | undefined> {
        return structuredClone(values.get(key)) as T | undefined;
      },
      async put<T>(key: string, value: T): Promise<void> {
        values.set(key, structuredClone(value));
      },
      async delete(key: string): Promise<boolean> {
        return values.delete(key);
      },
    },
    async blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      return callback();
    },
  };
}

const clientsUrl = new URL("../src/clients.ts", import.meta.url).href;
const fixtureClients = `data:text/javascript,${encodeURIComponent(
  `export * from ${JSON.stringify(clientsUrl)}; export async function command() { return ""; }`,
)}`;
const loader = registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    return result.url === clientsUrl && context.parentURL !== fixtureClients
      ? { ...result, url: fixtureClients, shortCircuit: true }
      : result;
  },
});
const { Run, acceptanceDiagnostic } = await import("../src/run.ts");
loader.deregister();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(
  context: TestContext,
  countsReply: (read: number) => Response,
  captureReply = () => Response.json({ count: 0 }),
) {
  const stateDir = await mkdtemp(resolve(tmpdir(), "pgcf-relay-ready-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  const bearer = randomBytes(32).toString("hex");
  process.env.PGCF_E2E_AGENT_KEY = randomBytes(32).toString("hex");
  const runId = `${"1".repeat(14)}-${randomBytes(3).toString("hex")}`;
  const runName = `pgcf-e2e-${runId}`;
  const events: string[] = [];
  const firstRead = deferred();
  let reads = 0;
  let captures = 0;
  let ready = false;
  const run = Object.create(Run.prototype) as InstanceType<typeof Run>;
  Object.assign(run, {
    runName,
    stateDir,
    deadline: Date.now() + 60_000,
    c: {
      apiUrl: new URL(`https://${["api", "test", "invalid"].join(".")}/`),
      values: {
        CLOUDFLARE_ACCOUNT_ID: randomBytes(16).toString("hex"),
        CLOUDFLARE_API_TOKEN: randomBytes(32).toString("hex"),
        PGCF_E2E_PROBE_BEARER: bearer,
      },
      credentialExpiries: [{ name: "PGCF_E2E_AGENT_KEY", expires_at: null }],
    },
    state: {
      run_id: runId,
      worker_name: runName,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      completed: [],
      intents: [],
    },
    save: async () => undefined,
    emit: async () => undefined,
    cf: {
      request: async (path: string, method: string, body: { name: string }) => {
        if (path === "/workers/subdomain")
          return { result: { subdomain: "test" } };
        assert.equal(path, `/workers/scripts/${runName}-relay/secrets`);
        assert.equal(method, "PUT");
        events.push(`secret:${body.name}`);
        return {};
      },
    },
  });
  context.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        `Bearer ${bearer}`,
      );
      assert.equal(init?.redirect, "error");
      assert(init?.signal instanceof AbortSignal);
      if (path === "/control/counts") {
        events.push("counts");
        reads++;
        firstRead.resolve();
        const reply = countsReply(reads);
        if (reply.ok) {
          const value = await reply
            .clone()
            .json()
            .catch(() => ({}));
          ready = value.agent_key_configured === true;
        }
        return reply;
      }
      assert.equal(path, "/control/capture-empty");
      events.push("capture");
      captures++;
      assert.equal(
        ready,
        true,
        "capture must wait for configured relay readiness",
      );
      return captureReply();
    },
  );
  return {
    run,
    events,
    firstRead,
    reads: () => reads,
    captures: () => captures,
  };
}

test("relay startup retries a transient counts read and captures once only after secrets are ready", async (context) => {
  context.mock.timers.enable({
    apis: ["Date", "setTimeout"],
    now: Date.UTC(2030, 0, 1),
  });
  const sample = await fixture(context, (read) =>
    read === 1
      ? new Response(null, { status: 500 })
      : Response.json({ agent_key_configured: true }),
  );
  const deployment = sample.run.deployRelay();
  void deployment.catch(() => undefined);
  await Promise.race([sample.firstRead.promise, deployment]);
  await nextTurn();
  assert.equal(sample.captures(), 0);
  context.mock.timers.tick(250);
  await deployment;
  assert.deepEqual(sample.events, [
    "secret:PROBE_BEARER",
    "secret:AGENT_KEY",
    "counts",
    "counts",
    "capture",
  ]);
  assert.equal(sample.reads(), 2);
  assert.equal(sample.captures(), 1);
  assert.deepEqual(sample.run.state.completed, ["chaos-empty-captured"]);
});

test("an authenticated false readiness flag cannot start capture", async (context) => {
  context.mock.timers.enable({
    apis: ["Date", "setTimeout"],
    now: Date.UTC(2030, 0, 1),
  });
  const sample = await fixture(context, (read) =>
    Response.json({ agent_key_configured: read > 1 }),
  );
  const deployment = sample.run.deployRelay();
  void deployment.catch(() => undefined);
  await Promise.race([sample.firstRead.promise, deployment]);
  await nextTurn();
  assert.equal(sample.captures(), 0);
  context.mock.timers.tick(250);
  await deployment;
  assert.equal(sample.reads(), 2);
  assert.equal(sample.captures(), 1);
});

test("relay readiness rejects401 without retry or capture and exposes only safe status", async (context) => {
  const sample = await fixture(
    context,
    () => new Response(null, { status: 401 }),
  );
  await assert.rejects(sample.run.deployRelay(), (error) => {
    assert.deepEqual(acceptanceDiagnostic(error), {
      code: "real_chaos_snapshot_or_relay_unavailable",
      http_status: 401,
      probe_code: "unknown",
    });
    return true;
  });
  assert.equal(sample.reads(), 1);
  assert.equal(sample.captures(), 0);
});

test("relay readiness rejects410 without retry or capture", async (context) => {
  const sample = await fixture(
    context,
    () => new Response(null, { status: 410 }),
  );
  await assert.rejects(sample.run.deployRelay(), (error) => {
    assert.equal(acceptanceDiagnostic(error).http_status, 410);
    return true;
  });
  assert.equal(sample.reads(), 1);
  assert.equal(sample.captures(), 0);
});

test("malformed authenticated readiness is never retried or captured", async (context) => {
  const canary = randomBytes(32).toString("hex");
  const sample = await fixture(context, () => new Response(canary));
  await assert.rejects(sample.run.deployRelay(), (error) => {
    assert.equal(
      JSON.stringify(acceptanceDiagnostic(error)).includes(canary),
      false,
    );
    return true;
  });
  assert.equal(sample.reads(), 1);
  assert.equal(sample.captures(), 0);
});

test("relay readiness ends within fifteen seconds without capture", async (context) => {
  context.mock.timers.enable({
    apis: ["Date", "setTimeout"],
    now: Date.UTC(2030, 0, 1),
  });
  const sample = await fixture(context, () =>
    Response.json({ agent_key_configured: false }),
  );
  const deployment = sample.run.deployRelay();
  void deployment.catch(() => undefined);
  await Promise.race([sample.firstRead.promise, deployment]);
  await nextTurn();
  context.mock.timers.tick(15_000);
  await assert.rejects(deployment, { message: "relay_readiness_timeout" });
  assert.equal(sample.reads(), 1);
  assert.equal(sample.captures(), 0);
  assert.deepEqual(sample.run.state.completed, []);
});

test("a ready reply after the deadline cannot start snapshot capture", async (context) => {
  context.mock.timers.enable({
    apis: ["Date", "setTimeout"],
    now: Date.UTC(2030, 0, 1),
  });
  const sample = await fixture(context, () => {
    context.mock.timers.tick(15_000);
    return Response.json({ agent_key_configured: true });
  });
  await assert.rejects(sample.run.deployRelay(), {
    message: "relay_readiness_timeout",
  });
  assert.equal(sample.reads(), 1);
  assert.equal(sample.captures(), 0);
});

test("a snapshot failure after readiness is not replayed and reports safe status", async (context) => {
  const sample = await fixture(
    context,
    () => Response.json({ agent_key_configured: true }),
    () => new Response(null, { status: 500 }),
  );
  await assert.rejects(sample.run.deployRelay(), (error) => {
    assert.equal(acceptanceDiagnostic(error).http_status, 500);
    return true;
  });
  assert.equal(sample.reads(), 1);
  assert.equal(sample.captures(), 1);
  assert.deepEqual(sample.run.state.completed, []);
});

test("real relay counts expose only configuration presence behind expiry and bearer guards", async () => {
  const bearer = randomBytes(32).toString("hex");
  const env = {
    API_URL: `https://${["api", "test", "invalid"].join(".")}`,
    RUN_NAME: "pgcf-e2e-test",
    RUN_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString(),
    PROBE_BEARER: bearer,
    AGENT_KEY: "",
    RELAY: {
      idFromName: () => "test",
      get: () => {
        throw new Error("unused_test_binding");
      },
    },
  };
  const request = (authenticated: boolean) =>
    new Request(
      `https://${["relay", "test", "invalid"].join(".")}/control/counts`,
      {
        method: "POST",
        headers: authenticated ? { Authorization: `Bearer ${bearer}` } : {},
      },
    );
  const missing = new ChaosRelay(memoryState(), env);
  assert.equal((await missing.fetch(request(false))).status, 401);
  assert.equal(
    (await (await missing.fetch(request(true))).json()).agent_key_configured,
    false,
  );
  const agent = randomBytes(32).toString("hex");
  const configured = new ChaosRelay(memoryState(), {
    ...env,
    AGENT_KEY: agent,
  });
  const body = await (await configured.fetch(request(true))).json();
  assert.equal(body.agent_key_configured, true);
  assert.equal(JSON.stringify(body).includes(agent), false);
  const expired = new ChaosRelay(memoryState(), {
    ...env,
    RUN_EXPIRES_AT: new Date(Date.now() - 1).toISOString(),
  });
  assert.equal((await expired.fetch(request(true))).status, 410);
});
