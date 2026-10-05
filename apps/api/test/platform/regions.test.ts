// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { RegionCreated, randomString, newAgentKey } from "@pgcf/contracts";
import { createApp } from "../../src/app.ts";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture, request } from "../domain/fixtures.ts";
import {
  agentKeyReference,
  loadRegionAgentKey,
} from "../../src/crypto/bootstrap-credentials.ts";

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
    gateway_url: `https://${["gateway", "invalid"].join(".")}`,
    backup_bucket: "b-" + crypto.randomUUID(),
    backup_endpoint_url: `https://${["archive", "invalid"].join(".")}`,
  };
}
it("region creation commits encrypted agent custody and a safe receipt together without replaying credentials", async () => {
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
  const custody = await env.DB.prepare(
    "SELECT region_id,purpose,revision,version,kid,iv,ciphertext FROM region_bootstrap_credentials WHERE region_id=?",
  )
    .bind(body.id)
    .first();
  expect(custody).not.toBeNull();
  expect(custody).toMatchObject({
    region_id: body.id,
    purpose: "agent_key",
    revision: 1,
    version: 1,
  });
  expect(JSON.stringify(custody).includes(result.agent_key)).toBe(false);
  expect(
    await loadRegionAgentKey(env.DB, env, agentKeyReference(body.id)),
  ).toBe(result.agent_key);
  const replay = await request("/v1/regions", state.admin, "POST", body, idem);
  expect(replay.status).toBe(409);
  expect((await replay.text()).includes(result.agent_key)).toBe(false);
  expect(
    await env.DB.prepare(
      "SELECT region_id,purpose,revision,version,kid,iv,ciphertext FROM region_bootstrap_credentials WHERE region_id=?",
    )
      .bind(body.id)
      .first(),
  ).toEqual(custody);
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

it("concurrent matching region creations produce one immutable custody row and no credential replay", async () => {
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
  expect(
    await loadRegionAgentKey(env.DB, env, agentKeyReference(body.id)),
  ).toBe(winner.agent_key);
  expect(
    await env.DB.prepare(
      "SELECT count(*) count FROM region_bootstrap_credentials WHERE region_id=?",
    )
      .bind(body.id)
      .first("count"),
  ).toBe(1);
});
it("different creation leases cannot replace the same region's encrypted agent key", async () => {
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
  expect(
    await loadRegionAgentKey(env.DB, env, agentKeyReference(body.id)),
  ).toBe(winner.agent_key);
  const listing = await request("/v1/regions", state.admin);
  const text = await listing.text();
  const ciphertext = await env.DB.prepare(
    "SELECT ciphertext FROM region_bootstrap_credentials WHERE region_id=?",
  )
    .bind(body.id)
    .first<string>("ciphertext");
  expect(text.includes(winner.agent_key)).toBe(false);
  expect(text.includes(ciphertext!)).toBe(false);
  expect(text.includes("agent_key_hash")).toBe(false);
  expect(text.includes("bootstrap")).toBe(false);
});
it("a failed encrypted custody insertion rolls back the region hash and successful receipt atomically", async () => {
  const state = await fixture(),
    body = input(),
    idem = crypto.randomUUID(),
    trigger = "custody_fail_" + crypto.randomUUID().replaceAll("-", "");
  await env.DB.exec(
    `CREATE TRIGGER ${trigger} BEFORE INSERT ON region_bootstrap_credentials WHEN NEW.region_id='${body.id}' BEGIN SELECT RAISE(ABORT,'fixture_custody_failure'); END`,
  );
  try {
    const response = await request(
      "/v1/regions",
      state.admin,
      "POST",
      body,
      idem,
    );
    expect(response.status).toBe(500);
    expect(
      await env.DB.prepare("SELECT count(*) count FROM regions WHERE id=?")
        .bind(body.id)
        .first("count"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT count(*) count FROM region_bootstrap_credentials WHERE region_id=?",
      )
        .bind(body.id)
        .first("count"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT count(*) count FROM idempotency_keys WHERE key=?",
      )
        .bind(idem)
        .first("count"),
    ).toBe(0);
    expect((await response.text()).includes("fixture_custody_failure")).toBe(
      false,
    );
  } finally {
    await env.DB.exec(`DROP TRIGGER ${trigger}`);
  }
  expect(
    (await request("/v1/regions", state.admin, "POST", body, idem)).status,
  ).toBe(201);
});

it("encryption failure occurs before region and custody commits and never echoes protected configuration", async () => {
  const state = await fixture(),
    body = input(),
    idem = crypto.randomUUID(),
    canary = newAgentKey(body.id);
  const response = await createApp().fetch(
    new Request(
      new URL("/v1/regions", `https://${["api", "invalid"].join(".")}`),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${state.admin}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idem,
        },
        body: JSON.stringify(body),
      },
    ),
    { ...env, CREDENTIAL_KEYS: canary },
  );
  expect(response.status).toBe(500);
  expect((await response.text()).includes(canary)).toBe(false);
  expect(
    await env.DB.prepare("SELECT count(*) count FROM regions WHERE id=?")
      .bind(body.id)
      .first("count"),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT count(*) count FROM region_bootstrap_credentials WHERE region_id=?",
    )
      .bind(body.id)
      .first("count"),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT count(*) count FROM idempotency_keys WHERE key=?",
    )
      .bind(idem)
      .first("count"),
  ).toBe(0);
});
