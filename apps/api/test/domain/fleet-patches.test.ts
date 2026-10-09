// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { newOperationId } from "@pgcf/contracts";
import {
  FleetPatchStatus,
  type FleetPatchFacts,
} from "@pgcf/contracts/fleet-patches";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";
import {
  fleetPatchInput,
  readFleetPatch,
  recordFleetPatchCheckpoint,
  assertFleetPatchAuthority,
  fleetPatchAuthoritySql,
} from "../../src/domain/fleet-patches.ts";
import {
  storeRegionJoinBundle,
  joinBundleReference,
} from "../../src/crypto/bootstrap-credentials.ts";
import { installationHash } from "../../src/domain/node-installation.ts";
import { createApp } from "../../src/app.ts";
import type { Env } from "../../src/env.ts";
import { thinExecutionFixture } from "./thin-execution-fixture.ts";

const releases: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
it("public successor assignment cannot skip retained thin trust by disabling the host configuration flag", async () => {
  const f = await thinExecutionFixture(releases),
    successor = `unguarded-${crypto.randomUUID()}`;
  const spec = structuredClone(f.qualified.spec);
  delete spec.thin_storage_qualification;
  delete spec.storage_authority_keys_sha256;
  for (const role of Object.values(spec.roles))
    role.host_configuration_required = false;
  // The physical fixture has no full software inventory; public status represents that as unknown.
  await env.DB.prepare(
    "UPDATE fleet_node_release_observations SET facts_json=json_set(facts_json,'$.components',json('[]')) WHERE node_id=?",
  )
    .bind(f.node)
    .run();
  releases.push(successor);
  expect(
    (
      await request(
        `/v1/fleet/releases/${successor}`,
        f.admin,
        "PUT",
        spec,
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request(
        `/v1/regions/${f.region}/release`,
        f.admin,
        "PUT",
        { expected_revision: 1, release_id: successor },
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(200);
  const assigned = await request(
    `/v1/nodes/${f.node}/release`,
    f.admin,
    "PUT",
    {
      expected_revision: 1,
      release_id: successor,
      node_uid: f.uid,
      role: "customer",
    },
    crypto.randomUUID(),
  );
  expect(assigned.status).toBe(200);
  const before = await env.DB.prepare(
    "SELECT revision,sha256,ciphertext FROM node_host_configurations WHERE node_id=?",
  )
    .bind(f.node)
    .first();
  const patches = await env.DB.prepare(
    "SELECT COUNT(*) n FROM fleet_patch_operations WHERE node_id=?",
  )
    .bind(f.node)
    .first("n");
  const result = await request(
    `/v1/nodes/${f.node}/patches`,
    f.admin,
    "POST",
    {
      node_uid: f.uid,
      assignment_revision: 2,
      release_id: successor,
      address: "192.0.2.18",
      maintenance_acknowledged: true,
    },
    crypto.randomUUID(),
  );
  expect(result.status).toBe(409);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM fleet_patch_operations WHERE node_id=?",
    )
      .bind(f.node)
      .first("n"),
  ).toBe(patches);
  expect(
    await env.DB.prepare(
      "SELECT revision,sha256,ciphertext FROM node_host_configurations WHERE node_id=?",
    )
      .bind(f.node)
      .first(),
  ).toEqual(before);
  // A queued patch from the former implementation must fail current authority too.
  const legacy = newOperationId(),
    at = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE nodes SET database_placement_closed_at=? WHERE id=?",
    ).bind(at, f.node),
    env.DB.prepare(
      `INSERT INTO fleet_patch_operations(operation_id,node_id,region_id,node_uid,cluster_uid,release_id,spec_sha256,assignment_revision,region_revision,material_revision,address,cluster_nodes_json,revision,stage,state,created_at,updated_at,deadline_at) VALUES(?,?,?,?,?,?,?,2,2,1,'192.0.2.18',?,0,'preflight','pending',?,?,?)`,
    ).bind(
      legacy,
      f.node,
      f.region,
      f.uid,
      f.authority.cluster_uid,
      successor,
      await installationHash(spec),
      JSON.stringify([
        {
          node_id: f.node,
          node_uid: f.uid,
          k8s_node_name: f.nodeName,
          assignment_revision: 2,
          previous_placement_closed_at: null,
        },
      ]),
      at,
      at,
      new Date(Date.now() + 60000).toISOString(),
    ),
  ]);
  expect(
    await env.DB.prepare(
      `SELECT 1 valid FROM fleet_patch_operations WHERE operation_id=? AND ${fleetPatchAuthoritySql}`,
    )
      .bind(legacy)
      .first("valid"),
  ).toBe(1);
  await expect(
    assertFleetPatchAuthority(f.local, await readFleetPatch(f.local, legacy)),
  ).rejects.toThrow("Fleet patch identity or authority changed");
});
async function setup(hostRequired = false) {
  const f = await fixture(),
    id = `patch-${crypto.randomUUID()}`,
    nodeUid = crypto.randomUUID(),
    clusterUid = crypto.randomUUID(),
    op = newOperationId(),
    now = new Date().toISOString();
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
    ],
    role = {
      ...(hostRequired ? { host_configuration_required: true } : {}),
      talos_version: "1.14.1",
      talos_installer: `registry.example/talos@sha256:${"a".repeat(64)}`,
      talos_schematic_sha256: "b".repeat(64),
      talos_extensions: [],
      kubernetes_version: "1.36.5",
      components: names
        .slice(3)
        .filter((name) => !["postgres", "barman"].includes(name)),
    };
  const spec = {
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
  const hash = await installationHash(spec);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE nodes SET node_uid=?,last_observed_at=?,database_placement_closed_at=? WHERE id=?",
    ).bind(nodeUid, now, now, f.node),
    env.DB.prepare(
      "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES(?,?,?,?)",
    ).bind(id, JSON.stringify(spec), hash, now),
    env.DB.prepare(
      "INSERT INTO fleet_region_releases(region_id,release_id,revision,updated_at) VALUES(?,?,1,?)",
    ).bind(f.region, id, now),
    env.DB.prepare(
      "INSERT INTO fleet_node_releases(node_id,node_uid,release_id,role,revision,updated_at) VALUES(?,?,?,'customer',1,?)",
    ).bind(f.node, nodeUid, id, now),
  ]);
  await storeRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 1),
    {
      version: 1,
      cluster_name: "test-cluster",
      cluster_endpoint: "https://192.0.2.18:6443/",
      talos_version: "1.14.0",
      kubernetes_version: "1.36.3",
      talos_machine_secrets_yaml: "test-only-machine-secrets",
      talos_admin_config: "test-only-talos-config",
      kube_system_uid: clusterUid,
      kubeconfig: "test-only-kubeconfig",
    },
  );
  const row = await env.DB.prepare("SELECT k8s_node_name FROM nodes WHERE id=?")
    .bind(f.node)
    .first<{ k8s_node_name: string }>();
  await env.DB.prepare(
    `INSERT INTO fleet_patch_operations(operation_id,node_id,region_id,node_uid,cluster_uid,release_id,spec_sha256,assignment_revision,region_revision,material_revision,address,cluster_nodes_json,revision,stage,state,created_at,updated_at,deadline_at)
    VALUES(?,?,?,?,?,?,?,1,1,1,'192.0.2.18',?,0,'preflight','pending',?,?,?)`,
  )
    .bind(
      op,
      f.node,
      f.region,
      nodeUid,
      clusterUid,
      id,
      hash,
      JSON.stringify([
        {
          node_id: f.node,
          node_uid: nodeUid,
          k8s_node_name: row!.k8s_node_name,
          assignment_revision: 1,
        },
      ]),
      now,
      now,
      new Date(Date.now() + 3600_000).toISOString(),
    )
    .run();
  const facts: FleetPatchFacts = {
    node_uid: nodeUid,
    cluster_uid: clusterUid,
    system_uuid: crypto.randomUUID(),
    boot_id: crypto.randomUUID(),
    talos_version: "v1.14.0",
    talos_schematic_sha256: "b".repeat(64),
    kubelet_version: "v1.36.3",
    kubernetes_version: "v1.36.3",
    node_ready: true,
    databases_ready: true,
    cluster_nodes: [
      { node_uid: nodeUid, kubelet_version: "v1.36.3", node_ready: true },
    ],
    observed_at: now,
  };
  return {
    ...f,
    op,
    id,
    nodeUid,
    clusterUid,
    facts,
    runtime: {
      ...env,
      NODE_BOOTSTRAP_CALLBACK_URL:
        "https://api.invalid/internal/v1/node-bootstrap",
    },
  };
}
it("uses current sealed custody without reopening a bootstrap job or touching provider credentials", async () => {
  const f = await setup(),
    input = await fleetPatchInput(f.runtime, f.op);
  expect(input.status.cluster_uid).toBe(f.clusterUid);
  expect(input.talos_admin_config).toBe("test-only-talos-config");
  const response = await request(`/v1/fleet/patches/${f.op}`, f.admin);
  expect(response.status).toBe(200);
  expect(JSON.stringify(await response.json())).not.toContain("test-only");
  expect(
    (await env.DB.prepare(
      "SELECT count(*) count FROM node_bootstrap_jobs WHERE node_id=?",
    )
      .bind(f.node)
      .first<{ count: number }>())!.count,
  ).toBe(0);
  expect(
    (await request(`/v1/fleet/patches/${f.op}`, f.integrator)).status,
  ).toBe(403);
});
it("rejects stale transitions, changed UID/material/release authority and never clears a dispatched uncertainty", async () => {
  const f = await setup();
  let current = await recordFleetPatchCheckpoint(f.runtime, f.op, {
    expected_revision: 0,
    stage: "preflight",
    state: "confirmed",
    facts: f.facts,
    error_code: null,
  });
  current = await recordFleetPatchCheckpoint(f.runtime, f.op, {
    expected_revision: current.revision,
    stage: "host_config",
    state: "pending",
    facts: f.facts,
    error_code: null,
  });
  current = await recordFleetPatchCheckpoint(f.runtime, f.op, {
    expected_revision: current.revision,
    stage: "host_config",
    state: "confirmed",
    facts: f.facts,
    error_code: null,
  });
  current = await recordFleetPatchCheckpoint(f.runtime, f.op, {
    expected_revision: current.revision,
    stage: "host_service",
    state: "pending",
    facts: f.facts,
    error_code: null,
  });
  current = await recordFleetPatchCheckpoint(f.runtime, f.op, {
    expected_revision: current.revision,
    stage: "host_service",
    state: "confirmed",
    facts: f.facts,
    error_code: null,
  });
  const kubernetesFacts = {
    ...f.facts,
    kubernetes_version: "v1.36.5",
    kubelet_version: "v1.36.5",
    cluster_nodes: f.facts.cluster_nodes.map((node) => ({
      ...node,
      kubelet_version: "v1.36.5",
    })),
  };
  current = await recordFleetPatchCheckpoint(f.runtime, f.op, {
    expected_revision: current.revision,
    stage: "kubernetes",
    state: "pending",
    facts: f.facts,
    error_code: null,
  });
  current = await recordFleetPatchCheckpoint(f.runtime, f.op, {
    expected_revision: current.revision,
    stage: "kubernetes",
    state: "confirmed",
    facts: kubernetesFacts,
    error_code: null,
  });
  current = await recordFleetPatchCheckpoint(f.runtime, f.op, {
    expected_revision: current.revision,
    stage: "kubernetes_images",
    state: "pending",
    facts: kubernetesFacts,
    error_code: null,
  });
  current = await recordFleetPatchCheckpoint(f.runtime, f.op, {
    expected_revision: current.revision,
    stage: "kubernetes_images",
    state: "confirmed",
    facts: kubernetesFacts,
    error_code: null,
  });
  current = await recordFleetPatchCheckpoint(f.runtime, f.op, {
    expected_revision: current.revision,
    stage: "talos",
    state: "pending",
    facts: f.facts,
    error_code: null,
  });
  current = await recordFleetPatchCheckpoint(f.runtime, f.op, {
    expected_revision: current.revision,
    stage: "talos",
    state: "dispatched",
    facts: f.facts,
    error_code: null,
  });
  await expect(
    recordFleetPatchCheckpoint(f.runtime, f.op, {
      expected_revision: current.revision,
      stage: "talos",
      state: "pending",
      facts: f.facts,
      error_code: null,
    }),
  ).rejects.toThrow("authority changed");
  await expect(
    recordFleetPatchCheckpoint(f.runtime, f.op, {
      expected_revision: current.revision,
      stage: "talos",
      state: "confirmed",
      facts: { ...f.facts, talos_version: "v1.14.1" },
      error_code: null,
    }),
  ).rejects.toThrow("authority changed");
  expect((await readFleetPatch(env, f.op)).revision).toBe(current.revision);
  await env.DB.prepare(
    "UPDATE regions SET bootstrap_material_revision=2 WHERE id=?",
  )
    .bind(f.region)
    .run();
  await expect(fleetPatchInput(f.runtime, f.op)).rejects.toThrow(
    "authority changed",
  );
});
it("requires a positive exact-installer deployment receipt before installation confirmation and advances once", async () => {
  const f = await setup();
  await env.DB.prepare(
    "UPDATE fleet_patch_operations SET stage='talos',state='dispatched',baseline_json=? WHERE operation_id=?",
  )
    .bind(JSON.stringify(f.facts), f.op)
    .run();
  const value = {
    expected_revision: 0,
    stage: "talos" as const,
    state: "confirmed" as const,
    facts: f.facts,
    error_code: null,
    talos_upgrade_receipt: {
      method: "deploymentreceipt" as const,
      installer: `registry.example/talos@sha256:${"a".repeat(64)}`,
      node_uid: f.nodeUid,
      cluster_uid: f.clusterUid,
      system_uuid: f.facts.system_uuid,
      pre_reboot_boot_id: f.facts.boot_id,
      completed_at: new Date().toISOString(),
      source: "cli_exit_0" as const,
    },
  };
  expect(
    (await recordFleetPatchCheckpoint(f.runtime, f.op, value))
      .talos_upgrade_receipt?.source,
  ).toBe("cli_exit_0");
  await expect(
    recordFleetPatchCheckpoint(f.runtime, f.op, value),
  ).rejects.toThrow("authority changed");
  expect((await fleetPatchInput(f.runtime, f.op)).status.revision).toBe(1);
});
it("new or reassigned cluster members invalidate patch authority and an unresolved patch holds the regional slot", async () => {
  const f = await setup(),
    row = await readFleetPatch(env, f.op);
  await env.DB.prepare(
    "UPDATE fleet_node_releases SET revision=2 WHERE node_id=?",
  )
    .bind(f.node)
    .run();
  await expect(assertFleetPatchAuthority(f.runtime, row)).rejects.toThrow(
    "authority changed",
  );
  await expect(
    env.DB.prepare(
      `INSERT INTO fleet_patch_operations(operation_id,node_id,region_id,node_uid,cluster_uid,release_id,spec_sha256,assignment_revision,region_revision,material_revision,address,cluster_nodes_json,revision,stage,state,baseline_json,observed_json,error_code,created_at,updated_at,deadline_at) SELECT ?,node_id,region_id,node_uid,cluster_uid,release_id,spec_sha256,assignment_revision,region_revision,material_revision,address,cluster_nodes_json,revision,stage,state,baseline_json,observed_json,error_code,created_at,updated_at,deadline_at FROM fleet_patch_operations WHERE operation_id=?`,
    )
      .bind(newOperationId(), f.op)
      .run(),
  ).rejects.toThrow(/UNIQUE constraint failed/);
});
it("creation is replayable during maintenance and persists only one separate patch operation", async () => {
  const f = await setup();
  await env.DB.prepare(
    "DELETE FROM fleet_patch_operations WHERE operation_id=?",
  )
    .bind(f.op)
    .run();
  const body = {
      node_uid: f.nodeUid,
      assignment_revision: 1,
      release_id: f.id,
      address: "192.0.2.18",
      maintenance_acknowledged: true,
    },
    key = crypto.randomUUID(),
    path = `/v1/nodes/${f.node}/patches`;
  // Keep the Workflow scheduling boundary controlled; authorization/idempotency and all persisted state use real D1.
  const scheduled = new Set<string>(),
    runtime = {
      ...f.runtime,
      PATCH_NODE: {
        create: async (input: { id: string }) => {
          if (scheduled.has(input.id)) throw new Error("instance_exists");
          scheduled.add(input.id);
        },
        get: async () => ({ status: async () => ({ status: "running" }) }),
      } as unknown as Env["PATCH_NODE"],
    };
  const send = async () => {
    const context = createExecutionContext(),
      response = await createApp().fetch(
        new Request(new URL(path, "https://api.invalid"), {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.admin}`,
            "content-type": "application/json",
            "Idempotency-Key": key,
          },
          body: JSON.stringify(body),
        }),
        runtime,
        context,
      );
    await waitOnExecutionContext(context);
    return response;
  };
  const first = await send();
  expect(first.status).toBe(202);
  const status = FleetPatchStatus.parse(await first.json());
  {
    await env.DB.prepare(
      "UPDATE nodes SET ready=0,last_observed_at=? WHERE id=?",
    )
      .bind("2020-01-01T00:00:00.000Z", f.node)
      .run();
    const replay = await send();
    expect(replay.status).toBe(202);
    expect(FleetPatchStatus.parse(await replay.json()).operation_id).toBe(
      status.operation_id,
    );
    expect(
      (await env.DB.prepare(
        "SELECT count(*) count FROM fleet_patch_operations WHERE region_id=?",
      )
        .bind(f.region)
        .first<{ count: number }>())!.count,
    ).toBe(1);
  }
  expect(scheduled.size).toBe(1);
});
it("full release completion restores only owned placement closures and preserves operator exclusions", async () => {
  const complete = async (previous: string | null) => {
    const f = await setup(),
      row = await readFleetPatch(env, f.op),
      members = JSON.parse(row.cluster_nodes_json),
      input = await fleetPatchInput(f.runtime, f.op);
    members[0].previous_placement_closed_at = previous;
    const receipt = {
        method: "deploymentreceipt",
        installer: input.spec.roles.customer.talos_installer,
        node_uid: f.nodeUid,
        cluster_uid: f.clusterUid,
        system_uuid: f.facts.system_uuid,
        pre_reboot_boot_id: f.facts.boot_id,
        completed_at: new Date().toISOString(),
        source: "cli_exit_0",
      },
      progress = {
        total: 0,
        applied: 0,
        pending: 0,
        deferred_cold: 0,
        queued_unassigned: 0,
        queued_pending: 0,
        errors: [],
      };
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE fleet_patch_operations SET stage='release_verify',baseline_json=?,cluster_nodes_json=?,talos_upgrade_receipt_json=?,postgres_progress_json=? WHERE operation_id=?",
      ).bind(
        JSON.stringify(f.facts),
        JSON.stringify(members),
        JSON.stringify(receipt),
        JSON.stringify(progress),
        f.op,
      ),
      env.DB.prepare(
        "UPDATE nodes SET database_placement_closed_at=?,database_placement_enabled=0 WHERE id=?",
      ).bind(previous ?? row.created_at, f.node),
    ]);
    const boot = crypto.randomUUID(),
      role = input.spec.roles.customer,
      facts = {
        ...f.facts,
        boot_id: boot,
        talos_version: "v1.14.1",
        kubelet_version: "v1.36.5",
        kubernetes_version: "v1.36.5",
        cluster_nodes: [
          { node_uid: f.nodeUid, kubelet_version: "v1.36.5", node_ready: true },
        ],
        release_facts: {
          boot_id: boot,
          configuration_schema_revision: 1,
          talos_version: "1.14.1",
          talos_installer: role.talos_installer,
          talos_schematic_sha256: role.talos_schematic_sha256,
          kubernetes_version: "1.36.5",
          talos_provenance: {
            method: "deploymentreceipt" as const,
            installer: role.talos_installer,
            node_uid: f.nodeUid,
            cluster_uid: f.clusterUid,
            boot_id: boot,
          },
          components: input.spec.components
            .filter((v) => role.components.includes(v.name))
            .map((v) => ({
              name: v.name,
              version: v.version,
              sha256: v.sha256,
            })),
        },
      };
    expect(
      (
        await recordFleetPatchCheckpoint(f.runtime, f.op, {
          expected_revision: 0,
          stage: "complete",
          state: "confirmed",
          facts,
          error_code: null,
        })
      ).stage,
    ).toBe("complete");
    expect(
      await env.DB.prepare(
        "SELECT database_placement_closed_at,database_placement_enabled FROM nodes WHERE id=?",
      )
        .bind(f.node)
        .first(),
    ).toEqual({
      database_placement_closed_at: previous,
      database_placement_enabled: 0,
    });
    expect(
      (
        await env.DB.prepare(
          "SELECT facts_json FROM fleet_node_release_observations WHERE node_id=?",
        )
          .bind(f.node)
          .first<{ facts_json: string }>()
      )?.facts_json,
    ).toContain("deploymentreceipt");
  };
  await complete(null);
  await complete("2024-01-01T00:00:00.000Z");
});

it("synchronizes retained seed/join version metadata only after every current member has qualified release facts", async () => {
  const f = await setup();
  const { synchronizeFleetPatchRegionMaterial } =
    await import("../../src/domain/fleet-patches.ts");
  const {
    loadRegionJoinBundle,
    loadRegionSeed,
    storeRegionSeed,
    regionSeedReference,
    loadCurrentRegionMaterialReference,
  } = await import("../../src/crypto/bootstrap-credentials.ts");
  const old = await loadRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 1),
  );
  const seed = {
    version: old.version,
    cluster_name: old.cluster_name,
    cluster_endpoint: old.cluster_endpoint,
    talos_version: old.talos_version,
    kubernetes_version: old.kubernetes_version,
    talos_machine_secrets_yaml: old.talos_machine_secrets_yaml,
    talos_admin_config: old.talos_admin_config,
  };
  await storeRegionSeed(
    env.DB,
    env.CREDENTIAL_KEYS,
    regionSeedReference(f.region, 1),
    seed,
  );
  await env.DB.prepare(
    "UPDATE fleet_patch_operations SET stage='complete',state='confirmed' WHERE operation_id=?",
  )
    .bind(f.op)
    .run();
  await env.DB.prepare(
    "UPDATE nodes SET provider_instance_id='12345' WHERE id=?",
  )
    .bind(f.node)
    .run();
  expect(await synchronizeFleetPatchRegionMaterial(f.runtime, f.op)).toBe(
    "waiting_members",
  );
  const release = JSON.parse(
      (await env.DB.prepare("SELECT spec_json FROM fleet_releases WHERE id=?")
        .bind(f.id)
        .first<{ spec_json: string }>())!.spec_json,
    ),
    now = new Date().toISOString();
  const facts = {
    boot_id: f.facts.boot_id,
    configuration_schema_revision: 1,
    talos_version: release.roles.customer.talos_version,
    talos_installer: release.roles.customer.talos_installer,
    talos_schematic_sha256: release.roles.customer.talos_schematic_sha256,
    kubernetes_version: release.roles.customer.kubernetes_version,
    components: release.components
      .filter((v: { name: string }) =>
        release.roles.customer.components.includes(v.name),
      )
      .map(
        ({
          name,
          version,
          sha256,
        }: {
          name: string;
          version: string;
          sha256: string;
        }) => ({ name, version, sha256 }),
      ),
  };
  await env.DB.prepare(
    "INSERT INTO fleet_node_release_observations(node_id,node_uid,assignment_revision,agent_key_hash,facts_json,observed_at,received_at) SELECT ?,?,1,agent_key_hash,?,?,? FROM regions WHERE id=?",
  )
    .bind(f.node, f.nodeUid, JSON.stringify(facts), now, now, f.region)
    .run();
  expect(await synchronizeFleetPatchRegionMaterial(f.runtime, f.op)).toBe(
    "synchronized",
  );
  const ref = await loadCurrentRegionMaterialReference(
    env.DB,
    f.region,
    "join_bundle",
  );
  expect(ref.revision).toBe(2);
  const actual = await loadRegionJoinBundle(env.DB, env.CREDENTIAL_KEYS, ref),
    actualSeed = await loadRegionSeed(
      env.DB,
      env.CREDENTIAL_KEYS,
      regionSeedReference(f.region, ref.revision),
    );
  expect(actual).toEqual({
    ...old,
    talos_version: "1.14.1",
    kubernetes_version: "1.36.5",
  });
  expect(actualSeed).toEqual({
    ...seed,
    talos_version: "1.14.1",
    kubernetes_version: "1.36.5",
  });
  expect(await synchronizeFleetPatchRegionMaterial(f.runtime, f.op)).toBe(
    "synchronized",
  );
  expect(
    (await loadCurrentRegionMaterialReference(env.DB, f.region, "join_bundle"))
      .revision,
  ).toBe(2);
});

it("reuses an exact prior installed-image receipt after metadata-only custody revision advances without reusing old transport material", async () => {
  const f = await setup(),
    oldId = newOperationId(),
    now = new Date().toISOString(),
    receipt = {
      method: "deploymentreceipt",
      installer: `registry.example/talos@sha256:${"a".repeat(64)}`,
      node_uid: f.nodeUid,
      cluster_uid: f.clusterUid,
      system_uuid: f.facts.system_uuid,
      pre_reboot_boot_id: crypto.randomUUID(),
      completed_at: now,
      source: "cli_exit_0",
    };
  const observed = {
    ...f.facts,
    talos_version: "1.14.1",
    kubernetes_version: "1.36.5",
    kubelet_version: "1.36.5",
    observed_at: now,
  };
  await env.DB.prepare(
    `INSERT INTO fleet_patch_operations(operation_id,node_id,region_id,node_uid,cluster_uid,release_id,spec_sha256,assignment_revision,region_revision,material_revision,address,cluster_nodes_json,revision,stage,state,baseline_json,observed_json,talos_upgrade_receipt_json,created_at,updated_at,deadline_at) SELECT ?,node_id,region_id,node_uid,cluster_uid,release_id,spec_sha256,assignment_revision,region_revision,material_revision,address,cluster_nodes_json,0,'complete','confirmed',?,?,?,created_at,?,deadline_at FROM fleet_patch_operations WHERE operation_id=?`,
  )
    .bind(
      oldId,
      JSON.stringify(observed),
      JSON.stringify(observed),
      JSON.stringify(receipt),
      now,
      f.op,
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO fleet_node_release_observations(node_id,node_uid,assignment_revision,agent_key_hash,facts_json,observed_at,received_at) SELECT ?,?,1,agent_key_hash,'{\"components\":[]}',?,? FROM regions WHERE id=?",
  )
    .bind(f.node, f.nodeUid, now, now, f.region)
    .run();
  const { loadRegionJoinBundle } =
      await import("../../src/crypto/bootstrap-credentials.ts"),
    old = await loadRegionJoinBundle(
      env.DB,
      env.CREDENTIAL_KEYS,
      joinBundleReference(f.region, 1),
    );
  await storeRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 2),
    { ...old, talos_version: "1.14.1", kubernetes_version: "1.36.5" },
  );
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE regions SET bootstrap_material_revision=2 WHERE id=?",
    ).bind(f.region),
    env.DB.prepare(
      "UPDATE fleet_patch_operations SET material_revision=2 WHERE operation_id=?",
    ).bind(f.op),
  ]);
  const input = await fleetPatchInput(f.runtime, f.op);
  expect(input.retained_talos_installation?.receipt).toEqual(receipt);
  expect(input.talos_admin_config).toBe(old.talos_admin_config);
  expect((await readFleetPatch(f.runtime, f.op)).material_revision).toBe(2);
});

it("keeps a host-qualified control operation terminal while a worker and idempotent control finalization finish the same release", async () => {
  const f = await setup(),
    worker = `nod_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
    workerUid = crypto.randomUUID(),
    now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO nodes(id,region_id,k8s_node_name,ready,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at,node_uid,database_placement_closed_at) SELECT ?,region_id,'worker-test',1,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,?,?,?, ?,database_placement_closed_at FROM nodes WHERE id=?`,
    ).bind(worker, now, now, now, workerUid, f.node),
    env.DB.prepare(
      "INSERT INTO fleet_node_releases(node_id,node_uid,release_id,role,revision,updated_at) VALUES(?,?,?,'customer',1,?)",
    ).bind(worker, workerUid, f.id, now),
    env.DB.prepare(
      "UPDATE fleet_node_releases SET role='control_relay' WHERE node_id=?",
    ).bind(f.node),
  ]);
  const original = await readFleetPatch(env, f.op),
    input = await fleetPatchInput(f.runtime, f.op).catch(() => null);
  expect(input).toBeNull(); // exact membership is fenced before accepting the new snapshot.
  const members = [
    {
      node_id: f.node,
      node_uid: f.nodeUid,
      k8s_node_name: "test-node",
      assignment_revision: 1,
    },
    {
      node_id: worker,
      node_uid: workerUid,
      k8s_node_name: "worker-test",
      assignment_revision: 1,
    },
  ];
  await env.DB.prepare(
    "UPDATE fleet_patch_operations SET cluster_nodes_json=? WHERE operation_id=?",
  )
    .bind(JSON.stringify(members), f.op)
    .run();
  const selected = await fleetPatchInput(f.runtime, f.op),
    role = selected.spec.roles.control_relay;
  const factsFor = (uid: string): FleetPatchFacts => {
    const boot = crypto.randomUUID();
    return {
      ...f.facts,
      node_uid: uid,
      boot_id: boot,
      talos_version: "1.14.1",
      kubernetes_version: "1.36.5",
      kubelet_version: "1.36.5",
      observed_at: new Date().toISOString(),
      cluster_nodes: members.map((m) => ({
        node_uid: m.node_uid,
        kubelet_version: "1.36.5",
        node_ready: true,
      })),
      release_facts: {
        boot_id: boot,
        configuration_schema_revision: 1,
        talos_version: "1.14.1",
        talos_installer: role.talos_installer,
        talos_schematic_sha256: role.talos_schematic_sha256,
        kubernetes_version: "1.36.5",
        talos_provenance: {
          method: "deploymentreceipt",
          installer: role.talos_installer,
          node_uid: uid,
          cluster_uid: f.clusterUid,
          boot_id: boot,
        },
        components: selected.spec.components
          .filter((c) => role.components.includes(c.name))
          .map((c) => ({ name: c.name, version: c.version, sha256: c.sha256 })),
      },
    };
  };
  const controlFacts = factsFor(f.nodeUid),
    workerFacts = factsFor(workerUid),
    receiptFor = (facts: FleetPatchFacts) => ({
      method: "deploymentreceipt",
      installer: role.talos_installer,
      node_uid: facts.node_uid,
      cluster_uid: f.clusterUid,
      system_uuid: facts.system_uuid,
      pre_reboot_boot_id: crypto.randomUUID(),
      completed_at: now,
      source: "cli_exit_0",
    }),
    emptyProgress = {
      total: 0,
      applied: 0,
      pending: 0,
      deferred_cold: 0,
      queued_unassigned: 0,
      queued_pending: 0,
      errors: [],
    };
  await env.DB.prepare(
    "UPDATE fleet_patch_operations SET stage='regional',state='confirmed',baseline_json=?,talos_upgrade_receipt_json=? WHERE operation_id=?",
  )
    .bind(
      JSON.stringify(controlFacts),
      JSON.stringify(receiptFor(controlFacts)),
      f.op,
    )
    .run();
  expect((await fleetPatchInput(f.runtime, f.op)).regional_hosts_ready).toBe(
    false,
  );
  await recordFleetPatchCheckpoint(f.runtime, f.op, {
    expected_revision: 0,
    stage: "runtime_admission",
    state: "pending",
    facts: controlFacts,
    error_code: null,
  });
  expect(
    (
      await recordFleetPatchCheckpoint(f.runtime, f.op, {
        expected_revision: 1,
        stage: "host_ready",
        state: "confirmed",
        facts: controlFacts,
        error_code: null,
      })
    ).stage,
  ).toBe("host_ready");
  await expect(
    assertFleetPatchAuthority(f.runtime, await readFleetPatch(env, f.op)),
  ).rejects.toThrow("authority changed");
  const { readFleetNodeRelease } =
    await import("../../src/domain/fleet-releases.ts");
  expect((await readFleetNodeRelease(env.DB, f.node)).state).toBe("pending");
  const workerOp = newOperationId();
  await env.DB.prepare(
    `INSERT INTO fleet_patch_operations(operation_id,node_id,region_id,node_uid,cluster_uid,release_id,spec_sha256,assignment_revision,region_revision,material_revision,address,cluster_nodes_json,revision,stage,state,baseline_json,talos_upgrade_receipt_json,postgres_progress_json,created_at,updated_at,deadline_at) SELECT ?,?,region_id,?,cluster_uid,release_id,spec_sha256,assignment_revision,region_revision,material_revision,'192.0.2.19',cluster_nodes_json,0,'release_verify','pending',?,?,?,created_at,updated_at,deadline_at FROM fleet_patch_operations WHERE operation_id=?`,
  )
    .bind(
      workerOp,
      worker,
      workerUid,
      JSON.stringify(workerFacts),
      JSON.stringify(receiptFor(workerFacts)),
      JSON.stringify(emptyProgress),
      f.op,
    )
    .run();
  expect(
    (await fleetPatchInput(f.runtime, workerOp)).regional_hosts_ready,
  ).toBe(true);
  await recordFleetPatchCheckpoint(f.runtime, workerOp, {
    expected_revision: 0,
    stage: "complete",
    state: "confirmed",
    facts: workerFacts,
    error_code: null,
  });
  expect(
    (await env.DB.prepare(
      "SELECT database_placement_closed_at FROM nodes WHERE id=?",
    )
      .bind(f.node)
      .first<{ database_placement_closed_at: string }>())!
      .database_placement_closed_at,
  ).toBe(original.created_at);
  const { ensureFleetPatchFinalization, restoreFleetPatchPlacements } =
    await import("../../src/domain/fleet-patches.ts");
  const patchEnv = {
    ...f.runtime,
    PATCH_NODE: { create: async () => ({}) },
  } as unknown as Env;
  const final = await ensureFleetPatchFinalization(patchEnv, f.op);
  expect(final!.stage).toBe("runtime_admission");
  expect(final!.operation_id).not.toBe(f.op);
  expect(
    (await ensureFleetPatchFinalization(patchEnv, f.op))!.operation_id,
  ).toBe(final!.operation_id);
  expect((await readFleetPatch(env, f.op)).stage).toBe("host_ready");
  await env.DB.prepare(
    "UPDATE fleet_patch_operations SET stage='release_verify',postgres_progress_json=? WHERE operation_id=?",
  )
    .bind(JSON.stringify(emptyProgress), final!.operation_id)
    .run();
  await recordFleetPatchCheckpoint(f.runtime, final!.operation_id, {
    expected_revision: 0,
    stage: "complete",
    state: "confirmed",
    facts: { ...controlFacts, observed_at: new Date().toISOString() },
    error_code: null,
  });
  expect(
    await restoreFleetPatchPlacements(f.runtime, final!.operation_id),
  ).toBe(true);
  expect(
    await restoreFleetPatchPlacements(f.runtime, final!.operation_id),
  ).toBe(true);
  expect(
    (await env.DB.prepare(
      "SELECT database_placement_closed_at FROM nodes WHERE id=?",
    )
      .bind(f.node)
      .first<{ database_placement_closed_at: string | null }>())!
      .database_placement_closed_at,
  ).toBeNull();
});

it("a metadata-only material transition creates one current-custody host-only final pass and keeps Ready pending", async () => {
  const f = await setup(true),
    row = await readFleetPatch(env, f.op),
    now = new Date().toISOString();
  const { loadRegionJoinBundle, importRegionAgentKey } =
    await import("../../src/crypto/bootstrap-credentials.ts");
  const { ensureNodeHostConfiguration } =
    await import("../../src/domain/node-host-configuration.ts");
  const { ensureFleetPatchFinalization, restoreFleetPatchPlacements } =
    await import("../../src/domain/fleet-patches.ts");
  const { fleetPatchCheckpointAllowed } =
    await import("@pgcf/contracts/fleet-patches");
  const generated = (
    await import("../../../../packages/contracts/native/compute-pool.generated.json")
  ).default;
  const spec = JSON.parse(
    (await env.DB.prepare("SELECT spec_json FROM fleet_releases WHERE id=?")
      .bind(f.id)
      .first<{ spec_json: string }>())!.spec_json,
  );
  spec.roles.customer.host_configuration_required = true;
  spec.roles.control_relay.host_configuration_required = true;
  const policy = {
    ...generated.lease.policy,
    target_slots: 0,
    profile: { ...generated.lease.policy.profile, release_id: f.id },
  };
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO node_compute_pool_policies VALUES(?,?,1,?,?,?)",
    ).bind(f.node, f.nodeUid, f.id, JSON.stringify(policy), now),
  ]);
  await importRegionAgentKey(env.DB, env, f.region, f.agent);
  const oldHost = await ensureNodeHostConfiguration(f.runtime, {
    node_id: f.node,
    node_uid: f.nodeUid,
  });
  const receipt = {
    method: "deploymentreceipt",
    installer: spec.roles.customer.talos_installer,
    node_uid: f.nodeUid,
    cluster_uid: f.clusterUid,
    system_uuid: f.facts.system_uuid,
    pre_reboot_boot_id: crypto.randomUUID(),
    completed_at: now,
    source: "cli_exit_0",
  };
  const oldFacts = {
    ...f.facts,
    talos_version: "1.14.1",
    kubernetes_version: "1.36.5",
    kubelet_version: "1.36.5",
    host_configuration_sha256: oldHost.sha256,
  };
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE fleet_patch_operations SET stage='complete',state='confirmed',host_configuration_revision=?,host_configuration_sha256=?,observed_json=?,talos_upgrade_receipt_json=? WHERE operation_id=?",
    ).bind(
      oldHost.revision,
      oldHost.sha256,
      JSON.stringify(oldFacts),
      JSON.stringify(receipt),
      f.op,
    ),
    env.DB.prepare(
      "INSERT INTO fleet_node_release_observations(node_id,node_uid,assignment_revision,agent_key_hash,facts_json,observed_at,received_at) SELECT ?,?,1,agent_key_hash,?,?,? FROM regions WHERE id=?",
    ).bind(
      f.node,
      f.nodeUid,
      JSON.stringify({ boot_id: oldFacts.boot_id, components: [] }),
      now,
      now,
      f.region,
    ),
  ]);
  const bundle = await loadRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 1),
  );
  await storeRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 2),
    { ...bundle, talos_version: "1.14.1", kubernetes_version: "1.36.5" },
  );
  await env.DB.prepare(
    "UPDATE regions SET bootstrap_material_revision=2 WHERE id=?",
  )
    .bind(f.region)
    .run();
  expect(await restoreFleetPatchPlacements(f.runtime, f.op)).toBe(false);
  const runtime = {
    ...f.runtime,
    PATCH_NODE: { create: async () => ({}) },
  } as unknown as Env;
  const created = await ensureFleetPatchFinalization(runtime, f.op);
  expect(created!.stage).toBe("host_config");
  expect(
    (await ensureFleetPatchFinalization(runtime, f.op))!.operation_id,
  ).toBe(created!.operation_id);
  const input = await fleetPatchInput(runtime, created!.operation_id);
  expect(input.host_configuration_only).toBe(true);
  expect(input.host_configuration!.status.material_revision).toBe(2);
  expect(input.host_configuration!.status.sha256).not.toBe(oldHost.sha256);
  expect(
    JSON.parse(input.host_configuration!.files[0].content).cloudflare
      .material_revision,
  ).toBe(2);
  expect(input.talos_admin_config).toBe(bundle.talos_admin_config);
  expect(
    fleetPatchCheckpointAllowed(
      {
        ...input,
        status: { ...input.status, stage: "host_service", state: "confirmed" },
      },
      {
        expected_revision: 0,
        stage: "kubernetes",
        state: "pending",
        facts: oldFacts,
        error_code: null,
      },
    ),
  ).toBe(false);
  expect(
    fleetPatchCheckpointAllowed(
      {
        ...input,
        status: { ...input.status, stage: "host_service", state: "confirmed" },
      },
      {
        expected_revision: 0,
        stage: "runtime_admission",
        state: "pending",
        facts: oldFacts,
        error_code: null,
      },
    ),
  ).toBe(true);
  expect(
    (await env.DB.prepare(
      "SELECT database_placement_closed_at FROM nodes WHERE id=?",
    )
      .bind(f.node)
      .first<{ database_placement_closed_at: string }>())!
      .database_placement_closed_at,
  ).toBe(row.created_at);
});

it("a host-free material transition retains closure until one current-custody runtime final pass", async () => {
  const f = await setup(),
    now = new Date().toISOString();
  const { loadRegionJoinBundle } =
    await import("../../src/crypto/bootstrap-credentials.ts");
  const { continueFleetPatchRegion, restoreFleetPatchPlacements } =
    await import("../../src/domain/fleet-patches.ts");
  const oldFacts = {
      ...f.facts,
      talos_version: "v1.14.1",
      kubelet_version: "v1.36.5",
      kubernetes_version: "v1.36.5",
    },
    receipt = {
      method: "deploymentreceipt",
      installer: `registry.example/talos@sha256:${"a".repeat(64)}`,
      node_uid: f.nodeUid,
      cluster_uid: f.clusterUid,
      system_uuid: f.facts.system_uuid,
      pre_reboot_boot_id: crypto.randomUUID(),
      completed_at: now,
      source: "cli_exit_0",
    };
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE fleet_patch_operations SET stage='complete',state='confirmed',observed_json=?,talos_upgrade_receipt_json=? WHERE operation_id=?",
    ).bind(JSON.stringify(oldFacts), JSON.stringify(receipt), f.op),
    env.DB.prepare(
      "INSERT INTO fleet_node_release_observations(node_id,node_uid,assignment_revision,agent_key_hash,facts_json,observed_at,received_at) SELECT ?,?,1,agent_key_hash,?,?,? FROM regions WHERE id=?",
    ).bind(
      f.node,
      f.nodeUid,
      JSON.stringify({ boot_id: oldFacts.boot_id, components: [] }),
      now,
      now,
      f.region,
    ),
  ]);
  const old = await loadRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 1),
  );
  await storeRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 2),
    {
      ...old,
      talos_version: "1.14.1",
      kubernetes_version: "1.36.5",
      talos_admin_config: "new-current-talos-authority",
      kubeconfig: "new-current-kubernetes-authority",
    },
  );
  await env.DB.prepare(
    "UPDATE regions SET bootstrap_material_revision=2 WHERE id=?",
  )
    .bind(f.region)
    .run();
  expect(await restoreFleetPatchPlacements(f.runtime, f.op)).toBe(false);
  let dispatched = 0;
  const runtime = {
    ...f.runtime,
    PATCH_NODE: {
      create: async () => {
        dispatched++;
        return {};
      },
    },
  } as unknown as Env;
  const next = await continueFleetPatchRegion(runtime, f.op);
  expect(next).not.toBeNull();
  expect(next!.stage).toBe("runtime_admission");
  const input = await fleetPatchInput(runtime, next!.operation_id);
  expect(
    (await readFleetPatch(runtime, next!.operation_id)).material_revision,
  ).toBe(2);
  expect(input.host_configuration_only).toBe(false);
  expect(input.host_configuration).toBeUndefined();
  expect(input.talos_admin_config).toBe("new-current-talos-authority");
  expect(input.kubeconfig).toBe("new-current-kubernetes-authority");
  expect((await continueFleetPatchRegion(runtime, f.op))!.operation_id).toBe(
    next!.operation_id,
  );
  expect(dispatched).toBe(2);
  expect(await restoreFleetPatchPlacements(runtime, f.op)).toBe(false);
  expect((await readFleetPatch(runtime, f.op)).stage).toBe("complete");
  expect((await readFleetPatch(runtime, f.op)).material_revision).toBe(1);
  await env.DB.prepare(
    "UPDATE fleet_patch_operations SET stage='complete',state='confirmed' WHERE operation_id=?",
  )
    .bind(next!.operation_id)
    .run();
  expect(await restoreFleetPatchPlacements(runtime, next!.operation_id)).toBe(
    true,
  );
});
