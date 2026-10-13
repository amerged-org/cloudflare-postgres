// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { newNodeId, newOperationId } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture, request } from "../domain/fixtures.ts";
import { thinExecutionFixture } from "../domain/thin-execution-fixture.ts";

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
  role: string | null;
  release: { state: string; desired_release_id: string | null };
  observation: {
    state: string;
    observed_at: string | null;
    talos_version: string | null;
    kubernetes_version: string | null;
    agent_version: string | null;
    agent_image_sha256: string | null;
  };
  latest_patch: {
    operation_id: string;
    node_uid: string;
    stage: string;
  } | null;
};

async function observedFixture() {
  const f = await thinExecutionFixture(releases),
    at = new Date().toISOString(),
    facts = {
      configuration_schema_revision: 1,
      talos_version: "1.14.2",
      kubernetes_version: "1.36.5",
      kubelet_version: "1.36.5",
      components: [
        {
          name: "native-controller",
          version: "observed-controller-build",
          sha256: "e".repeat(64),
          runtime_image_sha256: "e".repeat(64),
        },
      ],
    };
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE fleet_node_release_observations SET facts_json=?,observed_at=? WHERE node_id=?",
    ).bind(JSON.stringify(facts), at, f.node),
    // Public patch projection accepts unknown runtime facts; this is an inventory fixture.
    env.DB.prepare(
      "UPDATE fleet_patch_operations SET observed_json=NULL WHERE node_id=?",
    ).bind(f.node),
  ]);
  return { ...f, at, facts };
}

async function node(id: string, key: string): Promise<Inventory> {
  const response = await request(`/v1/nodes/${id}`, key);
  expect(response.status).toBe(200);
  return response.json<Inventory>();
}

it("provides admin individual node and region reads with explicit unobserved inventory", async () => {
  const f = await fixture();
  expect(await node(f.node, f.admin)).toMatchObject({
    id: f.node,
    role: null,
    release: { state: "unassigned", desired_release_id: null },
    observation: {
      state: "unobserved",
      observed_at: null,
      talos_version: null,
      kubernetes_version: null,
      agent_version: null,
      agent_image_sha256: null,
    },
    latest_patch: null,
  });
  const region = await request(`/v1/regions/${f.region}`, f.admin);
  expect(region.status).toBe(200);
  const body = await region.json<Record<string, unknown>>();
  expect(body.id).toBe(f.region);
  expect(body).not.toHaveProperty("agent_key_hash");
  expect(JSON.stringify(body).includes(f.agent)).toBe(false);
  expect((await request(`/v1/nodes/${f.node}`, f.integrator)).status).toBe(403);
  expect((await request(`/v1/regions/${f.region}`, f.integrator)).status).toBe(
    403,
  );
  expect((await request(`/v1/nodes/${newNodeId()}`, f.admin)).status).toBe(404);
  expect((await request("/v1/regions/region-not-found", f.admin)).status).toBe(
    404,
  );
});

