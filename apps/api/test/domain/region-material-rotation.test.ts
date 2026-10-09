// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { parseApiKey } from "@pgcf/contracts";
import { fixture, cleanupFixtures, request } from "./fixtures.ts";
import {
  storeRegionSeed,
  storeRegionJoinBundle,
  regionSeedReference,
  joinBundleReference,
  loadRegionSeed,
} from "../../src/crypto/bootstrap-credentials.ts";
import { installationHash } from "../../src/domain/node-installation.ts";
afterEach(cleanupFixtures);
async function setup() {
  const f = await fixture(),
    uid = crypto.randomUUID(),
    cluster = crypto.randomUUID();
  await env.DB.prepare(
    "UPDATE nodes SET node_uid=?,provider_instance_id=? WHERE id=?",
  )
    .bind(uid, "12345", f.node)
    .run();
  const seed = {
    version: 1 as const,
    cluster_name: "retained",
    cluster_endpoint: "https://192.0.2.10:6443",
    talos_version: "1.14.2",
    kubernetes_version: "1.36.5",
    talos_machine_secrets_yaml: "original PRIVATE material",
    talos_admin_config: "original PRIVATE Talos config",
  };
  const join = {
    ...seed,
    kube_system_uid: cluster,
    kubeconfig: "original PRIVATE kubeconfig",
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
  const next = {
      ...seed,
      talos_machine_secrets_yaml: "replacement PRIVATE material",
      talos_admin_config: "replacement PRIVATE Talos config",
    },
    nextJoin = {
      ...next,
      kube_system_uid: cluster,
      kubeconfig: "replacement PRIVATE kubeconfig",
    };
  const observed = {
    observed_at: new Date().toISOString(),
    kube_system_uid: cluster,
    talos_version: seed.talos_version,
    kubernetes_version: seed.kubernetes_version,
    nodes: [
      {
        node_id: f.node,
        node_uid: uid,
        k8s_node_name: f.nodeName,
        provider_instance_id: "12345",
      },
    ],
  };
  const common = {
    expected_revision: 1,
    expected_seed_sha256: await installationHash(seed),
    expected_join_sha256: await installationHash(join),
    seed_sha256: await installationHash(next),
    join_sha256: await installationHash(nextJoin),
  };
  const stage = { ...common, seed: next, join: nextJoin, observed };
  const kinds = [
    "talos_api_ca",
    "kubernetes_api_ca",
    "etcd_ca",
    "aggregator_ca",
    "service_account_signer",
    "trustd_token",
    "kubernetes_bootstrap_token",
    "discovery_secret",
    "secret_at_rest_key",
  ];
  const verified = {
    ...observed,
    source: "trusted_admin",
    seed_sha256: common.seed_sha256,
    join_sha256: common.join_sha256,
    transcript_sha256: "e".repeat(64),
    retired_authorities: kinds.map((authority) => ({
      authority,
      prior_sha256: "a".repeat(64),
      replacement_sha256: "b".repeat(64),
      new_access_sha256: "c".repeat(64),
      retired_access_sha256: "d".repeat(64),
      result:
        authority === "discovery_secret" || authority === "secret_at_rest_key"
          ? "retired_from_live_configuration"
          : "rejected",
    })),
  };
  const activate = {
    ...common,
    verified,
    verification_sha256: await installationHash(verified),
  };
  const rows = () =>
    env.DB.prepare(
      "SELECT * FROM region_bootstrap_credentials WHERE region_id=? ORDER BY revision,purpose",
    )
      .bind(f.region)
      .all();
  return {
    ...f,
    seed,
    next,
    stage,
    activate,
    rows,
    path: `/v1/regions/${f.region}/bootstrap-material`,
  };
}
it("stages matching private custody without activating or changing historical ciphertext", async () => {
  const f = await setup(),
    before = (await f.rows()).results,
    key = crypto.randomUUID();
  const response = await request(
    `${f.path}/stage`,
    f.admin,
    "POST",
    f.stage,
    key,
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain("PRIVATE");
  expect(JSON.parse(text)).toMatchObject({
    active_revision: 1,
    staged_revision: 2,
    active: false,
  });
  expect(
    (await request(`${f.path}/stage`, f.admin, "POST", f.stage, key)).status,
  ).toBe(200);
  expect((await f.rows()).results.filter((row) => row.revision === 1)).toEqual(
    before,
  );
  expect((await f.rows()).results).toHaveLength(4);
  expect(
    await env.DB.prepare(
      "SELECT bootstrap_material_revision FROM regions WHERE id=?",
    )
      .bind(f.region)
      .first("bootstrap_material_revision"),
  ).toBe(1);
  expect(
    await loadRegionSeed(
      env.DB,
      env.CREDENTIAL_KEYS,
      regionSeedReference(f.region, 1),
    ),
  ).toEqual(f.seed);
});
it("activates only the exact verified pair and resolves replay from state without rewriting ciphertext", async () => {
  const f = await setup();
  expect(
    (await request(`${f.path}/activate`, f.admin, "POST", f.activate)).status,
  ).toBe(409);
  expect(
    (await request(`${f.path}/stage`, f.admin, "POST", f.stage)).status,
  ).toBe(200);
  const before = (await f.rows()).results;
  expect(
    (await request(`${f.path}/activate`, f.admin, "POST", f.activate)).status,
  ).toBe(200);
  expect(
    (await request(`${f.path}/activate`, f.admin, "POST", f.activate)).status,
  ).toBe(200);
  expect((await f.rows()).results).toEqual(before);
  expect(
    await env.DB.prepare(
      "SELECT bootstrap_material_revision FROM regions WHERE id=?",
    )
      .bind(f.region)
      .first("bootstrap_material_revision"),
  ).toBe(2);
  expect(
    await loadRegionSeed(
      env.DB,
      env.CREDENTIAL_KEYS,
      regionSeedReference(f.region, 2),
    ),
  ).toEqual(f.next);
});
it("resolves two simultaneous identical activation requests to the same selected revision", async () => {
  const f = await setup();
  expect(
    (await request(`${f.path}/stage`, f.admin, "POST", f.stage)).status,
  ).toBe(200);
  const responses = await Promise.all([
    request(
      `${f.path}/activate`,
      f.admin,
      "POST",
      f.activate,
      crypto.randomUUID(),
    ),
    request(
      `${f.path}/activate`,
      f.admin,
      "POST",
      f.activate,
      crypto.randomUUID(),
    ),
  ]);
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  expect((await f.rows()).results).toHaveLength(4);
});
it("rejects forged hashes, partial retirement evidence and changes to retained physical topology", async () => {
  const f = await setup();
  expect(
    (await request(`${f.path}/stage`, f.integrator, "POST", f.stage)).status,
  ).toBe(403);
  const bad = { ...f.stage, seed_sha256: "f".repeat(64) };
  const failure = await request(`${f.path}/stage`, f.admin, "POST", bad);
  expect(failure.status).toBe(409);
  expect(await failure.text()).not.toContain("PRIVATE");
  expect(
    (await request(`${f.path}/stage`, f.admin, "POST", f.stage)).status,
  ).toBe(200);
  expect(
    (
      await request(`${f.path}/activate`, f.admin, "POST", {
        ...f.activate,
        verified: { ...f.activate.verified, retired_authorities: [] },
      })
    ).status,
  ).toBe(400);
  await env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?")
    .bind(crypto.randomUUID(), f.node)
    .run();
  expect(
    (await request(`${f.path}/activate`, f.admin, "POST", f.activate)).status,
  ).toBe(409);
  expect(
    await env.DB.prepare(
      "SELECT bootstrap_material_revision FROM regions WHERE id=?",
    )
      .bind(f.region)
      .first("bootstrap_material_revision"),
  ).toBe(1);
});
it("refuses active uncertain physical actions and preserves ordinary read leases", async () => {
  const f = await setup(),
    now = new Date().toISOString(),
    expires = new Date(Date.now() + 60000).toISOString();
  await env.DB.prepare(
    "INSERT INTO node_thin_storage(node_id,node_uid,cluster_uid,address,volume_group_uuid,profile_revision,profile_sha256,profile_json,material_revision,status,lease_id,lease_expires_at,action_json,created_at,updated_at) VALUES(?,?,?,'192.0.2.10','retained-vg',1,?,'{}',1,'selected','op_abcdefghijklmnopqrst',?,?,?,?)",
  )
    .bind(
      f.node,
      f.stage.observed.nodes[0]!.node_uid,
      f.stage.observed.kube_system_uid,
      "a".repeat(64),
      expires,
      '{"state":"dispatched"}',
      now,
      now,
    )
    .run();
  expect(
    (await request(`${f.path}/stage`, f.admin, "POST", f.stage)).status,
  ).toBe(409);
  await env.DB.prepare(
    "UPDATE node_thin_storage SET action_json=NULL WHERE node_id=?",
  )
    .bind(f.node)
    .run();
  expect(
    (await request(`${f.path}/stage`, f.admin, "POST", f.stage)).status,
  ).toBe(200);
  await env.DB.prepare(
    "UPDATE node_thin_storage SET action_json='{}' WHERE node_id=?",
  )
    .bind(f.node)
    .run();
  expect(
    (await request(`${f.path}/activate`, f.admin, "POST", f.activate)).status,
  ).toBe(409);
  await env.DB.prepare(
    "UPDATE node_thin_storage SET action_json=NULL WHERE node_id=?",
  )
    .bind(f.node)
    .run();
  expect(
    (await request(`${f.path}/activate`, f.admin, "POST", f.activate)).status,
  ).toBe(200);
  expect(
    await env.DB.prepare(
      "SELECT lease_id,lease_expires_at FROM node_thin_storage WHERE node_id=?",
    )
      .bind(f.node)
      .first(),
  ).toEqual({ lease_id: "op_abcdefghijklmnopqrst", lease_expires_at: expires });
});
it("never overwrites a competing staged revision or activates a stale verification", async () => {
  const f = await setup();
  expect(
    (await request(`${f.path}/stage`, f.admin, "POST", f.stage)).status,
  ).toBe(200);
  const before = (await f.rows()).results;
  const seed = { ...f.next, talos_admin_config: "different PRIVATE config" },
    join = { ...f.stage.join, ...seed };
  expect(
    (
      await request(`${f.path}/stage`, f.admin, "POST", {
        ...f.stage,
        seed,
        join,
        seed_sha256: await installationHash(seed),
        join_sha256: await installationHash(join),
      })
    ).status,
  ).toBe(409);
  const verified = {
    ...f.activate.verified,
    observed_at: new Date(Date.now() - 121000).toISOString(),
  };
  expect(
    (
      await request(`${f.path}/activate`, f.admin, "POST", {
        ...f.activate,
        verified,
        verification_sha256: await installationHash(verified),
      })
    ).status,
  ).toBe(409);
  expect((await f.rows()).results).toEqual(before);
});
it("accepts bounded private stage bodies above64KiB only after admin authorization", async () => {
  const f = await setup(),
    seed = {
      ...f.next,
      talos_machine_secrets_yaml: "PRIVATE" + "x".repeat(40000),
    },
    join = { ...f.stage.join, ...seed };
  const body = {
    ...f.stage,
    seed,
    join,
    seed_sha256: await installationHash(seed),
    join_sha256: await installationHash(join),
  };
  expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeGreaterThan(
    64 * 1024,
  );
  expect(
    (await request(`${f.path}/stage`, f.integrator, "POST", body)).status,
  ).toBe(403);
  const response = await request(`${f.path}/stage`, f.admin, "POST", body);
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain("PRIVATE");
  const tooLarge = await request(`${f.path}/stage`, f.admin, "POST", {
    ...body,
    extra: "x".repeat(512 * 1024),
  });
  expect(tooLarge.status).toBe(400);
  expect(await tooLarge.text()).toContain("512 KiB");
});
it("revoked administrator authority cannot activate or replay staged custody", async () => {
  const f = await setup(),
    key = crypto.randomUUID();
  expect(
    (await request(`${f.path}/stage`, f.admin, "POST", f.stage, key)).status,
  ).toBe(200);
  await env.DB.prepare("UPDATE api_keys SET revoked_at=? WHERE lookup_id=?")
    .bind(new Date().toISOString(), parseApiKey(f.admin)!.lookupId)
    .run();
  expect(
    (await request(`${f.path}/activate`, f.admin, "POST", f.activate)).status,
  ).toBe(401);
  expect(
    (await request(`${f.path}/stage`, f.admin, "POST", f.stage, key)).status,
  ).toBe(401);
  expect(
    await env.DB.prepare(
      "SELECT bootstrap_material_revision FROM regions WHERE id=?",
    )
      .bind(f.region)
      .first("bootstrap_material_revision"),
  ).toBe(1);
});
