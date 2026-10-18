// SPDX-License-Identifier: Apache-2.0
// The claim of a wake runs inside the Actor's concurrency block: every D1 round trip in it holds
// every other event of the database. These tests name the reads a claim needs and that its hint
// holds nothing back; each safety check of the admission mutation stays, as the neighbouring
// admission tests prove. Real D1 and Durable Object harness; no live evidence.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupFixtures } from "./fixtures.ts";
import {
  actor,
  registered,
  reportReady,
  sleep,
  sleeping,
  untilWake,
} from "./wake-fixture.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
});

const ADMISSION = "r.name role_name";
const ROW = "SELECT * FROM databases WHERE id=?";
const OPERATION = "SELECT id FROM operations WHERE id=? AND database_id=?";
const EPOCH_INSERT = "INSERT INTO database_admission_epochs";
const EPOCH_READ =
  "SELECT database_id,admission_revision,route_revision,mutation_id FROM";
const PRESENCE = "SELECT d.id database_id,d.generation revision";
const FENCE = "mutation_outcome='fenced'";
const PUBLISH_SNAPSHOT = "SELECT d.*,p.deleted_at project_deleted_at";
const PUBLISH_EPOCH =
  "SELECT admission_revision,route_revision,mutation_id,completed_mutation_id";

type Gate = {
  name: string;
  nth: number;
  gate: Promise<void>;
  open: () => void;
};
/**
 * Records every D1 execution (start and end) and every node hint in one ordered list. A gate
 * holds the n-th execution of a statement until it is opened, to prove that another one is issued
 * meanwhile.
 */
async function record(node: string, gates: Gate[] = []) {
  const events: string[] = [];
  const seen = new Map<string, number>();
  const prototype = Object.getPrototypeOf(env.DB) as D1Database;
  const original = prototype.prepare;
  vi.spyOn(prototype, "prepare").mockImplementation(function (
    this: D1Database,
    sql: string,
  ) {
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === "bind")
            return (...values: unknown[]) => wrap(target.bind(...values));
          if (
            property === "first" ||
            property === "run" ||
            property === "all" ||
            property === "raw"
          )
            return async (...args: unknown[]) => {
              const count = (seen.get(sql) ?? 0) + 1;
              seen.set(sql, count);
              events.push(`start ${sql}`);
              try {
                const result = await Reflect.apply(
                  Reflect.get(target, property),
                  target,
                  args,
                );
                const gate = gates.find(
                  (g) => sql.includes(g.name) && g.nth === count,
                );
                if (gate) await gate.gate;
                return result;
              } finally {
                events.push(`end ${sql}`);
              }
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    return wrap(original.call(this, sql));
  });
  await runInDurableObject(
    env.NODE_ACTOR.get(env.NODE_ACTOR.idFromName(node)),
    (instance) => {
      const proto = Object.getPrototypeOf(instance) as {
        notify: (ids?: string[]) => Promise<number>;
      };
      const notify = proto.notify;
      vi.spyOn(proto, "notify").mockImplementation(async function (
        this: unknown,
        ids?: string[],
      ) {
        events.push("HINT");
        return notify.call(this, ids);
      });
    },
  );
  return events;
}
const gate = (name: string, nth: number): Gate => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { name, nth, gate: promise, open };
};
const starts = (events: string[], needle: string) =>
  events.filter((e) => e.startsWith("start ") && e.includes(needle));
const indexOf = (events: string[], needle: string, from = 0) =>
  events.findIndex((e, i) => i >= from && e.includes(needle));

/** Runs the claim of one wake up to its registered waiter and returns what the Actor did. */
async function claim(gates: Gate[] = []) {
  const f = await sleeping();
  const events = await record(f.node, gates);
  const waiterId = crypto.randomUUID();
  const waiting = actor(f.id).ensureAwake(f.id, "app", {
    waiterId,
    deadline: Date.now() + 20_000,
  });
  const row = await untilWake(f.id);
  await registered(f.id, waiterId);
  const finish = async () => {
    for (const g of gates) g.open();
    expect((await reportReady(f, f.id, row.generation)).status).toBe(200);
    expect(await waiting).toMatchObject({ ok: true });
  };
  return { f, events, row, finish };
}