it("lists actual observed versions and the current physical node's latest patch", async () => {
  const f = await observedFixture(),
    expectedPatch = newOperationId(),
    oldPhysicalPatch = newOperationId(),
    now = Date.now();
  const clone = (id: string, uid: string, at: number) =>
    env.DB.prepare(
      "INSERT INTO fleet_patch_operations(operation_id,node_id,region_id,node_uid,cluster_uid,release_id,spec_sha256,assignment_revision,region_revision,material_revision,address,cluster_nodes_json,revision,stage,state,created_at,updated_at,deadline_at) SELECT ?,node_id,region_id,?,cluster_uid,release_id,spec_sha256,assignment_revision,region_revision,material_revision,address,cluster_nodes_json,revision,stage,state,?,?,deadline_at FROM fleet_patch_operations WHERE node_id=? ORDER BY created_at DESC LIMIT 1",
    ).bind(
      id,
      uid,
      new Date(at).toISOString(),
      new Date(at).toISOString(),
      f.node,
    );
  await env.DB.batch([
    clone(expectedPatch, f.uid, now + 1),
    clone(oldPhysicalPatch, crypto.randomUUID(), now + 2),
  ]);
  const response = await request("/v1/nodes?limit=100", f.admin);
  expect(response.status).toBe(200);
  const body = await response.json<{ data: Inventory[] }>(),
    item = body.data.find((value) => value.id === f.node)!;
  expect(item).toMatchObject({
    role: "customer",
    release: { state: "drifted", desired_release_id: f.qualified.releaseId },
    observation: {
      state: "current",
      observed_at: f.at,
      talos_version: f.facts.talos_version,
      kubernetes_version: f.facts.kubernetes_version,
      agent_version: f.facts.components[0]!.version,
      agent_image_sha256: f.facts.components[0]!.runtime_image_sha256,
    },
    latest_patch: {
      operation_id: expectedPatch,
      node_uid: f.uid,
      stage: "complete",
    },
  });
  expect(item.observation.agent_version).not.toBe(
    f.qualified.spec.components.find(
      (component) => component.name === "native-controller",
    )!.version,
  );
  expect(JSON.stringify(item).includes(f.agent)).toBe(false);
  expect(item.latest_patch).not.toHaveProperty("address");
  expect(await node(f.node, f.admin)).toEqual(item);
});

it("labels old matching observations stale without inventing a current agent version", async () => {
  const f = await observedFixture(),
    at = new Date(Date.now() - 181_000).toISOString();
  await env.DB.prepare(
    "UPDATE fleet_node_release_observations SET observed_at=? WHERE node_id=?",
  )
    .bind(at, f.node)
    .run();
  const item = await node(f.node, f.admin);
  expect(item.release.state).toBe("stale");
  expect(item.observation).toMatchObject({
    state: "stale",
    observed_at: at,
    agent_version: f.facts.components[0]!.version,
  });
});

it("leaves the agent version unknown without an observed runtime image digest", async () => {
  const f = await observedFixture();
  await env.DB.prepare(
    "UPDATE fleet_node_release_observations SET facts_json=json_remove(facts_json,'$.components[0].runtime_image_sha256') WHERE node_id=?",
  )
    .bind(f.node)
    .run();
  expect(await node(f.node, f.admin)).toMatchObject({
    observation: {
      state: "current",
      agent_version: null,
      agent_image_sha256: null,
    },
  });
});

it("does not present a former physical node's observations or patch as current", async () => {
  const f = await observedFixture(),
    changedUid = crypto.randomUUID();
  await env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?")
    .bind(changedUid, f.node)
    .run();
  const item = await node(f.node, f.admin);
  expect(item).toMatchObject({
    node_uid: changedUid,
    role: null,
    release: { state: "identity_changed" },
    observation: {
      state: "unobserved",
      observed_at: null,
      talos_version: null,
      agent_version: null,
      agent_image_sha256: null,
    },
    latest_patch: null,
  });
});

it("fences observations from an older assignment revision", async () => {
  const f = await observedFixture();
  await env.DB.prepare(
    "UPDATE fleet_node_release_observations SET assignment_revision=assignment_revision+1 WHERE node_id=?",
  )
    .bind(f.node)
    .run();
  expect(await node(f.node, f.admin)).toMatchObject({
    release: { state: "pending" },
    observation: { state: "unobserved", agent_version: null },
  });
});

it("fences observations signed by a retired regional agent", async () => {
  const f = await observedFixture();
  await env.DB.prepare(
    "UPDATE fleet_node_release_observations SET agent_key_hash=? WHERE node_id=?",
  )
    .bind("f".repeat(64), f.node)
    .run();
  expect(await node(f.node, f.admin)).toMatchObject({
    release: { state: "pending" },
    observation: { state: "unobserved", agent_version: null },
  });
});

it("keeps the enriched node list bounded and cursor ordered", async () => {
  const f = await fixture(),
    sibling = newNodeId();
  await env.DB.prepare(
    "INSERT INTO nodes(id,region_id,k8s_node_name,ready,allocatable_memory_mib,allocatable_cpu_millicores,platform_reserved_memory_mib,created_at,updated_at,node_uid) VALUES(?,?,?,1,8192,4000,128,?,?,?)",
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
