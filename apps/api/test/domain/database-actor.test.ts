// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { DatabaseWithOperation, newDatabaseId } from "@pgcf/contracts";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import type { ApiEnv } from "../../src/env.ts";
import {
  databaseActor,
  reconcileDatabaseActors,
  readDatabasePresence,
  syncDatabaseActor,
} from "../../src/domain/database-actor-sync.ts";
import { DATABASE_ADMISSION_QUERY } from "../../src/database-actor.ts";
import { publishDatabaseAdmission } from "../../src/domain/database-admission-snapshot.ts";
import { cleanupFixtures, fixture, report } from "./fixtures.ts";

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
  expect((await report(f, id, 1)).status).toBe(200);
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

it("names no unit of a storage generation D1 has moved on from", async () => {
  const f = await ready();
  expect((await actor(f.id).ensureAwake(f.id, "app")).ok).toBe(true);
  // D1 names the next storage generation; the unit the node reported is of the old volume, and
  // the Actor's fallback read of D1 must not route to it.
  await env.DB.prepare("UPDATE databases SET storage_generation=2 WHERE id=?")
    .bind(f.id)
    .run();
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  expect(await actor(f.id).ensureAwake(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
  expect(await actor(f.id).admit(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
});

it("rejects a known hint flood at the Actor's per-minute allowance before D1 or wake", async () => {
  const f = await ready();
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  const admissions = () =>
    runInDurableObject(actor(f.id), (instance) =>
      structuredClone(Reflect.get(instance, "admissions")),
    );
  await runInDurableObject(actor(f.id), (instance) => {
    Reflect.set(instance, "admissions", {
      minute: Math.floor(Date.now() / 60000),
      attempts: 12000,
    });
  });
  const count = admissionQueries();
  const result = await actor(f.id).ensureAwake(f.id, "app");
  expect(result).toEqual({ ok: false, sqlstate: "53300" });
  expect(count()).toBe(0);
  expect(await actor(f.id).ensureAwake(f.id, "unknown_role")).toEqual({
    ok: false,
    sqlstate: "28P01",
  });
  expect(await actor(f.id).admitWake(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "53300",
  });
  expect(count()).toBe(0);
  expect((await admissions()).attempts).toBe(12000);
  clock.mockReturnValue(Date.now() + 60000);
  expect((await actor(f.id).ensureAwake(f.id, "app")).ok).toBe(true);
  expect(await admissions()).toEqual({
    minute: Math.floor(Date.now() / 60000),
    attempts: 1,
  });
});

it("gets every DatabaseActor with the configured location hint, and none without one", async () => {
  const f = await ready();
  const get = vi.spyOn(Object.getPrototypeOf(env.DATABASE_ACTOR), "get");
  const hinted = { ...env, DATABASE_ACTOR_LOCATION_HINT: "weur" };
  expect((await databaseActor(hinted, f.id).admitWake(f.id, "app")).ok).toBe(
    true,
  );
  await reconcileDatabaseActors(hinted);
  expect(get.mock.calls.length).toBeGreaterThan(1);
  expect(get.mock.calls.map((call) => call[1])).toEqual(
    get.mock.calls.map(() => ({ locationHint: "weur" })),
  );
  get.mockClear();
  await databaseActor(env, f.id).admitWake(f.id, "app");
  expect(get.mock.calls.map((call) => call[1])).toEqual([undefined]);
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
  await sync(f.id);
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
    await runInDurableObject(
      actor(f.id),
      (instance) => Reflect.get(instance, "admissions").attempts,
    ),
  ).toBe(2);
  await runInDurableObject(actor(f.id), (instance) => {
    Reflect.get(instance, "env").DATABASE_CONNECTION_LIMIT_PER_MINUTE = "12001";
  });
  const count = admissionQueries();
  expect(await actor(f.id).ensureAwake(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "53300",
  });
  expect(count()).toBe(0);
  // The Actor environment is shared by later tests in this file.
  await runInDurableObject(actor(f.id), (instance) => {
    delete Reflect.get(instance, "env").DATABASE_CONNECTION_LIMIT_PER_MINUTE;
  });
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
    "database_presence",
    "database_wake",
  ]);
  const persisted = await runInDurableObject(actor(id), (_instance, state) =>
    state.storage.sql.exec("SELECT * FROM database_presence").toArray(),
  );
  // A role without an expiry is stored as it always was, the bare name.
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

it("a seeded unknown role and a valid role are both answered from the snapshot without a D1 admission query", async () => {
  const f = await ready();
  expect(await sync(f.id)).toBe(true);
  const count = admissionQueries();
  expect(await actor(f.id).admit(f.id, "unknown")).toEqual({
    ok: false,
    sqlstate: "28P01",
  });
  expect(count()).toBe(0);
  expect(await actor(f.id).admit(f.id, "app")).toMatchObject({
    ok: true,
    region: {
      id: f.region,
      gateway_url: `https://${["gateway", "invalid"].join(".")}`,
      gateway_binding: null,
    },
    node: f.node,
    target: { revision: 1, route_revision: 1 },
  });
  expect(count()).toBe(0);
});

it("sends a connection to the gateway of the node that serves the database, and to the region's only when the node has none", async () => {
  const f = await ready();
  expect(await sync(f.id)).toBe(true);
  const regional = `https://${["gateway", "invalid"].join(".")}`,
    own = `https://pgcf-node-${"a".repeat(20)}.nodes.example.org`;
  await env.DB.prepare(
    "UPDATE regions SET gateway_binding='REGIONAL' WHERE id=?",
  )
    .bind(f.region)
    .run();
  const gateway = async () => {
    const row = (await env.DB.prepare(DATABASE_ADMISSION_QUERY)
      .bind("app", f.id)
      .first<{ gateway_url: string; gateway_binding: string | null }>())!;
    expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
    const admitted = await actor(f.id).admit(f.id, "app");
    expect(admitted.ok).toBe(true);
    // The snapshot and the query of the actor's cold path name the same gateway.
    const route = (
      admitted as {
        region: { gateway_url: string; gateway_binding: string | null };
      }
    ).region;
    expect({
      gateway_url: route.gateway_url,
      gateway_binding: route.gateway_binding,
    }).toEqual({
      gateway_url: row.gateway_url,
      gateway_binding: row.gateway_binding,
    });
    return route;
  };
  expect(await gateway()).toMatchObject({
    gateway_url: regional,
    gateway_binding: "REGIONAL",
  });
  await env.DB.prepare("UPDATE nodes SET gateway_url=? WHERE id=?")
    .bind(own, f.node)
    .run();
  // A node's own gateway is a public hostname: the region's service binding is not its.
  expect(await gateway()).toMatchObject({
    gateway_url: own,
    gateway_binding: null,
  });
});

it("stale positive snapshots never authorize deleted roles, databases or projects", async () => {
  const f = await ready();
  await sync(f.id);
  const time = new Date().toISOString();
  await env.DB.prepare("UPDATE roles SET deleted_at=? WHERE database_id=?")
    .bind(time, f.id)
    .run();
  await sync(f.id);
  expect((await actor(f.id).admit(f.id, "app")).ok).toBe(false);
  await env.DB.prepare("UPDATE roles SET deleted_at=NULL WHERE database_id=?")
    .bind(f.id)
    .run();
  await env.DB.prepare("UPDATE projects SET deleted_at=? WHERE id=?")
    .bind(time, f.project)
    .run();
  await sync(f.id);
  expect((await actor(f.id).admit(f.id, "app")).ok).toBe(false);
  await env.DB.prepare("UPDATE projects SET deleted_at=NULL WHERE id=?")
    .bind(f.project)
    .run();
  await env.DB.prepare(
    "UPDATE databases SET desired_state='deleted',deleted_at=?,generation=generation+1 WHERE id=?",
  )
    .bind(time, f.id)
    .run();
  await sync(f.id);
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

it("known roles are admitted from their snapshots with no D1 query, whether or not D1 is available", async () => {
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
  expect(count()).toBe(0);
  await runInDurableObject(actor(f.id), async (instance) => {
    const db = (instance as unknown as { env: { DB: D1Database } }).env.DB;
    const prepare = vi.spyOn(db, "prepare").mockImplementation(() => {
      throw new Error("unavailable");
    });
    try {
      expect((await instance.admit(f.id, "app")).ok).toBe(true);
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
  expect(await actor(f.id).admit(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
  // The node applies the new generation and reports it ready.
  expect((await report(f, f.id, newer.revision)).status).toBe(200);
  expect((await actor(f.id).admit(f.id, "app")).ok).toBe(true);
});

it("seeded running roles still require a currently ready database and live region metadata", async () => {
  const f = await ready();
  await sync(f.id);
  await env.DB.prepare("UPDATE databases SET observed_state='error' WHERE id=?")
    .bind(f.id)
    .run();
  await sync(f.id);
  expect(await actor(f.id).admit(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
  await env.DB.prepare(
    "UPDATE databases SET observed_state='ready',desired_state='suspended' WHERE id=?",
  )
    .bind(f.id)
    .run();
  await sync(f.id);
  expect(await actor(f.id).admit(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
});
