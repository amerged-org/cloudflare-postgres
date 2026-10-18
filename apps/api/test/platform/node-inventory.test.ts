// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { newNodeId } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import {
  assignRelease,
  cleanupFixtures,
  fixture,
  request,
} from "../domain/fixtures.ts";

const releases: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});

type Inventory = {
  id: string;
  node_uid: string | null;
  release: {
    state: string;
    desired_release_id: string | null;
    observed_release_id: string | null;
  };
  observation: {
    state: string;
    observed_at: string | null;
    agent_version: string | null;
  };
};

async function node(id: string, key: string): Promise<Inventory> {
  const response = await request(`/v1/nodes/${id}`, key);
  expect(response.status).toBe(200);
  return response.json<Inventory>();
}
/** What the node's hello and its newest link message left in D1. */
const heard = (
  id: string,
  update: { at?: string | null; release?: string | null; agent?: string },
) =>
  env.DB.prepare(
    "UPDATE nodes SET last_observed_at=?,reported_release_id=?,agent_version=? WHERE id=?",
  )
    .bind(update.at ?? null, update.release ?? null, update.agent ?? null, id)
    .run();

it("provides admin individual node and region reads with explicit unobserved inventory", async () => {
  const f = await fixture();
  await heard(f.node, {});
  expect(await node(f.node, f.admin)).toMatchObject({
    id: f.node,
    release: {
      state: "unassigned",
      desired_release_id: null,
      observed_release_id: null,
    },
    observation: {
      state: "unobserved",
      observed_at: null,
      agent_version: null,
    },
  });
  const region = await request(`/v1/regions/${f.region}`, f.admin);
  expect(region.status).toBe(200);
  const body = await region.json<Record<string, unknown>>();
  expect(body.id).toBe(f.region);
  expect(body).not.toHaveProperty("agent_key_hash");
  expect((await request(`/v1/nodes/${f.node}`, f.integrator)).status).toBe(403);
  expect((await request(`/v1/regions/${f.region}`, f.integrator)).status).toBe(
    403,
  );
  expect((await request(`/v1/nodes/${newNodeId()}`, f.admin)).status).toBe(404);
  expect((await request("/v1/regions/region-not-found", f.admin)).status).toBe(
    404,
  );
});

it("lists what the node's link reported against the release of its region", async () => {
  const f = await fixture(),
    release = await assignRelease(f);
  releases.push(release);
  const at = new Date().toISOString();
  await heard(f.node, { at, release: "release-old", agent: "0.1.0" });
  const response = await request("/v1/nodes?limit=100", f.admin);
  expect(response.status).toBe(200);
  const listed = (await response.json<{ data: Inventory[] }>()).data.find(
    (value) => value.id === f.node,
  )!;
  expect(listed).toMatchObject({
    release: {
      state: "pending",
      desired_release_id: release,
      observed_release_id: "release-old",
    },
    observation: { state: "current", observed_at: at, agent_version: "0.1.0" },
  });
  expect(await node(f.node, f.admin)).toEqual(listed);
  await heard(f.node, { at, release, agent: "0.1.0" });
  expect((await node(f.node, f.admin)).release.state).toBe("converged");
});

it("labels a silent node stale and a lost node fenced", async () => {
  const f = await fixture(),
    release = await assignRelease(f);
  releases.push(release);
  const silent = new Date(Date.now() - 181_000).toISOString();
  await heard(f.node, { at: silent, release, agent: "0.1.0" });
  expect(await node(f.node, f.admin)).toMatchObject({
    release: { state: "stale" },
    observation: {
      state: "stale",
      observed_at: silent,
      agent_version: "0.1.0",
    },
  });
  await env.DB.prepare(
    "UPDATE nodes SET lost_at=?,lost_reason='test' WHERE id=?",
  )
    .bind(new Date().toISOString(), f.node)
    .run();
  expect((await node(f.node, f.admin)).release.state).toBe("fenced");
});

it("keeps the enriched node list bounded and cursor ordered", async () => {
  const f = await fixture(),
    sibling = newNodeId();
  await heard(f.node, {});
  await env.DB.prepare(
    "INSERT INTO nodes(id,region_id,hostname,ready,allocatable_memory_mib,allocatable_cpu_millicores,platform_reserved_memory_mib,created_at,updated_at,node_uid) VALUES(?,?,?,1,8192,4000,128,?,?,?)",
  )
    .bind(
      sibling,
      f.region,
      "sibling",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      crypto.randomUUID(),
    )
    .run();
  const first = await request("/v1/nodes?limit=1", f.admin);
  expect(first.status).toBe(200);
  const pageOne = await first.json<{
    data: Inventory[];
    next_cursor: string | null;
  }>();
  expect(pageOne.data).toHaveLength(1);
  expect(pageOne.data[0]!.id).toBe(f.node);
  expect(pageOne.data[0]!.observation.state).toBe("unobserved");
  expect(pageOne.next_cursor).not.toBeNull();
  const second = await request(
    `/v1/nodes?limit=1&cursor=${encodeURIComponent(pageOne.next_cursor!)}`,
    f.admin,
  );
  expect(second.status).toBe(200);
  const pageTwo = await second.json<{
    data: Inventory[];
    next_cursor: string | null;
  }>();
  expect(pageTwo.data[0]!.id).toBe(sibling);
  expect(pageTwo.next_cursor).toBeNull();
});
