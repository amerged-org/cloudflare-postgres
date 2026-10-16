// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { newDatabaseId, newOperationId } from "@pgcf/contracts";
import { roleRevisionHash } from "@pgcf/contracts/route-token";
import { afterEach, expect, it, vi } from "vitest";
import {
  publishDatabaseAdmission,
  readDatabaseAdmissionSnapshot,
} from "../../src/domain/database-admission-snapshot.ts";
import { cleanupFixtures } from "./fixtures.ts";
import {
  admissionFixtureReleases,
  admissionSnapshotFixture,
} from "./admission-snapshot-fixture.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
  for (const id of admissionFixtureReleases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
const actor = (id: string) =>
  env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id));
const route = (region: string) => ({
  id: region,
  gateway_url: "https://gateway.invalid",
  gateway_binding: null,
});

/** A cache-capable database the controller reported asleep after an idle (or manual) sleep. */
async function sleeper(reason: "idle" | "manual" = "idle") {
  const f = await admissionSnapshotFixture();
  const sleepOperation = newOperationId(),
    sleepGeneration = f.proof.generation + 1,
    at = new Date().toISOString();
  // Controlled committed regional sleep metadata, as the capable idle sleeper test writes it.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at,completed_at) VALUES(?,?,'succeeded',?,?,?,?,?,?)",
    ).bind(
      sleepOperation,
      reason === "idle" ? "database.hibernate" : "database.suspend",
      f.project,
      f.id,
      sleepGeneration,
      at,
      at,
      at,
    ),
    env.DB.prepare(
      "UPDATE databases SET desired_state='suspended',suspension_reason=?,generation=?,observed_state='provisioning',observed_power='hibernated',observed_generation=?,power_operation=?,runtime_attestation_json=NULL WHERE id=?",
    ).bind(reason, sleepGeneration, sleepGeneration, sleepOperation, f.id),
    env.DB.prepare(
      "UPDATE database_admission_epochs SET admission_revision=admission_revision+1,route_revision=route_revision+1 WHERE database_id=?",
    ).bind(f.id),
  ]);
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  const snapshot = (await readDatabaseAdmissionSnapshot(env, f.id))!.snapshot;
  expect(snapshot.wakeable).toBe(reason === "idle");
  return { ...f, sleepGeneration, sleepOperation, snapshot };
}
type Sleeper = Awaited<ReturnType<typeof sleeper>>;
async function expectedWake(f: Sleeper) {
  return {
    operation: expect.stringMatching(/^op_[a-z0-9]{20}$/),
    generation: f.sleepGeneration + 1,
    route_revision: f.snapshot.route_revision,
    role_revision_hash: await roleRevisionHash(f.snapshot.roles),
  };
}
/** Holds the Actor's ticket claims until `open`; the Actor itself may only await the gate. */
async function holdClaims(id: string) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let started = 0;
  await runInDurableObject(actor(id), (instance) => {
    const claim = Reflect.get(instance, "claimTicket") as (
      ...args: unknown[]
    ) => Promise<unknown>;
    Reflect.set(instance, "claimTicket", async (...args: unknown[]) => {
      started++;
      await gate;
      return claim.apply(instance, args);
    });
  });
  return { open, started: () => started };
}
/** Holds the Actor's D1 batches (its claim's commit) until `open`. */
async function holdCommit(id: string) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let batches = 0;
  await runInDurableObject(actor(id), (instance) => {
    const db = (instance as unknown as { env: { DB: D1Database } }).env.DB;
    const original = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementation(async (statements) => {
      batches++;
      await gate;
      return original(statements);
    });
  });
  return { open, batches: () => batches };
}
const ticket = (id: string) =>
  runInDurableObject(actor(id), (_instance, state) =>
    state.storage.sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='database_ticket'",
      )
      .toArray().length
      ? state.storage.sql
          .exec<{
            operation: string;
            generation: number;
            state: string;
          }>("SELECT operation,generation,state FROM database_ticket")
          .toArray()
      : [],
  );
const row = (id: string) =>
  env.DB.prepare(
    "SELECT generation,desired_state,power_operation FROM databases WHERE id=?",
  )
    .bind(id)
    .first<{
      generation: number;
      desired_state: string;
      power_operation: string;
    }>();
const wakeOperations = (id: string) =>
  env.DB.prepare(
    "SELECT COUNT(*) n FROM operations WHERE database_id=? AND kind='database.wake'",
  )
    .bind(id)
    .first("n");
