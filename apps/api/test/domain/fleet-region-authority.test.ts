// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { newNodeId, newOperationId } from "@pgcf/contracts";
import { FleetRolloutIntent } from "@pgcf/contracts/fleet-rollouts";
import { FleetReleaseSpec } from "@pgcf/contracts/releases";
import {
  RegionMaterialRotationActivate,
  RegionMaterialRotationAuthority,
  RegionMaterialRotationVerification,
} from "@pgcf/contracts/region-material-rotation";
import type { Env } from "../../src/env.ts";
import {
  joinBundleReference,
  regionSeedReference,
  storeRegionJoinBundle,
  storeRegionSeed,
} from "../../src/crypto/bootstrap-credentials.ts";
import {
  authorizeFleetRegionRotation,
  preparedRegionRotationInput,
} from "../../src/domain/fleet-region-authority.ts";
import { readFleetRolloutIntent } from "../../src/domain/fleet-rollouts.ts";
import { installationHash } from "../../src/domain/node-installation.ts";
import { activateNativeRegionBootstrapRotation } from "../../src/domain/region-material-revisions.ts";
import { cleanupFixtures, fixture } from "./fixtures.ts";

const releases: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});

function releaseSpec() {
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
    "image/cilium/cilium",
  ];
  const role = {
    talos_version: "1.14.2",
    talos_installer: `registry.example/talos@sha256:${"a".repeat(64)}`,
    talos_schematic_sha256: "b".repeat(64),
    talos_extensions: [],
    kubernetes_version: "1.36.5",
    components: names
      .slice(3)
      .filter((name) => !["postgres", "barman"].includes(name)),
  };
  return FleetReleaseSpec.parse({
    version: 1,
    versions_lock_sha256: "c".repeat(64),
    configuration_schema_revision: 1,
    components: names.map((name) => ({
      name,
      kind: ["api", "edge"].includes(name) ? "worker_bundle" : "image",
      version: "1.0.0",
      reference: `registry.example/${name}@sha256:${"d".repeat(64)}`,
      sha256: "d".repeat(64),
    })),
    roles: { control_relay: role, customer: structuredClone(role) },
  });
}

