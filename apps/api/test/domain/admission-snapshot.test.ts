// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { DesiredResponse, newNodeId, newOperationId } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { admissionSnapshotCapable } from "../../src/domain/fleet-releases.ts";
import { reconcileDatabaseActors } from "../../src/domain/database-actor-sync.ts";
import {
  readDatabaseAdmissionSnapshot,
  publishDatabaseAdmission,
} from "../../src/domain/database-admission-snapshot.ts";
import { cleanupFixtures, request } from "./fixtures.ts";
import {
  admissionSnapshotFixture,
  admissionFixtureReleases,
} from "./admission-snapshot-fixture.ts";

afterEach(async () => {
  await cleanupFixtures();
  for (const id of admissionFixtureReleases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
const actorFor = (id: string) =>
  env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id));

it("a v4 snapshot refuses stale runtime generation after an unrelated role change", async () => {
  const f = await admissionSnapshotFixture();
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  expect((await actorFor(f.id).admit(f.id, "app")).ok).toBe(true);
  expect(
    (
      await request(`/v1/databases/${f.id}/roles`, f.integrator, "POST", {
        name: "unrelated",
      })
    ).status,
  ).toBe(201);
  expect(
    await env.DB.prepare(
      "SELECT generation,observed_generation,observed_state,observed_power FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({
    generation: f.proof.generation + 1,
    observed_generation: f.proof.generation,
    observed_state: "ready",
    observed_power: "awake",
  });
  expect(
    (await readDatabaseAdmissionSnapshot(env, f.id))?.snapshot.admissible,
  ).toBe(false);
  expect(await actorFor(f.id).admit(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
  expect(
    await actorFor(f.id).ensureAwake(f.id, "app", {
      deadline: Date.now() + 50,
    }),
  ).toEqual({ ok: false, sqlstate: "57P03" });
});

it("a bounded legacy reconciliation clears a previously capable snapshot rather than retaining its cached route", async () => {
  const f = await admissionSnapshotFixture();
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  expect((await actorFor(f.id).admit(f.id, "app")).ok).toBe(true);
  // Controlled current Fleet metadata rollback; this does not model a live release write.
  await env.DB.prepare("DELETE FROM fleet_region_releases WHERE region_id=?")
    .bind(f.region)
    .run();
  await reconcileDatabaseActors(env);
  await env.DB.exec(
    "ALTER TABLE databases RENAME TO withheld_legacy_databases",
  );
  try {
    expect(await actorFor(f.id).admit(f.id, "app")).toEqual({
      ok: false,
      sqlstate: "08006",
    });
  } finally {
    await env.DB.exec(
      "ALTER TABLE withheld_legacy_databases RENAME TO databases",
    );
  }
});
async function replaceProof(id: string, proof: unknown) {
  await env.DB.prepare(
    "UPDATE databases SET runtime_attestation_json=? WHERE id=?",
  )
    .bind(JSON.stringify(proof), id)
    .run();
}
async function refused(id: string, proof: unknown) {
  await replaceProof(id, proof);
  const snapshot = (await readDatabaseAdmissionSnapshot(env, id))?.snapshot;
  expect(snapshot?.cache_capable).toBe(true);
  expect(snapshot?.admissible).toBe(false);
  expect(snapshot?.runtime).toBeNull();
}
async function requireActorPowerFence(id: string) {
  await env.DB.exec(
    `CREATE TRIGGER actor_power_admission_fence BEFORE UPDATE OF desired_state,generation ON databases
    WHEN NEW.id='${id}' AND (NEW.desired_state<>OLD.desired_state OR NEW.generation<>OLD.generation)
      AND NOT EXISTS(SELECT 1 FROM database_admission_epochs e WHERE e.database_id=NEW.id AND e.mutation_id IS NOT NULL AND e.mutation_status='pending')
    BEGIN SELECT RAISE(ABORT,'actor power write lacks admission fence'); END`.replace(
      /\n\s*/g,
      " ",
    ),
  );
}

it("the capable Actor fences its actual idle hibernation before changing desired power", async () => {
  const f = await admissionSnapshotFixture();
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  await env.DB.prepare(
    "UPDATE size_classes SET sleep_after_seconds=60 WHERE id=?",
  )
    .bind(f.size)
    .run();
  expect(
    await actorFor(f.id).recordActivity(f.id, {
      revision: f.proof.generation,
      observed_at: new Date().toISOString(),
      last_activity_at: new Date(Date.now() - 120000).toISOString(),
      active_connections: 0,
    }),
  ).toBe(true);
  await requireActorPowerFence(f.id);
  try {
    const result = await actorFor(f.id).requestIdle(f.id, f.proof.generation);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("fixture idle power transition refused");
    expect(result.revision).toBe(f.proof.generation + 1);
    expect(
      await env.DB.prepare(
        "SELECT desired_state,generation,suspension_reason,power_operation FROM databases WHERE id=?",
      )
        .bind(f.id)
        .first(),
    ).toEqual({
      desired_state: "suspended",
      generation: result.revision,
      suspension_reason: "idle",
      power_operation: result.operation,
    });
    expect(
      await env.DB.prepare(
        "SELECT kind,generation FROM operations WHERE id=? AND database_id=?",
      )
        .bind(result.operation, f.id)
        .first(),
    ).toEqual({ kind: "database.hibernate", generation: result.revision });
    expect(
      await env.DB.prepare(
        "SELECT admission_revision,route_revision,mutation_id,mutation_outcome FROM database_admission_epochs WHERE database_id=?",
      )
        .bind(f.id)
        .first(),
    ).toEqual({
      admission_revision: f.proof.admission_epoch + 1,
      route_revision: f.proof.route_revision + 1,
      mutation_id: null,
      mutation_outcome: "committed",
    });
    expect(await actorFor(f.id).admit(f.id, "app")).toEqual({
      ok: false,
      sqlstate: "57P03",
    });
  } finally {
    await env.DB.exec("DROP TRIGGER actor_power_admission_fence");
  }
});

it("a capable idle sleeper takes guarded authoritative cold preparation and returns only a current v4 target", async () => {
  const f = await admissionSnapshotFixture();
  const sleepOperation = newOperationId(),
    sleepGeneration = f.proof.generation + 1,
    at = new Date().toISOString();
  // Controlled committed regional sleep metadata, followed by the real Actor wake writer.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at,completed_at) VALUES(?,'database.hibernate','succeeded',?,?,?,?,?,?)",
    ).bind(sleepOperation, f.project, f.id, sleepGeneration, at, at, at),
    env.DB.prepare(
      "UPDATE databases SET desired_state='suspended',suspension_reason='idle',generation=?,observed_state='provisioning',observed_power='hibernated',observed_generation=?,power_operation=?,runtime_attestation_json=NULL WHERE id=?",
    ).bind(sleepGeneration, sleepGeneration, sleepOperation, f.id),
    env.DB.prepare(
      "UPDATE database_admission_epochs SET admission_revision=admission_revision+1,route_revision=route_revision+1 WHERE database_id=?",
    ).bind(f.id),
  ]);
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  await requireActorPowerFence(f.id);
  const waking = actorFor(f.id).ensureAwake(f.id, "reader", {
    deadline: Date.now() + 3000,
  });
  try {
    await expect
      .poll(
        async () =>
          env.DB.prepare(
            "SELECT d.generation,d.desired_state,e.mutation_id FROM databases d JOIN database_admission_epochs e ON e.database_id=d.id WHERE d.id=?",
          )
            .bind(f.id)
            .first(),
        { interval: 5, timeout: 2000 },
      )
      .toEqual({
        generation: sleepGeneration + 1,
        desired_state: "running",
        mutation_id: null,
      });
    const row = await env.DB.prepare(
      "SELECT generation,power_operation FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first<{ generation: number; power_operation: string }>();
    expect(row).not.toBeNull();
    const epoch = await env.DB.prepare(
      "SELECT admission_revision,route_revision,mutation_outcome FROM database_admission_epochs WHERE database_id=?",
    )
      .bind(f.id)
      .first<{
        admission_revision: number;
        route_revision: number;
        mutation_outcome: string;
      }>();
    expect(epoch).toEqual({
      admission_revision: f.proof.admission_epoch + 2,
      route_revision: f.proof.route_revision + 2,
      mutation_outcome: "committed",
    });
    expect(
      await env.DB.prepare(
        "SELECT kind,generation FROM operations WHERE id=? AND database_id=?",
      )
        .bind(row!.power_operation, f.id)
        .first(),
    ).toEqual({ kind: "database.wake", generation: row!.generation });
    const observedAt = Date.now(),
      proof = {
        ...f.proof,
        generation: row!.generation,
        admission_epoch: epoch!.admission_revision,
        route_revision: epoch!.route_revision,
        pod_uid: crypto.randomUUID(),
        container_id: "b".repeat(64),
        observed_at: observedAt,
        observation: {
          ...f.proof.observation,
          verified_at: observedAt,
          expires_at: observedAt + 60000,
          watch_epoch: f.proof.observation.watch_epoch + 1,
        },
      };
    await env.DB.prepare(
      "UPDATE databases SET observed_state='ready',observed_power='awake',observed_generation=generation,runtime_attestation_json=? WHERE id=?",
    )
      .bind(JSON.stringify(proof), f.id)
      .run();
    expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
    await actorFor(f.id).observedReady(
      f.id,
      row!.generation,
      row!.power_operation,
    );
    expect(await waking).toEqual({
      ok: true,
      region: {
        id: f.region,
        gateway_url: "https://gateway.invalid",
        gateway_binding: null,
      },
      target: {
        revision: row!.generation,
        pod_uid: proof.pod_uid,
        route_revision: proof.route_revision,
      },
    });
  } finally {
    await waking;
    await env.DB.exec("DROP TRIGGER actor_power_admission_fence");
  }
});

it("a confirmed current snapshot admits and wakes after actual admission tables become unavailable", async () => {
  const f = await admissionSnapshotFixture();
  expect(await admissionSnapshotCapable(env.DB, f.region)).toBe(true);
  expect(
    (await readDatabaseAdmissionSnapshot(env, f.id))?.snapshot,
  ).toMatchObject({
    cache_capable: true,
    admissible: true,
    runtime: { pod_uid: f.proof.pod_uid },
  });
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  let epochsHidden = false,
    databasesHidden = false;
  try {
    await env.DB.exec(
      "ALTER TABLE database_admission_epochs RENAME TO admission_test_hidden_epochs",
    );
    epochsHidden = true;
    await env.DB.exec(
      "ALTER TABLE databases RENAME TO admission_test_hidden_databases",
    );
    databasesHidden = true;
    await evictDurableObject(actorFor(f.id));
    const admitted = {
      ok: true,
      region: {
        id: f.region,
        gateway_url: "https://gateway.invalid",
        gateway_binding: null,
      },
      target: {
        revision: f.proof.generation,
        pod_uid: f.proof.pod_uid,
        route_revision: f.proof.route_revision,
      },
    };
    expect(await actorFor(f.id).admit(f.id, "app")).toEqual(admitted);
    expect(
      await actorFor(f.id).ensureAwake(f.id, "reader", {
        deadline: Date.now() + 2000,
      }),
    ).toEqual(admitted);
    expect(await actorFor(f.id).admit(f.id, "unknown")).toEqual({
      ok: false,
      sqlstate: "28P01",
    });
  } finally {
    if (databasesHidden)
      await env.DB.exec(
        "ALTER TABLE admission_test_hidden_databases RENAME TO databases",
      );
    if (epochsHidden)
      await env.DB.exec(
        "ALTER TABLE admission_test_hidden_epochs RENAME TO database_admission_epochs",
      );
  }
});

it("role proofs compare the exact current revision set independently of array order", async () => {
  const f = await admissionSnapshotFixture();
  await replaceProof(f.id, {
    ...f.proof,
    applied_role_revisions: [...f.proof.applied_role_revisions].reverse(),
  });
  expect(
    (await readDatabaseAdmissionSnapshot(env, f.id))?.snapshot.admissible,
  ).toBe(true);
  await refused(f.id, {
    ...f.proof,
    applied_role_revisions: f.proof.applied_role_revisions.map((role) =>
      role.name === "reader" ? { ...role, revision: role.revision + 1 } : role,
    ),
  });
});

it("a matching role set cannot replace the authoritative configuration fingerprint or memory proof", async () => {
  const f = await admissionSnapshotFixture();
  await refused(f.id, {
    ...f.proof,
    configuration_fingerprint: "0".repeat(64),
  });
  await refused(f.id, {
    ...f.proof,
    memory_request_bytes: f.proof.memory_request_bytes - 1,
  });
  await refused(f.id, {
    ...f.proof,
    memory_limit_bytes: f.proof.memory_limit_bytes + 1,
  });
});

it("physical storage and current node identities cannot be substituted at a ready generation", async () => {
  const f = await admissionSnapshotFixture();
  await refused(f.id, {
    ...f.proof,
    storage_generation: f.proof.storage_generation + 1,
  });
  await refused(f.id, { ...f.proof, pvc_uid: crypto.randomUUID() });
  await refused(f.id, { ...f.proof, pv_uid: crypto.randomUUID() });
  await refused(f.id, { ...f.proof, storage_uid: crypto.randomUUID() });
  await refused(f.id, { ...f.proof, namespace_uid: crypto.randomUUID() });
  await refused(f.id, { ...f.proof, cnpg_cluster_uid: crypto.randomUUID() });
  await refused(f.id, { ...f.proof, node_uid: crypto.randomUUID() });
});

it("a thin profile without its current physical receipt cannot seed a verified snapshot", async () => {
  const f = await admissionSnapshotFixture(true, {
    thin: true,
    receipt: false,
  });
  await refused(f.id, f.proof);
});

it("CA binding, coverage gaps and expired proof close a capable snapshot", async () => {
  const f = await admissionSnapshotFixture();
  await refused(f.id, {
    ...f.proof,
    tls_server_name: "database-rw.pgcf-db-another.svc",
  });
  await refused(f.id, { ...f.proof, ca_secret_resource_version: "82" });
  await refused(f.id, {
    ...f.proof,
    observation: { ...f.proof.observation, coverage: "gapped" },
  });
  await replaceProof(f.id, f.proof);
  expect(
    (
      await readDatabaseAdmissionSnapshot(
        env,
        f.id,
        f.proof.observation.expires_at,
      )
    )?.snapshot.admissible,
  ).toBe(false);
});

it("missing capability markers keep desired admission fields and cached snapshots disabled", async () => {
  const f = await admissionSnapshotFixture(false);
  expect(await admissionSnapshotCapable(env.DB, f.region)).toBe(false);
  expect(
    (await readDatabaseAdmissionSnapshot(env, f.id))?.snapshot.cache_capable,
  ).toBe(false);
  const response = await request("/agent/v1/desired", f.agent);
  expect(response.status).toBe(200);
  const desired = DesiredResponse.parse(await response.json());
  expect(
    desired.databases.find((database) => database.id === f.id)?.admission,
  ).toBeUndefined();
  expect(
    desired.fleet_release?.release.spec.admission_snapshot_version,
  ).toBeUndefined();
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  const admitted = await actorFor(f.id).admit(f.id, "app");
  expect(admitted.ok).toBe(true);
  if (admitted.ok) expect(admitted.target?.route_revision).toBeUndefined();
});

it("unconfirmed patches and a new unassigned current node cannot activate snapshot wire", async () => {
  const f = await admissionSnapshotFixture();
  await env.DB.prepare(
    "UPDATE fleet_patch_operations SET state='pending' WHERE operation_id=?",
  )
    .bind(f.patchId)
    .run();
  expect(await admissionSnapshotCapable(env.DB, f.region)).toBe(false);
  await env.DB.prepare(
    "UPDATE fleet_patch_operations SET state='confirmed' WHERE operation_id=?",
  )
    .bind(f.patchId)
    .run();
  expect(await admissionSnapshotCapable(env.DB, f.region)).toBe(true);
  await env.DB.prepare(
    `INSERT INTO nodes(id,region_id,k8s_node_name,node_uid,ready,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at)
    SELECT ?,region_id,?, ?,ready,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at FROM nodes WHERE id=?`,
  )
    .bind(newNodeId(), `${f.nodeName}-new`, crypto.randomUUID(), f.node)
    .run();
  expect(await admissionSnapshotCapable(env.DB, f.region)).toBe(false);
  expect(
    (await readDatabaseAdmissionSnapshot(env, f.id))?.snapshot.cache_capable,
  ).toBe(false);
  const response = await request("/agent/v1/desired", f.agent);
  expect(response.status).toBe(200);
  expect(
    DesiredResponse.parse(await response.json()).databases.find(
      (database) => database.id === f.id,
    )?.admission,
  ).toBeUndefined();
});

it("a real control-plane rollback to a legacy release removes snapshot wire and cached v4 admission", async () => {
  const f = await admissionSnapshotFixture();
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  const specJson = await env.DB.prepare(
    "SELECT spec_json FROM fleet_releases WHERE id=?",
  )
    .bind(f.releaseId)
    .first<string>("spec_json");
  if (!specJson) throw new Error("fixture approved release missing");
  const spec = JSON.parse(specJson) as Record<string, unknown>;
  delete spec.admission_snapshot_version;
  delete spec.runtime_attestation_version;
  spec.route_token_version = 3;
  const legacy = `admission-rollback-${crypto.randomUUID()}`;
  expect(
    (await request(`/v1/fleet/releases/${legacy}`, f.admin, "PUT", spec))
      .status,
  ).toBe(200);
  admissionFixtureReleases.push(legacy);
  expect(
    (
      await request(`/v1/regions/${f.region}/release`, f.admin, "PUT", {
        expected_revision: 1,
        release_id: legacy,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await request(`/v1/nodes/${f.node}/release`, f.admin, "PUT", {
        expected_revision: 1,
        release_id: legacy,
        node_uid: f.nodeUid,
        role: "customer",
      })
    ).status,
  ).toBe(200);
  expect(await admissionSnapshotCapable(env.DB, f.region)).toBe(false);
  const response = await request("/agent/v1/desired", f.agent);
  expect(response.status).toBe(200);
  expect(
    DesiredResponse.parse(await response.json()).databases.find(
      (database) => database.id === f.id,
    )?.admission,
  ).toBeUndefined();
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  const result = await actorFor(f.id).admit(f.id, "app");
  if (result.ok) expect(result.target?.route_revision).toBeUndefined();
});