async function regionNotifications(region: string) {
  return runInDurableObject(
    env.REGION_LINK.get(env.REGION_LINK.idFromName(region)),
    (instance) => vi.spyOn(Object.getPrototypeOf(instance), "notify"),
  );
}

it("admitWake answers a sleeping wakeable database before any D1 statement runs", async () => {
  const f = await sleeper();
  const held = await holdClaims(f.id);
  const prepare = vi.spyOn(Object.getPrototypeOf(env.DB), "prepare");
  const admitted = await actor(f.id).admitWake(f.id, "reader");
  expect(prepare).not.toHaveBeenCalled();
  prepare.mockRestore();
  expect(admitted).toEqual({
    ok: true,
    region: route(f.region),
    wake: await expectedWake(f),
  });
  expect(held.started()).toBe(1);
  expect(await ticket(f.id)).toEqual([
    {
      operation: (admitted as { wake: { operation: string } }).wake.operation,
      generation: f.sleepGeneration + 1,
      state: "pending",
    },
  ]);
  held.open();
  await expect
    .poll(() => row(f.id), { interval: 5, timeout: 3000 })
    .toEqual({
      generation: f.sleepGeneration + 1,
      desired_state: "running",
      power_operation: (admitted as { wake: { operation: string } }).wake
        .operation,
    });
});

it("parallel admitWake calls during the claim reuse one ticket", async () => {
  const f = await sleeper();
  const commit = await holdCommit(f.id);
  const first = await actor(f.id).admitWake(f.id, "reader");
  if (!first.ok || !("wake" in first)) throw new Error("no wake ticket");
  // The claim has closed the Actor's barrier and waits on its commit.
  await expect
    .poll(() => commit.batches(), { interval: 5, timeout: 3000 })
    .toBe(1);
  const during = await Promise.all(
    Array.from({ length: 5 }, () => actor(f.id).admitWake(f.id, "app")),
  );
  for (const admitted of during)
    expect(admitted).toEqual({
      ok: true,
      region: route(f.region),
      wake: first.wake,
    });
  commit.open();
  await expect
    .poll(() => ticket(f.id), { interval: 5, timeout: 3000 })
    .toEqual([
      {
        operation: first.wake.operation,
        generation: first.wake.generation,
        state: "claimed",
      },
    ]);
  expect(await wakeOperations(f.id)).toBe(1);
  // The snapshot published after the claim is the woken, not yet admissible generation.
  expect(await actor(f.id).admitWake(f.id, "reader")).toEqual({
    ok: true,
    region: route(f.region),
    wake: first.wake,
  });
  expect(await wakeOperations(f.id)).toBe(1);
});

it("the ticket claim commits generation+1 with the ticket operation and hints the region", async () => {
  const f = await sleeper();
  const notify = await regionNotifications(f.region);
  const admitted = await actor(f.id).admitWake(f.id, "reader");
  if (!admitted.ok || !("wake" in admitted)) throw new Error("no wake ticket");
  const { operation, generation } = admitted.wake;
  await expect
    .poll(() => notify.mock.calls.length, { interval: 5, timeout: 3000 })
    .toBe(1);
  const [ids, page] = notify.mock.calls[0]! as [
    string[],
    { databases: { id: string; power?: { operation: string } }[] },
  ];
  expect(ids).toEqual([f.id]);
  expect(page.databases[0]).toMatchObject({ id: f.id, power: { operation } });
  expect(await row(f.id)).toEqual({
    generation,
    desired_state: "running",
    power_operation: operation,
  });
  expect(
    await env.DB.prepare(
      "SELECT kind,generation FROM operations WHERE id=? AND database_id=?",
    )
      .bind(operation, f.id)
      .first(),
  ).toEqual({ kind: "database.wake", generation });
  await expect
    .poll(() => ticket(f.id), { interval: 5, timeout: 3000 })
    .toEqual([{ operation, generation, state: "claimed" }]);
  expect(
    await runInDurableObject(actor(f.id), (_instance, state) =>
      state.storage.sql
        .exec("SELECT operation,revision FROM database_wake")
        .toArray(),
    ),
  ).toEqual([{ operation, revision: generation }]);
});

