// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

interface ScanSocket {
  opened: Promise<unknown>;
  closed: Promise<unknown>;
  close(): Promise<void>;
}
const moduleUrl =
  "data:text/javascript," +
  encodeURIComponent(
    "let factory; export function setFactory(value) { factory = value; } export function connect(options) { return factory(options); }",
  );
const fixtureModule = (await import(moduleUrl)) as {
  setFactory(
    value: (options: { hostname: string; port: number }) => ScanSocket,
  ): void;
};
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "cloudflare:sockets"
      ? { url: moduleUrl, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
const probe = await import("../probe/worker.ts");
hook.deregister();

function request(ports: number[]) {
  const env = {
    PROBE_BEARER: randomBytes(32).toString("base64url"),
    INTEGRATOR_KEY: randomBytes(32).toString("base64url"),
    DATABASE_ID: `d${randomBytes(10).toString("hex").slice(0, 19)}`,
    API_URL: `https://${["api", "test"].join(".")}`,
    ENDPOINT_HOST: ["edge", "test"].join("."),
    RUN_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString(),
  };
  return {
    env,
    request: new Request(`https://${["probe", "test"].join(".")}/scan`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.PROBE_BEARER}` },
      body: JSON.stringify({ host: [203, 0, 113, 4].join("."), ports }),
    }),
  };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("probe response does not wait for delayed socket-close acknowledgement", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let completeClose: (() => void) | undefined;
  let completeOpen: (() => void) | undefined;
  const close = new Promise<void>((resolve) => {
    completeClose = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    completeOpen = resolve;
  });
  let connections = 0;
  let closes = 0;
  fixtureModule.setFactory(() => {
    connections++;
    return {
      opened,
      closed: close,
      close: () => {
        closes++;
        return close;
      },
    };
  });
  const value = request([80]);
  const response = probe.default.fetch(value.request, value.env);
  let settled = false;
  void response.then(() => {
    settled = true;
  });
  try {
    await flush();
    assert.equal(connections, 1);
    context.mock.timers.tick(400);
    await flush();
    assert.equal(closes, 1);
    assert.equal(settled, true);
    const result = await response;
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), {
      open: [],
      checked: 1,
      timedOut: 1,
    });
    assert.equal(connections, 1);
  } finally {
    completeClose!();
    completeOpen!();
    await response;
    context.mock.timers.reset();
  }
});

test("probe retains positive opens and handles close acknowledgement rejection", async () => {
  let closes = 0;
  fixtureModule.setFactory(() => ({
    opened: Promise.resolve(),
    closed: Promise.reject(new Error("closed_rejected")),
    close: () => {
      closes++;
      return Promise.reject(new Error("close_rejected"));
    },
  }));
  const value = request([443]);
  const response = await probe.default.fetch(value.request, value.env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    open: [443],
    checked: 1,
    timedOut: 0,
  });
  await flush();
  assert.equal(closes, 1);
});

test("probe handles opened and closed rejection without retrying or reporting an open", async () => {
  let connections = 0;
  let closes = 0;
  fixtureModule.setFactory(() => {
    connections++;
    return {
      opened: Promise.reject(new Error("connection_refused")),
      closed: Promise.reject(new Error("closed_rejected")),
      close: () => {
        closes++;
        return Promise.reject(new Error("close_rejected"));
      },
    };
  });
  const value = request([80]);
  const response = await probe.default.fetch(value.request, value.env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    open: [],
    checked: 1,
    timedOut: 0,
  });
  await flush();
  assert.equal(connections, 1);
  assert.equal(closes, 1);
});
