// SPDX-License-Identifier: Apache-2.0
// Real D1/Actor/Ed25519 authority tests; fixture qualification is not live kernel acceptance.
import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  createExecutionContext,
  waitOnExecutionContext,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
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
import { countStatements } from "./d1-statements.ts";
const releases: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
it("exposes a reclaim change barrier without inventing connection activity", async () => {
  const f = await ready();
  const lastAdmitted = () =>
    runInDurableObject(actor(f.id), async (_instance, context) => {
      if (
        !context.storage.sql
          .exec(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='database_reclaim'",
          )
          .toArray().length
      )
        return 0;
      return (
        context.storage.sql
          .exec<{ value: number }>(
            "SELECT COALESCE(json_extract(state,'$.last_admitted_at'),0) value FROM database_reclaim WHERE singleton=1",
          )
          .toArray()[0]?.value ?? 0
      );
    });
  const before = await lastAdmitted();
  expect(await actor(f.id).revokeBeforeChange(f.id, Date.now() + 3000)).toBe(
    true,
  );
  expect(await lastAdmitted()).toBe(before);
});
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
/**
 * A node with an accepted qualification and one database with a policy.
 * `policy: false` leaves the node's databases without one. `before` runs once everything the
 * qualification stands on exists and before it is made. `viaSql` writes the qualification row as
 * another isolate's request would have left it, bypassing this isolate's request path.
 */
