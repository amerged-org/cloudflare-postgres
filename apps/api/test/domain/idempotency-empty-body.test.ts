// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { DatabaseWithOperation, ErrorBody } from "@pgcf/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createApp } from "../../src/app.ts";
import type { ApiEnv } from "../../src/env.ts";
import { requestHash } from "../../src/middleware/idempotency.ts";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";

afterEach(cleanupFixtures);

function streamRequest(
  path: string,
  credential: string,
  key: string,
  bytes: Uint8Array = new Uint8Array(),
  contentType?: string,
): Request {
  const headers = new Headers({
    Authorization: `Bearer ${credential}`,
    "Idempotency-Key": key,
  });
  if (contentType) headers.set("Content-Type", contentType);
  return new Request(new URL(path, `https://${["api", "invalid"].join(".")}`), {
    method: "DELETE",
    headers,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  });
}

async function fetchRequest(input: Request): Promise<Response> {
  const context = createExecutionContext();
  const response = await createApp().fetch(input, env, context);
  await waitOnExecutionContext(context);
  return response;
}

describe("empty-stream request idempotency on real Workers D1", () => {
  it("deletes once and replays an empty stream as the same absent body", async () => {
    const f = await fixture();
    const created = DatabaseWithOperation.parse(
      await (await f.create()).json(),
    );
    const id = created.database.id;
    const path = `/v1/databases/${id}`;
    const key = crypto.randomUUID();
    const input = streamRequest(path, f.integrator, key);
    expect(input.body).not.toBeNull();
    const first = await fetchRequest(input);
    expect(first.status).toBe(202);
    const deleted = DatabaseWithOperation.parse(await first.json());
    const replay = await request(path, f.integrator, "DELETE", undefined, key);
    expect(replay.status).toBe(202);
    expect(DatabaseWithOperation.parse(await replay.json())).toEqual(deleted);
    const repeatedStream = await fetchRequest(
      streamRequest(path, f.integrator, key, undefined, "application/json"),
    );
    expect(repeatedStream.status).toBe(202);
    expect(
      DatabaseWithOperation.parse(await repeatedStream.json()).operation.id,
    ).toBe(deleted.operation.id);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) count FROM operations WHERE database_id=? AND kind='database.delete'",
      )
        .bind(id)
        .first("count"),
    ).toBe(1);
    const row = await env.DB.prepare(
      "SELECT desired_state, generation FROM databases WHERE id=?",
    )
      .bind(id)
      .first();
    expect(row).toEqual({ desired_state: "deleted", generation: 2 });

    const otherCredential = await fetchRequest(
      streamRequest(path, f.admin, key),
    );
    expect(otherCredential.status).toBe(202);
    expect(
      DatabaseWithOperation.parse(await otherCredential.json()).operation.id,
    ).toBe(deleted.operation.id);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) count FROM idempotency_keys WHERE key=?",
      )
        .bind(key)
        .first("count"),
    ).toBe(2);
  });

  it("rejects whitespace and malformed nonempty JSON without reserving or deleting", async () => {
    const f = await fixture();
    const created = DatabaseWithOperation.parse(
      await (await f.create()).json(),
    );
    const path = `/v1/databases/${created.database.id}`;
    const whitespaceKey = crypto.randomUUID();
    const whitespace = await fetchRequest(
      streamRequest(
        path,
        f.integrator,
        whitespaceKey,
        new TextEncoder().encode(" \n\t"),
        "application/json",
      ),
    );
    expect(whitespace.status).toBe(400);
    expect(ErrorBody.parse(await whitespace.json()).error.message).toBe(
      "Malformed JSON body",
    );
    const malformedKey = crypto.randomUUID();
    const malformed = await fetchRequest(
      streamRequest(
        path,
        f.integrator,
        malformedKey,
        new TextEncoder().encode("{"),
        "application/json",
      ),
    );
    expect(malformed.status).toBe(400);
    expect(ErrorBody.parse(await malformed.json()).error.message).toBe(
      "Malformed JSON body",
    );
    const bom = await fetchRequest(
      streamRequest(
        path,
        f.integrator,
        crypto.randomUUID(),
        new Uint8Array([0xef, 0xbb, 0xbf]),
        "application/json",
      ),
    );
    expect(bom.status).toBe(400);
    expect(ErrorBody.parse(await bom.json()).error.message).toBe(
      "Malformed JSON body",
    );
    expect(
      await env.DB.prepare("SELECT desired_state FROM databases WHERE id=?")
        .bind(created.database.id)
        .first("desired_state"),
    ).toBe("running");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) count FROM idempotency_keys WHERE key IN(?,?)",
      )
        .bind(whitespaceKey, malformedKey)
        .first("count"),
    ).toBe(0);
  });

  it("still requires JSON when the route declares a required body", async () => {
    const f = await fixture();
    const input = streamRequest(
      "/v1/databases",
      f.integrator,
      crypto.randomUUID(),
    );
    const response = await fetchRequest(new Request(input, { method: "POST" }));
    expect(response.status).toBe(400);
    expect(ErrorBody.parse(await response.json()).error.code).toBe(
      "invalid_request",
    );
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) count FROM databases WHERE project_id=?",
      )
        .bind(f.project)
        .first("count"),
    ).toBe(0);
  });

  it("hashes exactly empty bodies as absent while preserving JSON, path and method", async () => {
    const app = new Hono<ApiEnv>();
    app.onError((_error, c) => c.text("invalid", 400));
    app.all("*", async (c) => c.text(await requestHash(c)));
    const path = `/test/${crypto.randomUUID()}`;
    const key = crypto.randomUUID();
    const credential = crypto.randomUUID();
    const origin = `https://${["api", "invalid"].join(".")}`;
    const hash = async (input: Request) => (await app.fetch(input, env)).text();
    const absent = await hash(
      new Request(new URL(path, origin), { method: "DELETE" }),
    );
    expect(await hash(streamRequest(path, credential, key))).toBe(absent);
    const json = (body: string, method = "DELETE", route = path) =>
      new Request(new URL(route, origin), {
        method,
        headers: { "Content-Type": "application/json" },
        body,
      });
    const canonical = await hash(json('{"a":1,"b":[2,null]}'));
    expect(await hash(json('{ "b": [2, null], "a": 1 }'))).toBe(canonical);
    expect(await hash(json('{"a":2,"b":[2,null]}'))).not.toBe(canonical);
    expect(await hash(json('{"a":1,"b":[2,null]}', "POST"))).not.toBe(
      canonical,
    );
    expect(
      await hash(json('{"a":1,"b":[2,null]}', "DELETE", `${path}/other`)),
    ).not.toBe(canonical);
    expect((await app.fetch(json(" "), env)).status).toBe(400);
    expect((await app.fetch(json("{"), env)).status).toBe(400);
  });
});
