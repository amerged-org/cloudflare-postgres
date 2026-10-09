// SPDX-License-Identifier: Apache-2.0
// Real D1/Actor/Ed25519 authority tests; fixture qualification is not live kernel acceptance.
import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import {
  DatabaseWithOperation,
  ThinStorageProfile,
  base64urlToBytes,
} from "@pgcf/contracts";
import {
  DatabaseRuntimeAttestation,
  NodeWarmReclaimQualification,
  ReclaimIntentSnapshot,
  verifyReclaimIntent,
  type ReclaimClaims,
} from "@pgcf/contracts/reclaim";
import {
  fixture,
  cleanupFixtures,
  request,
  observation,
  observedBody,
} from "./fixtures.ts";
import { installThinQualifiedFixture } from "./thin-qualified-fixture.ts";
import {
  storeRegionJoinBundle,
  joinBundleReference,
} from "../../src/crypto/bootstrap-credentials.ts";
import { storageAuthorityPublicKeys } from "../../src/domain/storage-authority.ts";
import { configureNodeRegionPolicy } from "../../src/domain/node-state.ts";
import { createApp } from "../../src/app.ts";
import type { Env } from "../../src/env.ts";
const releases: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
const actor = (id: string) =>
  env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id));
const policy = {
  idle_after_seconds: 60,
  budget_bytes: 32 * 1024 ** 2,
  step_bytes: 1024 ** 2,
};
async function ready(actualRam = false) {
  const f = await fixture(8192);
  if (actualRam) {
    await configureNodeRegionPolicy(env.DB, {
      region_id: f.region,
      max_nodes: 3,
      purchases_enabled: false,
      order: null,
      placement_mode: "actual_ram",
      maximum_database_memory_mib: 4096,
      postgres_memory_request_mib: 128,
    });
    const uid = await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
        .bind(f.node)
        .first<string>("node_uid"),
      now = Date.now();
    await env.DB.prepare(
      "INSERT INTO node_memory_samples(node_id,node_uid,minute,observed_at,working_set_bytes,capacity_memory_bytes,available_bytes,memory_pressure) VALUES(?,?,?,?,?,?,?,0)",
    )
      .bind(
        f.node,
        uid,
        Math.floor(now / 60000),
        new Date(now).toISOString(),
        1024 * 1024 ** 2,
        8192 * 1024 ** 2,
        7168 * 1024 ** 2,
      )
      .run();
  }
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([observation(created.database.id, 1)]),
  );
  return { ...f, id: created.database.id };
}
async function qualified() {
  const f = await ready(true),
    cluster = crypto.randomUUID(),
    uid = await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
      .bind(f.node)
      .first<string>("node_uid");
  const profile = ThinStorageProfile.parse({
    version: 1,
    driver_image: `registry.invalid/driver@sha256:${"a".repeat(64)}`,
    initial_data_bytes: 32 * 1024 ** 3,
    growth_bytes: 8 * 1024 ** 3,
    maximum_data_bytes: 64 * 1024 ** 3,
    metadata_bytes: 1024 ** 3,
    vg_reserve_bytes: 4 * 1024 ** 3,
    data_reserve_bytes: 512 * 1024 ** 2,
    metadata_reserve_bytes: 64 * 1024 ** 2,
    startup_reserve_bytes: 32 * 1024 ** 2,
    write_bytes_per_second: 1024 ** 2,
    write_iops_per_second: 10,
    guard_seconds: 30,
    drain_seconds: 10,
    maximum_volumes: 1000,
    maximum_quota_gib: 16,
  });
  const proof = await installThinQualifiedFixture(
    env.DB,
    f.node,
    profile,
    cluster,
    {
      storageKeysSha256: (await storageAuthorityPublicKeys(env as Env)).sha256,
      extraComponents: [
        {
          name: "node-reclaimer",
          kind: "image",
          version: "1.0.0",
          reference: `registry.invalid/reclaimer@sha256:${"1".repeat(64)}`,
          sha256: "1".repeat(64),
        },
      ],
    },
  );
  releases.push(proof.releaseId);
  await storeRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 1),
    {
      version: 1,
      cluster_name: "fixture",
      cluster_endpoint: "https://192.0.2.18:6443/",
      talos_version: "1.14.1",
      kubernetes_version: "1.36.5",
      talos_machine_secrets_yaml: "test-only",
      talos_admin_config: "test-only",
      kube_system_uid: cluster,
      kubeconfig: "test-only",
    },
  );
  const qualification = NodeWarmReclaimQualification.parse({
    v: 1,
    revision: 1,
    node_uid: uid,
    boot_id: proof.bootId,
    cluster_uid: cluster,
    material_revision: 1,
    release_id: proof.releaseId,
    kernel_version: "6.18.51",
    proof_sha256: "2".repeat(64),
    qualified_at: Date.now(),
    worker: true,
    isolated_worker_accepted: true,
    cgroup_v2: true,
    limited_swap: true,
    encrypted_swap_bytes: 1024 ** 3,
    encrypted_swap_dm_uuids: ["CRYPT-LUKS2-" + "a".repeat(32) + "-pgcf-swap"],
    system_services_excluded: true,
  });
  const qualifyKey = crypto.randomUUID();
  const qualify = await request(
    `/v1/nodes/${f.node}/warm-reclaim-qualification`,
    f.admin,
    "PUT",
    { expected_revision: 0, node_uid: uid, qualification },
    qualifyKey,
  );
  expect(qualify.status, JSON.stringify(await qualify.clone().json())).toBe(
    200,
  );
  expect(
    (
      await request(
        `/v1/nodes/${f.node}/warm-reclaim-qualification`,
        f.admin,
        "PUT",
        { expected_revision: 0, node_uid: uid, qualification },
        qualifyKey,
      )
    ).status,
  ).toBe(200);
  const configure = await request(
    `/v1/databases/${f.id}/warm-reclaim`,
    f.admin,
    "PUT",
    { expected_revision: 0, expected_generation: 1, policy },
  );
  expect(configure.status).toBe(200);
  const size = await env.DB.prepare(
    "SELECT memory_mib FROM size_classes WHERE id=?",
  )
    .bind(f.size)
    .first<number>("memory_mib");
  const runtime = DatabaseRuntimeAttestation.parse({
    v: 1,
    database_id: f.id,
    generation: 1,
    storage_generation: 1,
    node_uid: uid,
    boot_id: proof.bootId,
    cluster_uid: cluster,
    namespace_uid: crypto.randomUUID(),
    cnpg_cluster_uid: crypto.randomUUID(),
    storage_uid: crypto.randomUUID(),
    pvc_uid: crypto.randomUUID(),
    pv_uid: crypto.randomUUID(),
    pod_uid: crypto.randomUUID(),
    container_id: "3".repeat(64),
    postgres_image_sha256: proof.spec.components.find(
      (c) => c.name === "postgres",
    )!.sha256,
    memory_request_bytes: 128 * 1024 ** 2,
    memory_limit_bytes: size! * 1024 ** 2,
    observed_at: Date.now(),
    configuration_fingerprint: "4".repeat(64),
  });
  const observed = await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([{ ...observation(f.id, 1), runtime_attestation: runtime }]),
  );
  expect(observed.status, JSON.stringify(await observed.clone().json())).toBe(
    200,
  );
  const now = new Date().toISOString();
  expect(
    await actor(f.id).recordActivity(f.id, {
      revision: 1,
      observed_at: now,
      last_activity_at: new Date(Date.now() - 120000).toISOString(),
      active_connections: 0,
    }),
  ).toBe(true);
  return { ...f, uid: uid!, runtime, qualification };
}
async function signed(token: string) {
  const keys = new Map<string, CryptoKey>();
  for (const [kid, raw] of Object.entries(
    JSON.parse(env.BOOTSTRAP_VERIFIER_KEYS) as Record<string, string>,
  ))
    keys.set(
      kid,
      await crypto.subtle.importKey(
        "raw",
        base64urlToBytes(raw)!,
        "Ed25519",
        false,
        ["verify"],
      ),
    );
  const claims = await verifyReclaimIntent(token, keys);
  expect(claims).not.toBeNull();
  return claims!;
}
async function snapshot(f: Awaited<ReturnType<typeof qualified>>) {
  const r = await request(`/agent/v1/nodes/${f.node}/reclaim`, f.agent);
  expect(r.status).toBe(200);
  return ReclaimIntentSnapshot.parse(await r.json());
}
async function ack(
  f: Awaited<ReturnType<typeof qualified>>,
  claims: ReclaimClaims,
  overrides: Record<string, unknown> = {},
) {
  const now = Date.now();
  return request(
    `/agent/v1/nodes/${f.node}/reclaim-observations`,
    f.agent,
    "POST",
    {
      purpose: "pgcf-reclaim-observations/v1",
      node_uid: f.uid,
      boot_id: f.runtime.boot_id,
      material_revision: 1,
      observed_at: now,
      results: [
        {
          database_id: f.id,
          operation_id: claims.operation_id,
          intent_revision: claims.intent_revision,
          generation: claims.generation,
          storage_generation: claims.storage_generation,
          pod_uid: claims.pod_uid,
          container_id: claims.container_id,
          observed_at: now,
          outcome: "revoked",
          in_flight: true,
          ...overrides,
        },
      ],
    },
  );
}
it("keeps cold idle behavior until explicit policy and isolated-node qualification exist", async () => {
  const f = await ready();
  expect(
    (await request(`/agent/v1/nodes/${f.node}/reclaim`, f.agent)).status,
  ).toBe(404);
  expect(
    (
      await request(`/v1/databases/${f.id}/warm-reclaim`, f.integrator, "PUT", {
        expected_revision: 0,
        expected_generation: 1,
        policy,
      })
    ).status,
  ).toBe(403);
  const key = crypto.randomUUID(),
    body = { expected_revision: 0, expected_generation: 1, policy };
  expect(
    (
      await request(
        `/v1/databases/${f.id}/warm-reclaim`,
        f.admin,
        "PUT",
        body,
        key,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request(
        `/v1/databases/${f.id}/warm-reclaim`,
        f.admin,
        "PUT",
        body,
        key,
      )
    ).status,
  ).toBe(200);
  await env.DB.prepare(
    "UPDATE size_classes SET sleep_after_seconds=60 WHERE id=?",
  )
    .bind(f.size)
    .run();
  await actor(f.id).recordActivity(f.id, {
    revision: 1,
    observed_at: new Date().toISOString(),
    last_activity_at: new Date(Date.now() - 120000).toISOString(),
    active_connections: 0,
  });
  expect((await actor(f.id).requestIdle(f.id, 1)).ok).toBe(true);
  expect(
    await env.DB.prepare(
      "SELECT generation,desired_state FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ generation: 2, desired_state: "suspended" });
  expect(await actor(f.id).reclaimIntent(f.id)).toBeNull();
});
it("signs same-runtime warm idle without a power transition and requires a bound revoked Ack before admission", async () => {
  const f = await qualified();
  expect((await actor(f.id).requestIdle(f.id, 1)).ok).toBe(true);
  const initial = await signed((await snapshot(f)).tokens[0]!);
  expect(initial).toMatchObject({
    mode: "reclaim",
    generation: 1,
    pod_uid: f.runtime.pod_uid,
    budget_bytes: policy.budget_bytes,
  });
  expect(
    await env.DB.prepare(
      "SELECT generation,desired_state,observed_power FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({
    generation: 1,
    desired_state: "running",
    observed_power: "awake",
  });
  let resolved = false;
  const pending = actor(f.id)
    .ensureAwake(f.id, "app", { deadline: Date.now() + 3000 })
    .then((v) => {
      resolved = true;
      return v;
    });
  await new Promise((r) => setTimeout(r, 25));
  expect(resolved).toBe(false);
  const revoked = await signed((await snapshot(f)).tokens[0]!);
  expect(revoked).toMatchObject({
    mode: "revoked",
    operation_id: initial.operation_id,
    budget_bytes: 0,
    step_bytes: 0,
  });
  expect(revoked.intent_revision).toBeGreaterThan(initial.intent_revision);
  expect(
    await (await ack(f, revoked, { pod_uid: crypto.randomUUID() })).json(),
  ).toEqual({ accepted: 0 });
  expect(resolved).toBe(false);
  expect(await (await ack(f, revoked)).json()).toEqual({ accepted: 1 });
  expect((await pending).ok).toBe(true);
  expect((await actor(f.id).requestIdle(f.id, 1)).ok).toBe(false);
  expect(
    await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
      .bind(f.id)
      .first("generation"),
  ).toBe(1);
});
it("persists a lost-revocation barrier across eviction and only uses lease expiry without an Ack", async () => {
  const f = await qualified();
  await actor(f.id).requestIdle(f.id, 1);
  const initial = await signed((await snapshot(f)).tokens[0]!);
  expect(
    await actor(f.id).ensureAwake(f.id, "app", { deadline: Date.now() + 50 }),
  ).toEqual({ ok: false, sqlstate: "57P03" });
  await evictDurableObject(actor(f.id));
  const revoked = await signed((await snapshot(f)).tokens[0]!);
  expect(revoked.mode).toBe("revoked");
  expect(
    await actor(f.id).ensureAwake(f.id, "app", { deadline: Date.now() + 50 }),
  ).toEqual({ ok: false, sqlstate: "57P03" });
  await new Promise((r) =>
    setTimeout(r, Math.max(1, initial.expires_at + 1001 - Date.now())),
  );
  expect(
    (
      await actor(f.id).ensureAwake(f.id, "app", {
        deadline: Date.now() + 1000,
      })
    ).ok,
  ).toBe(true);
}, 10000);
it("invalidates changed runtime and refuses another region or a control-plane qualification", async () => {
  const f = await qualified();
  expect(
    (await request(`/agent/v1/nodes/${f.node}/reclaim`, f.foreignAgent)).status,
  ).toBe(404);
  await actor(f.id).requestIdle(f.id, 1);
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(f.id, 1),
        runtime_attestation: {
          ...f.runtime,
          pod_uid: crypto.randomUUID(),
          observed_at: Date.now(),
        },
      },
    ]),
  );
  const changed = await actor(f.id).reclaimIntent(f.id);
  expect((await signed(changed!)).mode).toBe("revoked");
  await env.DB.prepare(
    "UPDATE fleet_node_release_observations SET facts_json=json_set(facts_json,'$.kubernetes_control_plane',1) WHERE node_id=?",
  )
    .bind(f.node)
    .run();
  expect(
    (await request(`/agent/v1/nodes/${f.node}/reclaim`, f.agent)).status,
  ).toBe(404);
  const token = await actor(f.id).reclaimIntent(f.id);
  expect((await signed(token!)).mode).toBe("revoked");
  expect(
    (
      await request(
        `/v1/nodes/${f.node}/warm-reclaim-qualification`,
        f.admin,
        "PUT",
        {
          expected_revision: 1,
          node_uid: f.uid,
          qualification: { ...f.qualification, revision: 2 },
        },
      )
    ).status,
  ).toBe(409);
});

it("authenticates the qualified node before accepting a bounded observation body above the ordinary API cap", async () => {
  const f = await qualified(),
    body =
      " ".repeat(70 * 1024) +
      JSON.stringify({
        purpose: "pgcf-reclaim-observations/v1",
        node_uid: f.uid,
        boot_id: f.runtime.boot_id,
        material_revision: 1,
        observed_at: Date.now(),
        results: [],
      });
  const call = async (key: string) => {
    const ctx = createExecutionContext(),
      response = await createApp().fetch(
        new Request(
          `https://api.invalid/agent/v1/nodes/${f.node}/reclaim-observations`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
            },
            body,
          },
        ),
        env as Env,
        ctx,
      );
    await waitOnExecutionContext(ctx);
    return response;
  };
  expect((await call(f.agent)).status).toBe(200);
  expect((await call("invalid")).status).toBe(401);
});
