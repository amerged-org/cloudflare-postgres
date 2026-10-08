// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture, request } from "../domain/fixtures.ts";

const createdRegions: string[] = [];
afterEach(async () => {
  for (const id of createdRegions.splice(0))
    await env.DB.prepare("DELETE FROM regions WHERE id=?").bind(id).run();
  await cleanupFixtures();
});
const path = (region: string) => `/v1/regions/${region}/configuration`;
const gateway = (name = "gateway") =>
  `https://${[name, "invalid"].join(".")}/pg`;
interface Configuration {
  region: { gateway_url: string; gateway_binding: string | null };
  configuration_sha256: string;
}
async function configuration(region: string, key: string) {
  const response = await request(path(region), key);
  expect(response.status).toBe(200);
  return (await response.json()) as Configuration;
}
async function row(region: string) {
  return env.DB.prepare("SELECT * FROM regions WHERE id=?")
    .bind(region)
    .first<Record<string, unknown>>();
}
const update = (before: Configuration, name = "next") => ({
  expected_configuration_sha256: before.configuration_sha256,
  gateway_url: gateway(name),
  gateway_binding: null,
});

it("refuses region creation when the gateway endpoint is missing /pg", async () => {
  const state = await fixture();
  const id = `r-${crypto.randomUUID().slice(0, 8)}`;
  const response = await request("/v1/regions", state.admin, "POST", {
    id,
    provider: "contabo",
    provider_region: "test",
    gateway_url: gateway().replace(/\/pg$/, ""),
    backup_bucket: "test-archive",
    backup_endpoint_url: `https://${["archive", "invalid"].join(".")}`,
  });
  try {
    expect(response.status).toBe(400);
    expect(await row(id)).toBeNull();
  } finally {
    await env.DB.prepare("DELETE FROM regions WHERE id=?").bind(id).run();
  }
});

it("repairs legacy routing through the admin API while preserving unrelated configuration and custody", async () => {
  const state = await fixture();
  const region = `r-${crypto.randomUUID().slice(0, 8)}`;
  createdRegions.push(region);
  expect(
    (
      await request("/v1/regions", state.admin, "POST", {
        id: region,
        provider: "contabo",
        provider_region: "test",
        gateway_url: gateway(),
        backup_bucket: "test-archive",
        backup_endpoint_url: `https://${["archive", "invalid"].join(".")}`,
      })
    ).status,
  ).toBe(201);
  // A previously stored malformed URL must remain readable and repairable.
  await env.DB.prepare("UPDATE regions SET gateway_url=? WHERE id=?")
    .bind(gateway().replace(/\/pg$/, ""), region)
    .run();
  const before = await configuration(region, state.admin);
  expect(before.region.gateway_url.endsWith("/pg")).toBe(false);
  const original = await row(region);
  const foreign = await row(state.foreign);
  const custody = await env.DB.prepare(
    "SELECT * FROM region_bootstrap_credentials WHERE region_id=?",
  )
    .bind(region)
    .all();
  expect(custody.results).toHaveLength(1);
  const idem = crypto.randomUUID();
  const result = await request(
    path(region),
    state.admin,
    "PUT",
    update(before),
    idem,
  );
  expect(result.status).toBe(200);
  const after = (await result.json()) as Configuration;
  expect(after.region.gateway_url).toBe(gateway("next"));
  expect(after.configuration_sha256).not.toBe(before.configuration_sha256);
  const stored = await row(region);
  expect(stored).toEqual({
    ...original,
    gateway_url: gateway("next"),
    gateway_binding: null,
    updated_at: stored!.updated_at,
  });
  expect(stored!.updated_at).not.toBe(original!.updated_at);
  expect(await row(state.foreign)).toEqual(foreign);
  expect(
    (
      await env.DB.prepare(
        "SELECT * FROM region_bootstrap_credentials WHERE region_id=?",
      )
        .bind(region)
        .all()
    ).results,
  ).toEqual(custody.results);
  const receipt = await env.DB.prepare(
    "SELECT state,resource_id,response_status FROM idempotency_keys WHERE key=?",
  )
    .bind(idem)
    .first();
  expect(receipt).toEqual({
    state: "completed",
    resource_id: region,
    response_status: 200,
  });
  expect(JSON.stringify(after)).not.toContain("agent_key_hash");
  expect(JSON.stringify(after)).not.toContain("ciphertext");
});

it("rejects stale and concurrently competing configuration digests without completing the losing lease", async () => {
  const state = await fixture();
  const before = await configuration(state.region, state.admin);
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  const responses = await Promise.all(
    ids.map((id, i) =>
      request(
        path(state.region),
        state.admin,
        "PUT",
        update(before, `next-${i}`),
        id,
      ),
    ),
  );
  expect(responses.map((response) => response.status).sort()).toEqual([
    200, 409,
  ]);
  const losingKey =
    ids[responses.findIndex((response) => response.status === 409)]!;
  expect(
    await env.DB.prepare("SELECT state FROM idempotency_keys WHERE key=?")
      .bind(losingKey)
      .first(),
  ).toBeNull();
  const unchanged = await row(state.region);
  expect(
    (
      await request(
        path(state.region),
        state.admin,
        "PUT",
        update(before),
        losingKey,
      )
    ).status,
  ).toBe(409);
  expect(await row(state.region)).toEqual(unchanged);
});

