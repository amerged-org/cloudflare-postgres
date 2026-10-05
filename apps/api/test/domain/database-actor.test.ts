// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { DatabaseWithOperation, newDatabaseId } from "@pgcf/contracts";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import type { ApiEnv } from "../../src/env.ts";
import {
  reconcileDatabaseActors,
  readDatabasePresence,
  syncDatabaseActor,
} from "../../src/domain/database-actor-sync.ts";
import { cleanupFixtures, fixture } from "./fixtures.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
});
const actor = (id: string) =>
  env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id));
function admissionQueries() {
  const spy = vi.spyOn(Object.getPrototypeOf(env.DB), "prepare");
  return () => spy.mock.calls.length;
}
async function ready() {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  const id = created.database.id;
  await env.DB.prepare(
    "UPDATE databases SET observed_state='ready',observed_generation=generation WHERE id=?",
  )
    .bind(id)
    .run();
  return { ...f, id };
}
async function sync(id: string) {
  const app = new Hono<ApiEnv>();
  app.get("/sync", async (c) =>
    c.json({ synced: await syncDatabaseActor(c, id) }),
  );
  const response = await app.fetch(
    new Request(`https://${["api", "invalid"].join(".")}/sync`),
    env,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { synced: boolean }).synced;
}

async function applicationTables(id: string) {
  return runInDurableObject(actor(id), (_instance, state) =>
    state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'database_%' ORDER BY name",
      )
      .toArray()
      .map((row) => row.name),
  );
}

it("fresh unknown actors reject hints without creating application tables or querying D1", async () => {
  const id = newDatabaseId();
  const count = admissionQueries();
  const before = await applicationTables(id);
  const admitted = await actor(id).admit(id, "app");
  const awake = await actor(id).ensureAwake(id, "app");
  const after = await applicationTables(id);
  expect(admitted).toEqual({ ok: false, sqlstate: "3D000" });
  expect(awake).toEqual({ ok: false, sqlstate: "3D000" });
  expect(count()).toBe(0);
  expect({ before, after }).toEqual({ before: [], after: [] });
  await evictDurableObject(actor(id));
  expect(await applicationTables(id)).toEqual([]);
  expect((await actor(id).admit(id, "app")).ok).toBe(false);
  expect((await actor(id).ensureAwake(id, "app")).ok).toBe(false);
  expect(await applicationTables(id)).toEqual([]);
  expect(count()).toBe(0);
});

it("rejects a known hint flood at the durable aggregate allowance before D1 or wake", async () => {
  const f = await ready();
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  await runInDurableObject(actor(f.id), (_instance, state) => {
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS database_admission(singleton INTEGER PRIMARY KEY CHECK(singleton=1),minute INTEGER NOT NULL,attempts INTEGER NOT NULL)",
    );
    state.storage.sql.exec(
      "INSERT INTO database_admission VALUES(1,?,12000)",
      Math.floor(Date.now() / 60000),
    );
  });
  const count = admissionQueries();
  const result = await actor(f.id).ensureAwake(f.id, "app");
  expect(result).toEqual({ ok: false, sqlstate: "53300" });
  expect(count()).toBe(0);
  expect(await actor(f.id).ensureAwake(f.id, "unknown_role")).toEqual({
    ok: false,
    sqlstate: "28P01",
  });
  expect(count()).toBe(0);
  expect(
    await runInDurableObject(actor(f.id), (_instance, state) =>
      state.storage.sql.exec("SELECT attempts FROM database_admission").one(),
    ),
  ).toEqual({ attempts: 12000 });
  await evictDurableObject(actor(f.id));
  expect(await actor(f.id).ensureAwake(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "53300",
  });
  expect(count()).toBe(0);
  clock.mockReturnValue(Date.now() + 60000);
  expect((await actor(f.id).ensureAwake(f.id, "app")).ok).toBe(true);
  expect(
    await runInDurableObject(actor(f.id), (_instance, state) =>
      state.storage.sql.exec("SELECT attempts FROM database_admission").one(),
    ),
  ).toEqual({ attempts: 1 });
});

