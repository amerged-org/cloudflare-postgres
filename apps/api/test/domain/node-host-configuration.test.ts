// SPDX-License-Identifier: Apache-2.0
import { env as bindings } from "cloudflare:workers";
import { createApp } from "../../src/app.ts";
const env = {
  ...bindings,
  NODE_BOOTSTRAP_CALLBACK_URL: "https://api.invalid/",
};
import { afterEach, expect, it } from "vitest";
import { fixture, cleanupFixtures } from "./fixtures.ts";
async function request(
  path: string,
  key: string,
  method = "GET",
  body?: unknown,
) {
  return createApp().request(
    path,
    {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
}
import {
  importRegionAgentKey,
  joinBundleReference,
  storeRegionJoinBundle,
} from "../../src/crypto/bootstrap-credentials.ts";
import {
  loadNodeHostConfiguration,
  ensureNodeHostConfiguration,
} from "../../src/domain/node-host-configuration.ts";
import generated from "../../../../packages/contracts/native/compute-pool.generated.json" with { type: "json" };
import { bytesToBase64url, DatabaseWithOperation } from "@pgcf/contracts";
import { installationHash } from "../../src/domain/node-installation.ts";
const releases: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
async function configured(
  spec: Record<string, unknown> = {},
  seedDatabase = false,
) {
  const f = await fixture(),
    uid = (await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
      .bind(f.node)
      .first<{ node_uid: string }>())!.node_uid,
    id = "host-" + crypto.randomUUID(),
    cluster = crypto.randomUUID(),
    now = new Date().toISOString(),
    policy = {
      ...generated.lease.policy,
      profile: { ...generated.lease.policy.profile, release_id: id },
    };
  releases.push(id);
  let database: { id: string } | undefined;
  if (seedDatabase) {
    const response = await f.create("thick-restart");
    expect(response.status).toBe(202);
    database = DatabaseWithOperation.parse(await response.json()).database;
    // Establish the retained thick assignment; this fixture exercises host custody, not startup placement.
    await env.DB.prepare("UPDATE databases SET node_id=? WHERE id=?")
      .bind(f.node, database.id)
      .run();
  }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO fleet_releases VALUES(?,?,?,?)").bind(
      id,
      JSON.stringify(spec),
      "a".repeat(64),
      now,
    ),
    env.DB.prepare("INSERT INTO fleet_region_releases VALUES(?,?,1,?)").bind(
      f.region,
      id,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO fleet_node_releases VALUES(?,?,?,'customer',1,?)",
    ).bind(f.node, uid, id, now),
    env.DB.prepare(
      "INSERT INTO node_compute_pool_policies VALUES(?,?,1,?,?,?)",
    ).bind(f.node, uid, id, JSON.stringify(policy), now),
    env.DB.prepare(
      "UPDATE regions SET bootstrap_material_revision=1 WHERE id=?",
    ).bind(f.region),
  ]);
  await importRegionAgentKey(env.DB, env, f.region, f.agent);
  await storeRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 1),
    {
      version: 1,
      cluster_name: "test-host",
      cluster_endpoint: "https://127.0.0.1:6443/",
      talos_version: "1.14.1",
      kubernetes_version: "1.36.5",
      talos_machine_secrets_yaml: "fixture-machine",
      talos_admin_config: "fixture-admin",
      kube_system_uid: cluster,
      kubeconfig: "fixture-kube",
    },
  );
  return { ...f, uid, cluster, policy, database };
}
it("seals the exact CF thick restart cohort and selected public trust; deletion preserves safe historical exemptions and key drift refuses loading", async () => {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) throw Error("fixture key invalid");
  const publicKey = await crypto.subtle.exportKey("raw", pair.publicKey),
    privateKey = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  if (
    !(publicKey instanceof ArrayBuffer) ||
    !(privateKey instanceof ArrayBuffer)
  )
    throw Error("fixture key invalid");
  const keys = {
      cf: bytesToBase64url(new Uint8Array(publicKey)),
    },
    pin = await installationHash(keys),
    f = await configured({ storage_authority_keys_sha256: pin }, true),
    local = {
      ...env,
      BOOTSTRAP_RELAY_SIGNING_KEYS: JSON.stringify({
        active: "cf",
        keys: {
          cf: bytesToBase64url(new Uint8Array(privateKey)),
        },
      }),
      BOOTSTRAP_VERIFIER_KEYS: JSON.stringify(keys),
    };
  const database = f.database!;
  const status = await ensureNodeHostConfiguration(local, {
    node_id: f.node,
    node_uid: f.uid,
  });
  const binding = {
    node_id: f.node,
    node_uid: f.uid,
    cluster_uid: f.cluster,
    material_revision: 1,
    revision: status.revision,
    sha256: status.sha256,
  };
  const initial = await loadNodeHostConfiguration(local, binding),
    settings = JSON.parse(initial.files[0].content) as {
      cloudflare: {
        storage_authority: { sha256: string; legacy_database_ids: string[] };
      };
    };
  expect(settings.cloudflare.storage_authority.sha256).toBe(pin);
  expect(settings.cloudflare.storage_authority.legacy_database_ids).toEqual([
    database.id,
  ]);
  await env.DB.prepare(
    "UPDATE databases SET desired_state='deleted',deleted_at=? WHERE id=?",
  )
    .bind(new Date().toISOString(), database.id)
    .run();
  expect((await loadNodeHostConfiguration(local, binding)).files).toEqual(
    initial.files,
  );
  await expect(
    loadNodeHostConfiguration(
      { ...local, BOOTSTRAP_VERIFIER_KEYS: JSON.stringify({ other: keys.cf }) },
      binding,
    ),
  ).rejects.toThrow();
});
it("admin metadata never exposes sealed host files; private leaf derives the current custodied regional key", async () => {
  const f = await configured();
  expect(
    (
      await request(
        `/v1/nodes/${f.node}/host-configuration`,
        f.integrator,
        "PUT",
        { node_uid: f.uid, expected_revision: 0 },
      )
    ).status,
  ).toBe(403);
  const response = await request(
    `/v1/nodes/${f.node}/host-configuration`,
    f.admin,
    "PUT",
    { node_uid: f.uid, expected_revision: 0 },
  );
  expect(response.status).toBe(200);
  const status = (await response.json()) as Record<string, unknown>;
  expect(JSON.stringify(status)).not.toContain(f.agent);
  expect(status).not.toHaveProperty("files");
  const stored = await env.DB.prepare(
    "SELECT ciphertext FROM node_host_configurations WHERE node_id=?",
  )
    .bind(f.node)
    .first<{ ciphertext: string }>();
  expect(stored!.ciphertext).not.toContain(f.agent);
  const payload = await loadNodeHostConfiguration(env, {
    node_id: f.node,
    node_uid: f.uid,
    cluster_uid: f.cluster,
    material_revision: 1,
    revision: 1,
    sha256: String(status.sha256),
  });
  expect(payload.files.map((file) => file.path)).toEqual([
    "/var/lib/pgcf-sandbox/settings.json",
    "/var/lib/pgcf-sandbox/agent-key",
  ]);
  expect(payload.files.every((file) => file.permissions === 384)).toBe(true);
  expect(payload.files[1].content).toBe(f.agent + "\n");
  const settings = JSON.parse(payload.files[0].content);
  expect(settings.cloudflare.node_uid).toBe(f.uid);
  expect(settings.cloudflare.material_revision).toBe(1);
  expect(settings).not.toHaveProperty("kubeconfig");
  expect(settings.cloudflare).not.toHaveProperty("agent_key");
  expect(
    (await request(`/v1/nodes/${f.node}/host-configuration`, f.agent)).status,
  ).toBe(401);
  expect(
    (await request(`/v1/nodes/${f.node}/host-configuration`, f.admin)).status,
  ).toBe(200);
});
it("current physical/cluster/material/hash authority is mandatory, including for the private patch leaf", async () => {
  const f = await configured(),
    status = await ensureNodeHostConfiguration(env, {
      node_id: f.node,
      node_uid: f.uid,
      expected_revision: 0,
    }),
    binding = {
      node_id: f.node,
      node_uid: f.uid,
      cluster_uid: f.cluster,
      material_revision: 1,
      revision: 1,
      sha256: status.sha256,
    };
  await expect(
    loadNodeHostConfiguration(env, {
      ...binding,
      cluster_uid: crypto.randomUUID(),
    }),
  ).rejects.toThrow();
  await expect(
    loadNodeHostConfiguration(env, { ...binding, sha256: "0".repeat(64) }),
  ).rejects.toThrow();
  await env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?")
    .bind(crypto.randomUUID(), f.node)
    .run();
  await expect(loadNodeHostConfiguration(env, binding)).rejects.toThrow();
  await env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?")
    .bind(f.uid, f.node)
    .run();
  await env.DB.prepare(
    "UPDATE regions SET bootstrap_material_revision=2 WHERE id=?",
  )
    .bind(f.region)
    .run();
  await expect(loadNodeHostConfiguration(env, binding)).rejects.toThrow();
});
it("a pool target change preserves identical protected host files; CAS and ciphertext substitution are refused", async () => {
  const f = await configured(),
    status = await ensureNodeHostConfiguration(env, {
      node_id: f.node,
      node_uid: f.uid,
      expected_revision: 0,
    });
  await env.DB.prepare(
    "UPDATE node_compute_pool_policies SET revision=2,policy_json=? WHERE node_id=?",
  )
    .bind(JSON.stringify({ ...f.policy, target_slots: 1 }), f.node)
    .run();
  const unchanged = await ensureNodeHostConfiguration(env, {
    node_id: f.node,
    node_uid: f.uid,
    expected_revision: 1,
  });
  expect(unchanged.revision).toBe(1);
  expect(unchanged.sha256).toBe(status.sha256);
  await expect(
    ensureNodeHostConfiguration(env, {
      node_id: f.node,
      node_uid: f.uid,
      expected_revision: 0,
    }),
  ).rejects.toThrow();
  await env.DB.prepare(
    "UPDATE node_host_configurations SET iv=? WHERE node_id=?",
  )
    .bind("A".repeat(16), f.node)
    .run();
  await expect(
    loadNodeHostConfiguration(env, {
      node_id: f.node,
      node_uid: f.uid,
      cluster_uid: f.cluster,
      material_revision: 1,
      revision: 1,
      sha256: status.sha256,
    }),
  ).rejects.toThrow();
});
it("planned reboot does not block exact sealed configuration recovery while new configuration still requires fresh Ready", async () => {
  const f = await configured(),
    status = await ensureNodeHostConfiguration(env, {
      node_id: f.node,
      node_uid: f.uid,
      expected_revision: 0,
    }),
    binding = {
      node_id: f.node,
      node_uid: f.uid,
      cluster_uid: f.cluster,
      material_revision: 1,
      revision: 1,
      sha256: status.sha256,
    };
  await env.DB.prepare(
    "UPDATE nodes SET ready=0,last_observed_at='2020-01-01T00:00:00.000Z' WHERE id=?",
  )
    .bind(f.node)
    .run();
  expect((await loadNodeHostConfiguration(env, binding)).status.sha256).toBe(
    status.sha256,
  );
  await expect(
    ensureNodeHostConfiguration(env, {
      node_id: f.node,
      node_uid: f.uid,
      expected_revision: 1,
    }),
  ).rejects.toThrow();
  await env.DB.prepare("UPDATE nodes SET lost_at=? WHERE id=?")
    .bind(new Date().toISOString(), f.node)
    .run();
  await expect(loadNodeHostConfiguration(env, binding)).rejects.toThrow();
});
