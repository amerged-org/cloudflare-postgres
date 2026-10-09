// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";
const releases: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
async function configured() {
  const f = await fixture(),
    node = (await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
      .bind(f.node)
      .first<{ node_uid: string }>())!,
    id = "pool-" + crypto.randomUUID();
  releases.push(id);
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
    "sandbox-controller",
  ];
  const role = {
    talos_version: "1.14.1",
    talos_installer: "registry.invalid/talos@sha256:" + "b".repeat(64),
    talos_schematic_sha256: "b".repeat(64),
    talos_extensions: [],
    kubernetes_version: "1.36.5",
    components: names.slice(3),
  };
  const spec = {
    version: 1,
    versions_lock_sha256: "d".repeat(64),
    configuration_schema_revision: 1,
    components: names.map((name) => ({
      name,
      kind: ["api", "edge"].includes(name) ? "worker_bundle" : "image",
      version: "1.0.0",
      reference: "registry.invalid/" + name + "@sha256:" + "a".repeat(64),
      sha256: "a".repeat(64),
    })),
    roles: { control_relay: role, customer: role },
  };
  expect(
    (await request(`/v1/fleet/releases/${id}`, f.admin, "PUT", spec)).status,
  ).toBe(200);
  expect(
    (
      await request(`/v1/regions/${f.region}/release`, f.admin, "PUT", {
        expected_revision: 0,
        release_id: id,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await request(`/v1/nodes/${f.node}/release`, f.admin, "PUT", {
        expected_revision: 0,
        release_id: id,
        node_uid: node.node_uid,
        role: "customer",
      })
    ).status,
  ).toBe(200);
  const policy = {
    version: 1 as const,
    target_slots: 2,
    max_idle_cpu_millicores: 100,
    max_idle_memory_mib: 128,
    max_age_seconds: 120,
    per_slot_cpu_millicores: 25,
    per_slot_memory_mib: 32,
    profile: {
      release_id: id,
      image: "registry.invalid/sandbox-controller@sha256:" + "a".repeat(64),
      holder_sha256: "b".repeat(64),
      controller_sha256: "c".repeat(64),
      containerd_version: "2.3.6" as const,
      runc_version: "1.5.2" as const,
      architecture: "amd64" as const,
    },
  };
  return { ...f, uid: node.node_uid, policy };
}
it("requires an administrator and an approved runtime before persisting pool targets", async () => {
  const f = await fixture();
  const body = {
    expected_revision: 0,
    node_uid: (await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
      .bind(f.node)
      .first<{ node_uid: string }>())!.node_uid,
    policy: {
      version: 1,
      target_slots: 2,
      max_idle_cpu_millicores: 100,
      max_idle_memory_mib: 128,
      max_age_seconds: 120,
      per_slot_cpu_millicores: 25,
      per_slot_memory_mib: 32,
      profile: {
        release_id: "unapproved-runtime",
        image: "registry.invalid/pool@sha256:" + "a".repeat(64),
        holder_sha256: "b".repeat(64),
        controller_sha256: "c".repeat(64),
        containerd_version: "2.3.6",
        runc_version: "1.5.2",
        architecture: "amd64",
      },
    },
  };
  const path = `/v1/nodes/${f.node}/compute-pool`;
  expect((await request(path, f.integrator, "PUT", body)).status).toBe(403);
  expect((await request(path, f.admin, "PUT", body)).status).toBe(409);
  const lease = await request(
    `/agent/v1/nodes/${f.node}/compute-pool`,
    f.agent,
  );
  expect(lease.status).toBe(404);
});
it("issues a short region-authenticated lease bound to current physical Node and exact release", async () => {
  const f = await configured(),
    path = `/v1/nodes/${f.node}/compute-pool`,
    body = { expected_revision: 0, node_uid: f.uid, policy: f.policy };
  const response = await request(
    path,
    f.admin,
    "PUT",
    body,
    "pool-policy-once",
  );
  expect(response.status).toBe(200);
  expect(((await response.json()) as { revision: number }).revision).toBe(1);
  expect(
    (await request(path, f.admin, "PUT", body, "pool-policy-once")).status,
  ).toBe(200);
  const url = `/agent/v1/nodes/${f.node}/compute-pool`,
    lease = await request(url, f.agent);
  expect(lease.status).toBe(200);
  const value = (await lease.json()) as {
    expires_at: string;
    issued_at: string;
    node_uid: string;
    material_revision: number;
  };
  expect(Date.parse(value.expires_at) - Date.parse(value.issued_at)).toBe(
    30000,
  );
  expect(value.node_uid).toBe(f.uid);
  expect(value.material_revision).toBe(1);
  expect((await request(url, f.foreignAgent)).status).toBe(404);
  await env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
    .bind(new Date(Date.now() - 180001).toISOString(), f.node)
    .run();
  expect((await request(url, f.agent)).status).toBe(404);
});
it("records actual slot ownership and unknown measurements without claiming a missing pool is empty", async () => {
  const f = await configured(),
    path = `/v1/nodes/${f.node}/compute-pool`;
  expect(
    (
      await request(path, f.admin, "PUT", {
        expected_revision: 0,
        node_uid: f.uid,
        policy: f.policy,
      })
    ).status,
  ).toBe(200);
  const statusPath = path + "/observations",
    missing = await request(statusPath, f.admin);
  expect(
    ((await missing.json()) as { observation: unknown }).observation,
  ).toBeNull();
  const observation = {
    node_id: f.node,
    node_uid: f.uid,
    policy_revision: 1,
    material_revision: 1,
    observed_at: new Date().toISOString(),
    profile: f.policy.profile,
    idle_memory_current_bytes: 33554432,
    idle_cpu_usage_usec: null,
    slots: [
      {
        slot_id: "a".repeat(32),
        holder_pid: 100,
        shim_pid: 101,
        live: true,
        sandbox_id: null,
        pod_uid: null,
        runtime_release_id: null,
        assignment_mode: null,
      },
    ],
  };
  const posted = await request(
    `/agent/v1/nodes/${f.node}/compute-pool`,
    f.agent,
    "POST",
    observation,
  );
  expect(posted.status).toBe(200);
  const current = await request(statusPath, f.admin),
    state = (await current.json()) as {
      freshness: string;
      observation: { idle_cpu_usage_usec: number | null; slots: unknown[] };
    };
  expect(state.freshness).toBe("current");
  expect(state.observation.idle_cpu_usage_usec).toBeNull();
  expect(state.observation.slots).toHaveLength(1);
  expect(
    (
      await request(`/agent/v1/nodes/${f.node}/compute-pool`, f.agent, "POST", {
        ...observation,
        node_uid: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  await env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?")
    .bind(crypto.randomUUID(), f.node)
    .run();
  expect(
    (await request(`/agent/v1/nodes/${f.node}/compute-pool`, f.agent)).status,
  ).toBe(404);
});
it("rejects a target above the finite idle budget and stale policy updates", async () => {
  const f = await configured(),
    path = `/v1/nodes/${f.node}/compute-pool`;
  expect(
    (
      await request(path, f.admin, "PUT", {
        expected_revision: 0,
        node_uid: f.uid,
        policy: { ...f.policy, target_slots: 16 },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(path, f.admin, "PUT", {
        expected_revision: 0,
        node_uid: f.uid,
        policy: f.policy,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await request(path, f.admin, "PUT", {
        expected_revision: 0,
        node_uid: f.uid,
        policy: { ...f.policy, target_slots: 0 },
      })
    ).status,
  ).toBe(409);
});
