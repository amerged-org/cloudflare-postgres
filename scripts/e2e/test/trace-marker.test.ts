// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Run } from "../src/run.ts";
import { formatTraceMarker, isTraceMarker } from "../src/trace-marker.ts";

function producer() {
  const database = `d${randomBytes(10).toString("hex").slice(0, 19)}`;
  const region = `r-${randomBytes(8).toString("hex")}`;
  const connection = randomUUID();
  const edge = "pgcf-edge-dev";
  const api = "pgcf-api-dev";
  const host = ["edge", "test"].join(".");
  const original = globalThis.WebSocket;
  const markers: string[] = [];
  const deletes: string[] = [];
  const sockets: Socket[] = [];
  class Socket extends EventTarget {
    static CLOSING = 2;
    readyState = 0;
    constructor(_url: string, protocol: string) {
      super();
      assert.equal(protocol, "trace-v1");
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }
    send(value: string) {
      assert.deepEqual(JSON.parse(value), { debug: false });
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const secret = randomBytes(32).toString("base64url");
  const state = {
    database_id: database,
    operation_id: `op_${randomBytes(10).toString("hex")}`,
    tails: [],
    actions: [] as { target: Record<string, unknown> }[],
  };
  const run = Object.create(Run.prototype) as Run;
  Object.assign(run, {
    state,
    c: {
      values: {
        PGCF_E2E_REGION_ID: region,
        PGCF_E2E_EDGE_WORKER_NAME: edge,
        PGCF_E2E_API_WORKER_NAME: api,
        PGCF_E2E_ENDPOINT_HOST: host,
        CLOUDFLARE_API_TOKEN: secret,
        PGCF_E2E_ADMIN_KEY: secret,
        PGCF_E2E_PROBE_BEARER: secret,
      },
    },
    assertCluster: async () => {},
    verify: async () => {},
    requireStep: () => {},
    intent: async () => {},
    save: async () => {},
    complete: async () => {},
    emit: async () => {},
    actionDone: async () => {},
    action: async (_kind: string, target: Record<string, unknown>) => {
      state.actions.push({ target });
      return state.actions.length - 1;
    },
    cf: {
      list: async () => [{ hostname: host, service: edge }],
      request: async (path: string, method?: string) => {
        if (method === "DELETE") {
          deletes.push(path);
          return { result: null };
        }
        if (path.endsWith("/tails"))
          return {
            result: {
              id: randomBytes(16).toString("hex"),
              url: `wss://${["trace", "test"].join(".")}/${randomBytes(24).toString("hex")}`,
              expires_at: new Date(Date.now() + 60_000).toISOString(),
            },
          };
        if (path.endsWith("/settings"))
          return {
            result: {
              bindings: [{ type: "d1", name: "DB", id: randomUUID() }],
            },
          };
        if (path.endsWith("/query"))
          return {
            result: [
              {
                results: [
                  {
                    database_id: database,
                    name: "app",
                    password_ciphertext: randomBytes(48).toString("base64"),
                  },
                ],
              },
            ],
          };
        return { result: { name: "pgcf-control-dev" } };
      },
    },
    kube: {
      gatewayLogs: async () =>
        JSON.stringify({
          event: "conn_close",
          connection,
          database,
          outcome: "startup_route_mismatch",
        }),
      rolePasswords: async () => [secret],
    },
    probe: async (path: string, _body?: unknown, marker?: string) => {
      if (path === "/canary-audit") return { pass: true, counts: {} };
      assert.match(marker ?? "", /^[a-f0-9]{16}\.[a-f0-9]{16}\.[a-f0-9]{16}$/);
      markers.push(marker!);
      const query = new URLSearchParams({
        database,
        user: "app",
        pgcf_trace: marker!,
      });
      const trace = JSON.stringify([
        {
          event: { request: { url: `https://${host}/v2?${query}` } },
          logs: [
            {
              message: [
                JSON.stringify({
                  event: "conn_admission",
                  cid: connection,
                  database_id: database,
                  user: "app",
                  region_id: region,
                  outcome: "accepted",
                }),
              ],
            },
          ],
        },
      ]);
      assert.equal(trace.includes(secret), false);
      sockets
        .at(-1)!
        .dispatchEvent(new MessageEvent("message", { data: trace }));
      return {
        pass: true,
        sqlstate: "28000",
        gateway_outcome: "startup_route_mismatch",
        duration_ms: 1,
      };
    },
  });
  return {
    run,
    markers,
    deletes,
    edge,
    restore: () => {
      globalThis.WebSocket = original;
    },
  };
}

test("startup trace producers use dot-separated markers with all 192 bits", async () => {
  const value = producer();
  try {
    await value.run.startupMismatches();
    assert.equal(value.markers.length, 2);
    assert.equal(value.markers[0]!.replaceAll(".", "").length, 48);
    assert.notEqual(value.markers[0], value.markers[1]);
    assert.equal(value.deletes.length, 2);
  } finally {
    value.restore();
  }
});

test("canary trace producers use the same segmented marker for both workers", async () => {
  const value = producer();
  const original = process.env.PGCF_E2E_EDGE_WORKER_NAME;
  process.env.PGCF_E2E_EDGE_WORKER_NAME = value.edge;
  try {
    await value.run.audit();
    assert.equal(value.markers.length, 2);
    assert.equal(value.markers[0], value.markers[1]);
    assert.equal(value.deletes.length, 2);
  } finally {
    if (original === undefined) delete process.env.PGCF_E2E_EDGE_WORKER_NAME;
    else process.env.PGCF_E2E_EDGE_WORKER_NAME = original;
    value.restore();
  }
});

test("marker formatting preserves each random byte and validation accepts only the two exact formats", () => {
  const entropy = randomBytes(24).toString("hex");
  const marker = formatTraceMarker(entropy);
  assert.equal(marker.replaceAll(".", ""), entropy);
  assert.equal(marker.length, 50);
  assert.equal(isTraceMarker(marker), true);
  assert.equal(isTraceMarker(entropy), true);
  assert.equal(isTraceMarker(undefined), false);
  assert.equal(isTraceMarker({ toString: () => entropy }), false);
  assert.equal(isTraceMarker(marker.replaceAll(".", "-")), false);
  assert.equal(isTraceMarker(marker.replaceAll(".", "_")), false);
  assert.equal(isTraceMarker(marker.slice(1)), false);
  assert.equal(isTraceMarker(marker + "."), false);
  assert.equal(isTraceMarker(marker + "\n"), false);
  assert.equal(isTraceMarker(entropy + "\n"), false);
  assert.equal(isTraceMarker("A" + marker.slice(1)), false);
  assert.throws(() => formatTraceMarker(marker), {
    message: "invalid_trace_marker",
  });
  assert.throws(() => formatTraceMarker("invalid"), {
    message: "invalid_trace_marker",
  });
  assert.throws(() => formatTraceMarker(entropy + "\n"), {
    message: "invalid_trace_marker",
  });
  assert.throws(
    () => formatTraceMarker({ toString: () => entropy } as unknown as string),
    { message: "invalid_trace_marker" },
  );
});
