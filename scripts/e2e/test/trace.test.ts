// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { Cloudflare } from "../src/clients.ts";
import { captureTrace } from "../src/trace.ts";
import type { TailSocket, TailSocketFactory } from "../src/trace-transport.ts";

type Tail = { id: string; url: string; expires_at: string };
let socketFactory: TailSocketFactory | undefined;
const capture: typeof captureTrace = (
  cf,
  worker,
  marker,
  trigger,
  owned,
  options,
) =>
  captureTrace(cf, worker, marker, trigger, owned, {
    socketFactory,
    settleMs: 0,
    ...options,
  });
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
    async request(path: string, method: string, body: unknown) {
      if (method === "POST") {
        assert.deepEqual(body, { filters: [] });
        return { result: tail, success: true };
      }
      assert.equal(method, "DELETE");
      deletes.push(path);
      return { result: null, success: true };
    },
  } as unknown as Cloudflare;
  return { tail, token, marker, deletes, client };
}

function installSocket() {
  const sockets: TraceSocket[] = [];
  class TraceSocket extends EventTarget {
    static CLOSING = 2;
    readyState = 0;
    terminated = 0;
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
    send(message: string, options: unknown, callback: (error?: Error) => void) {
      assert.deepEqual(JSON.parse(message), { debug: true });
      assert.deepEqual(options, {
        binary: false,
        compress: false,
        mask: false,
        fin: true,
      });
      callback();
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
    terminate() {
      this.terminated++;
      this.close();
    }
    emit(data: unknown) {
      this.dispatchEvent(new MessageEvent("message", { data }));
    }
  }
  socketFactory = (url) =>
    new TraceSocket(url, "trace-v1") as unknown as TailSocket;
  return {
    sockets,
    restore() {
      socketFactory = undefined;
      sockets
        .filter((socket) => socket.readyState !== 3)
        .forEach((socket) => socket.terminate());
    },
  };
}

test("trace initializes the CLI wire settings and terminates its owned socket", async () => {
  const fixtureValue = fixture();
  const socket = installSocket();
  try {
    const matching = event({
      headers: { "x-pgcf-trace": fixtureValue.marker },
    });
    const messages = await capture(
      fixtureValue.client,
      worker,
      fixtureValue.marker,
      async () => {
        socket.sockets[0]!.emit(matching);
      },
      async () => {},
    );
    assert.deepEqual(messages, [matching]);
    assert.equal(socket.sockets[0]!.terminated, 1);
    assert.equal(fixtureValue.deletes.length, 1);
  } finally {
    socket.restore();
  }
});

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

test("trace accepts provider UTC seconds and records canonical milliseconds", async () => {
  const fixtureValue = fixture();
  fixtureValue.tail.expires_at =
    fixtureValue.tail.expires_at.slice(0, 19) + "Z";
  const canonical = fixtureValue.tail.expires_at.slice(0, 19) + ".000Z";
  const socket = installSocket();
  const matching = event({ headers: { "x-pgcf-trace": fixtureValue.marker } });
  let ownedExpiry: string | undefined;
  try {
    const messages = await capture(
      fixtureValue.client,
      worker,
      fixtureValue.marker,
      async () => {
        socket.sockets[0]!.emit(matching);
      },
      async (tail) => {
        assert.equal(tail.id, fixtureValue.tail.id);
        ownedExpiry = tail.expires_at;
      },
    );
    assert.equal(ownedExpiry, canonical);
    assert.deepEqual(messages, [matching]);
    assert.equal(socket.sockets[0]!.readyState, 3);
    assert.deepEqual(fixtureValue.deletes, [
      `/workers/scripts/${worker}/tails/${fixtureValue.tail.id}`,
    ]);
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

test("trace rejects impossible provider expiry and still deletes the real tail", async () => {
  const fixtureValue = fixture();
  const socket = installSocket();
  const year = new Date(fixtureValue.tail.expires_at).getUTCFullYear() + 1;
  fixtureValue.tail.expires_at = `${year}-02-30T12:00:00Z`;
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

test("trace rejects expired UTC seconds before ownership and still deletes the tail", async () => {
  const fixtureValue = fixture();
  fixtureValue.tail.expires_at =
    new Date(Date.now() - 60_000).toISOString().slice(0, 19) + "Z";
  const socket = installSocket();
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
    assert.deepEqual(fixtureValue.deletes, [
      `/workers/scripts/${worker}/tails/${fixtureValue.tail.id}`,
    ]);
  } finally {
    socket.restore();
  }
});

test("trace rejects UTC offsets before ownership and still deletes the tail", async () => {
  const fixtureValue = fixture();
  fixtureValue.tail.expires_at = fixtureValue.tail.expires_at.replace(
    /Z$/,
    "+00:00",
  );
  const socket = installSocket();
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
    assert.deepEqual(fixtureValue.deletes, [
      `/workers/scripts/${worker}/tails/${fixtureValue.tail.id}`,
    ]);
  } finally {
    socket.restore();
  }
});

test("trace rejects malformed expiry text before ownership and still deletes the tail", async () => {
  const fixtureValue = fixture();
  fixtureValue.tail.expires_at = " " + fixtureValue.tail.expires_at;
  const socket = installSocket();
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
    assert.deepEqual(fixtureValue.deletes, [
      `/workers/scripts/${worker}/tails/${fixtureValue.tail.id}`,
    ]);
  } finally {
    socket.restore();
  }
});

test("trace event timeout never replays its trigger and always terminates and deletes", async () => {
  const value = fixture();
  const socket = installSocket();
  let calls = 0;
  try {
    await assert.rejects(
      capture(
        value.client,
        worker,
        value.marker,
        async () => {
          calls++;
        },
        async () => {},
        { eventTimeoutMs: 1 },
      ),
      { message: "trace_event_missing" },
    );
    assert.equal(calls, 1);
    assert.equal(socket.sockets[0]!.terminated, 1);
    assert.equal(value.deletes.length, 1);
  } finally {
    socket.restore();
  }
});

test("trace bounds a stalled trigger without replay or leaked tail", async () => {
  const value = fixture();
  const socket = installSocket();
  let calls = 0;
  try {
    await assert.rejects(
      capture(
        value.client,
        worker,
        value.marker,
        () => {
          calls++;
          return new Promise(() => {});
        },
        async () => {},
        { eventTimeoutMs: 1 },
      ),
      { message: "trace_event_missing" },
    );
    assert.equal(calls, 1);
    assert.equal(socket.sockets[0]!.terminated, 1);
    assert.equal(value.deletes.length, 1);
  } finally {
    socket.restore();
  }
});

test("trace counts UTF-8 bytes before retaining oversized metadata", async () => {
  const value = fixture();
  const socket = installSocket();
  try {
    await assert.rejects(
      capture(
        value.client,
        worker,
        value.marker,
        async () => {
          socket.sockets[0]!.emit("é".repeat(1_000_001));
        },
        async () => {},
      ),
      { message: "trace_failed" },
    );
    assert.equal(socket.sockets[0]!.terminated, 1);
    assert.equal(value.deletes.length, 1);
  } finally {
    socket.restore();
  }
});

test("trace initialization failure excludes socket error content and never triggers", async () => {
  const value = fixture();
  const socket = installSocket();
  const factory = socketFactory!;
  let calls = 0;
  const secret = randomBytes(32).toString("base64url");
  try {
    await assert.rejects(
      capture(
        value.client,
        worker,
        value.marker,
        async () => {
          calls++;
        },
        async () => {},
        {
          socketFactory: (url) => {
            const created = factory(url);
            created.send = (_data, _options, callback) =>
              callback(new Error(secret));
            return created;
          },
        },
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "trace_failed" &&
        !String(error).includes(secret),
    );
    assert.equal(calls, 0);
    assert.equal(socket.sockets[0]!.terminated, 1);
    assert.equal(value.deletes.length, 1);
  } finally {
    socket.restore();
  }
});

test("trace open timeout prevents triggering and deletes after termination", async () => {
  const value = fixture();
  let calls = 0;
  let terminated = 0;
  const target = new EventTarget();
  const stalled = {
    readyState: 0,
    addEventListener: target.addEventListener.bind(target),
    send: () => {
      throw new Error("unexpected_send");
    },
    terminate: () => {
      terminated++;
    },
  } as unknown as TailSocket;
  await assert.rejects(
    capture(
      value.client,
      worker,
      value.marker,
      async () => {
        calls++;
      },
      async () => {},
      { socketFactory: () => stalled, openTimeoutMs: 1 },
    ),
    { message: "trace_open_timeout" },
  );
  assert.equal(calls, 0);
  assert.equal(terminated, 1);
  assert.equal(value.deletes.length, 1);
});

test("trace never dispatches a trigger when settling resumes after expiry", async (context) => {
  context.mock.timers.enable({
    apis: ["Date", "setTimeout"],
    now: Date.UTC(2030, 0, 1),
  });
  const value = fixture();
  value.tail.expires_at = new Date(Date.now() + 8_000).toISOString();
  const socket = installSocket();
  const factory = socketFactory!;
  let initialized: (() => void) | undefined;
  const initialization = new Promise<void>((resolve) => {
    initialized = resolve;
  });
  let calls = 0;
  let failure: unknown;
  const captured = capture(
    value.client,
    worker,
    value.marker,
    async () => {
      calls++;
    },
    async () => {},
    {
      settleMs: 7_000,
      socketFactory: (url) => {
        const created = factory(url);
        const send = created.send.bind(created);
        created.send = (data, options, callback) => {
          send(data, options, callback);
          initialized!();
        };
        return created;
      },
    },
  ).catch((error: unknown) => {
    failure = error;
  });
  try {
    await initialization;
    await new Promise<void>((resolve) => setImmediate(resolve));
    context.mock.timers.tick(9_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    context.mock.timers.tick(0);
    await captured;
    assert.equal(calls, 0);
    assert(failure instanceof Error);
    assert.equal(failure.message, "invalid_tail_expiry");
    assert.equal(socket.sockets[0]!.terminated, 1);
    assert.deepEqual(value.deletes, [
      `/workers/scripts/${worker}/tails/${value.tail.id}`,
    ]);
  } finally {
    socket.restore();
    context.mock.timers.reset();
  }
});
