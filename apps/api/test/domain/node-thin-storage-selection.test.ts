// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import {
  bytesToBase64url,
  ThinStorageProfile,
  DatabaseWithOperation,
  thinStorageClass,
} from "@pgcf/contracts";
import { FleetReleaseSpec } from "@pgcf/contracts/releases";
import { NodeThinStorageState } from "@pgcf/contracts/node-thin-storage";
import { createApp } from "../../src/app.ts";
import type { Env } from "../../src/env.ts";
import { cleanupFixtures, fixture } from "./fixtures.ts";
import {
  configureNodeThinStorage,
  thinVolumeProfile,
} from "../../src/domain/node-thin-storage-selection.ts";
import { configureNodeRegionPolicy } from "../../src/domain/node-state.ts";
import { storageAuthorityPublicKeys } from "../../src/domain/storage-authority.ts";
import { thinExecutionFixture } from "./thin-execution-fixture.ts";
import {
  installationHash,
  canonicalInstallation,
} from "../../src/domain/node-installation.ts";
import {
  storeRegionJoinBundle,
  joinBundleReference,
} from "../../src/crypto/bootstrap-credentials.ts";
const releaseIds: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of releaseIds.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
async function setup() {
  const f = await fixture(),
    uid = crypto.randomUUID(),
    cuid = crypto.randomUUID(),
    at = new Date().toISOString();
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) throw new Error("fixture_keypair_invalid");
  const pk = await crypto.subtle.exportKey("pkcs8", pair.privateKey),
    pub = await crypto.subtle.exportKey("raw", pair.publicKey);
  if (!(pk instanceof ArrayBuffer) || !(pub instanceof ArrayBuffer))
    throw new Error("fixture_keypair_invalid");
  const selected = {
    ...env,
    NODE_PROOF_SIGNING_KEY_ID: "cf",
    BOOTSTRAP_RELAY_SIGNING_KEYS: JSON.stringify({
      active: "cf",
      keys: { cf: bytesToBase64url(new Uint8Array(pk)) },
    }),
    BOOTSTRAP_VERIFIER_KEYS: JSON.stringify({
      cf: bytesToBase64url(new Uint8Array(pub)),
    }),
  } as Env;
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
    "native-gateway",
    "pgcf-sandbox-controller",
  ];
  const components = names.map((name) => ({
    name,
    kind: name === "api" || name === "edge" ? "worker_bundle" : "image",
    version: name === "postgres" ? "18.6" : "1.0.0",
    reference: `registry.invalid/${name}@sha256:${"a".repeat(64)}`,
    sha256: "a".repeat(64),
  }));
  const role = {
    talos_version: "1.14.1",
    talos_installer: `registry.invalid/talos@sha256:${"b".repeat(64)}`,
    talos_schematic_sha256: "c".repeat(64),
    talos_extensions: ["pgcf-sandbox-controller"],
    kubernetes_version: "1.36.5",
    components: names.slice(3),
    host_configuration_required: true,
  };
  const spec = FleetReleaseSpec.parse({
      version: 1,
      versions_lock_sha256: "d".repeat(64),
      configuration_schema_revision: 1,
      storage_authority_keys_sha256: (
        await storageAuthorityPublicKeys(selected)
      ).sha256,
      components,
      roles: { control_relay: role, customer: role },
    }),
    release = `thin-${crypto.randomUUID()}`;
  releaseIds.push(release);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE nodes SET node_uid=?,provider_instance_id='fixture-instance',last_observed_at=? WHERE id=?",
    ).bind(uid, at, f.node),
    env.DB.prepare(
      "UPDATE regions SET bootstrap_material_revision=1 WHERE id=?",
    ).bind(f.region),
    env.DB.prepare(
      "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES(?,?,?,?)",
    ).bind(
      release,
      canonicalInstallation(spec),
      await installationHash(spec),
      at,
    ),
    env.DB.prepare(
      "INSERT INTO fleet_region_releases(region_id,release_id,revision,updated_at) VALUES(?,?,1,?)",
    ).bind(f.region, release, at),
    env.DB.prepare(
      "INSERT INTO fleet_node_releases(node_id,node_uid,release_id,role,revision,updated_at) VALUES(?,?,?,'customer',1,?)",
    ).bind(f.node, uid, release, at),
  ]);
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
      kube_system_uid: cuid,
      kubeconfig: "test-only",
    },
  );
  const profile = ThinStorageProfile.parse({
    version: 1,
    driver_image: components.find((c) => c.name === "openebs-lvm")!.reference,
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
  const body = {
    expected_revision: 0,
    node_uid: uid,
    address: "192.0.2.18",
    volume_group_uuid: "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef",
    profile,
    allow_new_databases: false,
  };
  const call = async (
    method: string,
    value?: unknown,
    key = f.admin,
    idempotency?: string,
  ) => {
    const ctx = createExecutionContext();
    const response = await createApp().fetch(
      new Request(`https://api.invalid/v1/nodes/${f.node}/storage-profile`, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          ...(idempotency ? { "Idempotency-Key": idempotency } : {}),
        },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      }),
      selected,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
  };
  return { ...f, selected, uid, cuid, body, profile, call };
}
it("exposes an authenticated CAS profile API and idempotent replay without authorizing physical writes or placement", async () => {
  const f = await setup();
  expect((await f.call("GET")).status).toBe(404);
  expect((await f.call("PUT", f.body, f.integrator)).status).toBe(403);
  const key = crypto.randomUUID(),
    r = await f.call("PUT", f.body, f.admin, key);
  expect(r.status).toBe(200);
  const value = NodeThinStorageState.parse(await r.json());
  expect(value).toMatchObject({
    revision: 1,
    allow_new_databases: false,
    status: "selected",
  });
  expect(await (await f.call("PUT", f.body, f.admin, key)).json()).toEqual(
    value,
  );
  expect((await f.call("PUT", f.body)).status).toBe(409);
  expect(await (await f.call("GET")).json()).toEqual(value);
  expect(
    await env.DB.prepare(
      "SELECT cluster_uid,authority_revision,lease_id,action_json FROM node_thin_storage WHERE node_id=?",
    )
      .bind(f.node)
      .first(),
  ).toEqual({
    cluster_uid: f.cuid,
    authority_revision: 0,
    lease_id: null,
    action_json: null,
  });
});
it("pins physical identity, current release driver and storage public keys and refuses unqualified activation", async () => {
  const f = await setup();
  await expect(
    configureNodeThinStorage(f.selected, f.node, {
      ...f.body,
      node_uid: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  await expect(
    configureNodeThinStorage(f.selected, f.node, {
      ...f.body,
      profile: {
        ...f.profile,
        driver_image: `registry.invalid/other@sha256:${"a".repeat(64)}`,
      },
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  await expect(
    configureNodeThinStorage(
      {
        ...f.selected,
        BOOTSTRAP_VERIFIER_KEYS: JSON.stringify({
          other: JSON.parse(f.selected.BOOTSTRAP_VERIFIER_KEYS).cf,
        }),
      },
      f.node,
      f.body,
    ),
  ).rejects.toBeDefined();
  await expect(
    configureNodeThinStorage(f.selected, f.node, {
      ...f.body,
      allow_new_databases: true,
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) count FROM node_thin_storage WHERE node_id=?",
    )
      .bind(f.node)
      .first("count"),
  ).toBe(0);
});
it("activates qualified native storage through the proved Talos host service without requiring a sandbox-controller Pod", async () => {
  const f = await thinExecutionFixture(releaseIds),
    spec = structuredClone(f.qualified.spec),
    sandbox = spec.components.find((c) => c.name === "sandbox-controller")!;
  spec.components = spec.components.filter((c) => c.name !== "regional");
  spec.components.push({
    name: "native-controller",
    kind: "image",
    version: "1.0.0",
    reference: `registry.example/native-controller@sha256:${"f".repeat(64)}`,
    sha256: "f".repeat(64),
  });
  for (const role of Object.values(spec.roles))
    role.components = role.components.map((name) =>
      name === "regional" ? "native-controller" : name,
    );
  const release = `native-thin-${crypto.randomUUID()}`,
    approved = FleetReleaseSpec.parse(spec),
    specSha = await installationHash(approved),
    profileSha = await installationHash(thinVolumeProfile(f.profile)),
    pool = JSON.parse(
      (await env.DB.prepare(
        "SELECT policy_json FROM node_compute_pool_policies WHERE node_id=?",
      )
        .bind(f.node)
        .first<string>("policy_json"))!,
    );
  pool.profile.image = sandbox.reference;
  pool.profile.release_id = release;
  const runtimeSha = await installationHash(pool.profile),
    receipt = {
      ...f.qualified.qualification,
      release_id: release,
      spec_sha256: specSha,
    },
    authority = {
      ...f.authority,
      profile_sha256: profileSha,
      storage_class: thinStorageClass(profileSha),
    };
  releaseIds.push(release);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES(?,?,?,?)",
    ).bind(release, canonicalInstallation(approved), specSha, f.qualified.at),
    env.DB.prepare(
      "UPDATE fleet_region_releases SET release_id=? WHERE region_id=?",
    ).bind(release, f.region),
    env.DB.prepare(
      "UPDATE fleet_node_releases SET release_id=? WHERE node_id=?",
    ).bind(release, f.node),
    env.DB.prepare(
      "UPDATE node_compute_pool_policies SET release_id=?,policy_json=? WHERE node_id=?",
    ).bind(release, JSON.stringify(pool), f.node),
    env.DB.prepare(
      "UPDATE node_host_configurations SET release_id=?,profile_sha256=? WHERE node_id=?",
    ).bind(release, runtimeSha, f.node),
    env.DB.prepare(
      "UPDATE fleet_patch_operations SET release_id=?,spec_sha256=?,observed_json=json_set(observed_json,'$.runtime_admission_sha256',?) WHERE node_id=?",
    ).bind(release, specSha, runtimeSha, f.node),
    env.DB.prepare(
      "UPDATE node_thin_storage SET profile_sha256=?,profile_json=?,qualification_json=?,authority_json=?,allow_new_databases=0 WHERE node_id=?",
    ).bind(
      profileSha,
      canonicalInstallation(f.profile),
      JSON.stringify(receipt),
      JSON.stringify(authority),
      f.node,
    ),
  ]);
  const select = () =>
    configureNodeThinStorage(f.local, f.node, {
      expected_revision: 1,
      node_uid: f.uid,
      address: "192.0.2.18",
      volume_group_uuid: authority.volume_group_uuid,
      profile: f.profile,
      allow_new_databases: true,
    });
  const missingExtension = structuredClone(approved);
  missingExtension.roles.customer.talos_extensions = ["schematic"];
  const missingRelease = `missing-ext-${crypto.randomUUID()}`;
  releaseIds.push(missingRelease);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES(?,?,?,?)",
    ).bind(
      missingRelease,
      canonicalInstallation(missingExtension),
      await installationHash(missingExtension),
      f.qualified.at,
    ),
    env.DB.prepare(
      "UPDATE fleet_node_releases SET release_id=? WHERE node_id=?",
    ).bind(missingRelease, f.node),
  ]);
  await expect(select()).rejects.toBeDefined();
  await env.DB.prepare(
    "UPDATE fleet_node_releases SET release_id=? WHERE node_id=?",
  )
    .bind(release, f.node)
    .run();
  await env.DB.prepare(
    "UPDATE node_thin_storage SET qualification_json=json_set(qualification_json,'$.software.host_extension_image',?) WHERE node_id=?",
  )
    .bind(`registry.example/other@sha256:${"c".repeat(64)}`, f.node)
    .run();
  await expect(select()).rejects.toMatchObject({ code: "conflict" });
  await env.DB.prepare(
    "UPDATE node_thin_storage SET qualification_json=? WHERE node_id=?",
  )
    .bind(JSON.stringify(receipt), f.node)
    .run();
  await env.DB.prepare(
    "UPDATE fleet_patch_operations SET observed_json=json_remove(observed_json,'$.runtime_admission_sha256') WHERE node_id=?",
  )
    .bind(f.node)
    .run();
  await expect(select()).rejects.toMatchObject({ code: "conflict" });
  await env.DB.prepare(
    "UPDATE fleet_patch_operations SET observed_json=json_set(observed_json,'$.runtime_admission_sha256',?) WHERE node_id=?",
  )
    .bind(runtimeSha, f.node)
    .run();
  expect(approved.roles.customer.components).not.toContain(
    "sandbox-controller",
  );
  expect(await select()).toMatchObject({
    revision: 2,
    allow_new_databases: true,
  });
});
it("preserves an uncertain dispatched pool write and only clears an expired known-negative pending action", async () => {
  const f = await setup();
  await configureNodeThinStorage(f.selected, f.node, f.body);
  const action = {
    kind: "initialize",
    state: "dispatched",
    nonce: "op_" + "a".repeat(20),
    target_data_bytes: f.profile.initial_data_bytes,
    target_metadata_bytes: f.profile.metadata_bytes,
    expected_pool_uuid: null,
    driver_pod_uid: crypto.randomUUID(),
    boot_id: crypto.randomUUID(),
    dispatched_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 30000).toISOString(),
  };
  await env.DB.prepare(
    "UPDATE node_thin_storage SET action_json=?,lease_id='op_aaaaaaaaaaaaaaaaaaaa',lease_expires_at='2000-01-01T00:00:00.000Z' WHERE node_id=?",
  )
    .bind(JSON.stringify(action), f.node)
    .run();
  await expect(
    configureNodeThinStorage(f.selected, f.node, {
      ...f.body,
      expected_revision: 1,
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(
    await env.DB.prepare(
      "SELECT action_json FROM node_thin_storage WHERE node_id=?",
    )
      .bind(f.node)
      .first("action_json"),
  ).toBe(JSON.stringify(action));
  await env.DB.prepare(
    "UPDATE node_thin_storage SET action_json=? WHERE node_id=?",
  )
    .bind(JSON.stringify({ ...action, state: "pending" }), f.node)
    .run();
  expect(
    await configureNodeThinStorage(f.selected, f.node, {
      ...f.body,
      expected_revision: 1,
    }),
  ).toMatchObject({ revision: 2, status: "selected" });
  expect(
    await env.DB.prepare(
      "SELECT action_json FROM node_thin_storage WHERE node_id=?",
    )
      .bind(f.node)
      .first("action_json"),
  ).toBeNull();
});
it("preserves the standing regional template when omitted and clears only explicit null", async () => {
  const f = await setup(),
    policy = {
      region_id: f.region,
      max_nodes: 3,
      purchases_enabled: false,
      order: null,
      thin_storage: f.profile,
    };
  await configureNodeRegionPolicy(env.DB, policy);
  const read = () =>
    env.DB.prepare(
      "SELECT thin_storage_json FROM node_region_policies WHERE region_id=?",
    )
      .bind(f.region)
      .first<string>("thin_storage_json");
  expect(JSON.parse((await read())!)).toEqual(f.profile);
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 3,
    purchases_enabled: false,
    order: null,
  });
  expect(JSON.parse((await read())!)).toEqual(f.profile);
  await configureNodeRegionPolicy(env.DB, { ...policy, thin_storage: null });
  expect(await read()).toBeNull();
});

