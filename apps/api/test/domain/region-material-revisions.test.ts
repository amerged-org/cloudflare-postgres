// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import {
  joinBundleReference,
  loadCurrentRegionMaterialReference,
  regionSeedReference,
  storeRegionJoinBundle,
  storeRegionSeed,
  loadRegionJoinBundle,
  loadRegionSeed,
} from "../../src/crypto/bootstrap-credentials.ts";
import { installationHash } from "../../src/domain/node-installation.ts";
import {
  configureNodeRegionPolicy,
  reserveNodeAddition,
} from "../../src/domain/node-state.ts";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
});
async function setup() {
  const f = await fixture();
  const uid = crypto.randomUUID(),
    cluster = crypto.randomUUID();
  await env.DB.prepare(
    "UPDATE nodes SET node_uid=?,provider_instance_id=? WHERE id=?",
  )
    .bind(uid, "12345", f.node)
    .run();
  const seed = {
    version: 1 as const,
    cluster_name: "retained-cluster",
    cluster_endpoint: "https://192.0.2.10:6443",
    talos_version: "1.14.1",
    kubernetes_version: "1.36.3",
    talos_machine_secrets_yaml: "retained machine secrets\n",
    talos_admin_config: "retained Talos administration\n",
  };
  const join = {
    ...seed,
    kube_system_uid: cluster,
    kubeconfig: "retained certificate kubeconfig\n",
  };
  await storeRegionSeed(
    env.DB,
    env.CREDENTIAL_KEYS,
    regionSeedReference(f.region, 1),
    seed,
  );
  await storeRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 1),
    join,
  );
  const desiredSeed = { ...seed, kubernetes_version: "1.36.5" };
  const desiredJoin = { ...join, kubernetes_version: "1.36.5" };
  const observed = {
    observed_at: new Date().toISOString(),
    kube_system_uid: cluster,
    kubernetes_version: "1.36.5",
    nodes: [
      {
        node_id: f.node,
        node_uid: uid,
        k8s_node_name: f.nodeName,
        provider_instance_id: "12345",
      },
    ],
  };
  const body = {
    expected_revision: 1,
    kubernetes_version: "1.36.5",
    expected_seed_sha256: await installationHash(seed),
    expected_join_sha256: await installationHash(join),
    seed_sha256: await installationHash(desiredSeed),
    join_sha256: await installationHash(desiredJoin),
    provenance_sha256: await installationHash(observed),
    observed,
  };
  const rows = () =>
    env.DB.prepare(
      "SELECT * FROM region_bootstrap_credentials WHERE region_id=? ORDER BY purpose,revision",
    )
      .bind(f.region)
      .all();
  return { ...f, uid, seed, join, desiredSeed, desiredJoin, body, rows };
}

it("activates only a metadata revision after verified upgrade while keeping historical encrypted custody unchanged", async () => {
  const f = await setup(),
    before = (await f.rows()).results;
  const response = await request(
    `/v1/regions/${f.region}/bootstrap-material`,
    f.admin,
    "POST",
    f.body,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    region_id: f.region,
    revision: 2,
    kubernetes_version: "1.36.5",
    provenance_sha256: f.body.provenance_sha256,
  });
  expect(
    await env.DB.prepare(
      "SELECT bootstrap_material_revision,bootstrap_material_provenance_sha256 FROM regions WHERE id=?",
    )
      .bind(f.region)
      .first(),
  ).toEqual({
    bootstrap_material_revision: 2,
    bootstrap_material_provenance_sha256: f.body.provenance_sha256,
  });
  expect((await f.rows()).results.filter((x) => x.revision === 1)).toEqual(
    before,
  );
  expect(
    await loadRegionSeed(
      env.DB,
      env.CREDENTIAL_KEYS,
      regionSeedReference(f.region, 2),
    ),
  ).toEqual(f.desiredSeed);
  expect(
    await loadRegionJoinBundle(
      env.DB,
      env.CREDENTIAL_KEYS,
      joinBundleReference(f.region, 2),
    ),
  ).toEqual(f.desiredJoin);
  expect(
    await loadRegionJoinBundle(
      env.DB,
      env.CREDENTIAL_KEYS,
      joinBundleReference(f.region, 1),
    ),
  ).toEqual(f.join);
});

it("does not activate an immutable staged pair and resolves an exact replay without new custody writes", async () => {
  const f = await setup();
  await storeRegionSeed(
    env.DB,
    env.CREDENTIAL_KEYS,
    regionSeedReference(f.region, 2),
    f.desiredSeed,
  );
  await storeRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 2),
    f.desiredJoin,
  );
  expect(
    (await loadCurrentRegionMaterialReference(env.DB, f.region, "join_bundle"))
      .revision,
  ).toBe(1);
  const staged = (await f.rows()).results;
  const first = await request(
    `/v1/regions/${f.region}/bootstrap-material`,
    f.admin,
    "POST",
    f.body,
  );
  expect(first.status).toBe(200);
  expect((await f.rows()).results).toEqual(staged);
  expect(
    (await loadCurrentRegionMaterialReference(env.DB, f.region, "join_bundle"))
      .revision,
  ).toBe(2);
  expect(
    (
      await request(
        `/v1/regions/${f.region}/bootstrap-material`,
        f.admin,
        "POST",
        f.body,
      )
    ).status,
  ).toBe(200);
  expect((await f.rows()).results).toEqual(staged);
  const status = await request(
    `/v1/regions/${f.region}/bootstrap-material`,
    f.admin,
  );
  expect(status.status).toBe(200);
  expect(Object.keys(await status.json()).sort()).toEqual([
    "join_sha256",
    "kubernetes_version",
    "provenance_sha256",
    "region_id",
    "revision",
    "seed_sha256",
  ]);
});

