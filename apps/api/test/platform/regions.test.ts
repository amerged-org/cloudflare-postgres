// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { Region, randomString } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture, request } from "../domain/fixtures.ts";

const created: string[] = [];
afterEach(async () => {
  for (const id of created.splice(0))
    await env.DB.prepare("DELETE FROM regions WHERE id=?").bind(id).run();
  await cleanupFixtures();
});
function input() {
  const id = "r-" + randomString("abcdefghijklmnopqrstuvwxyz0123456789", 12);
  created.push(id);
  return {
    id,
    provider: "contabo",
    provider_region: "test",
    gateway_url: `https://${["gateway", "invalid"].join(".")}/pg`,
    backup_bucket: "b-" + crypto.randomUUID(),
    backup_endpoint_url: `https://${["archive", "invalid"].join(".")}`,
  };
}
const count = (id: string) =>
  env.DB.prepare("SELECT COUNT(*) n FROM regions WHERE id=?")
    .bind(id)
    .first<number>("n");
it("region creation answers the region, replays it for the same key and holds no secret", async () => {
  const state = await fixture(),
    body = input(),
    idem = crypto.randomUUID();
  const response = await request(
    "/v1/regions",
    state.admin,
    "POST",
    body,
    idem,
  );
  expect(response.status).toBe(201);
  const result = Region.parse(await response.json());
  expect(result.id).toBe(body.id);
  const replay = await request("/v1/regions", state.admin, "POST", body, idem);
  expect(replay.status).toBe(201);
  expect(Region.parse(await replay.json())).toEqual(result);
  const receipt = await env.DB.prepare(
    "SELECT state,resource_id,response_status FROM idempotency_keys WHERE key=?",
  )
    .bind(idem)
    .first();
  expect(receipt).toEqual({
    state: "completed",
    resource_id: body.id,
    response_status: 201,
  });
  const text = await (await request("/v1/regions", state.admin)).text();
  expect(text).not.toContain("agent_key");
  expect(text).not.toContain("route_keyring");
});
it("concurrent matching region creations create one region", async () => {
  const state = await fixture(),
    body = input(),
    idem = crypto.randomUUID();
  const replies = await Promise.all([
    request("/v1/regions", state.admin, "POST", body, idem),
    request("/v1/regions", state.admin, "POST", body, idem),
  ]);
  // One request creates the region; the other replays it.
  expect(replies.map((reply) => reply.status)).toEqual([201, 201]);
  expect(await count(body.id)).toBe(1);
});
it("different creation leases cannot create the same region twice", async () => {
  const state = await fixture(),
    body = input();
  const replies = await Promise.all([
    request("/v1/regions", state.admin, "POST", body, crypto.randomUUID()),
    request("/v1/regions", state.admin, "POST", body, crypto.randomUUID()),
  ]);
  expect(replies.map((reply) => reply.status).sort()).toEqual([201, 409]);
  expect(await count(body.id)).toBe(1);
});
