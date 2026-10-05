// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import worker, {
  HTTPS_SOURCE_CONTROL_DOMAIN,
} from "../probe/source-control-worker.ts";
import type { SourceControlEnv } from "../probe/source-control-worker.ts";

const origin = "https://pgcf-source.example.invalid";
const nonce = "a".repeat(64);
const bearer = "private-acceptance-bearer";
const keys = generateKeyPairSync("ed25519");
const privateJwk = JSON.stringify(keys.privateKey.export({ format: "jwk" }));

function env(overrides: Partial<SourceControlEnv> = {}): SourceControlEnv {
  return {
    PROBE_BEARER: bearer,
    SOURCE_CONTROL_SIGNING_JWK: privateJwk,
    SOURCE_CONTROL_KID: "acceptance-observer",
    SOURCE_CONTROL_ORIGIN: origin,
    RUN_EXPIRES_AT: new Date(Date.now() + 599_000).toISOString(),
    ...overrides,
  };
}

function request(
  options: {
    url?: string;
    method?: string;
    body?: string | Uint8Array | ReadableStream<Uint8Array>;
    headers?: Record<string, string>;
  } = {},
): Request {
  const method = options.method ?? "POST";
  return new Request(options.url ?? `${origin}/source-control`, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      "CF-Connecting-IP": "198.51.100.20",
      ...options.headers,
    },
    ...(method === "GET"
      ? {}
      : { body: options.body ?? JSON.stringify({ nonce }) }),
    duplex: "half",
  } as RequestInit);
}

test("HTTPS source control signs the exact nonce and authoritative source in its own domain", async () => {
  const before = Date.now();
  const reply = await worker.fetch(request(), env());
  const after = Date.now();
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get("Cache-Control"), "no-store");
  const envelope = (await reply.json()) as {
    kid: string;
    payload: {
      nonce: string;
      source: string;
      observed_at: string;
      origin: string;
    };
    signature: string;
  };
  assert.deepEqual(Object.keys(envelope).sort(), [
    "kid",
    "payload",
    "signature",
  ]);
  assert.deepEqual(Object.keys(envelope.payload).sort(), [
    "nonce",
    "observed_at",
    "origin",
    "source",
  ]);
  assert.equal(envelope.kid, "acceptance-observer");
  assert.equal(envelope.payload.nonce, nonce);
  assert.equal(envelope.payload.source, "198.51.100.20");
  assert.equal(envelope.payload.origin, origin);
  assert(Date.parse(envelope.payload.observed_at) >= before);
  assert(Date.parse(envelope.payload.observed_at) <= after);
  const canonical = JSON.stringify({
    nonce,
    observed_at: envelope.payload.observed_at,
    origin,
    source: "198.51.100.20",
  });
  const signature = Buffer.from(envelope.signature, "base64url");
  assert.equal(signature.length, 64);
  assert.equal(signature.toString("base64url"), envelope.signature);
  assert.equal(
    HTTPS_SOURCE_CONTROL_DOMAIN,
    "pgcf-node-https-source-control/v1\n",
  );
  assert(
    verify(
      null,
      Buffer.from(HTTPS_SOURCE_CONTROL_DOMAIN + canonical),
      keys.publicKey,
      signature,
    ),
  );
  assert.equal(
    verify(
      null,
      Buffer.from("pgcf-node-source-control/v1\n" + canonical),
      keys.publicKey,
      signature,
    ),
    false,
  );
  assert.equal(
    verify(
      null,
      Buffer.from(
        HTTPS_SOURCE_CONTROL_DOMAIN + canonical.replace(nonce, "b".repeat(64)),
      ),
      keys.publicKey,
      signature,
    ),
    false,
  );
});

test("native IPv6 is canonicalized without trusting forwarded headers", async () => {
  const reply = await worker.fetch(
    request({
      headers: {
        "CF-Connecting-IP": "2001:0DB8:0:0:0:0:0:20",
        "CF-Connecting-IPv6": "2001:db8::20",
        "X-Forwarded-For": "198.51.100.99",
        "X-Real-IP": "198.51.100.98",
      },
    }),
    env(),
  );
  assert.equal(reply.status, 200);
  const result = (await reply.json()) as { payload: { source: string } };
  assert.equal(result.payload.source, "2001:db8::20");
});

