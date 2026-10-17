// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { RegionCreated, hashApiKey, randomString } from "@pgcf/contracts";
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
const agentKeyHash = (id: string) =>
  env.DB.prepare("SELECT agent_key_hash FROM regions WHERE id=?")
    .bind(id)
    .first<string>("agent_key_hash");
it("region creation stores only the agent key's hash with a safe receipt and never replays the key", async () => {
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
  const result = RegionCreated.parse(await response.json());
  expect(await agentKeyHash(body.id)).toBe(
    await hashApiKey(env.API_KEY_PEPPER, result.agent_key),
  );
  const replay = await request("/v1/regions", state.admin, "POST", body, idem);
  expect(replay.status).toBe(409);
  expect((await replay.text()).includes(result.agent_key)).toBe(false);
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
});
it("concurrent matching region creations keep one agent key and replay none", async () => {
  const state = await fixture(),
    body = input(),
    idem = crypto.randomUUID();
  const replies = await Promise.all([
    request("/v1/regions", state.admin, "POST", body, idem),
    request("/v1/regions", state.admin, "POST", body, idem),
  ]);
  expect(replies.map((reply) => reply.status).sort()).toEqual([201, 409]);
  const winner = RegionCreated.parse(
    await replies.find((reply) => reply.status === 201)!.json(),
  );
  expect(await agentKeyHash(body.id)).toBe(
    await hashApiKey(env.API_KEY_PEPPER, winner.agent_key),
  );
});
it("different creation leases cannot replace the same region's agent key", async () => {
  const state = await fixture(),
    body = input();
  const replies = await Promise.all([
    request("/v1/regions", state.admin, "POST", body, crypto.randomUUID()),
    request("/v1/regions", state.admin, "POST", body, crypto.randomUUID()),
  ]);
  expect(replies.map((reply) => reply.status).sort()).toEqual([201, 409]);
  const winner = RegionCreated.parse(
    await replies.find((reply) => reply.status === 201)!.json(),
  );
  expect(await agentKeyHash(body.id)).toBe(
    await hashApiKey(env.API_KEY_PEPPER, winner.agent_key),
  );
  const text = await (await request("/v1/regions", state.admin)).text();
  expect(text.includes(winner.agent_key)).toBe(false);
  expect(text.includes("agent_key_hash")).toBe(false);
  expect(text.includes("bootstrap")).toBe(false);
});
