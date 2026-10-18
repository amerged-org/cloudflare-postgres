// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { newNodeId, newOperationId } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import {
  readDatabaseAdmissionSnapshot,
  publishDatabaseAdmission,
} from "../../src/domain/database-admission-snapshot.ts";
import { cleanupFixtures, report, request } from "./fixtures.ts";
import { admissionSnapshotFixture } from "./admission-snapshot-fixture.ts";

afterEach(cleanupFixtures);
const actorFor = (id: string) =>
  env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id));

it("a v4 snapshot refuses stale runtime generation after an unrelated role change", async () => {
  const f = await admissionSnapshotFixture();
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  expect((await actorFor(f.id).admit(f.id, "app")).ok).toBe(true);
  expect(
    (
      await request(
        `/v1/databases/${f.id}/roles`,
        f.integrator,
        "POST",
        {
          name: "unrelated",
        },
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(201);
  expect(
    await env.DB.prepare(
      "SELECT generation,observed_generation,observed_state,observed_power FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({
    generation: f.generation + 1,
    observed_generation: f.generation,
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

async function replaceRuntime(id: string, runtime: unknown) {
  await env.DB.prepare("UPDATE databases SET runtime_json=? WHERE id=?")
    .bind(JSON.stringify(runtime), id)
    .run();
}
async function refused(id: string, runtime: unknown) {
  await replaceRuntime(id, runtime);
  const snapshot = (await readDatabaseAdmissionSnapshot(env, id))?.snapshot;
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

it("fences the idle sleep a node reports before changing desired power", async () => {
  const f = await admissionSnapshotFixture();
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  await requireActorPowerFence(f.id);
  try {
    expect((await report(f, f.id, f.generation, "asleep")).status).toBe(200);
    const row = (await env.DB.prepare(
      "SELECT desired_state,generation,suspension_reason,power_operation FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first<{ generation: number; power_operation: string }>())!;
    expect(row).toEqual({
      desired_state: "suspended",
      generation: f.generation + 1,
      suspension_reason: "idle",
      power_operation: expect.any(String),
    });
    expect(
      await env.DB.prepare(
        "SELECT kind,generation FROM operations WHERE id=? AND database_id=?",
      )
        .bind(row.power_operation, f.id)
        .first(),
    ).toEqual({ kind: "database.hibernate", generation: f.generation + 1 });
    expect(
      await env.DB.prepare(
        "SELECT admission_revision,route_revision,mutation_id,mutation_outcome FROM database_admission_epochs WHERE database_id=?",
      )
        .bind(f.id)
        .first(),
    ).toEqual({
      admission_revision: f.epoch.admission_revision + 1,
      route_revision: f.epoch.route_revision + 1,
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
    sleepGeneration = f.generation + 1,
    at = new Date().toISOString();
  // Controlled committed regional sleep metadata, followed by the real Actor wake writer.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at,completed_at) VALUES(?,'database.hibernate','succeeded',?,?,?,?,?,?)",
    ).bind(sleepOperation, f.project, f.id, sleepGeneration, at, at, at),
    env.DB.prepare(
      "UPDATE databases SET desired_state='suspended',suspension_reason='idle',generation=?,observed_state='provisioning',observed_power='hibernated',observed_generation=?,power_operation=?,runtime_json=NULL WHERE id=?",
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
      admission_revision: f.epoch.admission_revision + 2,
      route_revision: f.epoch.route_revision + 2,
      mutation_outcome: "committed",
    });
    expect(
      await env.DB.prepare(
        "SELECT kind,generation FROM operations WHERE id=? AND database_id=?",
      )
        .bind(row!.power_operation, f.id)
        .first(),
    ).toEqual({ kind: "database.wake", generation: row!.generation });
    // The node starts the unit and reports it ready: the intake commits the runtime and releases the waiter.
    const instance = crypto.randomUUID();
    expect(
      (await report(f, f.id, row!.generation, "ready", { instance })).status,
    ).toBe(200);
    expect(await waking).toEqual({
      ok: true,
      region: {
        id: f.region,
        gateway_url: "https://gateway.invalid",
        gateway_binding: null,
      },
      node: f.node,
      target: {
        revision: row!.generation,
        route_revision: epoch!.route_revision,
        instance,
      },
    });
  } finally {
    await waking;
    await env.DB.exec("DROP TRIGGER actor_power_admission_fence");
  }
});

it("a confirmed current snapshot admits and wakes after actual admission tables become unavailable", async () => {
  const f = await admissionSnapshotFixture();
  expect(
    (await readDatabaseAdmissionSnapshot(env, f.id))?.snapshot,
  ).toMatchObject({
    admissible: true,
    node: f.node,
    runtime: { instance: f.runtime.instance },
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
      node: f.node,
      target: {
        revision: f.generation,
        route_revision: f.epoch.route_revision,
        instance: f.runtime.instance,
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

it("a report that names another database, node, generation or storage generation does not admit", async () => {
  const f = await admissionSnapshotFixture();
  await refused(f.id, { ...f.runtime, database_id: "a".repeat(20) });
  await refused(f.id, { ...f.runtime, node_id: newNodeId() });
  await refused(f.id, { ...f.runtime, generation: f.runtime.generation + 1 });
  await refused(f.id, {
    ...f.runtime,
    storage_generation: f.runtime.storage_generation + 1,
  });
  await replaceRuntime(f.id, f.runtime);
  expect(
    (await readDatabaseAdmissionSnapshot(env, f.id))?.snapshot,
  ).toMatchObject({ admissible: true, runtime: f.runtime });
});

it("a runtime document the contract does not know closes admission instead of being repaired", async () => {
  const f = await admissionSnapshotFixture();
  await refused(f.id, { ...f.runtime, instance: "not-a-unit" });
  await refused(f.id, { ...f.runtime, pod_uid: crypto.randomUUID() });
  await env.DB.prepare("UPDATE databases SET runtime_json=NULL WHERE id=?")
    .bind(f.id)
    .run();
  expect(
    (await readDatabaseAdmissionSnapshot(env, f.id))?.snapshot.admissible,
  ).toBe(false);
});

it("wakeable is true only for an idle suspension with a power operation, a node and no barrier", async () => {
  const f = await admissionSnapshotFixture();
  const wakeable = async () =>
    (await readDatabaseAdmissionSnapshot(env, f.id))?.snapshot.wakeable;
  expect(await wakeable()).toBe(false);
  const sleepOperation = newOperationId(),
    sleepGeneration = f.generation + 1,
    at = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at,completed_at) VALUES(?,'database.hibernate','succeeded',?,?,?,?,?,?)",
    ).bind(sleepOperation, f.project, f.id, sleepGeneration, at, at, at),
    env.DB.prepare(
      "UPDATE databases SET desired_state='suspended',suspension_reason='idle',generation=?,observed_state='provisioning',observed_power='hibernated',observed_generation=?,power_operation=?,runtime_json=NULL WHERE id=?",
    ).bind(sleepGeneration, sleepGeneration, sleepOperation, f.id),
  ]);
  expect(await wakeable()).toBe(true);
  const refusedBy = async (change: string, restore: string) => {
    await env.DB.exec(change);
    try {
      expect(await wakeable(), change).toBe(false);
    } finally {
      await env.DB.exec(restore);
    }
    expect(await wakeable()).toBe(true);
  };
  const where = `WHERE id='${f.id}'`;
  await refusedBy(
    `UPDATE databases SET suspension_reason='manual' ${where}`,
    `UPDATE databases SET suspension_reason='idle' ${where}`,
  );
  await refusedBy(
    `UPDATE databases SET power_operation=NULL ${where}`,
    `UPDATE databases SET power_operation='${sleepOperation}' ${where}`,
  );
  await refusedBy(
    `UPDATE databases SET node_id=NULL ${where}`,
    `UPDATE databases SET node_id='${f.node}' ${where}`,
  );
  await refusedBy(
    `UPDATE database_admission_epochs SET mutation_id='${crypto.randomUUID()}',mutation_started_at='${at}',mutation_status='pending' WHERE database_id='${f.id}'`,
    `UPDATE database_admission_epochs SET mutation_id=NULL,mutation_started_at=NULL,mutation_status=NULL WHERE database_id='${f.id}'`,
  );
  expect(await wakeable()).toBe(true);
  // A lost node is final.
  await env.DB.exec(`UPDATE nodes SET lost_at='${at}' WHERE id='${f.node}'`);
  expect(await wakeable()).toBe(false);
  await env.DB.exec(
    `UPDATE databases SET desired_state='deleted',deleted_at='${at}' ${where}`,
  );
  expect(await wakeable()).toBe(false);
});
