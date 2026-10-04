// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PostgresActivity,
  WebSocketInputActivity,
} from "../../src/gateway/activity.ts";

function frame(type: string, body = Buffer.alloc(0)): Buffer {
  const out = Buffer.alloc(5 + body.length);
  out[0] = type.charCodeAt(0);
  out.writeUInt32BE(4 + body.length, 1);
  body.copy(out, 5);
  return out;
}
const auth = frame("R", Buffer.alloc(4));
const ready = (state = "I") => frame("Z", Buffer.from(state));
const query = frame("Q", Buffer.from("SELECT 1\0"));
function idle(): PostgresActivity {
  const state = new PostgresActivity();
  state.observeBackend(Buffer.concat([auth, ready()]));
  assert.equal(state.busy, false);
  return state;
}

test("authentication and partial messages stay busy; pipelined ReadyForQuery cannot acknowledge a later request", () => {
  const state = new PostgresActivity();
  assert.equal(state.busy, true);
  for (const byte of auth) {
    state.observeBackend(Buffer.from([byte]));
    assert.equal(state.busy, true);
  }
  state.observeBackend(ready());
  assert.equal(state.busy, false);
  for (const byte of query.subarray(0, -1)) {
    state.observeFrontend(Buffer.from([byte]));
    assert.equal(state.busy, true);
  }
  state.observeBackend(ready());
  assert.equal(state.busy, true);
  state.observeFrontend(query.subarray(-1));
  assert.equal(state.busy, true);
  const pipeline = idle();
  pipeline.observeFrontend(Buffer.concat([query, query]));
  assert.equal(pipeline.busy, true);
  pipeline.observeBackend(ready());
  assert.equal(pipeline.busy, true);
  pipeline.observeBackend(ready());
  assert.equal(pipeline.busy, false);
});

test("extended work, copy streams and transaction/error states require their full completion", () => {
  const state = idle();
  state.observeFrontend(frame("P", Buffer.from([0, 0, 0, 0])));
  assert.equal(state.busy, true);
  state.observeFrontend(frame("S"));
  assert.equal(state.busy, true);
  state.observeBackend(ready("T"));
  assert.equal(state.busy, true);
  state.observeFrontend(query);
  state.observeBackend(ready("E"));
  assert.equal(state.busy, true);
  state.observeFrontend(query);
  state.observeBackend(ready());
  assert.equal(state.busy, false);
  state.observeFrontend(query);
  state.observeBackend(frame("G", Buffer.alloc(3)));
  const body = Buffer.alloc(1024 * 1024, 1);
  const header = Buffer.alloc(5);
  header[0] = 100;
  header.writeUInt32BE(body.length + 4, 1);
  state.observeFrontend(header);
  state.observeFrontend(body);
  assert.equal(state.busy, true);
  state.observeFrontend(frame("c"));
  state.observeBackend(ready());
  assert.equal(state.busy, false);
});

test("malformed, ambiguous, duplicate readiness and partial backend input never become idle", () => {
  const malformed = idle();
  malformed.observeFrontend(Buffer.from([81, 0, 0, 0, 3]));
  malformed.observeBackend(ready());
  assert.equal(malformed.busy, true);
  const ambiguous = idle();
  ambiguous.observeFrontend(frame("F"));
  ambiguous.observeBackend(ready());
  assert.equal(ambiguous.busy, true);
  const duplicate = idle();
  duplicate.observeBackend(ready());
  assert.equal(duplicate.busy, true);
  const partial = idle();
  partial.observeBackend(Buffer.from([78]));
  assert.equal(partial.busy, true);
  const brokenReady = idle();
  brokenReady.observeFrontend(query);
  brokenReady.observeBackend(ready("x"));
  assert.equal(brokenReady.busy, true);
});

test("WebSocket partial envelopes, continuations and emitted-but-unconsumed messages remain busy", () => {
  const wire = new WebSocketInputActivity();
  const masked = (opcode: number, final: boolean, payload: Buffer) =>
    Buffer.concat([
      Buffer.from([
        (final ? 128 : 0) | opcode,
        128 | payload.length,
        0,
        0,
        0,
        0,
      ]),
      payload,
    ]);
  const first = masked(2, false, Buffer.from([81]));
  for (const byte of first) {
    wire.observe(Buffer.from([byte]));
    assert.equal(wire.busy, true);
  }
  wire.observe(masked(9, true, Buffer.from([1])));
  assert.equal(wire.busy, true);
  wire.observe(masked(0, true, Buffer.from([0])));
  assert.equal(wire.busy, true);
  wire.consumeMessage();
  assert.equal(wire.busy, false);
  wire.observe(masked(2, true, Buffer.alloc(0)));
  assert.equal(wire.busy, true);
  wire.consumeMessage();
  assert.equal(wire.busy, false);
});
