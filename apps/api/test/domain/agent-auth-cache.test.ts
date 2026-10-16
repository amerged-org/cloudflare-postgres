// SPDX-License-Identifier: Apache-2.0
// What authenticating an agent request costs D1, and how soon a rotated agent key takes effect.
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { hashApiKey, newAgentKey } from "@pgcf/contracts";
import { countStatements } from "./d1-statements.ts";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";

afterEach(async () => {
  vi.useRealTimers();
  await cleanupFixtures();
});

/** The cheapest agent route that authenticates and then finds nothing to lease. */
const poll = (f: { node: string }, key: string) =>
  request(`/agent/v1/nodes/${f.node}/compute-pool`, key);
const regionReads = (sql: string[]) =>
  sql.filter((text) => /FROM regions WHERE id=\?/.test(text)).length;
/** The bound the design allows: a rotation is visible in every isolate within this. */
const ROTATION_BOUND_MS = 10_000;

it("authenticates a region's agent requests from one read of its row", async () => {
  const f = await fixture();
  const counted = await countStatements(async () => {
    for (let i = 0; i < 5; i++)
      expect((await poll(f, f.agent)).status).toBe(404);
  });
  expect(regionReads(counted.sql)).toBe(1);
});

it("refuses a rotated key once the cache bound has passed", async () => {
  const f = await fixture();
  expect((await poll(f, f.agent)).status).toBe(404);
  const replacement = newAgentKey(f.region);
  await env.DB.prepare("UPDATE regions SET agent_key_hash=? WHERE id=?")
    .bind(await hashApiKey(env.API_KEY_PEPPER, replacement), f.region)
    .run();
  // Another isolate that read the row before the rotation: its entry ends within the bound.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + ROTATION_BOUND_MS);
  expect((await poll(f, f.agent)).status).toBe(401);
  expect((await poll(f, replacement)).status).toBe(404);
});

it("accepts a replacement key on its first request, and then no longer the old one", async () => {
  const f = await fixture();
  expect((await poll(f, f.agent)).status).toBe(404);
  const replacement = newAgentKey(f.region);
  await env.DB.prepare("UPDATE regions SET agent_key_hash=? WHERE id=?")
    .bind(await hashApiKey(env.API_KEY_PEPPER, replacement), f.region)
    .run();
  // A key the cached row does not know is checked against D1, not refused from the cache.
  expect((await poll(f, replacement)).status).toBe(404);
  expect((await poll(f, f.agent)).status).toBe(401);
});

it("refuses an unknown region and a wrong key without displacing the region's own entry", async () => {
  const f = await fixture();
  expect((await poll(f, f.agent)).status).toBe(404);
  expect((await poll(f, newAgentKey("eu-unknown1"))).status).toBe(401);
  expect((await poll(f, newAgentKey(f.region))).status).toBe(401);
  const counted = await countStatements(() => poll(f, f.agent));
  expect(counted.result.status).toBe(404);
  expect(regionReads(counted.sql)).toBe(0);
});