it("a refused claim marks the ticket refused, notifies the region and the next admitWake issues a new ticket", async () => {
  const f = await sleeper();
  // The row moved to a manual suspension after the snapshot the Actor answers from.
  await env.DB.prepare(
    "UPDATE databases SET suspension_reason='manual' WHERE id=?",
  )
    .bind(f.id)
    .run();
  const notify = await regionNotifications(f.region);
  const refused = await actor(f.id).admitWake(f.id, "reader");
  if (!refused.ok || !("wake" in refused)) throw new Error("no wake ticket");
  await expect
    .poll(() => ticket(f.id), { interval: 5, timeout: 3000 })
    .toEqual([
      {
        operation: refused.wake.operation,
        generation: refused.wake.generation,
        state: "refused",
      },
    ]);
  await expect
    .poll(() => notify.mock.calls.length, { interval: 5, timeout: 3000 })
    .toBe(1);
  expect(notify.mock.calls[0]![0]).toEqual([f.id]);
  expect(await row(f.id)).toMatchObject({ generation: f.sleepGeneration });
  expect(await wakeOperations(f.id)).toBe(0);
  await env.DB.prepare(
    "UPDATE databases SET suspension_reason='idle' WHERE id=?",
  )
    .bind(f.id)
    .run();
  const next = await actor(f.id).admitWake(f.id, "reader");
  if (!next.ok || !("wake" in next)) throw new Error("no wake ticket");
  expect(next.wake.operation).not.toBe(refused.wake.operation);
  expect(next.wake.generation).toBe(refused.wake.generation);
  await expect
    .poll(() => row(f.id), { interval: 5, timeout: 3000 })
    .toEqual({
      generation: f.sleepGeneration + 1,
      desired_state: "running",
      power_operation: next.wake.operation,
    });
});

it("an awake admissible snapshot answers a v4 target", async () => {
  const f = await admissionSnapshotFixture();
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  const prepare = vi.spyOn(Object.getPrototypeOf(env.DB), "prepare");
  expect(await actor(f.id).admitWake(f.id, "app")).toEqual({
    ok: true,
    region: route(f.region),
    target: {
      revision: f.proof.generation,
      pod_uid: f.proof.pod_uid,
      route_revision: f.proof.route_revision,
    },
  });
  expect(prepare).not.toHaveBeenCalled();
  expect(await ticket(f.id)).toEqual([]);
});

it("a manual suspension is not wakeable and answers 57P03", async () => {
  const f = await sleeper("manual");
  expect(await actor(f.id).admitWake(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
  expect(await ticket(f.id)).toEqual([]);
  expect(await wakeOperations(f.id)).toBe(0);
});

it("a snapshot without wakeable falls back to ensureAwake", async () => {
  const f = await sleeper();
  const calls: unknown[][] = [];
  await runInDurableObject(actor(f.id), (instance, state) => {
    // A snapshot persisted before the wakeable field existed.
    const stored = state.storage.sql
      .exec<{ snapshot: string }>(
        "SELECT snapshot FROM database_snapshot WHERE singleton=1",
      )
      .toArray()[0]!;
    const snapshot = JSON.parse(stored.snapshot) as Record<string, unknown>;
    delete snapshot.wakeable;
    state.storage.sql.exec(
      "UPDATE database_snapshot SET snapshot=? WHERE singleton=1",
      JSON.stringify(snapshot),
    );
    Reflect.set(instance, "ensureAwake", async (...args: unknown[]) => {
      calls.push(args);
      return { ok: false, sqlstate: "08006" };
    });
  });
  const options = {
    deadline: Date.now() + 1000,
    waiterId: crypto.randomUUID(),
  };
  expect(await actor(f.id).admitWake(f.id, "reader", options)).toEqual({
    ok: false,
    sqlstate: "08006",
  });
  expect(calls).toEqual([[f.id, "reader", options]]);
  expect(await ticket(f.id)).toEqual([]);
});

it("a deleted database answers 3D000 and an unknown role 28P01", async () => {
  const unknown = newDatabaseId();
  expect(await actor(unknown).admitWake(unknown, "app")).toEqual({
    ok: false,
    sqlstate: "3D000",
  });
  const f = await sleeper();
  expect(await actor(f.id).admitWake(f.id, "missing")).toEqual({
    ok: false,
    sqlstate: "28P01",
  });
  await env.DB.prepare(
    "UPDATE databases SET desired_state='deleted',deleted_at=? WHERE id=?",
  )
    .bind(new Date().toISOString(), f.id)
    .run();
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  expect(await actor(f.id).admitWake(f.id, "reader")).toEqual({
    ok: false,
    sqlstate: "3D000",
  });
  expect(await ticket(f.id)).toEqual([]);
});