it("blocks synchronization while another region has an active addition", async () => {
  const f = await setup();
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.foreign,
    max_nodes: 2,
    purchases_enabled: false,
    order: null,
  });
  await reserveNodeAddition(env.DB, {
    request_key: crypto.randomUUID(),
    request: {
      mode: "adopt",
      region_id: f.foreign,
      provider_instance_id: "54321",
    },
  });
  const before = (await f.rows()).results;
  expect(
    (
      await request(
        `/v1/regions/${f.region}/bootstrap-material`,
        f.admin,
        "POST",
        f.body,
      )
    ).status,
  ).toBe(409);
  expect((await f.rows()).results).toEqual(before);
  expect(
    (await loadCurrentRegionMaterialReference(env.DB, f.region, "join_bundle"))
      .revision,
  ).toBe(1);
});

it("never overwrites conflicting staged keys or accepts an unverified cluster identity", async () => {
  const f = await setup();
  await storeRegionSeed(
    env.DB,
    env.CREDENTIAL_KEYS,
    regionSeedReference(f.region, 2),
    {
      ...f.desiredSeed,
      talos_machine_secrets_yaml: "different keys are forbidden\n",
    },
  );
  const before = (await f.rows()).results;
  expect(
    (
      await request(
        `/v1/regions/${f.region}/bootstrap-material`,
        f.admin,
        "POST",
        f.body,
      )
    ).status,
  ).toBe(409);
  expect((await f.rows()).results).toEqual(before);
  const changed = {
    ...f.body,
    observed: { ...f.body.observed, kube_system_uid: crypto.randomUUID() },
  };
  changed.provenance_sha256 = await installationHash(changed.observed);
  expect(
    (
      await request(
        `/v1/regions/${f.region}/bootstrap-material`,
        f.admin,
        "POST",
        changed,
      )
    ).status,
  ).toBe(409);
  expect(
    (await loadCurrentRegionMaterialReference(env.DB, f.region, "join_bundle"))
      .revision,
  ).toBe(1);
});

it("atomically selects one provenance across competing activation requests", async () => {
  const f = await setup();
  const second = {
    ...f.body,
    observed: {
      ...f.body.observed,
      observed_at: new Date(
        Date.parse(f.body.observed.observed_at) - 1,
      ).toISOString(),
    },
  };
  second.provenance_sha256 = await installationHash(second.observed);
  const responses = await Promise.all([
    request(
      `/v1/regions/${f.region}/bootstrap-material`,
      f.admin,
      "POST",
      f.body,
    ),
    request(
      `/v1/regions/${f.region}/bootstrap-material`,
      f.admin,
      "POST",
      second,
    ),
  ]);
  expect(responses.map((x) => x.status).sort()).toEqual([200, 409]);
  const winner = responses[0]!.status === 200 ? f.body : second;
  expect(
    await env.DB.prepare(
      "SELECT bootstrap_material_revision,bootstrap_material_provenance_sha256 FROM regions WHERE id=?",
    )
      .bind(f.region)
      .first(),
  ).toEqual({
    bootstrap_material_revision: 2,
    bootstrap_material_provenance_sha256: winner.provenance_sha256,
  });
});

it("rejects non-administrator updates and embedded-NUL provenance in the SQL constraint", async () => {
  const f = await setup();
  expect(
    (
      await request(
        `/v1/regions/${f.region}/bootstrap-material`,
        f.integrator,
        "POST",
        f.body,
      )
    ).status,
  ).toBe(403);
  await expect(
    env.DB.prepare(
      "UPDATE regions SET bootstrap_material_provenance_sha256=? WHERE id=?",
    )
      .bind("a".repeat(64) + "\0suffix", f.region)
      .run(),
  ).rejects.toThrow();
  expect(
    (await loadCurrentRegionMaterialReference(env.DB, f.region, "join_bundle"))
      .revision,
  ).toBe(1);
});

it("requires exact provenance even when resolving an already completed activation", async () => {
  const f = await setup();
  expect(
    (
      await request(
        `/v1/regions/${f.region}/bootstrap-material`,
        f.admin,
        "POST",
        f.body,
      )
    ).status,
  ).toBe(200);
  const changed = {
    ...f.body,
    observed: { ...f.body.observed, kube_system_uid: crypto.randomUUID() },
  };
  expect(
    (
      await request(
        `/v1/regions/${f.region}/bootstrap-material`,
        f.admin,
        "POST",
        changed,
      )
    ).status,
  ).toBe(409);
});

it("fences expired administrator readback at the actual D1 activation boundary", async () => {
  const f = await setup();
  const at = Date.now() - 120001;
  f.body.observed.observed_at = new Date(at).toISOString();
  f.body.provenance_sha256 = await installationHash(f.body.observed);
  // The Worker clock allows the initial check; D1's real current clock must still
  // reject expired provenance after asynchronous encryption and immutable staging.
  vi.spyOn(Date, "now").mockReturnValue(at);
  expect(
    (
      await request(
        `/v1/regions/${f.region}/bootstrap-material`,
        f.admin,
        "POST",
        f.body,
      )
    ).status,
  ).toBe(409);
  expect(
    (await loadCurrentRegionMaterialReference(env.DB, f.region, "join_bundle"))
      .revision,
  ).toBe(1);
});