async function setup() {
  const f = await fixture(),
    now = new Date().toISOString(),
    uid = crypto.randomUUID(),
    cluster = crypto.randomUUID(),
    foreignNode = newNodeId(),
    foreignUid = crypto.randomUUID(),
    foreignCluster = crypto.randomUUID(),
    release = `authority-${crypto.randomUUID()}`,
    successor = `successor-${crypto.randomUUID()}`,
    spec = releaseSpec(),
    specHash = await installationHash(spec);
  releases.push(release, successor);
  await env.DB.batch([
    ...[release, successor].map((id) =>
      env.DB.prepare(
        "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES(?,?,?,?)",
      ).bind(id, JSON.stringify(spec), specHash, now),
    ),
    env.DB.prepare(
      "UPDATE nodes SET node_uid=?,provider_instance_id=? WHERE id=?",
    ).bind(uid, "12345", f.node),
    env.DB.prepare(
      "INSERT INTO nodes(id,region_id,k8s_node_name,node_uid,provider_instance_id,ready,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at) VALUES(?,?,?,?,?,1,4096,2000,30,128,100,?,?,?)",
    ).bind(
      foreignNode,
      f.foreign,
      "retained-foreign",
      foreignUid,
      "23456",
      now,
      now,
      now,
    ),
    env.DB.prepare(
      "UPDATE regions SET bootstrap_material_revision=2 WHERE id=?",
    ).bind(f.foreign),
  ]);
  const seed = {
      version: 1 as const,
      cluster_name: "retained",
      cluster_endpoint: "https://192.0.2.10:6443",
      talos_version: "1.14.1",
      kubernetes_version: "1.36.3",
      talos_machine_secrets_yaml: "test-only original authority",
      talos_admin_config: "test-only original Talos client",
    },
    join = {
      ...seed,
      kube_system_uid: cluster,
      kubeconfig: "test-only original Kubernetes client",
    },
    next = {
      ...seed,
      talos_machine_secrets_yaml: "test-only prepared authority",
      talos_admin_config: "test-only prepared Talos client",
    },
    nextJoin = {
      ...next,
      kube_system_uid: cluster,
      kubeconfig: "test-only prepared Kubernetes client",
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
  await storeRegionSeed(
    env.DB,
    env.CREDENTIAL_KEYS,
    regionSeedReference(f.region, 2),
    next,
  );
  await storeRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 2),
    nextJoin,
  );
  await storeRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.foreign, 2),
    {
      ...join,
      cluster_name: "retained-foreign",
      cluster_endpoint: "https://192.0.2.20:6443",
      kube_system_uid: foreignCluster,
    },
  );
  const hashes = {
    expected_revision: 1,
    expected_seed_sha256: await installationHash(seed),
    expected_join_sha256: await installationHash(join),
    seed_sha256: await installationHash(next),
    join_sha256: await installationHash(nextJoin),
  };
  const verified = RegionMaterialRotationVerification.parse({
    source: "trusted_native",
    seed_sha256: hashes.seed_sha256,
    join_sha256: hashes.join_sha256,
    transcript_sha256: "e".repeat(64),
    retired_authorities: RegionMaterialRotationAuthority.options.map(
      (authority) => ({
        authority,
        prior_sha256: "a".repeat(64),
        replacement_sha256: "b".repeat(64),
        new_access_sha256: "c".repeat(64),
        retired_access_sha256: "d".repeat(64),
        result: ["discovery_secret", "secret_at_rest_key"].includes(authority)
          ? "retired_from_live_configuration"
          : "rejected",
      }),
    ),
    observed_at: now,
    kube_system_uid: cluster,
    talos_version: spec.roles.control_relay.talos_version,
    kubernetes_version: spec.roles.control_relay.kubernetes_version,
    nodes: [
      {
        node_id: f.node,
        node_uid: uid,
        k8s_node_name: f.nodeName,
        provider_instance_id: "12345",
      },
    ],
  });
  const activation = RegionMaterialRotationActivate.parse({
    ...hashes,
    verified,
    verification_sha256: await installationHash(verified),
  });
  const intent = FleetRolloutIntent.parse({
    rollout_id: newOperationId(),
    release_id: release,
    maintenance_acknowledged: true,
    created_at: now,
    regions: [
      {
        region_id: f.region,
        expected_revision: 0,
        revision: 1,
        cluster_uid: cluster,
        material_revision: 1,
        current_material_revision: 1,
        staged_material_revision: 2,
        rotation: {
          revision: 1,
          phase: "verify",
          node_index: 0,
          state: "confirmed",
          prior_boot_id: crypto.randomUUID(),
          verified,
        },
        nodes: [
          {
            node_id: f.node,
            node_uid: uid,
            expected_revision: 0,
            assignment_revision: 1,
            role: "control_relay",
            address: "192.0.2.10",
          },
        ],
      },
      {
        region_id: f.foreign,
        expected_revision: 0,
        revision: 1,
        cluster_uid: foreignCluster,
        material_revision: 2,
        current_material_revision: 2,
        nodes: [
          {
            node_id: foreignNode,
            node_uid: foreignUid,
            expected_revision: 0,
            assignment_revision: 1,
            role: "customer",
            address: "192.0.2.20",
          },
        ],
      },
    ],
  });
  await env.DB.batch([
    ...intent.regions.map((region) =>
      env.DB.prepare(
        "INSERT INTO fleet_region_releases(region_id,release_id,revision,updated_at,rollout_json) VALUES(?,?,1,?,?)",
      ).bind(region.region_id, release, now, JSON.stringify(intent)),
    ),
    ...intent.regions.flatMap((region) =>
      region.nodes.map((node) =>
        env.DB.prepare(
          "INSERT INTO fleet_node_releases(node_id,node_uid,release_id,role,revision,updated_at) VALUES(?,?,?,?,1,?)",
        ).bind(node.node_id, node.node_uid, release, node.role, now),
      ),
    ),
    env.DB.prepare(
      "INSERT INTO fleet_node_release_observations(node_id,node_uid,assignment_revision,agent_key_hash,facts_json,observed_at,received_at) SELECT ?,?,1,agent_key_hash,?,?,? FROM regions WHERE id=?",
    ).bind(
      f.node,
      uid,
      JSON.stringify({
        kubernetes_control_plane: true,
        components: [
          { name: "image/cilium/cilium", runtime_image_sha256: "d".repeat(64) },
        ],
      }),
      now,
      now,
      f.region,
    ),
    env.DB.prepare(
      "INSERT INTO fleet_patch_operations(operation_id,node_id,region_id,node_uid,cluster_uid,release_id,spec_sha256,assignment_revision,region_revision,material_revision,address,cluster_nodes_json,stage,state,created_at,updated_at,deadline_at) VALUES(?,?,?,?,?,?,?,1,1,1,?,?,'host_ready','confirmed',?,?,?)",
    ).bind(
      newOperationId(),
      f.node,
      f.region,
      uid,
      cluster,
      release,
      specHash,
      "192.0.2.10",
      JSON.stringify(verified.nodes),
      now,
      now,
      now,
    ),
  ]);
  const runtime = {
    ...env,
    NODE_BOOTSTRAP_CALLBACK_URL: "https://api.invalid/",
  } as Env;
  const custody = () =>
    env.DB.prepare(
      "SELECT * FROM region_bootstrap_credentials WHERE region_id=? ORDER BY revision,purpose",
    )
      .bind(f.region)
      .all();
  const pointer = () =>
    env.DB.prepare(
      "SELECT bootstrap_material_revision revision,bootstrap_material_provenance_sha256 provenance FROM regions WHERE id=?",
    )
      .bind(f.region)
      .first();
  const supersede = async () => {
    const replacement = FleetRolloutIntent.parse({
      ...intent,
      rollout_id: newOperationId(),
      release_id: successor,
      regions: [
        {
          ...intent.regions[0]!,
          expected_revision: 1,
          revision: 2,
          nodes: intent.regions[0]!.nodes.map((node) => ({
            ...node,
            expected_revision: 1,
            assignment_revision: 2,
          })),
        },
      ],
    });
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE fleet_region_releases SET release_id=?,revision=2,rollout_json=? WHERE region_id=?",
      ).bind(successor, JSON.stringify(replacement), f.region),
      env.DB.prepare(
        "UPDATE fleet_node_releases SET release_id=?,revision=2 WHERE node_id=?",
      ).bind(successor, f.node),
    ]);
  };
  return { ...f, intent, activation, runtime, custody, pointer, supersede };
}

