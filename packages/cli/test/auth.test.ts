// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { once } from "node:events";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { randomBytes } from "node:crypto";
import {
  BackendAuthentication,
  FrontendPrelude,
  AUTH_BYTES,
} from "../src/auth.ts";
import WebSocket, { WebSocketServer } from "ws";
import { newDatabaseId } from "@pgcf/contracts";
import { startBridge, UPSTREAM_OPTIONS } from "../src/bridge.ts";

function message(type: string, payload: Buffer): Buffer {
  const value = Buffer.alloc(5 + payload.length);
  value[0] = type.charCodeAt(0);
  value.writeUInt32BE(4 + payload.length, 1);
  payload.copy(value, 5);
  return value;
}
function authentication(code: number, payload = Buffer.alloc(0)): Buffer {
  const value = Buffer.alloc(4 + payload.length);
  value.writeUInt32BE(code);
  payload.copy(value, 4);
  return message("R", value);
}
function offer(...mechanisms: string[]): Buffer {
  return authentication(10, Buffer.from(mechanisms.join("\0") + "\0\0"));
}

async function transform(
  chunks: Buffer[],
  filter = new BackendAuthentication(),
): Promise<Buffer> {
  const values: Buffer[] = [];
  filter.on("data", (value: Buffer) => values.push(value));
  const complete = new Promise<Buffer>((resolve, reject) => {
    filter.once("end", () => resolve(Buffer.concat(values)));
    filter.once("error", reject);
  });
  for (const chunk of chunks) filter.write(chunk);
  filter.end();
  return complete;
}

