// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import https from "node:https";
import { test } from "node:test";
import { newOperationId } from "@pgcf/contracts";
import {
  inspectionResponseBody,
  openInspectionTransport,
  type InspectionProxyConfig,
} from "../src/inspection-proxy-command.ts";

function config(): InspectionProxyConfig {
  const operation_id = newOperationId();
  const base = `https://inspection.invalid/internal/v1/node-installation/${operation_id}`;
  return {
    operation_id,
    expected_generation: 1,
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    expected_network: {
      mac: "02:00:00:00:00:17",
      ipv4: "192.0.2.17",
      prefix_length: 24,
      gateway: "192.0.2.1",
    },
    callback: {
      url: `${base}/inspection`,
      bearer: randomBytes(32).toString("base64url"),
    },
    transport_url: `${base}/transport`,
    relay_url: base.replace("https:", "wss:") + "/relay",
  };
}

test("strict inspection transport requests only its generation and rejects an unbound SSH target", async () => {
  const value = config();
  let requests = 0;
  await assert.rejects(
    openInspectionTransport(
      value,
      AbortSignal.timeout(1000),
      async (url, options) => {
        requests++;
        assert.equal(String(url), value.transport_url);
        assert.equal(options?.method, "POST");
        assert.equal(options?.redirect, "error");
        assert.deepEqual(JSON.parse(String(options?.body)), {
          expected_generation: 1,
        });
        assert.equal(
          new Headers(options?.headers).get("authorization"),
          `Bearer ${value.callback.bearer}`,
        );
        return Response.json({
          websocket_url: value.relay_url,
          token: randomBytes(32).toString("base64url"),
          expectedTarget: { ip: "192.0.2.18", port: 22 },
        });
      },
    ),
    /inspection_transport_target_mismatch/,
  );
  assert.equal(requests, 1);
});

test("foreign authority origins fail before HTTP and transport refusals are never retried", async () => {
  const value = config();
  let requests = 0;
  const request: typeof fetch = async () => {
    requests++;
    return new Response(null, { status: 409 });
  };
  await assert.rejects(
    openInspectionTransport(
      {
        ...value,
        relay_url: value.relay_url.replace(
          "inspection.invalid",
          "foreign.invalid",
        ),
      },
      AbortSignal.timeout(1000),
      request,
    ),
    /inspection_transport_endpoint_mismatch/,
  );
  assert.equal(requests, 0);
  await assert.rejects(
    openInspectionTransport(value, AbortSignal.timeout(1000), request),
    /inspection_transport_refused/,
  );
  assert.equal(requests, 1);
});

test("oversized authority streams are cancelled without buffering the remainder", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(16_385));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assert.rejects(
    inspectionResponseBody(response, 16_384, AbortSignal.timeout(1000)),
    /inspection_response_limit/,
  );
  assert.equal(cancelled, true);
});

test("abort cancels a response stalled before its next byte", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
  );
  const abort = new AbortController();
  const reading = inspectionResponseBody(response, 16_384, abort.signal);
  abort.abort(new Error("inspection_cancelled"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(
      Promise.race([
        reading,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("abort_did_not_cancel_reader")),
            100,
          );
        }),
      ]),
      /inspection_cancelled/,
    );
    assert.equal(cancelled, true);
  } finally {
    if (timer) clearTimeout(timer);
  }
});

test("inspection authority permits its 20-second preflight and caps the budget at the total deadline", async (t) => {
  const now = Date.now(),
    budgets: number[] = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    budgets.push(milliseconds);
    return new AbortController().signal;
  });
  const value = {
    ...config(),
    deadline_at: new Date(now + 120_000).toISOString(),
  };
  const refuseTarget: typeof fetch = async () =>
    Response.json({
      websocket_url: value.relay_url,
      token: randomBytes(32).toString("base64url"),
      expectedTarget: { ip: "192.0.2.18", port: 22 },
    });
  await assert.rejects(
    openInspectionTransport(value, new AbortController().signal, refuseTarget),
    /inspection_transport_target_mismatch/,
  );
  assert.deepEqual(budgets, [120_000, 60_000]);
  budgets.length = 0;
  await assert.rejects(
    openInspectionTransport(
      { ...value, deadline_at: new Date(now + 5000).toISOString() },
      new AbortController().signal,
      refuseTarget,
    ),
    /inspection_transport_target_mismatch/,
  );
  assert.deepEqual(budgets, [5000, 5000]);
});

test("the WebSocket budget uses monotonic time left after a slow authority response", async (t) => {
  const now = Date.now();
  let elapsed = 0,
    handshake = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(performance, "now", () => elapsed);
  t.mock.method(AbortSignal, "timeout", () => new AbortController().signal);
  t.mock.method(
    https,
    "request",
    (...args: Parameters<typeof https.request>) => {
      handshake = (args[0] as unknown as { timeout: number }).timeout;
      const request = new EventEmitter();
      return Object.assign(request, {
        end: () => {
          queueMicrotask(() =>
            request.emit("error", new Error("fixture_handshake_stop")),
          );
        },
      }) as unknown as ReturnType<typeof https.request>;
    },
  );
  const value = {
    ...config(),
    deadline_at: new Date(now + 90_000).toISOString(),
  };
  await assert.rejects(
    openInspectionTransport(value, new AbortController().signal, async () => {
      elapsed = 45_000;
      return Response.json({
        websocket_url: value.relay_url,
        token: randomBytes(32).toString("base64url"),
        expectedTarget: { ip: value.expected_network.ipv4, port: 22 },
      });
    }),
    /inspection_relay_failed/,
  );
  assert.equal(handshake, 45_000);
});

test("authority expiry cancels a stalled transport response independently of the later stream lifetime", async (t) => {
  const signals: AbortController[] = [];
  t.mock.method(AbortSignal, "timeout", () => {
    const controller = new AbortController();
    signals.push(controller);
    return controller.signal;
  });
  const caller = new AbortController();
  let cancelled = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  const pending = openInspectionTransport(
    config(),
    caller.signal,
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  signals[1]!.abort(new Error("inspection_authority_expired"));
  try {
    await assert.rejects(
      Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("authority_did_not_cancel_reader")),
            100,
          );
        }),
      ]),
      /inspection_authority_expired/,
    );
    assert.equal(cancelled, true);
  } finally {
    if (timer) clearTimeout(timer);
    caller.abort();
    await pending.catch(() => undefined);
  }
});
