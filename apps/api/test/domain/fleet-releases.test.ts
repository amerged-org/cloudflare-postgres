// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";

const releases: string[] = [];
afterEach(async () => {
  // Existing fixture cleanup removes assigned rows through their node/region FKs.
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
const names = [
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
];
function spec() {
  const role = {
    talos_version: "1.14.1",
    talos_installer: `registry.example/talos@sha256:${"a".repeat(64)}`,
    talos_schematic_sha256: "b".repeat(64),
    talos_extensions: [],
    kubernetes_version: "1.36.5",
    components: names.slice(3),
  };
  return {
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
    roles: { control_relay: role, customer: structuredClone(role) },
  };
}
async function setup() {
  const f = await fixture(),
    id = `release-${crypto.randomUUID()}`,
    uid = crypto.randomUUID(),
    value = spec();
  releases.push(id);
  await env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?")
    .bind(uid, f.node)
    .run();
  const approve = () =>
    request(`/v1/fleet/releases/${id}`, f.admin, "PUT", value);
  const assignRegion = (revision = 0, release = id) =>
    request(`/v1/regions/${f.region}/release`, f.admin, "PUT", {
      expected_revision: revision,
      release_id: release,
    });
  const assignNode = (revision = 0, nodeUid = uid, release = id) =>
    request(`/v1/nodes/${f.node}/release`, f.admin, "PUT", {
      expected_revision: revision,
      release_id: release,
      node_uid: nodeUid,
      role: "customer",
    });
  const inventory = () => ({
    node_id: f.node,
    node_uid: uid,
    assignment_revision: 1,
    observed_at: new Date().toISOString(),
    facts: {
      configuration_schema_revision: 1,
      talos_version: value.roles.customer.talos_version,
      talos_installer: value.roles.customer.talos_installer,
      talos_schematic_sha256: value.roles.customer.talos_schematic_sha256,
      kubernetes_version: value.roles.customer.kubernetes_version,
      components: value.components
        .filter((component) =>
          value.roles.customer.components.includes(component.name),
        )
        .map(({ name, version, sha256 }) => ({ name, version, sha256 })),
    },
  });
  return { ...f, id, uid, value, approve, assignRegion, assignNode, inventory };
}
it("approves immutable release specifications with idempotent replay and rejects unknown refs", async () => {
  const f = await setup(),
    key = crypto.randomUUID();
  const put = () =>
    request(`/v1/fleet/releases/${f.id}`, f.admin, "PUT", f.value, key);
  const first = await put();
  expect(first.status).toBe(200);
  const result = await first.json();
  expect(await (await put()).json()).toEqual(result);
  const changed = structuredClone(f.value);
  changed.configuration_schema_revision = 2;
  expect(
    (await request(`/v1/fleet/releases/${f.id}`, f.admin, "PUT", changed))
      .status,
  ).toBe(409);
  expect((await f.assignRegion(0, "missing")).status).toBe(404);
  expect((await request(`/v1/fleet/releases/${f.id}`, f.admin)).status).toBe(
    200,
  );
  await expect(
    env.DB.prepare("UPDATE fleet_releases SET spec_json='{}' WHERE id=?")
      .bind(f.id)
      .run(),
  ).rejects.toThrow();
});
it("enforces admin scope, physical identity, region selection and revision compare-and-set", async () => {
  const f = await setup();
  expect(
    (await request(`/v1/fleet/releases/${f.id}`, f.integrator, "PUT", f.value))
      .status,
  ).toBe(403);
  expect((await request(`/v1/fleet/releases/${f.id}`, "invalid")).status).toBe(
    401,
  );
  expect((await f.approve()).status).toBe(200);
  expect((await f.assignNode()).status).toBe(409);
  expect((await f.assignRegion()).status).toBe(200);
  expect((await f.assignNode(0, crypto.randomUUID())).status).toBe(409);
  expect((await f.assignNode()).status).toBe(200);
  expect((await f.assignNode(7)).status).toBe(409);
  expect((await f.assignNode(0)).status).toBe(409);
  expect((await f.assignRegion(0)).status).toBe(409);
  const key = crypto.randomUUID(),
    body = {
      expected_revision: 1,
      release_id: f.id,
      node_uid: f.uid,
      role: "customer",
    };
  const put = () =>
    request(`/v1/nodes/${f.node}/release`, f.admin, "PUT", body, key);
  expect((await put()).status).toBe(200);
  expect((await put()).status).toBe(200);
  expect(
    await (await request(`/v1/nodes/${f.node}/release`, f.admin)).json(),
  ).toMatchObject({ revision: 2, state: "pending" });
});
it("elects one competing region revision and records no false observed convergence", async () => {
  const f = await setup();
  await f.approve();
  const responses = await Promise.all([f.assignRegion(0), f.assignRegion(9)]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  await f.assignNode();
  expect(
    await (await request(`/v1/nodes/${f.node}/release`, f.admin)).json(),
  ).toMatchObject({ state: "pending", observed_at: null });
  expect(
    (
      await request("/agent/v1/fleet-observations", f.agent, "POST", {
        node_id: f.node,
        node_uid: f.uid,
        release_id: f.id,
      })
    ).status,
  ).toBe(400);
});
it("compares the complete fresh component inventory and invalidates changed identity or credentials", async () => {
  const f = await setup();
  await f.approve();
  await f.assignRegion();
  await f.assignNode();
  const observation = f.inventory();
  expect(
    (
      await request(
        "/agent/v1/fleet-observations",
        f.foreignAgent,
        "POST",
        observation,
      )
    ).status,
  ).toBe(409);
  const missing = structuredClone(observation);
  missing.facts.components.pop();
  expect(
    (await request("/agent/v1/fleet-observations", f.agent, "POST", missing))
      .status,
  ).toBe(200);
  expect(
    await (await request(`/v1/nodes/${f.node}/release`, f.admin)).json(),
  ).toMatchObject({
    state: "pending",
    mismatches: ["unobserved/components/openebs-lvm"],
  });
  observation.observed_at = new Date(
    Date.parse(missing.observed_at) + 1,
  ).toISOString();
  expect(
    (
      await request(
        "/agent/v1/fleet-observations",
        f.agent,
        "POST",
        observation,
      )
    ).status,
  ).toBe(200);
  expect(
    await (await request(`/v1/nodes/${f.node}/release`, f.admin)).json(),
  ).toMatchObject({ state: "converged", mismatches: [] });
  const conflicting = structuredClone(observation);
  conflicting.facts.components[0]!.sha256 = "e".repeat(64);
  expect(
    (
      await request(
        "/agent/v1/fleet-observations",
        f.agent,
        "POST",
        conflicting,
      )
    ).status,
  ).toBe(409);
  await env.DB.prepare("UPDATE regions SET agent_key_hash=? WHERE id=?")
    .bind("f".repeat(64), f.region)
    .run();
  expect(
    await (await request(`/v1/nodes/${f.node}/release`, f.admin)).json(),
  ).toMatchObject({ state: "pending" });
  expect(
    (
      await request(
        "/agent/v1/fleet-observations",
        f.agent,
        "POST",
        observation,
      )
    ).status,
  ).toBe(401);
  await env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?")
    .bind(crypto.randomUUID(), f.node)
    .run();
  expect(
    await (await request(`/v1/nodes/${f.node}/release`, f.admin)).json(),
  ).toMatchObject({ state: "identity_changed" });
});
it("rejects stale, lost and older inventory without overwriting a current accepted observation", async () => {
  const f = await setup();
  await f.approve();
  await f.assignRegion();
  await f.assignNode();
  const observation = f.inventory();
  expect(
    (
      await request(
        "/agent/v1/fleet-observations",
        f.agent,
        "POST",
        observation,
      )
    ).status,
  ).toBe(200);
  const stale = {
    ...observation,
    observed_at: new Date(Date.now() - 180001).toISOString(),
  };
  expect(
    (await request("/agent/v1/fleet-observations", f.agent, "POST", stale))
      .status,
  ).toBe(409);
  const older = {
    ...observation,
    observed_at: new Date(
      Date.parse(observation.observed_at) - 1,
    ).toISOString(),
  };
  expect(
    (await request("/agent/v1/fleet-observations", f.agent, "POST", older))
      .status,
  ).toBe(409);
  await env.DB.prepare("UPDATE nodes SET lost_at=? WHERE id=?")
    .bind(new Date().toISOString(), f.node)
    .run();
  expect(
    (
      await request(
        "/agent/v1/fleet-observations",
        f.agent,
        "POST",
        observation,
      )
    ).status,
  ).toBe(409);
});
it("allows exactly one conflicting current-revision assignment and scopes its idempotency replay", async () => {
  const f = await setup(),
    other = `release-${crypto.randomUUID()}`;
  releases.push(other);
  await f.approve();
  expect(
    (await request(`/v1/fleet/releases/${other}`, f.admin, "PUT", f.value))
      .status,
  ).toBe(200);
  const responses = await Promise.all([
    f.assignRegion(0),
    f.assignRegion(0, other),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([
    200, 409,
  ]);
  const winner = responses[0]!.status === 200 ? f.id : other;
  expect(
    await (await request(`/v1/regions/${f.region}/release`, f.admin)).json(),
  ).toMatchObject({ revision: 1, desired_release_id: winner });
  const key = crypto.randomUUID();
  expect(
    (
      await request(
        `/v1/regions/${f.region}/release`,
        f.admin,
        "PUT",
        { expected_revision: 1, release_id: winner },
        key,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request(
        `/v1/regions/${f.region}/release`,
        f.admin,
        "PUT",
        { expected_revision: 1, release_id: winner === f.id ? other : f.id },
        key,
      )
    ).status,
  ).toBe(409);
  expect(
    (await request(`/v1/regions/${f.region}/release`, f.integrator)).status,
  ).toBe(403);
});
it("distributes only explicitly selected current node assignments and preserves the unassigned legacy response", async () => {
  const f = await setup();
  const legacy = (await (
    await request("/agent/v1/desired", f.agent)
  ).json()) as Record<string, unknown>;
  expect(legacy).not.toHaveProperty("fleet_release");
  await f.approve();
  await f.assignRegion();
  expect(
    await (await request("/agent/v1/desired", f.agent)).json(),
  ).toMatchObject({
    fleet_release: {
      region_id: f.region,
      region_revision: 1,
      release: { id: f.id },
      nodes: [],
    },
  });
  await f.assignNode();
  expect(
    await (await request("/agent/v1/desired", f.agent)).json(),
  ).toMatchObject({
    fleet_release: {
      nodes: [
        {
          node_id: f.node,
          node_uid: f.uid,
          revision: 1,
          role: "customer",
          k8s_node_name: f.nodeName,
        },
      ],
    },
  });
  await env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?")
    .bind(crypto.randomUUID(), f.node)
    .run();
  expect(
    await (await request("/agent/v1/desired", f.agent)).json(),
  ).toMatchObject({ fleet_release: { nodes: [] } });
});
it("stores partial authenticated runtime inventory as pending and exposes actual facts without claiming absent Talos provenance", async () => {
  const f = await setup();
  await f.approve();
  await f.assignRegion();
  await f.assignNode();
  const observation = {
    node_id: f.node,
    node_uid: f.uid,
    assignment_revision: 1,
    observed_at: new Date().toISOString(),
    facts: {
      kubernetes_version: "1.36.5",
      components: [{ name: "regional", runtime_image_sha256: "f".repeat(64) }],
    },
  };
  expect(
    (
      await request(
        "/agent/v1/fleet-observations",
        f.agent,
        "POST",
        observation,
      )
    ).status,
  ).toBe(200);
  const status = (await (
    await request(`/v1/nodes/${f.node}/release`, f.admin)
  ).json()) as { state: string; observed_facts: unknown; mismatches: string[] };
  expect(status.state).toBe("pending");
  expect(status.observed_facts).toEqual(observation.facts);
  expect(status.mismatches).toContain("unobserved/talos_installer");
  expect(status.mismatches).toContain("unobserved/components/regional");
});
