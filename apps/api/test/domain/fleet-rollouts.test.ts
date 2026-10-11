// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { ComputePoolPolicy } from "@pgcf/contracts/compute-pool";
import { FleetReleaseSpec } from "@pgcf/contracts/releases";
import generatedPool from "../../../../packages/contracts/native/compute-pool.generated.json" with { type: "json" };
import { newNodeId, newOperationId } from "@pgcf/contracts";
import { cleanupFixtures, fixture } from "./fixtures.ts";
import { createApp } from "../../src/app.ts";
import type { Env } from "../../src/env.ts";
import {
  storeRegionJoinBundle,
  importRegionAgentKey,
  storeRegionSeed,
  regionSeedReference,
  joinBundleReference,
} from "../../src/crypto/bootstrap-credentials.ts";
import {
  ensureRetainedFleetPatch,
  synchronizeFleetPatchRegionMaterial,
} from "../../src/domain/fleet-patches.ts";
import { installationHash } from "../../src/domain/node-installation.ts";
import {
  advanceFleetRollout,
  readFleetRollout,
  readFleetRolloutIntent,
  writeFleetRolloutIntent,
} from "../../src/domain/fleet-rollouts.ts";

const releases: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
async function setup() {
  const f = await fixture(),
    release = `rollout-${crypto.randomUUID()}`,
    now = new Date().toISOString();
  releases.push(release);
  const control = newNodeId(),
    customerUid = crypto.randomUUID(),
    controlUid = crypto.randomUUID(),
    us = newNodeId(),
    usUid = crypto.randomUUID();
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
  const spec = {
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
    roles: { customer: role, control_relay: structuredClone(role) },
  };
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES(?,?,?,?)",
    ).bind(release, JSON.stringify(spec), await installationHash(spec), now),
    env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?").bind(
      customerUid,
      f.node,
    ),
    ...[
      [control, f.region, controlUid],
      [us, f.foreign, usUid],
    ].map(([node, region, uid]) =>
      env.DB.prepare(
        "INSERT INTO nodes(id,region_id,k8s_node_name,node_uid,ready,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at) VALUES(?,?,?,?,1,4096,2000,30,128,100,?,?,?)",
      ).bind(
        node,
        region,
        `node-${node!.replaceAll("_", "-")}`,
        uid,
        now,
        now,
        now,
      ),
    ),
  ]);
  await env.DB.batch(
    [
      [f.node, customerUid],
      [control, controlUid],
      [us, usUid],
    ].map(([node, uid]) =>
      env.DB.prepare(
        "INSERT INTO node_memory_samples(node_id,node_uid,minute,observed_at,working_set_bytes,capacity_memory_bytes,available_bytes,memory_pressure) VALUES(?,?,?,?,104857600,4294967296,4000000000,0)",
      ).bind(node, uid, Math.floor(Date.now() / 60000), now),
    ),
  );
  const euCluster = crypto.randomUUID(),
    usCluster = crypto.randomUUID();
  for (const [region, uid] of [
    [f.region, euCluster],
    [f.foreign, usCluster],
  ])
    await storeRegionJoinBundle(
      env.DB,
      env.CREDENTIAL_KEYS,
      joinBundleReference(region!, 1),
      {
        version: 1,
        cluster_name: "test-cluster",
        cluster_endpoint: "https://192.0.2.18:6443/",
        talos_version: "1.14.1",
        kubernetes_version: "1.36.3",
        talos_machine_secrets_yaml: "test-only-machine-secrets",
        talos_admin_config: "test-only-talos-config",
        kube_system_uid: uid!,
        kubeconfig: "test-only-kubeconfig",
      },
    );
  const started = new Set<string>();
  const runtime = {
    ...env,
    PATCH_NODE: {
      create: async ({ id }: { id: string }) => {
        if (started.has(id)) throw new Error("existing");
        started.add(id);
        return {};
      },
      get: async () => ({ status: async () => ({ status: "running" }) }),
    },
  } as unknown as Env;
  const input = {
    release_id: release,
    maintenance_acknowledged: true,
    regions: [
      {
        region_id: f.foreign,
        expected_revision: 0,
        cluster_uid: usCluster,
        material_revision: 1,
        nodes: [
          {
            node_id: us,
            node_uid: usUid,
            expected_revision: 0,
            role: "customer",
            address: "192.0.2.20",
          },
        ],
      },
      {
        region_id: f.region,
        expected_revision: 0,
        cluster_uid: euCluster,
        material_revision: 1,
        nodes: [
          {
            node_id: f.node,
            node_uid: customerUid,
            expected_revision: 0,
            role: "customer",
            address: "192.0.2.19",
          },
          {
            node_id: control,
            node_uid: controlUid,
            expected_revision: 0,
            role: "control_relay",
            address: "192.0.2.18",
          },
        ],
      },
    ],
  };
  async function send(body = input, key = "start-rollout") {
    const context = createExecutionContext();
    const response = await createApp().fetch(
      new Request("https://api.invalid/v1/fleet/rollouts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${f.admin}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify(body),
      }),
      runtime,
      context,
    );
    await waitOnExecutionContext(context);
    return response;
  }
  return { ...f, release, spec, input, runtime, started, send, us, control };
}
it("an explicit quiescent held rollout replacement preserves its immediate predecessor, EU hold and completed receipts", async () => {
  const f = await setup(),
    original = structuredClone(
      f.input,
    ) as import("@pgcf/contracts/fleet-rollouts").FleetRolloutRequest;
  original.regions[1]!.staged_material_revision = 2;
  const response = await f.send(original as typeof f.input),
    { rollout_id } = (await response.json()) as { rollout_id: string };
  expect(response.status).toBe(202);
  const before = await readFleetRolloutIntent(env.DB, rollout_id),
    held = structuredClone(before);
  held.regions[1]!.rotation = {
    revision: 0,
    phase: "snapshot",
    node_index: 0,
    state: "halted",
    error_code: "operator_hold_us_acceptance",
  };
  await writeFleetRolloutIntent(f.runtime, before, held);
  await env.DB.prepare(
    "UPDATE fleet_patch_operations SET stage='complete',state='confirmed' WHERE node_id=?",
  )
    .bind(f.us)
    .run();
  const oldPatch = await env.DB.prepare(
      "SELECT * FROM fleet_patch_operations WHERE node_id=?",
    )
      .bind(f.us)
      .first(),
    nextRelease = `replacement-${crypto.randomUUID()}`,
    nextSpec = structuredClone(f.spec);
  for (const role of Object.values(nextSpec.roles)) {
    role.talos_installer = `registry.example/new-golden@sha256:${"e".repeat(64)}`;
    role.talos_schematic_sha256 = "f".repeat(64);
  }
  releases.push(nextRelease);
  await env.DB.prepare(
    "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES(?,?,?,?)",
  )
    .bind(
      nextRelease,
      JSON.stringify(nextSpec),
      await installationHash(nextSpec),
      new Date().toISOString(),
    )
    .run();
  const next = structuredClone(original);
  next.release_id = nextRelease;
  next.expected_previous_rollout_id = rollout_id;
  for (const region of next.regions) {
    region.expected_revision = 1;
    for (const node of region.nodes) node.expected_revision = 1;
  }
  const assignments = () =>
      env.DB.prepare(
        "SELECT node_id,node_uid,release_id,role,revision FROM fleet_node_releases ORDER BY node_id",
      )
        .all()
        .then((value) => value.results),
    saved = await assignments();
  expect(
    (
      await f.send(
        {
          ...next,
          expected_previous_rollout_id: newOperationId(),
        } as typeof f.input,
        "wrong-held-intent",
      )
    ).status,
  ).toBe(409);
  await env.DB.prepare(
    "UPDATE fleet_patch_operations SET stage='talos',state='dispatched' WHERE node_id=?",
  )
    .bind(f.us)
    .run();
  expect(
    (await f.send(next as typeof f.input, "unknown-held-write")).status,
  ).toBe(409);
  expect(await assignments()).toEqual(saved);
  await env.DB.prepare(
    "UPDATE fleet_patch_operations SET stage='complete',state='confirmed' WHERE node_id=?",
  )
    .bind(f.us)
    .run();
  const providerOperation = newOperationId(),
    providerTime = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO node_additions(operation_id,node_id,region_id,request_key,request_hash,intent_hash,intent_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'{}','ready',?,?)",
    ).bind(
      providerOperation,
      f.us,
      f.foreign,
      crypto.randomUUID(),
      "a".repeat(64),
      "b".repeat(64),
      providerTime,
      providerTime,
    ),
    env.DB.prepare(
      "INSERT INTO node_provider_mutations(operation_id,mutation,request_id,revision,state,created_at,updated_at) VALUES(?,'restart',?,1,'unknown',?,?)",
    ).bind(providerOperation, crypto.randomUUID(), providerTime, providerTime),
  ]);
  expect(
    (await f.send(next as typeof f.input, "unknown-provider-write")).status,
  ).toBe(409);
  expect(await assignments()).toEqual(saved);
  await env.DB.prepare(
    "UPDATE node_provider_mutations SET state='accepted' WHERE operation_id=?",
  )
    .bind(providerOperation)
    .run();
  const changedHold = structuredClone(held);
  changedHold.regions[1]!.rotation!.state = "pending";
  let raced = false;
  f.runtime.DB = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async (statements: D1PreparedStatement[]) => {
      if (!raced) {
        raced = true;
        await env.DB.prepare(
          "UPDATE fleet_region_releases SET rollout_json=? WHERE rollout_json=?",
        )
          .bind(JSON.stringify(changedHold), JSON.stringify(held))
          .run();
      }
      return env.DB.batch(statements);
    },
  } as D1Database;
  expect(
    (await f.send(next as typeof f.input, "changed-hold-before-cas")).status,
  ).toBe(409);
  expect(raced).toBe(true);
  expect(await assignments()).toEqual(saved);
  f.runtime.DB = env.DB;
  await env.DB.prepare(
    "UPDATE fleet_region_releases SET rollout_json=? WHERE rollout_json=?",
  )
    .bind(JSON.stringify(held), JSON.stringify(changedHold))
    .run();
  const accepted = await f.send(next as typeof f.input, "replace-held-intent");
  expect(accepted.status).toBe(202);
  const current = (await accepted.json()) as { rollout_id: string },
    replacement = await readFleetRolloutIntent(env.DB, current.rollout_id);
  expect(replacement.previous_intent).toEqual(held);
  expect(replacement.regions[1]!.rotation).toEqual(held.regions[1]!.rotation);
  expect(replacement.regions[1]!.staged_material_revision).toBe(2);
  expect(
    await env.DB.prepare(
      "SELECT * FROM fleet_patch_operations WHERE operation_id=?",
    )
      .bind(oldPatch!.operation_id)
      .first(),
  ).toEqual(oldPatch);
  expect((await readFleetRollout(f.runtime, rollout_id)).state).toBe("blocked");
  expect((await readFleetRollout(f.runtime, rollout_id)).reason).toBe(
    "identity_or_assignment_changed",
  );
  const started = f.started.size;
  await expect(advanceFleetRollout(f.runtime, rollout_id)).rejects.toThrow(
    /identity|authority/i,
  );
  expect(f.started.size).toBe(started);
  const replay = await f.send(original as typeof f.input);
  expect(replay.status).toBe(202);
  expect(((await replay.json()) as { state: string }).state).toBe("blocked");
  expect(f.started.size).toBe(started);
});
it("a completed fleet can select its next release without reopening confirmed host-ready history or bypassing unknown writes", async () => {
  const f = await setup(),
    first = await f.send(),
    { rollout_id } = (await first.json()) as { rollout_id: string },
    nextRelease = `next-${crypto.randomUUID()}`,
    now = new Date().toISOString(),
    next = structuredClone(f.input);
  expect(first.status).toBe(202);
  releases.push(nextRelease);
  await env.DB.prepare(
    "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES(?,?,?,?)",
  )
    .bind(
      nextRelease,
      JSON.stringify(f.spec),
      await installationHash(f.spec),
      now,
    )
    .run();
  next.release_id = nextRelease;
  for (const region of next.regions) {
    region.expected_revision = 1;
    for (const node of region.nodes) node.expected_revision = 1;
  }
  expect((await f.send(next, "next-before-complete")).status).toBe(409);

  const old = (await env.DB.prepare(
    "SELECT operation_id FROM fleet_patch_operations WHERE node_id=?",
  )
    .bind(f.us)
    .first<{ operation_id: string }>())!;
  await env.DB.prepare(
    "UPDATE fleet_patch_operations SET stage='complete',state='confirmed' WHERE operation_id=?",
  )
    .bind(old.operation_id)
    .run();
  const historical = newOperationId();
  const copy = async (
    id: string,
    region: (typeof f.input.regions)[number],
    node: (typeof f.input.regions)[number]["nodes"][number],
    stage: "complete" | "host_ready",
    created: string,
    parent: string | null = null,
  ) =>
    env.DB.prepare(
      `INSERT INTO fleet_patch_operations(operation_id,node_id,region_id,node_uid,cluster_uid,release_id,spec_sha256,assignment_revision,region_revision,material_revision,address,cluster_nodes_json,revision,stage,state,created_at,updated_at,deadline_at,finalization_of)
       SELECT ?,?,?,?, ?,release_id,spec_sha256,assignment_revision,region_revision,material_revision,?,?,revision,?,'confirmed',?,?,deadline_at,? FROM fleet_patch_operations WHERE operation_id=?`,
    )
      .bind(
        id,
        node.node_id,
        region.region_id,
        node.node_uid,
        region.cluster_uid,
        node.address,
        JSON.stringify(region.nodes),
        stage,
        created,
        created,
        parent,
        old.operation_id,
      )
      .run();
  const eu = f.input.regions[1]!;
  await copy(
    historical,
    eu,
    eu.nodes[0]!,
    "host_ready",
    new Date(Date.now() - 2000).toISOString(),
  );
  await copy(newOperationId(), eu, eu.nodes[0]!, "complete", now, historical);
  await copy(newOperationId(), eu, eu.nodes[1]!, "complete", now);
  for (const region of f.input.regions)
    for (const node of region.nodes)
      await env.DB.prepare(
        "INSERT INTO fleet_node_release_observations(node_id,node_uid,assignment_revision,agent_key_hash,facts_json,observed_at,received_at) SELECT ?,?,1,agent_key_hash,?,?,? FROM regions WHERE id=?",
      )
        .bind(
          node.node_id,
          node.node_uid,
          JSON.stringify({
            configuration_schema_revision: f.spec.configuration_schema_revision,
            talos_version: f.spec.roles.customer.talos_version,
            talos_installer: f.spec.roles.customer.talos_installer,
            talos_schematic_sha256:
              f.spec.roles.customer.talos_schematic_sha256,
            kubernetes_version: f.spec.roles.customer.kubernetes_version,
            components: f.spec.components
              .filter((component) =>
                f.spec.roles.customer.components.includes(component.name),
              )
              .map(({ name, version, sha256 }) => ({ name, version, sha256 })),
          }),
          now,
          now,
          region.region_id,
        )
        .run();
  expect((await readFleetRollout(f.runtime, rollout_id)).state).toBe(
    "complete",
  );

  await env.DB.prepare(
    "UPDATE fleet_patch_operations SET state='dispatched' WHERE operation_id=?",
  )
    .bind(historical)
    .run();
  expect((await f.send(next, "next-unconfirmed-host")).status).toBe(409);
  await env.DB.prepare(
    "UPDATE fleet_patch_operations SET stage='talos' WHERE operation_id=?",
  )
    .bind(historical)
    .run();
  expect((await f.send(next, "next-unknown-write")).status).toBe(409);
  await env.DB.prepare(
    "UPDATE fleet_patch_operations SET stage='host_ready',state='confirmed' WHERE operation_id=?",
  )
    .bind(historical)
    .run();

  expect((await f.send(next, "next-completed-fleet")).status).toBe(202);
  expect(
    await env.DB.prepare(
      "SELECT stage,state FROM fleet_patch_operations WHERE operation_id=?",
    )
      .bind(historical)
      .first(),
  ).toEqual({ stage: "host_ready", state: "confirmed" });
  expect(
    await env.DB.prepare(
      "SELECT release_id,revision FROM fleet_node_releases WHERE node_id=?",
    )
      .bind(f.us)
      .first(),
  ).toEqual({ release_id: nextRelease, revision: 2 });
});
it("one fleet request assigns all physical members but dispatches only the first region, and replay reuses the operation", async () => {
  const f = await setup(),
    first = await f.send();
  expect(first.status).toBe(202);
  const result = (await first.json()) as { rollout_id: string };
  expect(f.started.size).toBe(1);
  const rows = await env.DB.prepare(
    "SELECT node_id FROM fleet_patch_operations WHERE release_id=?",
  )
    .bind(f.release)
    .all<{ node_id: string }>();
  expect(rows.results.map((row) => row.node_id)).toEqual([f.us]);
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM fleet_node_releases WHERE release_id=?",
    )
      .bind(f.release)
      .first("n"),
  ).toBe(3);
  expect(
    ((await (await f.send()).json()) as { rollout_id: string }).rollout_id,
  ).toBe(result.rollout_id);
  expect(f.started.size).toBe(1);
  await advanceFleetRollout(f.runtime, result.rollout_id);
  expect(f.started.size).toBe(1);
});
it("global continuation does not start EU while US has an unresolved write, or duplicate its persisted patch", async () => {
  const f = await setup(),
    response = await f.send();
  const { rollout_id } = (await response.json()) as { rollout_id: string };
  await env.DB.prepare(
    "UPDATE fleet_patch_operations SET state='dispatched',deadline_at=? WHERE node_id=?",
  )
    .bind(new Date(Date.now() - 1000).toISOString(), f.us)
    .run();
  await advanceFleetRollout(f.runtime, rollout_id);
  expect(f.started.size).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM fleet_patch_operations WHERE region_id=?",
    )
      .bind(f.region)
      .first("n"),
  ).toBe(0);
});
it("identity changes fail closed before dispatching another node", async () => {
  const f = await setup(),
    response = await f.send();
  const { rollout_id } = (await response.json()) as { rollout_id: string };
  await env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?")
    .bind(crypto.randomUUID(), f.control)
    .run();
  await expect(advanceFleetRollout(f.runtime, rollout_id)).rejects.toThrow(
    /identity|authority/i,
  );
  expect(f.started.size).toBe(1);
});
it("stale revision or a missing cluster member rejects the entire assignment", async () => {
  const f = await setup(),
    invalid = structuredClone(f.input);
  invalid.regions[1]!.nodes.pop();
  expect((await f.send(invalid)).status).toBe(409);
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM fleet_node_releases WHERE release_id=?",
    )
      .bind(f.release)
      .first("n"),
  ).toBe(0);
  expect(f.started.size).toBe(0);
});
it("skips the already-current US region and starts every untouched EU host in supplied order", async () => {
  const f = await setup(),
    body = structuredClone(f.input),
    now = new Date().toISOString(),
    us = body.regions[0]!.nodes[0]!;
  body.regions[0]!.expected_revision = 1;
  us.expected_revision = 1;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO fleet_region_releases(region_id,release_id,revision,updated_at) VALUES(?,?,1,?)",
    ).bind(f.foreign, f.release, now),
    env.DB.prepare(
      "INSERT INTO fleet_node_releases(node_id,node_uid,release_id,role,revision,updated_at) VALUES(?,?,?,'customer',1,?)",
    ).bind(f.us, us.node_uid, f.release, now),
    env.DB.prepare(
      "INSERT INTO fleet_node_release_observations(node_id,node_uid,assignment_revision,agent_key_hash,facts_json,observed_at,received_at) SELECT ?,?,1,agent_key_hash,?,?,? FROM regions WHERE id=?",
    ).bind(
      f.us,
      us.node_uid,
      JSON.stringify({
        configuration_schema_revision: 1,
        talos_version: f.spec.roles.customer.talos_version,
        talos_installer: f.spec.roles.customer.talos_installer,
        talos_schematic_sha256: f.spec.roles.customer.talos_schematic_sha256,
        kubernetes_version: f.spec.roles.customer.kubernetes_version,
        components: f.spec.components
          .filter((component) =>
            f.spec.roles.customer.components.includes(component.name),
          )
          .map(({ name, version, sha256 }) => ({ name, version, sha256 })),
      }),
      now,
      now,
      f.foreign,
    ),
  ]);
  const response = await f.send(body),
    { rollout_id } = (await response.json()) as { rollout_id: string };
  expect(response.status).toBe(202);
  const first = await env.DB.prepare(
    "SELECT operation_id,node_id FROM fleet_patch_operations WHERE release_id=?",
  )
    .bind(f.release)
    .first<{ operation_id: string; node_id: string }>();
  expect(first!.node_id).toBe(f.node);
  await env.DB.prepare(
    "UPDATE fleet_patch_operations SET stage='host_ready',state='confirmed' WHERE operation_id=?",
  )
    .bind(first!.operation_id)
    .run();
  await advanceFleetRollout(f.runtime, rollout_id);
  expect(
    (
      await env.DB.prepare(
        "SELECT node_id FROM fleet_patch_operations WHERE release_id=? ORDER BY created_at,rowid",
      )
        .bind(f.release)
        .all<{ node_id: string }>()
    ).results.map((row) => row.node_id),
  ).toEqual([f.node, f.control]);
  expect(f.started.size).toBe(2);
});
it("an explicit halted patch blocks later regions and is never cleared by reconciliation", async () => {
  const f = await setup(),
    response = await f.send(),
    { rollout_id } = (await response.json()) as { rollout_id: string };
  await env.DB.prepare(
    "UPDATE fleet_patch_operations SET state='halted',error_code='identity_changed' WHERE node_id=?",
  )
    .bind(f.us)
    .run();
  expect((await advanceFleetRollout(f.runtime, rollout_id)).state).toBe(
    "blocked",
  );
  expect(f.started.size).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM fleet_patch_operations WHERE region_id=?",
    )
      .bind(f.region)
      .first("n"),
  ).toBe(0);
});
it("a declared prepared rotation holds the first host until its programmed material handoff", async () => {
  const f = await setup(),
    body = structuredClone(f.input) as typeof f.input & {
      regions: ((typeof f.input.regions)[number] & {
        staged_material_revision?: number;
      })[];
    };
  body.regions[0]!.staged_material_revision = 2;
  const response = await f.send(body);
  expect(response.status).toBe(202);
  const result = (await response.json()) as {
    reason: string;
    rollout_id: string;
  };
  expect(result.reason).toBe("prepared_rotation_pending");
  expect(f.started.size).toBe(0);
  expect((await advanceFleetRollout(f.runtime, result.rollout_id)).state).toBe(
    "pending",
  );
  expect(f.started.size).toBe(0);
});
it("rotation progress CAS updates every selected region copy and rejects a stale or identity-changing update", async () => {
  const f = await setup(),
    response = await f.send(),
    { rollout_id } = (await response.json()) as { rollout_id: string };
  const before = await readFleetRolloutIntent(env.DB, rollout_id),
    after = structuredClone(before);
  after.regions[1]!.rotation = {
    revision: 0,
    phase: "snapshot",
    node_index: 0,
    state: "pending",
  };
  await writeFleetRolloutIntent(f.runtime, before, after);
  const rows = await env.DB.prepare(
    "SELECT rollout_json FROM fleet_region_releases WHERE json_extract(rollout_json,'$.rollout_id')=?",
  )
    .bind(rollout_id)
    .all<{ rollout_json: string }>();
  expect(rows.results).toHaveLength(2);
  expect(new Set(rows.results.map((row) => row.rollout_json)).size).toBe(1);
  expect(
    (await readFleetRolloutIntent(env.DB, rollout_id)).regions[1]!.rotation,
  ).toEqual(after.regions[1]!.rotation);
  // A repeated committed write is a readback; another outcome cannot overwrite that same revision.
  await writeFleetRolloutIntent(f.runtime, before, after);
  const competing = structuredClone(after);
  competing.regions[1]!.rotation!.state = "dispatched";
  await expect(
    writeFleetRolloutIntent(f.runtime, before, competing),
  ).rejects.toThrow(/identity|authority/i);
  const replaced = structuredClone(after);
  replaced.regions[1]!.nodes[0]!.node_uid = crypto.randomUUID();
  await expect(
    writeFleetRolloutIntent(f.runtime, after, replaced),
  ).rejects.toThrow(/identity|authority/i);
});
it("version-only synchronization leaves an already-staged replacement envelope untouched until rotation completes", async () => {
  const f = await setup(),
    body = structuredClone(f.input) as typeof f.input & {
      regions: ((typeof f.input.regions)[number] & {
        staged_material_revision?: number;
      })[];
    };
  body.regions[0]!.staged_material_revision = 2;
  const response = await f.send(body),
    { rollout_id } = (await response.json()) as { rollout_id: string };
  const intent = await readFleetRolloutIntent(env.DB, rollout_id),
    node = intent.regions[0]!.nodes[0]!,
    now = new Date().toISOString();
  const patch = await ensureRetainedFleetPatch(f.runtime, node.node_id, {
    node_uid: node.node_uid,
    assignment_revision: node.assignment_revision,
    release_id: f.release,
    address: node.address,
    maintenance_acknowledged: true,
  });
  const seed = {
    version: 1 as const,
    cluster_name: "test-cluster",
    cluster_endpoint: "https://192.0.2.18:6443/",
    talos_version: "1.14.1",
    kubernetes_version: "1.36.3" as const,
    talos_machine_secrets_yaml: "old-test-only-machine-secrets",
    talos_admin_config: "old-test-only-talos-config",
  };
  await storeRegionSeed(
    env.DB,
    env.CREDENTIAL_KEYS,
    regionSeedReference(f.foreign, 1),
    seed,
  );
  await storeRegionSeed(
    env.DB,
    env.CREDENTIAL_KEYS,
    regionSeedReference(f.foreign, 2),
    {
      ...seed,
      talos_machine_secrets_yaml: "prepared-test-only-machine-secrets",
      talos_admin_config: "prepared-test-only-talos-config",
    },
  );
  const staged = await env.DB.prepare(
    "SELECT ciphertext FROM region_bootstrap_credentials WHERE region_id=? AND purpose='region_seed' AND revision=2",
  )
    .bind(f.foreign)
    .first("ciphertext");
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE fleet_patch_operations SET stage='complete',state='confirmed' WHERE operation_id=?",
    ).bind(patch.operation_id),
    env.DB.prepare(
      "UPDATE nodes SET provider_instance_id='123456' WHERE id=?",
    ).bind(node.node_id),
    env.DB.prepare(
      "INSERT INTO fleet_node_release_observations(node_id,node_uid,assignment_revision,agent_key_hash,facts_json,observed_at,received_at) SELECT ?,?,?,agent_key_hash,?,?,? FROM regions WHERE id=?",
    ).bind(
      node.node_id,
      node.node_uid,
      node.assignment_revision,
      JSON.stringify({
        configuration_schema_revision: 1,
        talos_version: f.spec.roles.customer.talos_version,
        talos_installer: f.spec.roles.customer.talos_installer,
        talos_schematic_sha256: f.spec.roles.customer.talos_schematic_sha256,
        kubernetes_version: f.spec.roles.customer.kubernetes_version,
        components: f.spec.components
          .filter((component) =>
            f.spec.roles.customer.components.includes(component.name),
          )
          .map(({ name, version, sha256 }) => ({ name, version, sha256 })),
      }),
      now,
      now,
      f.foreign,
    ),
  ]);
  expect(
    await synchronizeFleetPatchRegionMaterial(f.runtime, patch.operation_id),
  ).toBe("waiting_members");
  expect(
    await env.DB.prepare(
      "SELECT bootstrap_material_revision FROM regions WHERE id=?",
    )
      .bind(f.foreign)
      .first("bootstrap_material_revision"),
  ).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT ciphertext FROM region_bootstrap_credentials WHERE region_id=? AND purpose='region_seed' AND revision=2",
    )
      .bind(f.foreign)
      .first("ciphertext"),
  ).toBe(staged);
});
it("null RAM cannot finish a software-current region; a fresh physical-node sample permits continuation without changing placement policy", async () => {
  const f = await setup(),
    body = structuredClone(f.input),
    now = new Date().toISOString(),
    us = body.regions[0]!.nodes[0]!;
  body.regions[0]!.expected_revision = 1;
  us.expected_revision = 1;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO fleet_region_releases(region_id,release_id,revision,updated_at) VALUES(?,?,1,?)",
    ).bind(f.foreign, f.release, now),
    env.DB.prepare(
      "INSERT INTO fleet_node_releases(node_id,node_uid,release_id,role,revision,updated_at) VALUES(?,?,?,'customer',1,?)",
    ).bind(f.us, us.node_uid, f.release, now),
    env.DB.prepare(
      "INSERT INTO fleet_node_release_observations(node_id,node_uid,assignment_revision,agent_key_hash,facts_json,observed_at,received_at) SELECT ?,?,1,agent_key_hash,?,?,? FROM regions WHERE id=?",
    ).bind(
      f.us,
      us.node_uid,
      JSON.stringify({
        configuration_schema_revision: 1,
        talos_version: f.spec.roles.customer.talos_version,
        talos_installer: f.spec.roles.customer.talos_installer,
        talos_schematic_sha256: f.spec.roles.customer.talos_schematic_sha256,
        kubernetes_version: f.spec.roles.customer.kubernetes_version,
        components: f.spec.components
          .filter((component) =>
            f.spec.roles.customer.components.includes(component.name),
          )
          .map(({ name, version, sha256 }) => ({ name, version, sha256 })),
      }),
      now,
      now,
      f.foreign,
    ),
    env.DB.prepare(
      "UPDATE node_memory_samples SET working_set_bytes=NULL,capacity_memory_bytes=NULL,available_bytes=NULL,memory_pressure=NULL WHERE node_id=?",
    ).bind(f.us),
  ]);
  const response = await f.send(body),
    result = (await response.json()) as {
      rollout_id: string;
      state: string;
      reason: string;
    };
  expect(response.status).toBe(202);
  expect(result.state).toBe("pending");
  expect(result.reason).toBe("waiting_observations");
  expect(f.started.size).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT database_placement_enabled FROM nodes WHERE id=?",
    )
      .bind(f.us)
      .first("database_placement_enabled"),
  ).toBe(1);
  await env.DB.prepare(
    "UPDATE node_memory_samples SET observed_at=?,working_set_bytes=104857600,capacity_memory_bytes=4294967296,available_bytes=4000000000,memory_pressure=0 WHERE node_id=? AND node_uid=?",
  )
    .bind(new Date().toISOString(), f.us, us.node_uid)
    .run();
  await advanceFleetRollout(f.runtime, result.rollout_id);
  expect(f.started.size).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT node_id FROM fleet_patch_operations WHERE release_id=?",
    )
      .bind(f.release)
      .first("node_id"),
  ).toBe(f.node);
});
it("the single host-required request commits every release-bound pool policy before its patch dispatch", async () => {
  const f = await setup(),
    release = `pool-${crypto.randomUUID()}`,
    spec = FleetReleaseSpec.parse(f.spec),
    body = structuredClone(
      f.input,
    ) as import("@pgcf/contracts/fleet-rollouts").FleetRolloutRequest;
  releases.push(release);
  spec.components.push({
    name: "sandbox-controller",
    kind: "image",
    version: "1.0.0",
    reference: generatedPool.lease.policy.profile.image,
    sha256: generatedPool.lease.policy.profile.image.split("@sha256:")[1]!,
  });
  spec.roles.customer.host_configuration_required = true;
  spec.roles.control_relay.host_configuration_required = true;
  expect(
    (
      await import("./fixtures.ts").then(({ request }) =>
        request(`/v1/fleet/releases/${release}`, f.admin, "PUT", spec),
      )
    ).status,
  ).toBe(200);
  body.release_id = release;
  for (const region of body.regions)
    for (const node of region.nodes)
      node.compute_pool = {
        expected_revision: 0,
        policy: ComputePoolPolicy.parse({
          ...generatedPool.lease.policy,
          profile: {
            ...generatedPool.lease.policy.profile,
            release_id: release,
          },
        }),
      };
  await importRegionAgentKey(env.DB, env, f.region, f.agent);
  await importRegionAgentKey(env.DB, env, f.foreign, f.foreignAgent);
  f.runtime.NODE_BOOTSTRAP_CALLBACK_URL = "https://api.invalid/";
  let dispatched = 0;
  f.runtime.PATCH_NODE = {
    create: async ({ id }: { id: string }) => {
      const selected = await env.DB.prepare(
        "SELECT p.release_id,p.revision,p.policy_json,h.pool_policy_revision FROM fleet_patch_operations f JOIN node_compute_pool_policies p ON p.node_id=f.node_id JOIN node_host_configurations h ON h.node_id=f.node_id WHERE f.operation_id=?",
      )
        .bind(id)
        .first<{
          release_id: string;
          revision: number;
          policy_json: string;
          pool_policy_revision: number;
        }>();
      expect(selected!.release_id).toBe(release);
      expect(selected!.revision).toBe(1);
      expect(selected!.pool_policy_revision).toBe(1);
      expect(JSON.parse(selected!.policy_json).profile.release_id).toBe(
        release,
      );
      dispatched++;
      return {};
    },
  } as unknown as Env["PATCH_NODE"];
  const response = await f.send(body, "host-pool-once");
  expect(response.status).toBe(202);
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM node_compute_pool_policies WHERE release_id=?",
    )
      .bind(release)
      .first("n"),
  ).toBe(3);
  expect(dispatched).toBe(1);
  const saved = await env.DB.prepare(
    "SELECT revision,policy_json FROM node_compute_pool_policies WHERE node_id=?",
  )
    .bind(f.us)
    .first();
  await f.send(body, "host-pool-once");
  expect(
    await env.DB.prepare(
      "SELECT revision,policy_json FROM node_compute_pool_policies WHERE node_id=?",
    )
      .bind(f.us)
      .first(),
  ).toEqual(saved);
});
it("a superseded node assignment cannot advance a surviving multi-region intent copy", async () => {
  const f = await setup(),
    response = await f.send(),
    { rollout_id } = (await response.json()) as { rollout_id: string },
    before = await readFleetRolloutIntent(env.DB, rollout_id),
    after = structuredClone(before);
  after.regions[1]!.rotation = {
    revision: 0,
    phase: "snapshot",
    node_index: 0,
    state: "pending",
  };
  await env.DB.prepare(
    "UPDATE fleet_node_releases SET revision=revision+1 WHERE node_id=?",
  )
    .bind(f.control)
    .run();
  await expect(
    writeFleetRolloutIntent(f.runtime, before, after),
  ).rejects.toThrow(/identity|authority/i);
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM fleet_region_releases WHERE rollout_json=?",
    )
      .bind(JSON.stringify(before))
      .first("n"),
  ).toBe(2);
});
it("a same-release staged rotation starts a fresh normal patch for an already-current control instead of reusing its terminal journal", async () => {
  const f = await setup(),
    release = `current-${crypto.randomUUID()}`,
    spec = FleetReleaseSpec.parse(f.spec),
    body = structuredClone(
      f.input,
    ) as import("@pgcf/contracts/fleet-rollouts").FleetRolloutRequest,
    now = new Date().toISOString();
  releases.push(release);
  spec.components.push({
    name: "image/cilium/cilium",
    kind: "image",
    version: "1.0.0",
    reference: `registry.example/cilium@sha256:${"d".repeat(64)}`,
    sha256: "d".repeat(64),
  });
  for (const role of Object.values(spec.roles))
    role.components.push("image/cilium/cilium");
  const { request } = await import("./fixtures.ts");
  expect(
    (await request(`/v1/fleet/releases/${release}`, f.admin, "PUT", spec))
      .status,
  ).toBe(200);
  body.release_id = release;
  const first = await f.send(body, "current-base");
  expect(first.status).toBe(202);
  const old = (await env.DB.prepare(
    "SELECT operation_id FROM fleet_patch_operations WHERE node_id=?",
  )
    .bind(f.us)
    .first<{ operation_id: string }>())!;
  await env.DB.prepare(
    "UPDATE fleet_patch_operations SET stage='complete',state='confirmed' WHERE operation_id=?",
  )
    .bind(old.operation_id)
    .run();
  for (const region of body.regions)
    for (const node of region.nodes) {
      await env.DB.prepare("UPDATE nodes SET provider_instance_id=? WHERE id=?")
        .bind(
          node.node_id === f.us
            ? "123456"
            : node.node_id === f.node
              ? "123457"
              : "123458",
          node.node_id,
        )
        .run();
      await env.DB.prepare(
        "INSERT INTO fleet_node_release_observations(node_id,node_uid,assignment_revision,agent_key_hash,facts_json,observed_at,received_at) SELECT ?,?,1,agent_key_hash,?,?,? FROM regions WHERE id=?",
      )
        .bind(
          node.node_id,
          node.node_uid,
          JSON.stringify({
            boot_id: crypto.randomUUID(),
            kubernetes_control_plane: node.node_id === f.us,
            configuration_schema_revision: 1,
            talos_version: spec.roles.customer.talos_version,
            talos_installer: spec.roles.customer.talos_installer,
            talos_schematic_sha256: spec.roles.customer.talos_schematic_sha256,
            kubernetes_version: spec.roles.customer.kubernetes_version,
            components: spec.components
              .filter((component) =>
                spec.roles.customer.components.includes(component.name),
              )
              .map(({ name, version, sha256 }) => ({
                name,
                version,
                sha256,
                runtime_image_sha256: sha256,
              })),
          }),
          now,
          now,
          region.region_id,
        )
        .run();
      node.expected_revision = 1;
    }
  for (const region of body.regions) region.expected_revision = 1;
  body.regions[0]!.staged_material_revision = 2;
  const rotation = await f.send(body, "same-image-rotation"),
    { rollout_id } = (await rotation.json()) as { rollout_id: string };
  expect(rotation.status).toBe(202);
  const intent = await readFleetRolloutIntent(env.DB, rollout_id);
  const milestone = structuredClone(intent);
  milestone.regions[0]!.rotation = {
    revision: intent.regions[0]!.rotation!.revision + 1,
    phase: "discovery-secret",
    node_index: 0,
    state: "confirmed",
  };
  await writeFleetRolloutIntent(f.runtime, intent, milestone);
  // Fresh ordinary inventory already proves the selected image on the new assignment too.
  await env.DB.prepare(
    "UPDATE fleet_node_release_observations SET assignment_revision=? WHERE node_id=?",
  )
    .bind(milestone.regions[0]!.nodes[0]!.assignment_revision, f.us)
    .run();
  const { loadRegionJoinBundle } =
    await import("../../src/crypto/bootstrap-credentials.ts");
  const current = await loadRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.foreign, 1),
  );
  const { kubeconfig: discard, kube_system_uid: discardUid, ...seed } = current;
  void discard;
  void discardUid;
  await storeRegionSeed(
    env.DB,
    env.CREDENTIAL_KEYS,
    regionSeedReference(f.foreign, 1),
    seed,
  );
  await storeRegionSeed(
    env.DB,
    env.CREDENTIAL_KEYS,
    regionSeedReference(f.foreign, 2),
    {
      ...seed,
      talos_admin_config: "prepared-talos",
      talos_machine_secrets_yaml: "prepared-secrets",
    },
  );
  await storeRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.foreign, 2),
    {
      ...current,
      talos_admin_config: "prepared-talos",
      talos_machine_secrets_yaml: "prepared-secrets",
      kubeconfig: "prepared-kube",
    },
  );
  f.runtime.NODE_BOOTSTRAP_CALLBACK_URL = "https://api.invalid/";
  await advanceFleetRollout(f.runtime, rollout_id);
  const next = (await env.DB.prepare(
    "SELECT operation_id,assignment_revision,stage,state FROM fleet_patch_operations WHERE node_id=? ORDER BY rowid DESC LIMIT 1",
  )
    .bind(f.us)
    .first<{
      operation_id: string;
      assignment_revision: number;
      stage: string;
      state: string;
    }>())!;
  expect(next.operation_id).not.toBe(old.operation_id);
  expect(next.assignment_revision).toBe(2);
  expect(next.stage).toBe("preflight");
  expect(next.state).toBe("pending");
  const { fleetPatchInput } = await import("../../src/domain/fleet-patches.ts");
  const input = await fleetPatchInput(f.runtime, next.operation_id);
  expect(input.authority_rotation?.checkpoint.phase).toBe("discovery-secret");
  expect(
    input.authority_rotation?.nodes.find((node) => node.node_id === f.us)?.role,
  ).toBe("controlplane");
  expect(
    await env.DB.prepare(
      "SELECT stage FROM fleet_patch_operations WHERE operation_id=?",
    )
      .bind(old.operation_id)
      .first("stage"),
  ).toBe("complete");
});