async function qualified(
  options: {
    policy?: boolean;
    before?: (f: Awaited<ReturnType<typeof ready>>) => Promise<void>;
    viaSql?: boolean;
  } = {},
) {
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
  await options.before?.(f);
  if (options.viaSql) {
    await env.DB.prepare(
      "UPDATE nodes SET warm_reclaim_qualification_json=? WHERE id=?",
    )
      .bind(JSON.stringify({ revision: 1, qualification }), f.node)
      .run();
  } else {
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
  }
  if (options.policy !== false) {
    const configure = await request(
      `/v1/databases/${f.id}/warm-reclaim`,
      f.admin,
      "PUT",
      { expected_revision: 0, expected_generation: 1, policy },
    );
    expect(configure.status).toBe(200);
  }
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
/**
 * One poll of the reclaim route under a fake clock. A poll with nothing to deliver is held for
 * about 3.5 s; this steps the clock through that in 100 ms and reports how long the answer was
 * held, without waiting for it. `skewMs` moves the clock forward before the request.
 */
async function poll(node: string, key: string, skewMs = 0) {
  const real = globalThis.setTimeout;
  const tick = () => new Promise<void>((resolve) => real(resolve, 1));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    if (skewMs) vi.setSystemTime(Date.now() + skewMs);
    const arrived = Date.now();
    let response: Response | undefined;
    const pending = request(`/agent/v1/nodes/${node}/reclaim`, key).then(
      (value) => (response = value),
    );
    // D1 answers in real time; a hold shows as a pending fake timer.
    for (let i = 0; i < 5000 && !response && vi.getTimerCount() === 0; i++)
      await tick();
    let held = 0;
    for (; vi.getTimerCount() > 0 && held < 6000; held += 100)
      await vi.advanceTimersByTimeAsync(100);
    await pending;
    return { response: response!, heldMs: held, arrived };
  } finally {
    vi.useRealTimers();
  }
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
it("policy and qualification commits wait for the existing reclaim revocation acknowledgement", async () => {
  const f = await qualified();
  expect((await actor(f.id).requestIdle(f.id, 1)).ok).toBe(true);
  let completed = false;
  const changing = request(
    `/v1/databases/${f.id}/warm-reclaim`,
    f.admin,
    "PUT",
    {
      expected_revision: 1,
      expected_generation: 1,
      policy: {
        ...policy,
        budget_bytes: policy.budget_bytes + policy.step_bytes,
      },
    },
  ).then((response) => {
    completed = true;
    return response;
  });
  await expect
    .poll(async () => (await signed((await snapshot(f)).tokens[0]!)).mode)
    .toBe("revoked");
  expect(completed).toBe(false);
  expect(
    (await (
      await request(`/v1/databases/${f.id}/warm-reclaim`, f.admin)
    ).json()) as { revision: number },
  ).toMatchObject({ revision: 1 });
  const revoked = await signed((await snapshot(f)).tokens[0]!);
  expect(await (await ack(f, revoked)).json()).toEqual({ accepted: 1 });
  expect((await changing).status).toBe(200);
  const activity = new Date().toISOString();
  expect(
    await actor(f.id).recordActivity(f.id, {
      revision: 1,
      observed_at: activity,
      last_activity_at: new Date(Date.now() - 120000).toISOString(),
      active_connections: 0,
    }),
  ).toBe(true);
  expect((await actor(f.id).requestIdle(f.id, 1)).ok).toBe(true);
  let disabled = false;
  const removing = request(
    `/v1/nodes/${f.node}/warm-reclaim-qualification`,
    f.admin,
    "PUT",
    { expected_revision: 1, node_uid: f.uid, qualification: null },
  ).then((response) => {
    disabled = true;
    return response;
  });
  await expect
    .poll(async () => (await signed((await snapshot(f)).tokens[0]!)).mode)
    .toBe("revoked");
  expect(disabled).toBe(false);
  const nodeRevoked = await signed((await snapshot(f)).tokens[0]!);
  expect(await (await ack(f, nodeRevoked)).json()).toEqual({ accepted: 1 });
  expect((await removing).status).toBe(200);
});
it("keeps cold idle behavior until explicit policy and isolated-node qualification exist", async () => {
  const f = await ready();
  expect((await poll(f.node, f.agent)).response.status).toBe(404);
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
it("an admission without an outstanding reclaim defers warm idle from memory, not storage", async () => {
  const f = await qualified();
  expect((await actor(f.id).ensureAwake(f.id, "app")).ok).toBe(true);
  expect(await actor(f.id).requestIdle(f.id, 1)).toEqual({
    ok: false,
    reason: "not_idle",
  });
  expect(
    await runInDurableObject(actor(f.id), (_instance, context) =>
      context.storage.sql
        .exec(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN('database_reclaim','database_admission')",
        )
        .toArray(),
    ),
  ).toEqual([]);
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
  expect((await poll(f.node, f.foreignAgent)).response.status).toBe(404);
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
  expect((await poll(f.node, f.agent)).response.status).toBe(404);
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

// The host asks again 250 ms after every answer and gives up after 5 s, so a poll with nothing in
// it is held for 3 to 4 s and, once the node is known to be unqualified, answered without D1.
const HOLD_FROM_MS = 3000,
  HOLD_TO_MS = 4000,
  RECLAIM_HOLD_MS = 3500;
it("holds the poll of an unqualified node and then answers it without a D1 statement", async () => {
  const f = await ready();
  const first = await poll(f.node, f.agent);
  expect(first.response.status).toBe(404);
  expect(first.heldMs).toBeGreaterThanOrEqual(HOLD_FROM_MS);
  expect(first.heldMs).toBeLessThanOrEqual(HOLD_TO_MS);
  // A held request waits on a timer: nothing is read before, during or after it.
  const next = await countStatements(() => poll(f.node, f.agent));
  expect(next.statements).toBe(0);
  expect(next.result.response.status).toBe(404);
  expect(next.result.heldMs).toBeGreaterThanOrEqual(HOLD_FROM_MS);
  expect(next.result.heldMs).toBeLessThanOrEqual(HOLD_TO_MS);
});

it("never holds a refusal", async () => {
  const f = await ready();
  const wrong = await poll(f.node, f.admin);
  expect(wrong.response.status).toBe(401);
  expect(wrong.heldMs).toBe(0);
  const malformed = await poll("not-a-node", f.agent);
  expect(malformed.response.status).toBeGreaterThanOrEqual(400);
  expect(malformed.heldMs).toBe(0);
});

it("answers at once whatever a policy may still deliver", async () => {
  const f = await qualified();
  // A policy and no token yet: the answer is empty, and not held.
  const waiting = await poll(f.node, f.agent);
  expect(waiting.response.status).toBe(200);
  expect(waiting.heldMs).toBe(0);
  expect(
    ReclaimIntentSnapshot.parse(await waiting.response.json()).tokens,
  ).toEqual([]);
  // A token to deliver.
  expect((await actor(f.id).requestIdle(f.id, 1)).ok).toBe(true);
  const delivering = await poll(f.node, f.agent);
  expect(delivering.response.status).toBe(200);
  expect(delivering.heldMs).toBe(0);
  expect(
    ReclaimIntentSnapshot.parse(await delivering.response.json()).tokens,
  ).toHaveLength(1);
});

it("holds the empty snapshot of a qualified node without a policy and stamps it after the hold", async () => {
  const f = await qualified({ policy: false });
  const result = await poll(f.node, f.agent);
  expect(result.response.status).toBe(200);
  expect(result.heldMs).toBeGreaterThanOrEqual(HOLD_FROM_MS);
  expect(result.heldMs).toBeLessThanOrEqual(HOLD_TO_MS);
  const snapshot = ReclaimIntentSnapshot.parse(await result.response.json());
  expect(snapshot.tokens).toEqual([]);
  // What the host checks: issued within a second of its clock, expiring within two of the issue.
  expect(snapshot.issued_at - result.arrived).toBeGreaterThanOrEqual(
    HOLD_FROM_MS,
  );
  expect(snapshot.expires_at - snapshot.issued_at).toBeLessThanOrEqual(2000);
});

it("holds at most a bounded number of polls and answers the rest at once", async () => {
  const f = await ready();
  expect((await poll(f.node, f.agent)).response.status).toBe(404);
  const real = globalThis.setTimeout;
  const tick = () => new Promise<void>((resolve) => real(resolve, 1));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  // Past the warm-up poll's hold, which a clock stepped through left ahead of the real one.
  vi.setSystemTime(Date.now() + 4000);
  const answered: number[] = [];
  const polls = Array.from({ length: 80 }, () =>
    request(`/agent/v1/nodes/${f.node}/reclaim`, f.agent).then((response) => {
      answered.push(response.status);
    }),
  );
  for (let i = 0; i < 2000 && answered.length < 80 - 64; i++) await tick();
  // The held ones wait on their timers; the others came back without waiting for the clock.
  expect(answered.length).toBe(80 - 64);
  expect(vi.getTimerCount()).toBe(64);
  await vi.advanceTimersByTimeAsync(HOLD_TO_MS);
  await Promise.all(polls);
  expect(answered).toHaveLength(80);
  expect(new Set(answered)).toEqual(new Set([404]));
});

it("shows a qualification at once to the isolate that made it", async () => {
  let early = 0;
  const f = await qualified({
    before: async (ready) => {
      early = (await poll(ready.node, ready.agent)).response.status;
    },
  });
  expect(early).toBe(404);
  // The unqualified answer of a moment ago does not outlive the grant that ended it.
  const now = await poll(f.node, f.agent);
  expect(now.response.status).toBe(200);
  expect(now.heldMs).toBe(0);
});

it("shows a qualification another isolate made within the cache bound", async () => {
  let early = 0,
    learned = 0;
  const f = await qualified({
    viaSql: true,
    before: async (ready) => {
      learned = Date.now();
      early = (await poll(ready.node, ready.agent)).response.status;
    },
  });
  expect(early).toBe(404);
  // A second after the answer was learned: still the cached answer, since nothing here can know
  // of a write another isolate made.
  const within = await poll(f.node, f.agent, learned + 1000 - Date.now());
  expect(within.response.status).toBe(404);
  // Ten seconds on, the node is read again and found qualified.
  const later = await poll(f.node, f.agent, learned + 10_000 - Date.now());
  expect(later.response.status).toBe(200);
});

it("does not remember an unqualified answer that a qualification overtook", async () => {
  const prototype = Object.getPrototypeOf(env.DB) as D1Database;
  const prepare = prototype.prepare;
  let release!: () => void,
    reached!: () => void,
    armed = false;
  const gate = new Promise<void>((resolve) => (release = resolve)),
    atGate = new Promise<void>((resolve) => (reached = resolve));
  const gated = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => gated(target.bind(...values));
        if (property === "first")
          return async (...args: unknown[]) => {
            const row = await Reflect.apply(
              Reflect.get(target, property) as (...a: unknown[]) => unknown,
              target,
              args,
            );
            reached();
            await gate;
            return row;
          };
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  // The poll's own read of the node answers "no qualification" and then waits, before it can
  // remember that answer, while the qualification is written.
  vi.spyOn(prototype, "prepare").mockImplementation(function (
    this: D1Database,
    sql: string,
  ) {
    const statement = prepare.call(this, sql);
    if (
      armed &&
      sql.startsWith(
        "SELECT n.region_id,n.node_uid,n.warm_reclaim_qualification_json",
      )
    ) {
      armed = false;
      return gated(statement);
    }
    return statement;
  });
  let early: Promise<Response> | undefined;
  const f = await qualified({
    before: async (unqualifiedNode) => {
      armed = true;
      early = request(
        `/agent/v1/nodes/${unqualifiedNode.node}/reclaim`,
        unqualifiedNode.agent,
      );
      await atGate;
    },
  });
  const real = globalThis.setTimeout;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  release();
  for (let i = 0; i < 5000 && vi.getTimerCount() === 0; i++)
    await new Promise((r) => real(r, 1));
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(RECLAIM_HOLD_MS);
  expect((await early!).status).toBe(404);
  vi.useRealTimers();
  const next = await poll(f.node, f.agent);
  expect(next.response.status).toBe(200);
  expect(next.heldMs).toBe(0);
});