/** Interpose only at execution; every read and the actual conditional UPDATE use real D1. */
function beforeCustodyUpdate(db: D1Database, hook: () => Promise<void>) {
  let updates = 0;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values));
        if (property === "run")
          return async () => {
            updates++;
            if (updates === 1) await hook();
            return target.run();
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return {
    DB: new Proxy(db, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            const statement = target.prepare(sql);
            return /^\s*UPDATE regions SET bootstrap_material_revision=/.test(
              sql,
            )
              ? wrap(statement)
              : statement;
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    updates: () => updates,
  };
}

it("revokes an issued rotation capability when its region is superseded while another region retains the old intent", async () => {
  const f = await setup(),
    granted = await preparedRegionRotationInput(
      f.runtime,
      f.intent.rollout_id,
      f.region,
    ),
    bearer = `Bearer ${granted.callback.bearer}`;
  await expect(
    authorizeFleetRegionRotation(
      f.runtime,
      f.intent.rollout_id,
      f.region,
      bearer,
    ),
  ).resolves.toMatchObject({ region: { region_id: f.region } });
  await f.supersede();
  expect(await readFleetRolloutIntent(env.DB, f.intent.rollout_id)).toEqual(
    f.intent,
  );
  await expect(
    authorizeFleetRegionRotation(
      f.runtime,
      f.intent.rollout_id,
      f.region,
      bearer,
    ),
  ).rejects.toThrow(/authority|identity|changed/i);
  expect(await f.pointer()).toEqual({ revision: 1, provenance: null });
});

it("rejects an activation race at the actual custody UPDATE without changing active revision or staged ciphertext", async () => {
  const f = await setup(),
    before = (await f.custody()).results,
    racing = beforeCustodyUpdate(env.DB, f.supersede);
  await expect(
    activateNativeRegionBootstrapRotation(
      { ...f.runtime, DB: racing.DB },
      f.region,
      f.intent.rollout_id,
      f.activation,
    ),
  ).rejects.toThrow(/authority|identity|changed/i);
  expect(racing.updates()).toBe(1);
  expect(await f.pointer()).toEqual({ revision: 1, provenance: null });
  expect((await f.custody()).results).toEqual(before);
  expect(await readFleetRolloutIntent(env.DB, f.intent.rollout_id)).toEqual(
    f.intent,
  );
});

it("resolves exact native activation replay after pointer revision two without rewriting custody", async () => {
  const f = await setup(),
    before = (await f.custody()).results;
  expect(
    await activateNativeRegionBootstrapRotation(
      f.runtime,
      f.region,
      f.intent.rollout_id,
      f.activation,
    ),
  ).toMatchObject({
    revision: 2,
    provenance_sha256: f.activation.verification_sha256,
  });
  const replay = beforeCustodyUpdate(env.DB, async () => {
    throw Error(
      "exact activation replay must not execute another custody UPDATE",
    );
  });
  const status = await activateNativeRegionBootstrapRotation(
    { ...f.runtime, DB: replay.DB },
    f.region,
    f.intent.rollout_id,
    f.activation,
  );
  expect(status).toMatchObject({
    revision: 2,
    provenance_sha256: f.activation.verification_sha256,
    seed_sha256: f.activation.seed_sha256,
    join_sha256: f.activation.join_sha256,
  });
  expect(replay.updates()).toBe(0);
  expect((await f.custody()).results).toEqual(before);
  expect(await f.pointer()).toEqual({
    revision: 2,
    provenance: f.activation.verification_sha256,
  });
});
