// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { Cloudflare } from "../src/clients.ts";
import { captureTrace } from "../src/trace.ts";

type Tail = { id: string; url: string; expires_at: string };
const capture = captureTrace;
const worker = "pgcf-api-dev";
const authority = ["trace", "test"].join(".");

function fixture() {
  const id = randomBytes(16).toString("hex");
  const token = randomBytes(32).toString("base64url");
  const marker = randomBytes(24).toString("hex");
  const tail: Tail = {
    id,
    url: `wss://${authority}/${token}`,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const deletes: string[] = [];
  const client = {
    async request(path: string, method: string) {
      if (method === "POST") return { result: tail, success: true };
      assert.equal(method, "DELETE");
      deletes.push(path);
      return { result: null, success: true };
    },
  } as unknown as Cloudflare;
  return { tail, token, marker, deletes, client };
}

function installSocket() {
  const original = globalThis.WebSocket;
  const sockets: TraceSocket[] = [];
  class TraceSocket extends EventTarget {
    static CLOSING = 2;
    readyState = 0;
    constructor(url: string, protocol: string) {
      super();
      assert.equal(new URL(url).protocol, "wss:");
      assert.equal(protocol, "trace-v1");
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }
    send(message: string) {
      assert.deepEqual(JSON.parse(message), { debug: false });
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
    emit(data: unknown) {
      this.dispatchEvent(new MessageEvent("message", { data }));
    }
  }
  globalThis.WebSocket = TraceSocket as unknown as typeof WebSocket;
  return {
    sockets,
    restore() {
      globalThis.WebSocket = original;
    },
  };
}

function event(request: Record<string, unknown>, logs: unknown[] = []) {
  return JSON.stringify([{ event: { request }, logs }]);
}

test("trace waits for its request marker instead of the first or logged event", async () => {
  const fixtureValue = fixture();
  const socket = installSocket();
  let settled = false;
  let resolveTriggered: (() => void) | undefined;
  const triggered = new Promise<void>((resolve) => {
    resolveTriggered = resolve;
  });
  let captured: Promise<string[]> | undefined;
  try {
    captured = capture(
      fixtureValue.client,
      worker,
      fixtureValue.marker,
      async () => {
        socket.sockets[0]!.emit(
          event(
            {
              url: `https://${authority}/other?pgcf_trace=other${fixtureValue.marker}`,
            },
            [{ message: [fixtureValue.marker] }],
          ),
        );
        resolveTriggered!();
      },
      async (tail) => {
        assert.deepEqual(tail, {
          id: fixtureValue.tail.id,
          expires_at: fixtureValue.tail.expires_at,
        });
      },
    );
    void captured.then(
      () => (settled = true),
      () => (settled = true),
    );
    await Promise.race([triggered, captured]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    const matching = event({
      url: `https://${authority}/audit?pgcf_trace=${fixtureValue.marker}`,
    });
    socket.sockets[0]!.emit(matching);
    assert((await captured).includes(matching));
    assert.equal(socket.sockets[0]!.readyState, 3);
    assert.deepEqual(fixtureValue.deletes, [
      `/workers/scripts/${worker}/tails/${fixtureValue.tail.id}`,
    ]);
  } finally {
    socket.sockets[0]?.close();
    await captured?.catch(() => undefined);
    socket.restore();
  }
});

test("trace matches the request header marker in a binary provider frame", async () => {
  const fixtureValue = fixture();
  const socket = installSocket();
  try {
    const matching = event({
      url: `https://${authority}/audit`,
      headers: { "x-pgcf-trace": fixtureValue.marker },
    });
    const messages = await capture(
      fixtureValue.client,
      worker,
      fixtureValue.marker,
      async () => {
        socket.sockets[0]!.emit(new TextEncoder().encode(matching).buffer);
      },
      async () => {},
    );
    assert.deepEqual(messages, [matching]);
    assert.equal(fixtureValue.deletes.length, 1);
  } finally {
    socket.restore();
  }
});

test("trace deletes the real tail when its ownership callback rejects", async () => {
  const fixtureValue = fixture();
  const socket = installSocket();
  const expected = new Error("ledger_refused");
  try {
    await assert.rejects(
      capture(
        fixtureValue.client,
        worker,
        fixtureValue.marker,
        async () => {},
        async () => {
          throw expected;
        },
      ),
      (error) => error === expected,
    );
    assert.equal(socket.sockets.length, 0);
    assert.deepEqual(fixtureValue.deletes, [
      `/workers/scripts/${worker}/tails/${fixtureValue.tail.id}`,
    ]);
  } finally {
    socket.restore();
  }
});

test("trace deletes malformed provider URLs without leaking their secret", async () => {
  const fixtureValue = fixture();
  fixtureValue.tail.url = fixtureValue.token;
  await assert.rejects(
    capture(
      fixtureValue.client,
      worker,
      fixtureValue.marker,
      async () => {},
      async () => {},
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "invalid_tail_url" &&
      !String(error).includes(fixtureValue.token),
  );
  assert.deepEqual(fixtureValue.deletes, [
    `/workers/scripts/${worker}/tails/${fixtureValue.tail.id}`,
  ]);
});

test("trace rejects expired provider expiry and still deletes the real tail", async () => {
  const fixtureValue = fixture();
  const socket = installSocket();
  fixtureValue.tail.expires_at = new Date(Date.now() - 60_000).toISOString();
  let owned = false;
  try {
    await assert.rejects(
      capture(
        fixtureValue.client,
        worker,
        fixtureValue.marker,
        async () => {},
        async () => {
          owned = true;
        },
      ),
      { message: "invalid_tail_expiry" },
    );
    assert.equal(owned, false);
    assert.equal(socket.sockets.length, 0);
    assert.equal(fixtureValue.deletes.length, 1);
  } finally {
    socket.restore();
  }
});

test("trace rejects noncanonical provider expiry and still deletes the real tail", async () => {
  const fixtureValue = fixture();
  const socket = installSocket();
  fixtureValue.tail.expires_at =
    fixtureValue.tail.expires_at.slice(0, 19) + "Z";
  try {
    await assert.rejects(
      capture(
        fixtureValue.client,
        worker,
        fixtureValue.marker,
        async () => {},
        async () => {},
      ),
      { message: "invalid_tail_expiry" },
    );
    assert.equal(socket.sockets.length, 0);
    assert.equal(fixtureValue.deletes.length, 1);
  } finally {
    socket.restore();
  }
});
