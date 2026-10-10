// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import lock from "../../../../infra/platform/versions.lock.json" with { type: "json" };
import { afterEach, expect, it, vi } from "vitest";
import { FleetNodeReleaseObservation } from "@pgcf/contracts/releases";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";

const releases: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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
    talos_extensions: [] as string[],
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

const kubeImagePins = {
  kubelet: `registry.example/kubelet:v1.36.5@sha256:${"1".repeat(64)}`,
  apiServer: `registry.example/kube-apiserver:v1.36.5@sha256:${"2".repeat(64)}`,
  controllerManager: `registry.example/kube-controller-manager:v1.36.5@sha256:${"3".repeat(64)}`,
  scheduler: `registry.example/kube-scheduler:v1.36.5@sha256:${"4".repeat(64)}`,
};
async function receiptFixture(
  kubernetesImages = false,
  extensions = false,
  configure?: (value: ReturnType<typeof spec>) => void,
) {
  const f = await setup();
  if (kubernetesImages)
    for (const role of Object.values(f.value.roles))
      Object.assign(role, { kubernetes_images: kubeImagePins });
  if (extensions) {
    const component = {
      name: "pgcf-sandbox-controller",
      kind: "image",
      version: "0.1.0",
      reference: "registry.example/extension@sha256:" + "d".repeat(64),
      sha256: "d".repeat(64),
    };
    f.value.components.push(component);
    for (const role of Object.values(f.value.roles))
      role.talos_extensions.push(component.name);
  }
  configure?.(f.value);
  await f.approve();
  await f.assignRegion();
  await f.assignNode();
  const boot = crypto.randomUUID();
  const native = FleetNodeReleaseObservation.parse({
    ...f.inventory(),
    observed_at: new Date(Date.now() - 1000).toISOString(),
    facts: {
      ...f.inventory().facts,
      boot_id: boot,
      components: [
        ...f.inventory().facts.components,
        ...f.value.components
          .filter((component) =>
            f.value.roles.customer.talos_extensions.includes(component.name),
          )
          .map(({ name, version, sha256 }) => ({ name, version, sha256 })),
      ],
      talos_provenance: {
        method: "deploymentreceipt",
        installer: f.value.roles.customer.talos_installer,
        node_uid: f.uid,
        cluster_uid: crypto.randomUUID(),
        boot_id: boot,
      },
    },
  });
  const key = await env.DB.prepare(
    "SELECT agent_key_hash FROM regions WHERE id=?",
  )
    .bind(f.region)
    .first<string>("agent_key_hash");
  const seed = async () =>
    env.DB.prepare(
      `INSERT INTO fleet_node_release_observations(node_id,node_uid,assignment_revision,agent_key_hash,facts_json,observed_at,received_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET node_uid=excluded.node_uid,assignment_revision=excluded.assignment_revision,
      agent_key_hash=excluded.agent_key_hash,facts_json=excluded.facts_json,observed_at=excluded.observed_at,received_at=excluded.received_at`,
    )
      .bind(
        f.node,
        f.uid,
        1,
        key,
        JSON.stringify(native.facts),
        native.observed_at,
        native.observed_at,
      )
      .run();
  await seed();
  const partial = () =>
    FleetNodeReleaseObservation.parse({
      node_id: f.node,
      node_uid: f.uid,
      assignment_revision: 1,
      observed_at: new Date().toISOString(),
      facts: {
        boot_id: boot,
        talos_version: `v${f.value.roles.customer.talos_version}`,
        kubernetes_version: f.value.roles.customer.kubernetes_version,
        components: [
          { name: "regional", runtime_image_sha256: "e".repeat(64) },
        ],
      },
    });
  const observe = (value: FleetNodeReleaseObservation) =>
    request("/agent/v1/fleet-observations", f.agent, "POST", value);
  const stored = async () =>
    (await env.DB.prepare(
      "SELECT facts_json,observed_at FROM fleet_node_release_observations WHERE node_id=?",
    )
      .bind(f.node)
      .first<{ facts_json: string; observed_at: string }>())!;
  return { ...f, native, boot, key, seed, partial, observe, stored };
}
it("retains Native OS receipt across same-boot partial inventory without carrying stale Kubernetes components", async () => {
  const f = await receiptFixture(),
    partial = f.partial();
  expect((await f.observe(partial)).status).toBe(200);
  const row = await f.stored(),
    facts = JSON.parse(row.facts_json);
  expect(facts).toMatchObject({
    talos_installer: f.native.facts.talos_installer,
    talos_schematic_sha256: f.native.facts.talos_schematic_sha256,
    talos_provenance: f.native.facts.talos_provenance,
  });
  expect(facts.components).toEqual(partial.facts.components);
  expect((await f.observe(partial)).status).toBe(200);
});
it("missing boot or Talos version cannot refresh a retained Native OS receipt", async () => {
  const f = await receiptFixture(),
    before = await f.stored(),
    missingBoot = f.partial();
  delete missingBoot.facts.boot_id;
  expect((await f.observe(missingBoot)).status).toBe(409);
  expect(await f.stored()).toEqual(before);
  const missingVersion = f.partial();
  delete missingVersion.facts.talos_version;
  expect((await f.observe(missingVersion)).status).toBe(409);
  expect(await f.stored()).toEqual(before);
});
it("changed boot or Talos version invalidates prior Native OS provenance", async () => {
  const f = await receiptFixture(),
    reboot = f.partial();
  reboot.facts.boot_id = crypto.randomUUID();
  expect((await f.observe(reboot)).status).toBe(200);
  expect(JSON.parse((await f.stored()).facts_json)).not.toHaveProperty(
    "talos_provenance",
  );
  expect(JSON.parse((await f.stored()).facts_json)).not.toHaveProperty(
    "talos_installer",
  );
  await f.seed();
  const changedVersion = f.partial();
  changedVersion.facts.talos_version = "1.14.2";
  expect((await f.observe(changedVersion)).status).toBe(200);
  expect(JSON.parse((await f.stored()).facts_json)).not.toHaveProperty(
    "talos_provenance",
  );
});
it("ordinary Regional observations cannot mint a Native deployment receipt", async () => {
  const f = await receiptFixture();
  await env.DB.prepare(
    "DELETE FROM fleet_node_release_observations WHERE node_id=?",
  )
    .bind(f.node)
    .run();
  const supplied = f.partial();
  supplied.facts = { ...f.native.facts };
  supplied.observed_at = new Date().toISOString();
  expect((await f.observe(supplied)).status).toBe(409);
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM fleet_node_release_observations WHERE node_id=?",
    )
      .bind(f.node)
      .first("n"),
  ).toBe(0);
});
it("changed assignment or agent key cannot carry a previous Native receipt", async () => {
  const f = await receiptFixture();
  await f.assignNode(1);
  const next = f.partial();
  next.assignment_revision = 2;
  expect((await f.observe(next)).status).toBe(200);
  expect(JSON.parse((await f.stored()).facts_json)).not.toHaveProperty(
    "talos_provenance",
  );
  await f.seed();
  await env.DB.prepare(
    "UPDATE fleet_node_release_observations SET assignment_revision=2,agent_key_hash=? WHERE node_id=?",
  )
    .bind("f".repeat(64), f.node)
    .run();
  const current = f.partial();
  current.assignment_revision = 2;
  expect((await f.observe(current)).status).toBe(200);
  expect(JSON.parse((await f.stored()).facts_json)).not.toHaveProperty(
    "talos_installer",
  );
});
it("a concurrent Native receipt is never overwritten by a stale partial-inventory merge", async () => {
  const f = await receiptFixture(),
    partial = f.partial(),
    newFacts = structuredClone(f.native.facts);
  newFacts.talos_provenance!.cluster_uid = crypto.randomUUID();
  const at = new Date(Date.now() + 1).toISOString();
  partial.observed_at = new Date(Date.now() + 1000).toISOString();
  const prepare = env.DB.prepare.bind(env.DB);
  let raced = false;
  vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (!sql.includes("INSERT INTO fleet_node_release_observations"))
      return statement;
    return new Proxy(statement, {
      get(target, key) {
        if (key === "bind")
          return (...parameters: unknown[]) => {
            const bound = target.bind(...parameters);
            return new Proxy(bound, {
              get(inner, property) {
                if (property === "run")
                  return async () => {
                    if (!raced) {
                      raced = true;
                      await prepare(
                        "UPDATE fleet_node_release_observations SET facts_json=?,observed_at=? WHERE node_id=?",
                      )
                        .bind(JSON.stringify(newFacts), at, f.node)
                        .run();
                    }
                    return inner.run();
                  };
                const value = Reflect.get(inner, property);
                return typeof value === "function" ? value.bind(inner) : value;
              },
            });
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  expect((await f.observe(partial)).status).toBe(409);
  expect(raced).toBe(true);
  expect(await f.stored()).toEqual({
    facts_json: JSON.stringify(newFacts),
    observed_at: at,
  });
});
it("malformed old installer or schematic receipt never becomes refreshed target provenance", async () => {
  const f = await receiptFixture(),
    wrongInstaller = structuredClone(f.native.facts);
  wrongInstaller.talos_installer = `registry.example/old-talos@sha256:${"e".repeat(64)}`;
  wrongInstaller.talos_provenance!.installer = wrongInstaller.talos_installer;
  await env.DB.prepare(
    "UPDATE fleet_node_release_observations SET facts_json=? WHERE node_id=?",
  )
    .bind(JSON.stringify(wrongInstaller), f.node)
    .run();
  expect((await f.observe(f.partial())).status).toBe(200);
  expect(JSON.parse((await f.stored()).facts_json)).not.toHaveProperty(
    "talos_provenance",
  );
  await f.seed();
  const wrongSchematic = structuredClone(f.native.facts);
  wrongSchematic.talos_schematic_sha256 = "f".repeat(64);
  await env.DB.prepare(
    "UPDATE fleet_node_release_observations SET facts_json=? WHERE node_id=?",
  )
    .bind(JSON.stringify(wrongSchematic), f.node)
    .run();
  expect((await f.observe(f.partial())).status).toBe(200);
  expect(JSON.parse((await f.stored()).facts_json)).not.toHaveProperty(
    "talos_installer",
  );
});
it("replaced physical Node UID cannot inherit another machine's Native receipt", async () => {
  const f = await receiptFixture(),
    replacement = crypto.randomUUID();
  await env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?")
    .bind(replacement, f.node)
    .run();
  expect((await f.assignNode(1, replacement)).status).toBe(200);
  const partial = f.partial();
  partial.node_uid = replacement;
  partial.assignment_revision = 2;
  expect((await f.observe(partial)).status).toBe(200);
  expect(JSON.parse((await f.stored()).facts_json)).not.toHaveProperty(
    "talos_provenance",
  );
});

it("requires the observed current Ready Flux source commit when the release pins its platform source", async () => {
  const { mismatches } = await import("../../src/domain/fleet-releases.ts");
  const { FleetReleaseSpec } = await import("@pgcf/contracts/releases");
  const release = FleetReleaseSpec.parse({
    ...spec(),
    platform_source_commit: "a".repeat(40),
  });
  const facts = {
    configuration_schema_revision: 1,
    talos_version: release.roles.customer.talos_version,
    talos_installer: release.roles.customer.talos_installer,
    talos_schematic_sha256: release.roles.customer.talos_schematic_sha256,
    kubernetes_version: release.roles.customer.kubernetes_version,
    components: release.components
      .filter((v) => release.roles.customer.components.includes(v.name))
      .map(({ name, version, sha256 }) => ({ name, version, sha256 })),
  };
  expect(mismatches(release, "customer", facts)).toEqual([
    "unobserved/platform_source_commit",
  ]);
  expect(
    mismatches(release, "customer", {
      ...facts,
      platform_source_commit: "b".repeat(40),
    }),
  ).toEqual(["platform_source_commit"]);
  expect(
    mismatches(release, "customer", {
      ...facts,
      platform_source_commit: "a".repeat(40),
    }),
  ).toEqual([]);
});

it("retains Native kubelet image provenance at its original timestamp only across the same current boot/key/assignment and versions", async () => {
  // Its deliberately unqualified synthetic runtime has no registry metadata.
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, { status: 404 }),
  );
  const f = await receiptFixture(true),
    proof = {
      method: "native_runtime_readback" as const,
      observed_at: new Date(Date.now() - 60000).toISOString(),
      kubelet_version: "1.36.5",
      control_plane: false,
      images: {
        kubelet: {
          configuration: kubeImagePins.kubelet,
          runtime_sha256: "1".repeat(64),
        },
      },
    };
  Object.assign(f.native.facts, {
    kubelet_version: "1.36.5",
    kubernetes_control_plane: false,
    kubernetes_image_provenance: proof,
  });
  await f.seed();
  const partial = f.partial();
  Object.assign(partial.facts, {
    kubelet_version: "v1.36.5",
    kubernetes_control_plane: false,
  });
  expect((await f.observe(partial)).status).toBe(200);
  expect(
    JSON.parse((await f.stored()).facts_json).kubernetes_image_provenance,
  ).toEqual(proof);
  const forged = structuredClone(partial);
  forged.facts.kubernetes_image_provenance = {
    ...proof,
    observed_at: new Date().toISOString(),
  };
  expect((await f.observe(forged)).status).toBe(409);
  const changed = structuredClone(partial);
  changed.facts.kubelet_version = "1.36.4";
  changed.observed_at = new Date(
    Date.parse(partial.observed_at) + 100,
  ).toISOString();
  expect((await f.observe(changed)).status).toBe(200);
  expect(
    JSON.parse((await f.stored()).facts_json).kubernetes_image_provenance,
  ).toBeUndefined();
});

it("retains only selected boot-bound loaded extensions while ordinary reports cannot forge them or carry them across a reboot", async () => {
  const f = await receiptFixture(false, true),
    ext = f.native.facts.components.find(
      (c) => c.name === "pgcf-sandbox-controller",
    )!;
  expect((await f.observe(f.partial())).status).toBe(200);
  expect(JSON.parse((await f.stored()).facts_json).components).toContainEqual(
    ext,
  );
  const forged = f.partial();
  forged.observed_at = new Date(Date.now() + 1).toISOString();
  forged.facts.components.push({ ...ext, sha256: "f".repeat(64) });
  expect((await f.observe(forged)).status).toBe(409);
  const changed = f.partial();
  changed.observed_at = new Date(Date.now() + 2).toISOString();
  changed.facts.boot_id = crypto.randomUUID();
  expect((await f.observe(changed)).status).toBe(200);
  expect(
    JSON.parse((await f.stored()).facts_json).components,
  ).not.toContainEqual(ext);
});

const observedCiliumIndex =
  '{\n  "schemaVersion": 2,\n  "mediaType": "application/vnd.oci.image.index.v1+json",\n  "manifests": [\n    {\n      "mediaType": "application/vnd.oci.image.manifest.v1+json",\n      "digest": "sha256:9d308e3f7f05972b0b0604c40d2b0f08fa2f6a55084fef1e1aaadb469e430639",\n      "size": 1247,\n      "platform": {\n        "architecture": "amd64",\n        "os": "linux"\n      }\n    },\n    {\n      "mediaType": "application/vnd.oci.image.manifest.v1+json",\n      "digest": "sha256:02dd062a1f48a6ef52f50e7396117f9e7c82fbe9e6408dcaebe212257414bbeb",\n      "size": 1247,\n      "platform": {\n        "architecture": "arm64",\n        "os": "linux"\n      }\n    }\n  ]\n}';
const observedApiServerIndex =
  '{\n   "schemaVersion": 2,\n   "mediaType": "application/vnd.docker.distribution.manifest.list.v2+json",\n   "manifests": [\n      {\n         "mediaType": "application/vnd.docker.distribution.manifest.v2+json",\n         "size": 3444,\n         "digest": "sha256:78487f7b4b1a588d9630f758f6677895eabe00d93c4cbbea3d6b06e5f476a371",\n         "platform": {\n            "architecture": "amd64",\n            "os": "linux"\n         }\n      },\n      {\n         "mediaType": "application/vnd.docker.distribution.manifest.v2+json",\n         "size": 3444,\n         "digest": "sha256:fd2aeee57db21e3e988ae7845dd549f8fdc036a3de985dc70aad4a69ad8ceb5a",\n         "platform": {\n            "architecture": "arm64",\n            "os": "linux"\n         }\n      },\n      {\n         "mediaType": "application/vnd.docker.distribution.manifest.v2+json",\n         "size": 3444,\n         "digest": "sha256:a932de6bf497f09570130c750b97eee9c5e3306a32ad598f31933074a12258d2",\n         "platform": {\n            "architecture": "ppc64le",\n            "os": "linux"\n         }\n      },\n      {\n         "mediaType": "application/vnd.docker.distribution.manifest.v2+json",\n         "size": 3444,\n         "digest": "sha256:c7c14e0cee7edf77296ca3df0b9379a4e2159d87050372e1cf055b26160180e2",\n         "platform": {\n            "architecture": "s390x",\n            "os": "linux"\n         }\n      }\n   ]\n}';

it("Worker ingestion canonicalizes fresh TS or Rust OCI aliases while preserving raw carrier identity and immutable deployment timestamps", async () => {
  const reference = lock.charts
    .find((v) => v.name === "cilium")!
    .renderedImages.find((v) => v.startsWith("quay.io/cilium/cilium:"))!;
  const f = await receiptFixture(true, false, (value) => {
    Object.assign(
      value.components.find((v) => v.name === "cilium")!,
      {
        reference,
        sha256: reference.slice(-64),
        version: lock.charts.find((v) => v.name === "cilium")!.appVersion,
      },
    );
    for (const role of Object.values(value.roles))
      Object.assign(role, { kubernetes_images: lock.target.kubernetesImages });
  });
  const proof = {
    method: "native_runtime_readback" as const,
    observed_at: new Date(Date.now() - 60_000).toISOString(),
    kubelet_version: lock.target.kubernetesVersion,
    control_plane: true,
    images: Object.fromEntries(
      Object.entries(lock.target.kubernetesImages).map(
        ([name, configuration]) => [
          name,
          { configuration, runtime_sha256: configuration.slice(-64) },
        ],
      ),
    ),
  };
  Object.assign(f.native.facts, {
    kubelet_version: lock.target.kubernetesVersion,
    kubernetes_control_plane: true,
    kubernetes_image_provenance: proof,
    kubernetes_static_images: {
      apiServer: lock.target.kubernetesImages.apiServer.slice(-64),
      controllerManager:
        lock.target.kubernetesImages.controllerManager.slice(-64),
      scheduler: lock.target.kubernetesImages.scheduler.slice(-64),
    },
  });
  await f.seed();
  const rawCilium =
      "2939231d0d3e3ebddcd80fffa168b7ddcc78fdf0dc864d1c8c126ff523c54f01",
    rawKubernetesIndexDigest =
      "4b3e69973a1d58d3c1f670d3477a9b9f14a03a271823113e8e0c9a333eb84f48";
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url) => {
      const value = String(url),
        isCilium = value.includes("/cilium/cilium/");
      return new Response(
        isCilium ? observedCiliumIndex : observedApiServerIndex,
        {
          headers: {
            "docker-content-digest": `sha256:${isCilium ? rawCilium : rawKubernetesIndexDigest}`,
          },
        },
      );
    });
  const observation = f.partial();
  Object.assign(observation.facts, {
    kubelet_version: lock.target.kubernetesVersion,
    kubernetes_control_plane: true,
    kubernetes_static_images: { apiServer: rawKubernetesIndexDigest },
    components: [{ name: "cilium", runtime_image_sha256: rawCilium }],
  });
  expect((await f.observe(observation)).status).toBe(200);
  const facts = JSON.parse((await f.stored()).facts_json);
  expect(facts.components).toEqual([
    {
      name: "cilium",
      runtime_image_sha256: rawCilium,
      version: lock.charts.find((v) => v.name === "cilium")!.appVersion,
      sha256: reference.slice(-64),
    },
  ]);
  expect(facts.kubernetes_static_images).toEqual({
    apiServer: lock.target.kubernetesImages.apiServer.slice(-64),
  });
  expect(facts.kubernetes_image_provenance).toEqual(proof);
  expect(
    facts.components.find((v: { name: string }) => v.name === "regional"),
  ).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(2);
  const repeated = structuredClone(observation);
  repeated.observed_at = new Date(Date.now() + 1).toISOString();
  expect((await f.observe(repeated)).status).toBe(200);
  expect(JSON.parse((await f.stored()).facts_json).components).toEqual(
    facts.components,
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  const changed = structuredClone(observation);
  changed.facts.boot_id = crypto.randomUUID();
  changed.observed_at = new Date(Date.now() + 1).toISOString();
  expect((await f.observe(changed)).status).toBe(200);
  const changedFacts = JSON.parse((await f.stored()).facts_json);
  expect(changedFacts.components).toEqual(changed.facts.components);
  expect(changedFacts.kubernetes_static_images).toEqual({
    apiServer: rawKubernetesIndexDigest,
  });
  expect(changedFacts).not.toHaveProperty("kubernetes_image_provenance");
  expect(fetcher).toHaveBeenCalledTimes(2);
  await f.seed();
  vi.restoreAllMocks();
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response("{}", {
        headers: { "docker-content-digest": `sha256:${rawCilium}` },
      }),
  );
  const tampered = structuredClone(observation);
  tampered.observed_at = new Date(Date.now() + 2).toISOString();
  Object.assign(tampered.facts.components[0]!, {
    version: lock.charts.find((v) => v.name === "cilium")!.appVersion,
    sha256: reference.slice(-64),
  });
  expect((await f.observe(tampered)).status).toBe(200);
  const rejectedFacts = JSON.parse((await f.stored()).facts_json);
  expect(rejectedFacts.components).toEqual([
    { name: "cilium", runtime_image_sha256: rawCilium },
  ]);
  expect(rejectedFacts.kubernetes_static_images).toEqual({
    apiServer: rawKubernetesIndexDigest,
  });
});

it("an ordinary report cannot claim a target component hash while reporting a contradictory unproved runtime", async () => {
  const f = await setup();
  await f.approve();
  await f.assignRegion();
  await f.assignNode();
  const observation = f.inventory();
  Object.assign(
    observation.facts.components.find((value) => value.name === "regional")!,
    { runtime_image_sha256: "f".repeat(64) },
  );
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
  ).json()) as { state: string; mismatches: string[] };
  expect(status.state).toBe("pending");
  expect(status.mismatches).toContain("unobserved/components/regional");
});
