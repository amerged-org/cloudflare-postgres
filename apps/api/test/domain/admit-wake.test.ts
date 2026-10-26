// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { newDatabaseId } from "@pgcf/contracts";
import { roleRevisionHash } from "@pgcf/contracts/route-token";
import { afterEach, expect, it, vi } from "vitest";
import {
  publishDatabaseAdmission,
  readDatabaseAdmissionSnapshot,
} from "../../src/domain/database-admission-snapshot.ts";
import { DatabaseAdmissionSnapshot } from "../../src/domain/admission-state.ts";
import { DatabasePresence } from "../../src/database-actor.ts";
import { cleanupFixtures } from "./fixtures.ts";
import {
  admissionSnapshotFixture,
  sleepingSnapshotFixture as sleeper,
} from "./admission-snapshot-fixture.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
});
const actor = (id: string) =>
  env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id));
const route = (region: string) => ({
  id: region,
  gateway_url: "https://gateway.invalid",
  gateway_binding: null,
});

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
async function nodeNotifications(node: string) {
  return runInDurableObject(
    env.NODE_ACTOR.get(env.NODE_ACTOR.idFromName(node)),
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
    node: f.node,
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
  expect(await publishDatabaseAdmission(env, f.id)).toBe(false);
  expect((await ticket(f.id))[0]?.operation).toBe(first.wake.operation);
  const during = await Promise.all(
    Array.from({ length: 5 }, () => actor(f.id).admitWake(f.id, "app")),
  );
  for (const admitted of during)
    expect(admitted).toEqual({
      ok: true,
      region: route(f.region),
      node: f.node,
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
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  expect((await ticket(f.id))[0]?.operation).toBe(first.wake.operation);
  // The snapshot published after the claim is the woken, not yet admissible generation.
  expect(await actor(f.id).admitWake(f.id, "reader")).toEqual({
    ok: true,
    region: route(f.region),
    node: f.node,
    wake: first.wake,
  });
  expect(await wakeOperations(f.id)).toBe(1);
});

it("the ticket claim commits generation+1 with the ticket operation and hints the node", async () => {
  const f = await sleeper();
  const notify = await nodeNotifications(f.node);
  const admitted = await actor(f.id).admitWake(f.id, "reader");
  if (!admitted.ok || !("wake" in admitted)) throw new Error("no wake ticket");
  const { operation, generation } = admitted.wake;
  await expect
    .poll(() => notify.mock.calls.length, { interval: 5, timeout: 3000 })
    .toBe(1);
  expect(notify.mock.calls[0]![0]).toEqual([f.id]);
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

it("the ticket claim raises the route revision by exactly one and the ticket keeps the revision from before it", async () => {
  const f = await sleeper();
  const epoch = () =>
    env.DB.prepare(
      "SELECT admission_revision,route_revision FROM database_admission_epochs WHERE database_id=?",
    )
      .bind(f.id)
      .first<{ admission_revision: number; route_revision: number }>();
  const before = (await epoch())!;
  const admitted = await actor(f.id).admitWake(f.id, "reader");
  if (!admitted.ok || !("wake" in admitted)) throw new Error("no wake ticket");
  // The Edge signs the revision the Actor's snapshot had when it issued the ticket.
  expect(admitted.wake.route_revision).toBe(before.route_revision);
  await expect
    .poll(() => ticket(f.id), { interval: 5, timeout: 3000 })
    .toEqual([
      {
        operation: admitted.wake.operation,
        generation: admitted.wake.generation,
        state: "claimed",
      },
    ]);
  // The claim's own mutation raised both revisions by one. The node's page carries the epoch's
  // route revision (`node-desired.ts`), so the page that names the claim is one above the ticket.
  expect(await epoch()).toEqual({
    admission_revision: before.admission_revision + 1,
    route_revision: before.route_revision + 1,
  });
  expect(
    (await readDatabaseAdmissionSnapshot(env, f.id))!.snapshot.route_revision,
  ).toBe(before.route_revision + 1);
  // Every connect of the same wake keeps the ticket, whose revision is now one behind the page.
  expect(await actor(f.id).admitWake(f.id, "reader")).toMatchObject({
    wake: admitted.wake,
  });
});

it("a refused claim marks the ticket refused, notifies the node and the next admitWake issues a new ticket", async () => {
  const f = await sleeper();
  // The row moved to a manual suspension after the snapshot the Actor answers from.
  await env.DB.prepare(
    "UPDATE databases SET suspension_reason='manual' WHERE id=?",
  )
    .bind(f.id)
    .run();
  const notify = await nodeNotifications(f.node);
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

it("an awake admissible snapshot answers the node and its target", async () => {
  const f = await admissionSnapshotFixture();
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  const prepare = vi.spyOn(Object.getPrototypeOf(env.DB), "prepare");
  expect(await actor(f.id).admitWake(f.id, "app")).toEqual({
    ok: true,
    region: route(f.region),
    node: f.node,
    target: {
      revision: f.generation,
      route_revision: f.epoch.route_revision,
      instance: f.runtime.instance,
    },
  });
  expect(prepare).not.toHaveBeenCalled();
  expect(await ticket(f.id)).toEqual([]);
});

it("an awake admission writes nothing durable and parses its snapshot once", async () => {
  const f = await admissionSnapshotFixture();
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  // Every application table and row of the Actor: a durable write would change one of them.
  const durable = () =>
    runInDurableObject(actor(f.id), (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
        )
        .toArray()
        .map(({ name }) => [
          name,
          state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray(),
        ]),
    );
  const before = await durable();
  const snapshots = vi.spyOn(DatabaseAdmissionSnapshot, "safeParse");
  const presences = vi.spyOn(DatabasePresence, "parse");
  for (let attempt = 0; attempt < 3; attempt++)
    expect((await actor(f.id).admitWake(f.id, "app")).ok).toBe(true);
  expect(snapshots).toHaveBeenCalledTimes(3);
  expect(presences).toHaveBeenCalledTimes(3);
  expect(await durable()).toEqual(before);
});

/** Every SQL text the Durable Objects of this isolate run through `SqlStorage.exec` from now on. */
const sqlTexts = (id: string) =>
  runInDurableObject(actor(id), (_instance, state) =>
    vi.spyOn(Object.getPrototypeOf(state.storage.sql), "exec"),
  );
const texts = (exec: { mock: { calls: unknown[][] } }) =>
  exec.mock.calls.map(([query]) => String(query));
/** The actor_admit lines of one database that a console.log spy has seen so far. */
const admitLines = (log: { mock: { calls: unknown[][] } }, id: string) =>
  log.mock.calls
    .map(([line]) => (typeof line === "string" ? line : ""))
    .filter((line) => line.includes('"actor_admit"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.database_id === id);

const syncLines = (log: { mock: { calls: unknown[][] } }, id: string) =>
  log.mock.calls
    .map(([line]) => (typeof line === "string" ? line : ""))
    .filter((line) => line.includes('"actor_admit_pending_sync"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.database_id === id);

it("the first cold admission reuses its published ticket without any own SQL write", async () => {
  const f = await sleeper();
  const held = await holdClaims(f.id);
  const notify = await nodeNotifications(f.node);
  const prepared = await ticket(f.id);
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  expect(await ticket(f.id)).toEqual(prepared);
  expect(held.started()).toBe(0);
  expect(await wakeOperations(f.id)).toBe(0);
  expect(notify).not.toHaveBeenCalled();
  const exec = await sqlTexts(f.id);
  const prepare = vi.spyOn(Object.getPrototypeOf(env.DB), "prepare");
  try {
    const admitted = await actor(f.id).admitWake(f.id, "reader");
    expect(
      texts(exec).filter((text) =>
        /^\s*(CREATE|INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER)\b/i.test(text),
      ),
    ).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
    exec.mockRestore();
    prepare.mockRestore();
    expect(admitted).toMatchObject({ ok: true, wake: await expectedWake(f) });
    expect(prepared).toEqual(await ticket(f.id));
    expect(prepared).toEqual([
      {
        operation: (admitted as { wake: { operation: string } }).wake.operation,
        generation: f.sleepGeneration + 1,
        state: "pending",
      },
    ]);
    expect(held.started()).toBe(1);
  } finally {
    exec.mockRestore();
    prepare.mockRestore();
    held.open();
    await expect
      .poll(async () => (await ticket(f.id))[0]?.state)
      .toBe("claimed");
  }
});

it("a missing prepared ticket observes fallback sync before its claim without holding the reply", async () => {
  const awake = await admissionSnapshotFixture();
  expect(await publishDatabaseAdmission(env, awake.id)).toBe(true);
  const f = await sleeper();
  await runInDurableObject(actor(f.id), (_instance, state) => {
    state.storage.sql.exec("DELETE FROM database_ticket");
  });
  const held = await holdClaims(f.id);
  let open!: () => void;
  const pending = new Promise<void>((resolve) => {
    open = resolve;
  });
  let claimsAtSync: number | undefined;
  const sync = await runInDurableObject(actor(f.id), (_instance, state) =>
    vi.spyOn(state.storage, "sync").mockImplementation(() => {
      claimsAtSync = held.started();
      return pending;
    }),
  );
  const awakeSync = await runInDurableObject(
    actor(awake.id),
    (_instance, state) => vi.spyOn(state.storage, "sync"),
  );
  const log = vi.spyOn(console, "log");
  const waiterId = crypto.randomUUID();
  try {
    let answered = false;
    const reply = actor(f.id).admitWake(f.id, "reader", { waiterId });
    void reply.then(
      () => {
        answered = true;
      },
      () => {
        answered = true;
      },
    );
    await expect
      .poll(() => answered, { interval: 5, timeout: 3000 })
      .toBe(true);
    const admitted = await reply;
    expect(admitted).toMatchObject({ ok: true, wake: await expectedWake(f) });
    expect(sync).toHaveBeenCalledTimes(1);
    expect(claimsAtSync).toBe(0);
    expect(syncLines(log, f.id)).toEqual([]);
    expect(await actor(f.id).admitWake(f.id, "reader")).toEqual(admitted);
    expect(await actor(f.id).admitWake(undefined, "reader")).toEqual({
      ok: false,
      sqlstate: "3D000",
    });
    expect((await actor(awake.id).admitWake(awake.id, "app")).ok).toBe(true);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(awakeSync).not.toHaveBeenCalled();
    open();
    await expect.poll(() => syncLines(log, f.id).length).toBe(1);
    expect(syncLines(log, f.id)[0]).toMatchObject({
      database_id: f.id,
      waiter_id: waiterId,
      operation: (admitted as { wake: { operation: string } }).wake.operation,
      generation: f.sleepGeneration + 1,
      outcome: "synced",
    });
  } finally {
    open();
    held.open();
    await expect
      .poll(async () => (await ticket(f.id))[0]?.state)
      .toBe("claimed");
  }
});

it("a failed pending-sync observer keeps the admission and logs only fixed fields", async () => {
  const f = await sleeper();
  await runInDurableObject(actor(f.id), (_instance, state) => {
    state.storage.sql.exec("DELETE FROM database_ticket");
  });
  const held = await holdClaims(f.id);
  const log = vi.spyOn(console, "log");
  const sync = await runInDurableObject(actor(f.id), (_instance, state) =>
    vi
      .spyOn(state.storage, "sync")
      .mockRejectedValue(new Error("private sync error detail")),
  );
  try {
    const admitted = await actor(f.id).admitWake(f.id, "reader");
    expect(admitted).toMatchObject({ ok: true, wake: await expectedWake(f) });
    expect(sync).toHaveBeenCalledTimes(1);
    await expect.poll(() => syncLines(log, f.id).length).toBe(1);
    const line = syncLines(log, f.id)[0]!;
    expect(Object.keys(line)).toEqual([
      "event",
      "database_id",
      "waiter_id",
      "operation",
      "generation",
      "started_at_ms",
      "sync_ms",
      "outcome",
      "at_ms",
    ]);
    expect(line.waiter_id).toBeNull();
    expect(line.outcome).toBe("failed");
    expect(line.sync_ms).toBeGreaterThanOrEqual(0);
    expect(line.at_ms).toBeGreaterThanOrEqual(line.started_at_ms as number);
    expect(JSON.stringify(line)).not.toContain("private sync error detail");
  } finally {
    held.open();
    await expect
      .poll(async () => (await ticket(f.id))[0]?.state)
      .toBe("claimed");
  }
});

it("an admission runs no statement SQLite counts as a write", async () => {
  // SQLite counts CREATE TABLE IF NOT EXISTS as a write even when the table exists, and workerd
  // holds the answer of an Actor that wrote until the write has committed.
  const write = /^\s*(CREATE|INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER)\b/i;
  const awake = await admissionSnapshotFixture();
  expect(await publishDatabaseAdmission(env, awake.id)).toBe(true);
  expect((await actor(awake.id).admitWake(awake.id, "app")).ok).toBe(true);
  const exec = await sqlTexts(awake.id);
  for (let attempt = 0; attempt < 3; attempt++)
    expect((await actor(awake.id).admitWake(awake.id, "app")).ok).toBe(true);
  // The spy sees the reads too: a pass cannot be an Actor that ran nothing.
  expect(texts(exec)).not.toEqual([]);
  expect(texts(exec).filter((text) => write.test(text))).toEqual([]);

  const f = await sleeper();
  const held = await holdClaims(f.id);
  const issued = await actor(f.id).admitWake(f.id, "reader");
  if (!issued.ok || !("wake" in issued)) throw new Error("no wake ticket");
  exec.mockClear();
  for (let attempt = 0; attempt < 3; attempt++)
    expect(await actor(f.id).admitWake(f.id, "reader")).toMatchObject({
      ok: true,
      wake: issued.wake,
    });
  expect(texts(exec)).not.toEqual([]);
  expect(texts(exec).filter((text) => write.test(text))).toEqual([]);
  held.open();
  await expect
    .poll(() => ticket(f.id), { interval: 5, timeout: 3000 })
    .toEqual([
      {
        operation: issued.wake.operation,
        generation: issued.wake.generation,
        state: "claimed",
      },
    ]);
});

it("an Actor that holds no snapshot or ticket yet answers without creating their tables", async () => {
  const id = newDatabaseId();
  await actor(id).seed({
    database_id: id,
    revision: 1,
    updated_at: new Date().toISOString(),
    roles: ["app"],
    deleted: false,
  });
  const tables = () =>
    runInDurableObject(actor(id), (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
        )
        .toArray()
        .map(({ name }) => name),
    );
  expect(await tables()).toEqual(["database_presence", "database_wake"]);
  // No snapshot to answer from: D1 knows no such database.
  expect(
    await actor(id).admitWake(id, "app", { deadline: Date.now() + 1000 }),
  ).toEqual({ ok: false, sqlstate: "3D000" });
  expect(await actor(id).pendingTicket()).toBeNull();
  expect(await tables()).toEqual(["database_presence", "database_wake"]);
});

it("an admission logs one actor_admit line with the path it took", async () => {
  const log = vi.spyOn(console, "log");
  const awake = await admissionSnapshotFixture();
  expect(await publishDatabaseAdmission(env, awake.id)).toBe(true);
  const waiterId = crypto.randomUUID();
  await actor(awake.id).admitWake(awake.id, "app", { waiterId });
  await actor(awake.id).admitWake(awake.id, "app");
  await actor(awake.id).admitWake(awake.id, "missing");
  const sleeping = await sleeper();
  const held = await holdClaims(sleeping.id);
  await actor(sleeping.id).admitWake(sleeping.id, "reader");
  await actor(sleeping.id).admitWake(sleeping.id, "reader");
  // A snapshot persisted before the wakeable field existed takes ensureAwake.
  const legacy = await sleeper();
  await runInDurableObject(actor(legacy.id), (instance, state) => {
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
    Reflect.set(instance, "ensureAwake", async () => ({
      ok: false,
      sqlstate: "08006",
    }));
  });
  await actor(legacy.id).admitWake(legacy.id, "reader");

  const lines = [
    ...admitLines(log, awake.id),
    ...admitLines(log, sleeping.id),
    ...admitLines(log, legacy.id),
  ];
  expect(
    admitLines(log, awake.id).map(({ waiter_id, path, reused }) => [
      waiter_id,
      path,
      reused,
    ]),
  ).toEqual([
    [waiterId, "snapshot", null],
    [null, "snapshot", null],
    [null, "refused", null],
  ]);
  expect(
    admitLines(log, sleeping.id).map(({ path, reused }) => [path, reused]),
  ).toEqual([
    ["ticket", true],
    ["ticket", true],
  ]);
  expect(admitLines(log, legacy.id).map(({ path }) => path)).toEqual([
    "ensure_awake",
  ]);
  // Nothing but these fields: no role, password or token.
  for (const line of lines)
    expect(Object.keys(line)).toEqual([
      "event",
      "database_id",
      "waiter_id",
      "path",
      "reused",
      "handler_ms",
      "instance_age_ms",
      "isolate_actors",
      "at_ms",
    ]);
  held.open();
  await expect
    .poll(async () => (await ticket(sleeping.id))[0]?.state, {
      interval: 5,
      timeout: 3000,
    })
    .toBe("claimed");
});

it("an actor_admit line says how long its instance has existed and how many Actors the isolate built", async () => {
  // Another call may build the instance first: a node report publishes the snapshot before any
  // connect. So the line carries the instance's age, which is 0 only when this call built it.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const log = vi.spyOn(console, "log");
    const published = await admissionSnapshotFixture();
    expect(await publishDatabaseAdmission(env, published.id)).toBe(true);
    vi.advanceTimersByTime(5000);
    await actor(published.id).admitWake(published.id, "app");
    const [warm] = admitLines(log, published.id);
    expect(warm).toMatchObject({
      path: "snapshot",
      handler_ms: 0,
      instance_age_ms: 5000,
    });

    // An id nothing has called: this very admission builds its Actor, one more in the isolate.
    const cold = newDatabaseId();
    await actor(cold).admitWake(cold, "app");
    vi.advanceTimersByTime(7);
    await actor(cold).admitWake(cold, "app");
    const [first, second] = admitLines(log, cold);
    expect(first).toMatchObject({ instance_age_ms: 0 });
    expect(second).toMatchObject({ instance_age_ms: 7 });
    expect(first!.isolate_actors).toBe((warm!.isolate_actors as number) + 1);
    expect(second!.isolate_actors).toBe(first!.isolate_actors);

    // Admitting on the first database again builds nothing.
    await actor(published.id).admitWake(published.id, "app");
    const [, again] = admitLines(log, published.id);
    expect(again).toMatchObject({
      instance_age_ms: 5007,
      isolate_actors: first!.isolate_actors,
    });
  } finally {
    vi.useRealTimers();
  }
});

it("actor handler time includes its own wait but excludes time before the call", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const log = vi.spyOn(console, "log");
    const f = await sleeper("manual");
    await runInDurableObject(actor(f.id), (instance) => {
      vi.spyOn(instance, "ensureAwake").mockImplementation(async () => {
        vi.advanceTimersByTime(37);
        return { ok: false, sqlstate: "08006" };
      });
    });
    vi.advanceTimersByTime(5000);
    expect(await actor(f.id).admitWake(f.id, "app")).toEqual({
      ok: false,
      sqlstate: "08006",
    });
    expect(admitLines(log, f.id)).toEqual([
      expect.objectContaining({
        path: "ensure_awake",
        handler_ms: 37,
        instance_age_ms: 5037,
      }),
    ]);
  } finally {
    vi.useRealTimers();
  }
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

it("a manual suspension at the prepared generation invalidates the unrequested ticket", async () => {
  const f = await sleeper();
  const [prepared] = await ticket(f.id);
  expect(prepared?.generation).toBe(f.sleepGeneration + 1);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE databases SET generation=generation+1,suspension_reason='manual' WHERE id=?",
    ).bind(f.id),
    env.DB.prepare(
      "UPDATE database_admission_epochs SET admission_revision=admission_revision+1,route_revision=route_revision+1 WHERE database_id=?",
    ).bind(f.id),
  ]);
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  expect(await ticket(f.id)).toEqual([]);
  expect(await actor(f.id).admitWake(f.id, "reader")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
  expect(await wakeOperations(f.id)).toBe(0);
});

it("a changed role and route prepare a coherent ticket that survives actual eviction", async () => {
  const f = await sleeper();
  const [before] = await ticket(f.id);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE roles SET password_revision=password_revision+1 WHERE database_id=? AND name='reader'",
    ).bind(f.id),
    env.DB.prepare(
      "UPDATE databases SET generation=generation+1 WHERE id=?",
    ).bind(f.id),
    env.DB.prepare(
      "UPDATE database_admission_epochs SET admission_revision=admission_revision+1,route_revision=route_revision+1 WHERE database_id=?",
    ).bind(f.id),
  ]);
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  const snapshot = (await readDatabaseAdmissionSnapshot(env, f.id))!.snapshot;
  const [prepared] = await ticket(f.id);
  expect(prepared?.operation).not.toBe(before?.operation);
  await evictDurableObject(actor(f.id));
  expect(await ticket(f.id)).toEqual([prepared]);
  const held = await holdClaims(f.id);
  try {
    expect(await actor(f.id).admitWake(f.id, "reader")).toMatchObject({
      ok: true,
      wake: {
        operation: prepared!.operation,
        generation: snapshot.generation + 1,
        route_revision: snapshot.route_revision,
        role_revision_hash: await roleRevisionHash(snapshot.roles),
      },
    });
  } finally {
    held.open();
    await expect
      .poll(async () => (await ticket(f.id))[0]?.state)
      .toBe("claimed");
  }
});

it("a failed snapshot write rolls back ticket preparation and table knowledge together", async () => {
  const f = await sleeper();
  const stored = await runInDurableObject(actor(f.id), (instance, state) => {
    state.storage.sql.exec("DROP TABLE database_ticket");
    (Reflect.get(instance, "tables") as Set<string>).delete("database_ticket");
    state.storage.sql.exec(
      "CREATE TRIGGER refuse_snapshot BEFORE INSERT ON database_snapshot BEGIN SELECT RAISE(ABORT,'snapshot interrupted'); END",
    );
    return state.storage.sql
      .exec<{ snapshot: string }>("SELECT snapshot FROM database_snapshot")
      .one().snapshot;
  });
  await runInDurableObject(actor(f.id), async (instance, state) => {
    // Catch inside the actor so a deliberate failure does not reset it through the outer
    // concurrency gate: the same instance must discard its rolled-back table knowledge.
    const publish = Reflect.get(instance, "publishAdmissionSnapshotLocked") as (
      snapshot: typeof f.snapshot,
      completed: string | null,
    ) => Promise<boolean>;
    await expect(publish.call(instance, f.snapshot, null)).rejects.toThrow(
      "snapshot interrupted",
    );
    expect(
      state.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE name='database_ticket'")
        .toArray(),
    ).toEqual([]);
    expect(
      state.storage.sql
        .exec<{ snapshot: string }>("SELECT snapshot FROM database_snapshot")
        .one().snapshot,
    ).toBe(stored);
    expect(
      (Reflect.get(instance, "tables") as Set<string>).has("database_ticket"),
    ).toBe(false);
    state.storage.sql.exec("DROP TRIGGER refuse_snapshot");
  });
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  expect(await ticket(f.id)).toHaveLength(1);
  expect(await wakeOperations(f.id)).toBe(0);
});

it("a prepared ticket reports the actual admission time before waiting for the previous claim", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  let open = () => {};
  try {
    const f = await sleeper();
    const preparedAt = await runInDurableObject(
      actor(f.id),
      (_instance, state) =>
        state.storage.sql
          .exec<{ issued_at: number }>("SELECT issued_at FROM database_ticket")
          .one().issued_at,
    );
    const previous = new Promise<void>((resolve) => {
      open = resolve;
    });
    await runInDurableObject(actor(f.id), (instance) => {
      Reflect.set(instance, "claim", { operation: "previous", done: previous });
    });
    vi.advanceTimersByTime(60_000);
    const requestedAt = Date.now();
    const log = vi.spyOn(console, "log");
    expect((await actor(f.id).admitWake(f.id, "reader")).ok).toBe(true);
    vi.advanceTimersByTime(5000);
    open();
    await expect
      .poll(async () => (await ticket(f.id))[0]?.state)
      .toBe("claimed");
    const lines = log.mock.calls
      .map(([line]) => (typeof line === "string" ? line : ""))
      .filter((line) => line.includes('"event":"actor_claim"'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.database_id === f.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.requested_at_ms).toBe(requestedAt);
    expect(requestedAt).toBeGreaterThan(preparedAt);
    expect(syncLines(log, f.id)).toEqual([]);
  } finally {
    open();
    vi.useRealTimers();
  }
});

it("a stored snapshot of an earlier release is no snapshot: the Actor falls back, and the next publish replaces it", async () => {
  // Live after the node release: the Actors still held snapshots with cache_capable, roles without
  // valid_until and no node, so every read of them threw a ZodError and a cron step failed each minute.
  const f = await sleeper();
  await runInDurableObject(actor(f.id), (instance, state) => {
    const stored = state.storage.sql
      .exec<{ snapshot: string }>(
        "SELECT snapshot FROM database_snapshot WHERE singleton=1",
      )
      .toArray()[0]!;
    const old = JSON.parse(stored.snapshot) as Record<string, unknown>;
    delete old.node;
    old.cache_capable = true;
    old.roles = [{ name: "app", revision: 1 }];
    state.storage.sql.exec(
      "UPDATE database_snapshot SET snapshot=? WHERE singleton=1",
      JSON.stringify(old),
    );
    Reflect.set(instance, "ensureAwake", async () => ({
      ok: false,
      sqlstate: "08006",
    }));
  });
  expect(
    await actor(f.id).admitWake(f.id, "app", {
      deadline: Date.now() + 1000,
      waiterId: crypto.randomUUID(),
    }),
  ).toEqual({ ok: false, sqlstate: "08006" });
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  await runInDurableObject(actor(f.id), (_instance, state) => {
    const stored = state.storage.sql
      .exec<{ snapshot: string }>(
        "SELECT snapshot FROM database_snapshot WHERE singleton=1",
      )
      .toArray()[0]!;
    expect(
      DatabaseAdmissionSnapshot.safeParse(JSON.parse(stored.snapshot)).success,
    ).toBe(true);
  });
});

it("a snapshot without wakeable falls back to ensureAwake", async () => {
  const f = await sleeper();
  const prepared = await ticket(f.id);
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
  expect(await ticket(f.id)).toEqual(prepared);
});

it("a running database at a generation not yet observed waits through ensureAwake", async () => {
  // Resumed, created or restarted: desired running, the controller has not reported it ready.
  const f = await admissionSnapshotFixture();
  await env.DB.prepare(
    "UPDATE databases SET generation=generation+1 WHERE id=?",
  )
    .bind(f.id)
    .run();
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  const snapshot = (await readDatabaseAdmissionSnapshot(env, f.id))!.snapshot;
  expect(snapshot.admissible).toBe(false);
  expect(snapshot.wakeable).toBe(false);
  const calls: unknown[][] = [];
  await runInDurableObject(actor(f.id), (instance) => {
    Reflect.set(instance, "ensureAwake", async (...args: unknown[]) => {
      calls.push(args);
      return { ok: false, sqlstate: "08006" };
    });
  });
  const options = {
    deadline: Date.now() + 1000,
    waiterId: crypto.randomUUID(),
  };
  expect(await actor(f.id).admitWake(f.id, "app", options)).toEqual({
    ok: false,
    sqlstate: "08006",
  });
  expect(calls).toEqual([[f.id, "app", options]]);
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