test("loopback auth offer removes SCRAM PLUS before libpq sees it", async (context) => {
  const host = [127, 0, 0, 1].join(".");
  const upstream = new WebSocketServer({ host, port: 0 });
  await once(upstream, "listening");
  upstream.on("connection", (peer) => {
    peer.on("error", () => {});
    peer.send(offer("SCRAM-SHA-256-PLUS", "SCRAM-SHA-256"));
  });
  const bridge = await startBridge(
    {
      endpoint: `wss://${["edge", "test", "invalid"].join(".")}`,
      database: newDatabaseId(),
      user: "app",
      port: 0,
    },
    {
      connect: (url) => {
        const target = new URL(url);
        target.protocol = "ws:";
        target.hostname = host;
        target.port = String((upstream.address() as AddressInfo).port);
        return new WebSocket(target, UPSTREAM_OPTIONS);
      },
    },
  );
  context.after(async () => {
    await bridge.close();
    for (const peer of upstream.clients) peer.terminate();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  const local = connect({ host, port: bridge.port });
  local.on("error", () => {});
  await once(local, "connect");
  const received = await new Promise<Buffer>((resolve) => {
    let bytes = Buffer.alloc(0);
    local.on("data", (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length >= 5 && bytes.length >= bytes.readUInt32BE(1) + 1)
        resolve(bytes);
    });
  });
  assert.deepEqual(received, offer("SCRAM-SHA-256"));
  local.resetAndDestroy();
});

test("authentication byte splits and concatenated success preserve proof and subsequent raw bytes", async () => {
  const sasl = offer("SCRAM-SHA-256-PLUS", "SCRAM-SHA-256");
  const challenge = authentication(11, randomBytes(127));
  const proof = authentication(12, randomBytes(80));
  const ok = authentication(0);
  const raw = Buffer.concat([
    randomBytes(512),
    authentication(3),
    randomBytes(AUTH_BYTES + 1),
  ]);
  const source = Buffer.concat([sasl, challenge, proof, ok, raw]);
  const expected = Buffer.concat([
    offer("SCRAM-SHA-256"),
    challenge,
    proof,
    ok,
    raw,
  ]);
  for (
    let split = 0;
    split <= sasl.length + challenge.length + proof.length + ok.length;
    split++
  ) {
    assert.deepEqual(
      await transform([source.subarray(0, split), source.subarray(split)]),
      expected,
    );
  }
  assert.deepEqual(
    await transform(
      [...source.subarray(0, sasl.length)]
        .map((value) => Buffer.from([value]))
        .concat(source.subarray(sasl.length)),
    ),
    expected,
  );
});

test("plain SCRAM, nonauthentication frames and wrong-password errors remain byte exact", async () => {
  const error = message(
    "E",
    Buffer.from("SERROR\0C28P01\0Mpassword authentication failed\0\0"),
  );
  const notice = message("N", Buffer.from("SNOTICE\0Minitial notice\0\0"));
  const sasl = offer("SCRAM-SHA-256");
  const source = Buffer.concat([notice, sasl, error]);
  assert.deepEqual(
    await transform([...source].map((value) => Buffer.from([value]))),
    source,
  );
});

test("PLUS-only, duplicate offers, malformed mechanisms, cleartext and oversized authentication fail closed", async () => {
  await assert.rejects(
    transform([offer("SCRAM-SHA-256-PLUS")]),
    /invalid_sasl_offer/,
  );
  await assert.rejects(
    transform([
      Buffer.concat([offer("SCRAM-SHA-256"), offer("SCRAM-SHA-256")]),
    ]),
    /duplicate_sasl_offer/,
  );
  await assert.rejects(
    transform([offer("SCRAM-SHA-256", "SCRAM-SHA-256")]),
    /invalid_sasl_offer/,
  );
  await assert.rejects(
    transform([authentication(10, Buffer.from("SCRAM-SHA-256\0"))]),
    /invalid_sasl_offer/,
  );
  await assert.rejects(
    transform([authentication(10, Buffer.from("SCRAM-SHA-256\0\0extra"))]),
    /invalid_sasl_offer/,
  );
  await assert.rejects(
    transform([authentication(3)]),
    /cleartext_auth_refused/,
  );
  const short = Buffer.from([0x52, 0, 0, 0, 3]);
  await assert.rejects(transform([short]), /invalid_auth_frame/);
  const oversized = Buffer.alloc(5);
  oversized[0] = 0x52;
  oversized.writeUInt32BE(AUTH_BYTES, 1);
  await assert.rejects(transform([oversized]), /invalid_auth_frame/);
  await assert.rejects(
    transform([offer("SCRAM-SHA-256").subarray(0, 10)]),
    /truncated_auth_frame/,
  );
});

test("exact frontend SSL/GSS preludes track single-byte refusal without confusing fragmented notices", async () => {
  const backend = new BackendAuthentication();
  const frontend = new FrontendPrelude(backend);
  const received: Buffer[] = [];
  frontend.on("data", (chunk: Buffer) => received.push(chunk));
  const prelude = Buffer.alloc(8);
  prelude.writeUInt32BE(8);
  prelude.writeUInt32BE(80877104, 4);
  for (const value of prelude) frontend.write(Buffer.from([value]));
  assert.deepEqual(Buffer.concat(received), prelude);
  const notice = message("N", Buffer.from("SNOTICE\0Mafter denial\0\0"));
  const source = Buffer.concat([
    Buffer.from("N"),
    notice,
    offer("SCRAM-SHA-256-PLUS", "SCRAM-SHA-256"),
    authentication(0),
  ]);
  assert.deepEqual(
    await transform(
      [...source].map((value) => Buffer.from([value])),
      backend,
    ),
    Buffer.concat([
      Buffer.from("N"),
      notice,
      offer("SCRAM-SHA-256"),
      authentication(0),
    ]),
  );
  frontend.destroy();
  const sslBackend = new BackendAuthentication();
  const ssl = new FrontendPrelude(sslBackend);
  ssl.on("error", () => {});
  prelude.writeUInt32BE(80877103, 4);
  ssl.write(prelude);
  await assert.rejects(
    transform([Buffer.from("S")], sslBackend),
    /invalid_auth_prelude/,
  );
  ssl.destroy();
});

test("malformed frontend prelude length is refused without rewriting input", async () => {
  const backend = new BackendAuthentication();
  const frontend = new FrontendPrelude(backend);
  const value = Buffer.alloc(8);
  value.writeUInt32BE(9);
  value.writeUInt32BE(80877103, 4);
  const failed = once(frontend, "error");
  frontend.write(value);
  assert.equal((await failed)[0].message, "invalid_frontend_prelude");
  backend.destroy();
  frontend.destroy();
});

test("frontend buffered bytes remain exact if authentication succeeds between chunks", async () => {
  const backend = new BackendAuthentication();
  const frontend = new FrontendPrelude(backend);
  const received: Buffer[] = [];
  frontend.on("data", (chunk: Buffer) => received.push(chunk));
  const payload = randomBytes(64);
  frontend.write(payload.subarray(0, 4));
  await transform([authentication(0)], backend);
  const complete = once(frontend, "end");
  frontend.end(payload.subarray(4));
  await complete;
  assert.deepEqual(Buffer.concat(received), payload);
});