it("the claim's admission mutation reads an existing epoch once and reads no presence it never seeds", async () => {
  const { events, finish } = await claim();
  expect(starts(events, EPOCH_INSERT)).toHaveLength(0);
  expect(starts(events, EPOCH_READ)).toHaveLength(1);
  expect(starts(events, PRESENCE)).toHaveLength(0);
  await finish();
}, 30_000);

it("a committed claim does not fence an admission mutation its own commit completed", async () => {
  const { events, finish } = await claim();
  expect(starts(events, FENCE)).toHaveLength(0);
  await finish();
}, 30_000);

it("the claim reads the database row together with its admission read", async () => {
  // The claim's own admission read is the second one: the first is the wait's.
  const admission = gate(ADMISSION, 2);
  const f = await sleeping();
  const events = await record(f.node, [admission]);
  const waiting = actor(f.id).ensureAwake(f.id, "app", {
    deadline: Date.now() + 20_000,
  });
  for (let i = 0; i < 400 && starts(events, ROW).length === 0; i++)
    await sleep(5);
  // The row was read while the claim's admission read was still held back.
  expect(starts(events, ADMISSION)).toHaveLength(2);
  expect(
    events.filter((e) => e.startsWith("end ") && e.includes(ADMISSION)),
  ).toHaveLength(1);
  expect(starts(events, ROW)).toHaveLength(1);
  admission.open();
  const row = await untilWake(f.id);
  expect((await reportReady(f, f.id, row.generation)).status).toBe(200);
  expect(await waiting).toMatchObject({ ok: true });
}, 30_000);

it("the claim does not read back the row and the operation its own transition committed", async () => {
  const { events, finish } = await claim();
  // The one read of the row is the claim's first; the committed generation and operation are the
  // transition's own, and the publish that closes the mutation still follows its commit.
  expect(starts(events, ROW)).toHaveLength(1);
  expect(
    starts(events, OPERATION).filter((e) => e.includes("kind IN")),
  ).toHaveLength(0);
  const commit = indexOf(
    events,
    "UPDATE database_admission_epochs SET mutation_id=?",
  );
  expect(indexOf(events, PUBLISH_SNAPSHOT, commit)).toBeGreaterThan(commit);
  expect(indexOf(events, PUBLISH_EPOCH, commit)).toBeGreaterThan(commit);
  expect(events).toContain("HINT");
  await finish();
}, 30_000);

it("the claim does not wait for the hint's delivery", async () => {
  const f = await sleeping();
  let open!: () => void;
  const delivered = new Promise<void>((resolve) => {
    open = resolve;
  });
  let notified = 0;
  await runInDurableObject(
    env.NODE_ACTOR.get(env.NODE_ACTOR.idFromName(f.node)),
    (instance) => {
      const proto = Object.getPrototypeOf(instance) as {
        notify: (ids?: string[]) => Promise<number>;
      };
      const notify = proto.notify;
      vi.spyOn(proto, "notify").mockImplementation(async function (
        this: unknown,
        ids?: string[],
      ) {
        notified++;
        await delivered;
        return notify.call(this, ids);
      });
    },
  );
  const waiterId = crypto.randomUUID();
  const waiting = actor(f.id).ensureAwake(f.id, "app", {
    waiterId,
    deadline: Date.now() + 20_000,
  });
  // The wake is claimed and its waiter registered while the node's hint is still on its way: the
  // hint's RPC may reach the node's object after the registration, so its arrival is awaited.
  await registered(f.id, waiterId);
  await vi.waitFor(() => expect(notified).toBe(1), { timeout: 10_000 });
  open();
  const row = await untilWake(f.id);
  expect((await reportReady(f, f.id, row.generation)).status).toBe(200);
  expect(await waiting).toMatchObject({ ok: true });
}, 30_000);