it("a fresh authoritative node loss overrides a warm seeded route without waking it", async () => {
  const f = await ready();
  expect((await actor(f.id).ensureAwake(f.id, "app")).ok).toBe(true);
  await env.DB.prepare(
    "UPDATE nodes SET lost_at=?,lost_reason='confirmed loss',ready=0,schedulable=0 WHERE id=?",
  )
    .bind(new Date().toISOString(), f.node)
    .run();
  expect(await actor(f.id).ensureAwake(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
  expect(await actor(f.id).admit(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
  expect(
    await env.DB.prepare(
      "SELECT count(*) count FROM operations WHERE database_id=? AND kind='database.wake'",
    )
      .bind(f.id)
      .first("count"),
  ).toBe(0);
});

it("atomically bounds a configured aggregate across valid roles and refuses invalid policy", async () => {
  const f = await ready();
  vi.spyOn(Date, "now").mockReturnValue(Date.now());
  await env.DB.prepare(
    `INSERT INTO roles(database_id,name,owner,password_ciphertext,password_iv,password_kid,created_at,updated_at)
    SELECT database_id,'reader',0,password_ciphertext,password_iv,password_kid,created_at,updated_at FROM roles WHERE database_id=? AND name='app'`,
  )
    .bind(f.id)
    .run();
  await actor(f.id).seed(await readDatabasePresence(env.DB, f.id));
  await runInDurableObject(actor(f.id), (instance) => {
    Reflect.get(instance, "env").DATABASE_CONNECTION_LIMIT_PER_MINUTE = "2";
  });
  const allowed = await Promise.all(
    ["app", "reader", "app", "reader"].map((role) =>
      actor(f.id).ensureAwake(f.id, role),
    ),
  );
  expect(allowed.filter((value) => value.ok)).toHaveLength(2);
  expect(allowed.filter((value) => !value.ok)).toEqual([
    { ok: false, sqlstate: "53300" },
    { ok: false, sqlstate: "53300" },
  ]);
  expect(
    await runInDurableObject(actor(f.id), (_instance, state) =>
      state.storage.sql
        .exec(
          "SELECT count(*) count,MAX(attempts) attempts FROM database_admission",
        )
        .one(),
    ),
  ).toEqual({ count: 1, attempts: 2 });
  await runInDurableObject(actor(f.id), (instance) => {
    Reflect.get(instance, "env").DATABASE_CONNECTION_LIMIT_PER_MINUTE = "12001";
  });
  const count = admissionQueries();
  expect(await actor(f.id).ensureAwake(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "53300",
  });
  expect(count()).toBe(0);
});

it("only a validated management seed for the exact actor creates its persistent schema", async () => {
  const id = newDatabaseId();
  const snapshot = {
    database_id: id,
    revision: 1,
    updated_at: new Date().toISOString(),
    roles: ["app"],
    deleted: false,
  };
  await runInDurableObject(actor(id), async (instance) => {
    await expect(
      instance.seed({ ...snapshot, password: crypto.randomUUID() }),
    ).rejects.toThrow("invalid_actor_snapshot");
    await expect(
      instance.seed({ ...snapshot, database_id: newDatabaseId() }),
    ).rejects.toThrow("actor_identity_mismatch");
  });
  expect(await applicationTables(id)).toEqual([]);
  const count = admissionQueries();
  expect(await actor(id).admit(id, "app")).toEqual({
    ok: false,
    sqlstate: "3D000",
  });
  expect(await actor(id).ensureAwake(id, "app")).toEqual({
    ok: false,
    sqlstate: "3D000",
  });
  expect(await applicationTables(id)).toEqual([]);
  await actor(id).seed(snapshot);
  expect(count()).toBe(0);
  expect(await applicationTables(id)).toEqual([
    "database_activity",
    "database_presence",
    "database_wake",
  ]);
  const persisted = await runInDurableObject(actor(id), (_instance, state) =>
    state.storage.sql.exec("SELECT * FROM database_presence").toArray(),
  );
  expect(persisted).toEqual([
    {
      ...snapshot,
      singleton: 1,
      roles: JSON.stringify(snapshot.roles),
      deleted: 0,
    },
  ]);
  await evictDurableObject(actor(id));
  expect(
    await runInDurableObject(actor(id), (_instance, state) =>
      state.storage.sql.exec("SELECT * FROM database_presence").toArray(),
    ),
  ).toEqual(persisted);
  expect(await actor(id).admit(id, "unknown")).toEqual({
    ok: false,
    sqlstate: "28P01",
  });
  expect(count()).toBe(0);
});

it("one thousand distinct unseeded hints make zero authoritative admission queries", async () => {
  const count = admissionQueries();
  for (let index = 0; index < 1000; index++) {
    const id = newDatabaseId();
    expect(await actor(id).admit(id, "app")).toEqual({
      ok: false,
      sqlstate: "3D000",
    });
  }
  expect(count()).toBe(0);
}, 30_000);

it("a seeded unknown role makes no D1 admission query and a valid role reads real authoritative D1", async () => {
  const f = await ready();
  expect(await sync(f.id)).toBe(true);
  const count = admissionQueries();
  expect(await actor(f.id).admit(f.id, "unknown")).toEqual({
    ok: false,
    sqlstate: "28P01",
  });
  expect(count()).toBe(0);
  expect(await actor(f.id).admit(f.id, "app")).toEqual({
    ok: true,
    region: {
      id: f.region,
      gateway_url: `https://${["gateway", "invalid"].join(".")}`,
      gateway_binding: null,
    },
  });
  expect(count()).toBe(1);
});

it("stale positive snapshots never authorize deleted roles, databases or projects", async () => {
  const f = await ready();
  await sync(f.id);
  const time = new Date().toISOString();
  await env.DB.prepare("UPDATE roles SET deleted_at=? WHERE database_id=?")
    .bind(time, f.id)
    .run();
  expect((await actor(f.id).admit(f.id, "app")).ok).toBe(false);
  await env.DB.prepare("UPDATE roles SET deleted_at=NULL WHERE database_id=?")
    .bind(f.id)
    .run();
  await env.DB.prepare("UPDATE projects SET deleted_at=? WHERE id=?")
    .bind(time, f.project)
    .run();
  expect((await actor(f.id).admit(f.id, "app")).ok).toBe(false);
  await env.DB.prepare("UPDATE projects SET deleted_at=NULL WHERE id=?")
    .bind(f.project)
    .run();
  await env.DB.prepare(
    "UPDATE databases SET desired_state='deleted',deleted_at=?,generation=generation+1 WHERE id=?",
  )
    .bind(time, f.id)
    .run();
  expect((await actor(f.id).admit(f.id, "app")).ok).toBe(false);
});

it("malformed, cross-actor and credential-bearing seeds or invalid roles are refused", async () => {
  const f = await ready();
  const snapshot = (await readDatabasePresence(env.DB, f.id))!;
  await runInDurableObject(actor(f.id), async (instance) => {
    await expect(
      instance.seed({ ...snapshot, password: crypto.randomUUID() }),
    ).rejects.toThrow("invalid_actor_snapshot");
    await expect(
      instance.seed({ ...snapshot, roles: ["pg_admin"] }),
    ).rejects.toThrow("invalid_actor_snapshot");
    await expect(
      instance.seed({ ...snapshot, roles: Array<string>(101).fill("app") }),
    ).rejects.toThrow("invalid_actor_snapshot");
  });
  await runInDurableObject(actor(newDatabaseId()), async (instance) => {
    await expect(instance.seed(snapshot)).rejects.toThrow(
      "actor_identity_mismatch",
    );
  });
  const count = admissionQueries();
  expect(await actor(f.id).admit(f.id, "pg_admin")).toEqual({
    ok: false,
    sqlstate: "28P01",
  });
  expect(count()).toBe(0);
});

it("durable negative snapshot survives actual actor eviction without storing credentials", async () => {
  const f = await ready();
  await sync(f.id);
  const stub = actor(f.id);
  await evictDurableObject(stub);
  const count = admissionQueries();
  expect(await stub.admit(f.id, "unknown")).toEqual({
    ok: false,
    sqlstate: "28P01",
  });
  expect(count()).toBe(0);
  expect((await stub.admit(f.id, "app")).ok).toBe(true);
  const rows = await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec("SELECT * FROM database_presence").toArray(),
  );
  expect(Object.keys(rows[0]!).sort()).toEqual([
    "database_id",
    "deleted",
    "revision",
    "roles",
    "singleton",
    "updated_at",
  ]);
});

it("older or equal-clock seeds cannot revive a durable deletion tombstone", async () => {
  const f = await ready();
  const old = (await readDatabasePresence(env.DB, f.id))!;
  await actor(f.id).seed(old);
  await actor(f.id).seed({ ...old, deleted: true, roles: [] });
  await actor(f.id).seed(old);
  await actor(f.id).seed({
    ...old,
    revision: old.revision + 1,
    updated_at: new Date().toISOString(),
  });
  const count = admissionQueries();
  expect(await actor(f.id).admit(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "3D000",
  });
  expect(count()).toBe(0);
});

it("equal revision/time conflicts converge current role additions and removals from D1", async () => {
  const f = await ready();
  const old = (await readDatabasePresence(env.DB, f.id))!;
  await actor(f.id).seed(old);
  await env.DB.prepare(
    "UPDATE roles SET deleted_at=? WHERE database_id=? AND name='app'",
  )
    .bind(old.updated_at, f.id)
    .run();
  await sync(f.id);
  await actor(f.id).seed(old);
  const count = admissionQueries();
  expect(await actor(f.id).admit(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "28P01",
  });
  expect(count()).toBe(0);
  await env.DB.prepare(
    "UPDATE roles SET deleted_at=NULL WHERE database_id=? AND name='app'",
  )
    .bind(f.id)
    .run();
  await sync(f.id);
  expect((await actor(f.id).admit(f.id, "app")).ok).toBe(true);
});

it("keyset pages converge legacy databases and subsequent role/deletion snapshots", async () => {
  const f = await ready();
  const second = DatabaseWithOperation.parse(
    await (await f.create("second")).json(),
  ).database.id;
  const seen: string[] = [];
  let after: string | undefined;
  do {
    const page = await reconcileDatabaseActors(env, after, 1);
    seen.push(...page.ids);
    after = page.next ?? undefined;
  } while (after);
  expect(seen).toContain(f.id);
  expect(seen).toContain(second);
  expect(new Set(seen).size).toBe(seen.length);
  expect((await actor(f.id).admit(f.id, "app")).ok).toBe(true);
  await expect(reconcileDatabaseActors(env, undefined, 201)).rejects.toThrow(
    "invalid_actor_page_limit",
  );
  const time = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE databases SET desired_state='deleted',deleted_at=?,generation=generation+1 WHERE id=?",
  )
    .bind(time, f.id)
    .run();
  await reconcileDatabaseActors(env);
  expect(await actor(f.id).admit(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "3D000",
  });
});

it("known roles make independent authoritative requests and unavailable D1 never admits", async () => {
  const f = await ready();
  await sync(f.id);
  const other = await ready();
  await sync(other.id);
  const count = admissionQueries();
  const replies = await Promise.all(
    Array.from({ length: 8 }, (_, index) => {
      const id = index % 2 ? other.id : f.id;
      return actor(id).admit(id, "app");
    }),
  );
  expect(replies.every((reply) => reply.ok)).toBe(true);
  expect(count()).toBe(8);
  await runInDurableObject(actor(f.id), async (instance) => {
    const db = (instance as unknown as { env: { DB: D1Database } }).env.DB;
    const prepare = vi.spyOn(db, "prepare").mockImplementation(() => {
      throw new Error("unavailable");
    });
    try {
      expect(await instance.admit(f.id, "app")).toEqual({
        ok: false,
        sqlstate: "08006",
      });
    } finally {
      prepare.mockRestore();
    }
  });
});

it("older revisions and timestamps cannot reintroduce roles while fresh sync repairs omissions", async () => {
  const f = await ready();
  const original = (await readDatabasePresence(env.DB, f.id))!;
  const newer = {
    ...original,
    revision: original.revision + 1,
    updated_at: new Date(Date.parse(original.updated_at) + 1).toISOString(),
    roles: [],
  };
  await actor(f.id).seed(newer);
  await actor(f.id).seed(original);
  await actor(f.id).seed({
    ...newer,
    updated_at: original.updated_at,
    roles: ["app"],
  });
  const count = admissionQueries();
  expect(await actor(f.id).admit(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "28P01",
  });
  expect(count()).toBe(0);
  await env.DB.prepare(
    "UPDATE databases SET generation=?,updated_at=? WHERE id=?",
  )
    .bind(newer.revision, newer.updated_at, f.id)
    .run();
  await sync(f.id);
  expect((await actor(f.id).admit(f.id, "app")).ok).toBe(true);
});

it("seeded running roles still require a currently ready database and live region metadata", async () => {
  const f = await ready();
  await sync(f.id);
  await env.DB.prepare("UPDATE databases SET observed_state='error' WHERE id=?")
    .bind(f.id)
    .run();
  expect(await actor(f.id).admit(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
  await env.DB.prepare(
    "UPDATE databases SET observed_state='ready',desired_state='suspended' WHERE id=?",
  )
    .bind(f.id)
    .run();
  expect(await actor(f.id).admit(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
});