it("idempotency replay cannot restore an old gateway after a later configuration update", async () => {
  const state = await fixture();
  const first = await configuration(state.region, state.admin);
  const idem = crypto.randomUUID();
  const body = update(first, "first");
  expect(
    (await request(path(state.region), state.admin, "PUT", body, idem)).status,
  ).toBe(200);
  const second = await configuration(state.region, state.admin);
  expect(
    (
      await request(
        path(state.region),
        state.admin,
        "PUT",
        update(second, "second"),
      )
    ).status,
  ).toBe(200);
  const beforeReplay = await row(state.region);
  const replay = await request(
    path(state.region),
    state.admin,
    "PUT",
    body,
    idem,
  );
  expect(replay.status).toBe(200);
  expect(((await replay.json()) as Configuration).region.gateway_url).toBe(
    gateway("second"),
  );
  expect(await row(state.region)).toEqual(beforeReplay);
  expect(
    (
      await request(
        path(state.region),
        state.admin,
        "PUT",
        { ...body, gateway_url: gateway("third") },
        idem,
      )
    ).status,
  ).toBe(409);
  expect(await row(state.region)).toEqual(beforeReplay);
});

it("requires administrator scope for reads and writes and prevents protected-field updates", async () => {
  const state = await fixture();
  const before = await configuration(state.region, state.admin);
  const original = await row(state.region);
  expect((await request(path(state.region), "invalid")).status).toBe(401);
  expect((await request(path(state.region), state.integrator)).status).toBe(
    403,
  );
  expect(
    (await request(path(state.region), state.integrator, "PUT", update(before)))
      .status,
  ).toBe(403);
  expect(
    (await request(path(state.region), state.agent, "PUT", update(before)))
      .status,
  ).toBe(401);
  expect(
    (
      await request(path(state.region), state.admin, "PUT", {
        ...update(before),
        backup_bucket: "replacement",
      })
    ).status,
  ).toBe(400);
  expect((await request(path("unknown-region"), state.admin)).status).toBe(404);
  expect(await row(state.region)).toEqual(original);
});

it("keeps heartbeat activity outside the configuration CAS and fences bootstrap identity changes", async () => {
  const state = await fixture();
  const before = await configuration(state.region, state.admin);
  const heartbeat = new Date(Date.now() + 1000).toISOString();
  await env.DB.prepare("UPDATE regions SET agent_last_seen_at=? WHERE id=?")
    .bind(heartbeat, state.region)
    .run();
  expect(
    (await configuration(state.region, state.admin)).configuration_sha256,
  ).toBe(before.configuration_sha256);
  expect(
    (await request(path(state.region), state.admin, "PUT", update(before)))
      .status,
  ).toBe(200);
  expect((await row(state.region))!.agent_last_seen_at).toBe(heartbeat);
  const next = await configuration(state.region, state.admin);
  await env.DB.prepare(
    "UPDATE regions SET bootstrap_material_revision=bootstrap_material_revision+1 WHERE id=?",
  )
    .bind(state.region)
    .run();
  const changed = await row(state.region);
  expect(
    (
      await request(
        path(state.region),
        state.admin,
        "PUT",
        update(next, "blocked"),
      )
    ).status,
  ).toBe(409);
  expect(await row(state.region)).toEqual(changed);
});

it("validates the exact upgrade endpoint and permits HTTP only for an explicit service binding", async () => {
  const state = await fixture();
  const before = await configuration(state.region, state.admin);
  for (const gateway_url of [
    "not-a-url",
    gateway().replace(/\/pg$/, ""),
    `${gateway()}/`,
    `${gateway()}?mode=x`,
    `${gateway()}#x`,
    gateway().replace("https://", "https://user:password@"),
    gateway().replace("https://", "http://"),
  ]) {
    expect(
      (
        await request(path(state.region), state.admin, "PUT", {
          ...update(before),
          gateway_url,
        })
      ).status,
    ).toBe(400);
  }
  expect(
    (await configuration(state.region, state.admin)).configuration_sha256,
  ).toBe(before.configuration_sha256);
  expect(
    (
      await request(path(state.region), state.admin, "PUT", {
        ...update(before),
        gateway_url: gateway().replace("https://", "http://"),
        gateway_binding: "REGIONAL_GATEWAY",
      })
    ).status,
  ).toBe(200);
});

it("does not complete an idempotency receipt when the transaction's conditional update changes no row", async () => {
  const state = await fixture();
  const before = await configuration(state.region, state.admin);
  const original = await row(state.region);
  const idem = crypto.randomUUID();
  const trigger = `ignore_region_update_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.exec(
    `CREATE TRIGGER ${trigger} BEFORE UPDATE ON regions WHEN NEW.id='${state.region}' BEGIN SELECT RAISE(IGNORE); END`,
  );
  try {
    expect(
      (
        await request(
          path(state.region),
          state.admin,
          "PUT",
          update(before),
          idem,
        )
      ).status,
    ).toBe(409);
    expect(await row(state.region)).toEqual(original);
    expect(
      await env.DB.prepare("SELECT state FROM idempotency_keys WHERE key=?")
        .bind(idem)
        .first(),
    ).toBeNull();
  } finally {
    await env.DB.exec(`DROP TRIGGER ${trigger}`);
  }
  expect(
    (
      await request(
        path(state.region),
        state.admin,
        "PUT",
        update(before),
        idem,
      )
    ).status,
  ).toBe(200);
});