it("retains the immutable class and refuses quota-cap changes below an already assigned thin database", async () => {
  const f = await setup(),
    selected = await configureNodeThinStorage(f.selected, f.node, f.body),
    created = DatabaseWithOperation.parse(await (await f.create()).json());
  const storage = {
    backend: "lvm-thin-v1",
    storage_class: thinStorageClass(selected.profile_sha256),
    volume_attributes_class: thinStorageClass(selected.profile_sha256),
    profile_revision: 1,
    profile_sha256: selected.profile_sha256,
    node_uid: f.uid,
    volume_group_uuid: f.body.volume_group_uuid,
    pool_uuid: "poolxx-abcd-abcd-abcd-abcd-abcd-abcdef",
    startup_reserve_bytes: f.profile.startup_reserve_bytes,
    write_bytes_per_second: f.profile.write_bytes_per_second,
    write_iops_per_second: f.profile.write_iops_per_second,
    guard_seconds: f.profile.guard_seconds,
    drain_seconds: f.profile.drain_seconds,
  };
  await env.DB.prepare(
    "UPDATE databases SET node_id=?,storage_profile_json=? WHERE id=? AND node_id IS NULL",
  )
    .bind(f.node, JSON.stringify(storage), created.database.id)
    .run();
  await expect(
    configureNodeThinStorage(f.selected, f.node, {
      ...f.body,
      expected_revision: 1,
      profile: { ...f.profile, maximum_quota_gib: 4 },
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  await expect(
    configureNodeThinStorage(f.selected, f.node, {
      ...f.body,
      expected_revision: 1,
      profile: { ...f.profile, write_iops_per_second: 11 },
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(
    await configureNodeThinStorage(f.selected, f.node, {
      ...f.body,
      expected_revision: 1,
      profile: { ...f.profile, maximum_quota_gib: 17 },
    }),
  ).toMatchObject({ revision: 2, profile_sha256: selected.profile_sha256 });
  expect(
    await env.DB.prepare(
      "SELECT storage_profile_json FROM databases WHERE id=?",
    )
      .bind(created.database.id)
      .first("storage_profile_json"),
  ).toBe(JSON.stringify(storage));
});