test("Worker subrequests and absent, malformed or pseudo client addresses cannot be signed", async () => {
  const subrequest = await worker.fetch(
    request({ headers: { "CF-Worker": "worker.example.invalid" } }),
    env(),
  );
  assert.equal(subrequest.status, 403);
  const absent = request();
  absent.headers.delete("CF-Connecting-IP");
  assert.equal((await worker.fetch(absent, env())).status, 400);
  assert.equal(
    (
      await worker.fetch(
        request({
          headers: { "CF-Connecting-IP": "198.51.100.20,198.51.100.21" },
        }),
        env(),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await worker.fetch(
        request({
          headers: {
            "CF-Connecting-IP": "240.0.0.20",
            "CF-Connecting-IPv6": "2001:db8::20",
          },
        }),
        env(),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await worker.fetch(
        request({
          headers: {
            "CF-Connecting-IP": "2001:db8::20",
            "CF-Connecting-IPv6": "2001:db8::21",
          },
        }),
        env(),
      )
    ).status,
    400,
  );
});

test("only the configured HTTPS origin and exact POST endpoint are accepted", async () => {
  assert.equal(
    (
      await worker.fetch(
        request({ url: "https://other.example.invalid/source-control" }),
        env(),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await worker.fetch(
        request(),
        env({ SOURCE_CONTROL_ORIGIN: `${origin}/` }),
      )
    ).status,
    400,
  );
  assert.equal(
    (await worker.fetch(request({ method: "GET" }), env())).status,
    405,
  );
  assert.equal(
    (
      await worker.fetch(
        request({ url: `${origin}/source-control?nonce=${nonce}` }),
        env(),
      )
    ).status,
    404,
  );
  assert.equal(
    (await worker.fetch(request({ url: `${origin}/elsewhere` }), env())).status,
    404,
  );
});

test("a private bearer and an active canonical run expiry of at most ten minutes are required", async () => {
  assert.equal(
    (
      await worker.fetch(
        request({ headers: { Authorization: "Bearer wrong" } }),
        env(),
      )
    ).status,
    401,
  );
  assert.equal(
    (await worker.fetch(request(), env({ PROBE_BEARER: "" }))).status,
    401,
  );
  assert.equal(
    (await worker.fetch(request(), env({ RUN_EXPIRES_AT: "" }))).status,
    410,
  );
  assert.equal(
    (
      await worker.fetch(
        request(),
        env({ RUN_EXPIRES_AT: new Date(Date.now() - 1000).toISOString() }),
      )
    ).status,
    410,
  );
  assert.equal(
    (
      await worker.fetch(
        request(),
        env({ RUN_EXPIRES_AT: new Date(Date.now() + 610_000).toISOString() }),
      )
    ).status,
    410,
  );
  assert.equal(
    (
      await worker.fetch(
        request(),
        env({
          RUN_EXPIRES_AT:
            new Date(Date.now() + 5000).toISOString().slice(0, 19) + "Z",
        }),
      )
    ).status,
    410,
  );
});

test("the input is exactly one lowercase 64-hex nonce within 128 bytes", async () => {
  assert.equal(
    (
      await worker.fetch(
        request({ body: JSON.stringify({ nonce, source: "198.51.100.99" }) }),
        env(),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await worker.fetch(
        request({ body: JSON.stringify({ nonce: "A".repeat(64) }) }),
        env(),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await worker.fetch(
        request({ body: `{"nonce":"${nonce}","nonce":"${nonce}"}` }),
        env(),
      )
    ).status,
    413,
  );
  assert.equal(
    (
      await worker.fetch(
        request({ body: JSON.stringify({ nonce: nonce.slice(1) }) }),
        env(),
      )
    ).status,
    400,
  );
  assert.equal((await worker.fetch(request({ body: "{" }), env())).status, 400);
  assert.equal(
    (
      await worker.fetch(
        request({ headers: { "Content-Length": "129" } }),
        env(),
      )
    ).status,
    413,
  );
  assert.equal(
    (await worker.fetch(request({ body: " ".repeat(129) }), env())).status,
    413,
  );
  const padded = `${JSON.stringify({ nonce })}${" ".repeat(52)}`;
  assert.equal(Buffer.byteLength(padded), 128);
  assert.equal(
    (await worker.fetch(request({ body: padded }), env())).status,
    200,
  );
});

test("body streaming stops when the byte bound is exceeded", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(129));
    },
    cancel() {
      canceled = true;
    },
  });
  assert.equal((await worker.fetch(request({ body }), env())).status, 413);
  assert.equal(canceled, true);
});

test("an authenticated stalled body has one five-second deadline and its stream is canceled", async () => {
  let canceled = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      controller.enqueue(new TextEncoder().encode('{"nonce":"'));
    },
    cancel() {
      canceled = true;
      // A source that never acknowledges cancellation cannot delay the response.
      return new Promise<void>(() => undefined);
    },
  });
  const pending = worker.fetch(request({ body }), env());
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const started = performance.now();
  try {
    const reply = await Promise.race([
      pending,
      new Promise<undefined>((resolve) => {
        watchdog = setTimeout(() => resolve(undefined), 5500);
      }),
    ]);
    assert(reply, "stalled request did not finish within the body deadline");
    assert.equal(reply.status, 408);
    assert.deepEqual(await reply.json(), { code: "input_timeout" });
    assert.equal(canceled, true);
    assert(performance.now() - started >= 4750);
  } finally {
    clearTimeout(watchdog);
    if (!canceled) controller!.close();
    await pending;
  }
});

test("invalid signing configuration fails without exposing private material", async () => {
  const reply = await worker.fetch(
    request(),
    env({ SOURCE_CONTROL_SIGNING_JWK: "private-canary-not-json" }),
  );
  assert.equal(reply.status, 500);
  assert.equal((await reply.text()).includes("private-canary"), false);
  const publicJwk = JSON.stringify(keys.publicKey.export({ format: "jwk" }));
  assert.equal(
    (
      await worker.fetch(
        request(),
        env({ SOURCE_CONTROL_SIGNING_JWK: publicJwk }),
      )
    ).status,
    500,
  );
  assert.equal(
    (await worker.fetch(request(), env({ SOURCE_CONTROL_KID: "not/a/key" })))
      .status,
    500,
  );
});
