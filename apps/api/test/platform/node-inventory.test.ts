// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { newNodeId } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture, request } from "../domain/fixtures.ts";

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
};

/** A node assigned to its region's release, with an inventory report of that assignment. */
async function observedFixture() {
  const f = await fixture(),
    release = `inventory-${crypto.randomUUID()}`,
    at = new Date().toISOString(),
    names = [
      "api",
      "edge",
      "node-bootstrap",
      "regional",
      "postgres",
      "barman",
      "cloudflared",
      "cilium",
      "flux-source",
      "flux-kustomize",
      "flux-helm",
      "flux-notification",
      "cert-manager",
      "cloudnative-pg",
      "openebs-lvm",
      "native-controller",
    ],
    role = {
      talos_version: "1.14.1",
      talos_installer: `registry.example/talos@sha256:${"a".repeat(64)}`,
      talos_schematic_sha256: "b".repeat(64),
      talos_extensions: [],
      kubernetes_version: "1.36.5",
      components: names.slice(3),
    },
    spec = {
      version: 1,
      versions_lock_sha256: "c".repeat(64),
      configuration_schema_revision: 1,
      components: names.map((name) => ({
        name,
        kind: name === "api" || name === "edge" ? "worker_bundle" : "image",
        version: "1.0.0",
        reference: `registry.example/${name}@sha256:${"d".repeat(64)}`,
        sha256: "d".repeat(64),
      })),
      roles: { control_relay: role, customer: role },
    },
    uid = (await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
      .bind(f.node)
      .first<string>("node_uid"))!;
  releases.push(release);
  expect(
    (await request(`/v1/fleet/releases/${release}`, f.admin, "PUT", spec))
      .status,
  ).toBe(200);
  expect(
    (
      await request(`/v1/regions/${f.region}/release`, f.admin, "PUT", {
        expected_revision: 0,
        release_id: release,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await request(`/v1/nodes/${f.node}/release`, f.admin, "PUT", {
        expected_revision: 0,
        release_id: release,
        node_uid: uid,
        role: "customer",
      })
    ).status,
  ).toBe(200);
  const facts = {
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
  await env.DB.prepare(
    "INSERT INTO fleet_node_release_observations(node_id,node_uid,assignment_revision,agent_key_hash,facts_json,observed_at,received_at) SELECT n.id,n.node_uid,1,r.agent_key_hash,?,?,? FROM nodes n JOIN regions r ON r.id=n.region_id WHERE n.id=?",
  )
    .bind(JSON.stringify(facts), at, at, f.node)
    .run();
  return { ...f, uid, release, spec, at, facts };
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

it("lists actual observed versions of the current physical node", async () => {
  const f = await observedFixture();
  const response = await request("/v1/nodes?limit=100", f.admin);
  expect(response.status).toBe(200);
  const body = await response.json<{ data: Inventory[] }>(),
    item = body.data.find((value) => value.id === f.node)!;
  expect(item).toMatchObject({
    role: "customer",
    release: { state: "drifted", desired_release_id: f.release },
    observation: {
      state: "current",
      observed_at: f.at,
      talos_version: f.facts.talos_version,
      kubernetes_version: f.facts.kubernetes_version,
      agent_version: f.facts.components[0]!.version,
      agent_image_sha256: f.facts.components[0]!.runtime_image_sha256,
    },
  });
  expect(item.observation.agent_version).not.toBe(
    f.spec.components.find(
      (component) => component.name === "native-controller",
    )!.version,
  );
  expect(JSON.stringify(item).includes(f.agent)).toBe(false);
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

it("does not present a former physical node's observations as current", async () => {
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
