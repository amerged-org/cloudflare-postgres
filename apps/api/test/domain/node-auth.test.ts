// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import {
  NODE_FENCED_ERROR,
  NodeFencedResponse,
  nodePublicKey,
  type NodeKey,
} from "@pgcf/contracts";
import {
  cleanupFixtures,
  fixture,
  nodeRequest,
  nodeToken,
  rawRequest,
} from "./fixtures.ts";

afterEach(cleanupFixtures);

const OBSERVATIONS = "/node/v1/observations";
const empty = () => ({
  observed_at: new Date().toISOString(),
  databases: [],
  orders: [],
});
const post = (
  f: Awaited<ReturnType<typeof fixture>>,
  init: Parameters<typeof nodeRequest>[2] = {},
) => nodeRequest(f, OBSERVATIONS, { method: "POST", body: empty(), ...init });

describe("a request signed with a node's key", () => {
  it("is accepted for the node, the method, the path and the body it names", async () => {
    const f = await fixture();
    const response = await post(f);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ databases: [], orders: 0 });
  });

  it("is refused for another key, an unknown node or install, and a node without a key", async () => {
    const f = await fixture();
    const other = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    expect((await post(f, { key: other.privateKey as NodeKey })).status).toBe(
      401,
    );
    expect((await post(f, { uid: crypto.randomUUID() })).status).toBe(401);
    expect((await post(f, { node: `nod_${"z".repeat(20)}` })).status).toBe(401);
    await env.DB.prepare("UPDATE nodes SET public_key=? WHERE id=?")
      .bind(await nodePublicKey(other.publicKey as NodeKey), f.node)
      .run();
    // The key the row holds now is not the one that signed.
    expect((await post(f)).status).toBe(401);
    await env.DB.prepare("UPDATE nodes SET public_key=NULL WHERE id=?")
      .bind(f.node)
      .run();
    expect((await post(f)).status).toBe(401);
  });

  it("is the only credential: a management key or none is refused", async () => {
    const f = await fixture();
    const send = (headers: Record<string, string>) =>
      rawRequest(OBSERVATIONS, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(empty()),
      });
    expect((await send({})).status).toBe(401);
    expect((await send({ Authorization: `Bearer ${f.admin}` })).status).toBe(
      401,
    );
  });

  it("cannot be moved to another path, query, method or body", async () => {
    const f = await fixture();
    const text = JSON.stringify(empty()),
      bytes = new TextEncoder().encode(text);
    const send = async (path: string, token: string, body: string) =>
      rawRequest(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body,
      });
    const token = await nodeToken(f, OBSERVATIONS, "POST", bytes);
    expect((await send(OBSERVATIONS, token, text)).status).toBe(200);
    expect((await send("/node/v1/volumes", token, text)).status).toBe(401);
    expect(
      (
        await send(
          OBSERVATIONS,
          token,
          JSON.stringify({
            ...empty(),
            observed_at: "2026-01-01T00:00:00.000Z",
          }),
        )
      ).status,
    ).toBe(401);
    // The signature covers the exact bytes: a space the node did not sign is another body.
    expect((await send(OBSERVATIONS, token, `${text} `)).status).toBe(401);
    // A token for a query is for that query, and a GET is not a POST.
    const query = await nodeToken(f, "/node/v1/desired?limit=1", "GET");
    const desired = (suffix: string) =>
      rawRequest(`/node/v1/desired${suffix}`, {
        headers: { Authorization: `Bearer ${query}` },
      });
    expect((await desired("?limit=2")).status).toBe(401);
    expect(
      (
        await rawRequest("/node/v1/desired?limit=1", {
          method: "POST",
          headers: { Authorization: `Bearer ${query}` },
        })
      ).status,
    ).not.toBe(200);
  });

  it("is refused for an unknown node before its body is read", async () => {
    const f = await fixture();
    const huge = JSON.stringify({ pad: "x".repeat(5 * 1024 * 1024) });
    const send = (headers: Record<string, string>, body: string) =>
      rawRequest(OBSERVATIONS, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body,
      });
    // Whatever the body is, a caller without a node's credentials gets the same refusal: the
    // Worker neither buffers nor parses what it sends.
    expect((await send({}, huge)).status).toBe(401);
    expect((await send({}, "not json")).status).toBe(401);
    const unknown = await nodeToken(
      f,
      OBSERVATIONS,
      "POST",
      new TextEncoder().encode(huge),
      { node: `nod_${"z".repeat(20)}` },
    );
    expect(
      (await send({ Authorization: `Bearer ${unknown}` }, huge)).status,
    ).toBe(401);
  });

  it("is refused after its lifetime and before its start", async () => {
    const f = await fixture();
    expect((await post(f, { now: Date.now() - 120_000 })).status).toBe(401);
    expect((await post(f, { now: Date.now() + 120_000 })).status).toBe(401);
  });
});

describe("a node declared lost", () => {
  it("reaches only its desired page and its observations, and is told it is fenced", async () => {
    const f = await fixture();
    expect((await post(f)).status).toBe(200);
    await env.DB.prepare(
      "UPDATE nodes SET lost_at=?,lost_reason='test',ready=0,schedulable=0 WHERE id=?",
    )
      .bind(new Date().toISOString(), f.node)
      .run();
    // The observations stay open, for the results of its orders.
    expect((await post(f)).status).toBe(200);
    for (const [path, init] of [
      [
        "/node/v1/volumes",
        {
          method: "POST",
          body: { observed_at: new Date().toISOString(), volumes: [] },
        },
      ],
      ["/node/v1/events", { method: "POST", body: { events: [] } }],
      ["/node/v1/usage", { method: "POST", body: { rows: [] } }],
      ["/node/v1/link", {}],
    ] as const) {
      const response = await nodeRequest(f, path, init);
      expect(response.status, path).toBe(403);
      expect(NodeFencedResponse.parse(await response.json())).toEqual({
        error: NODE_FENCED_ERROR,
      });
    }
  });
});
