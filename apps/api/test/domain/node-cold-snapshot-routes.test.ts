// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it } from "vitest";
import { NODE_JSON_BODY_MAX_BYTES } from "../../src/app.ts";
import { cleanupFixtures, fixture, nodeToken, rawRequest } from "./fixtures.ts";

afterEach(cleanupFixtures);
const chunkPath = "/node/v1/cold-snapshots/op_abcdefghijklmnopqrst/chunks/0";

it("authenticates exact non-UTF8 chunk bytes before checking snapshot ownership", async () => {
  const f = await fixture();
  const bytes = new Uint8Array([0, 0xff, 0xfe, 0xc0, 0, 1, 2]);
  const authorization = `Bearer ${await nodeToken(f, chunkPath, "PUT", bytes)}`;
  const send = (body: Uint8Array) =>
    rawRequest(chunkPath, {
      method: "PUT",
      headers: { authorization, "Content-Type": "application/octet-stream" },
      body: body.slice().buffer,
    });
  // The operation does not exist: valid binary authentication reaches the scoped domain lookup.
  expect((await send(bytes)).status).toBe(404);
  const changed = bytes.slice();
  changed[0] = 42;
  expect((await send(changed)).status).toBe(401);
});

it("keeps JSON endpoints strict and preserves the bytes signed for a seal request", async () => {
  const f = await fixture();
  const bytes = new TextEncoder().encode("{}");
  expect(
    (
      await rawRequest("/node/v1/usage", {
        method: "POST",
        headers: {
          authorization: `Bearer ${await nodeToken(f, "/node/v1/usage", "POST", bytes)}`,
          "Content-Type": "application/octet-stream",
        },
        body: bytes,
      })
    ).status,
  ).toBe(400);
  const path = "/node/v1/cold-snapshots/op_abcdefghijklmnopqrst/seal";
  const body = new TextEncoder().encode(
    ` {  "manifest_sha256" : "${"a".repeat(64)}" }\n`,
  );
  expect(
    (
      await rawRequest(path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await nodeToken(f, path, "POST", body)}`,
          "Content-Type": "application/json",
        },
        body,
      })
    ).status,
  ).toBe(404);
});

it("bounds binary requests and requires node authentication before accepting a larger body", async () => {
  const f = await fixture();
  const body = new Uint8Array(NODE_JSON_BODY_MAX_BYTES + 1);
  const headers = {
    authorization: `Bearer ${await nodeToken(f, chunkPath, "PUT", body)}`,
    "Content-Type": "application/octet-stream",
  };
  expect(
    (await rawRequest(chunkPath, { method: "PUT", headers, body })).status,
  ).toBe(400);
  expect(
    (
      await rawRequest(chunkPath, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array([0xff]),
      })
    ).status,
  ).toBe(401);
});
