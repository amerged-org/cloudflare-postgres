// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  DatabaseWithOperation,
  NodeDesiredPage,
  newOperationId,
} from "@pgcf/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { keyring } from "../../src/crypto/keyring.ts";
import { fenceOperation } from "../../src/domain/node-desired.ts";
import {
  assignRelease,
  cleanupFixtures,
  fixture,
  grantCredential,
  nodePolicy,
  nodeRequest,
  report,
  request,
  served,
  setNodePolicy,
} from "./fixtures.ts";

afterEach(cleanupFixtures);

type F = Awaited<ReturnType<typeof fixture>>;
async function pull(f: F, query = "") {
  const response = await nodeRequest(f, `/node/v1/desired${query}`);
  expect(response.status).toBe(200);
  return NodeDesiredPage.parse(await response.json());
}
/** The database moves to its second storage generation: a new archive path with its credential. */
async function nextStorage(id: string) {
  const path = (await env.DB.prepare(
    "SELECT archive_path FROM databases WHERE id=?",
  )
    .bind(id)
    .first<string>("archive_path"))!;
  const next = path.replace(/\/g1-op_[a-z0-9]{20}$/, `/g2-${newOperationId()}`);
  await env.DB.prepare(
    "UPDATE databases SET storage_generation=2,archive_path=? WHERE id=?",
  )
    .bind(next, id)
    .run();
  await grantCredential(id);
}
const entry = async (f: F, id: string) =>
  (await pull(f)).databases.find((database) => database.id === id);

describe("the desired page of a node", () => {
  it("needs the region's node policy", async () => {
    const f = await fixture();
    expect((await nodeRequest(f, "/node/v1/desired")).status).toBe(409);
    await setNodePolicy(f);
    expect(await pull(f)).toEqual({
      node: {
        id: f.node,
        uid: f.nodeUid,
        hostname: f.nodeName,
        region_id: f.region,
      },
      release: null,
      policy: nodePolicy(),
      credentials_revision: 1,
      orders: [],
      databases: [],
      next: null,
    });
  });

  it("names a database once its credential exists, with its class resources, roles and archive", async () => {
    const f = await fixture();
    await setNodePolicy(f);
    const created = DatabaseWithOperation.parse(
      await (await f.create("page")).json(),
    );
    const id = created.database.id;
    expect(await entry(f, id)).toBeUndefined();
    const credential = await grantCredential(id);
    const database = (await entry(f, id))!;
    const row = (await env.DB.prepare(
      "SELECT archive_path FROM databases WHERE id=?",
    )
      .bind(id)
      .first<{ archive_path: string }>())!;
    const owner = (await env.DB.prepare(
      "SELECT * FROM roles WHERE database_id=? AND name='app'",
    )
      .bind(id)
      .first<{
        password_ciphertext: string;
        password_iv: string;
        password_kid: string;
      }>())!;
    expect(database).toMatchObject({
      id,
      generation: 1,
      operation: created.operation.id,
      desired_state: "running",
      route_revision: 1,
      storage_generation: 1,
      pg_major: 18,
      resources: { memory_mib: 512, cpu_millicores: 500, storage_gib: 5 },
      settings: { max_connections: 50, archive_timeout_seconds: 60 },
      sleep_after_seconds: null,
      archive: { path: row.archive_path, credential },
      origin: { kind: "create" },
    });
    expect(database.roles).toEqual([
      {
        name: "app",
        owner: true,
        revision: 1,
        password: await keyring(env.CREDENTIAL_KEYS).decrypt(id, "app", {
          ciphertext: owner.password_ciphertext,
          iv: owner.password_iv,
          kid: owner.password_kid,
        }),
      },
    ]);
  });

  it("leaves out a database whose credential has expired, but not a deleted one", async () => {
    const f = await fixture();
    const db = await served(f);
    await env.DB.prepare(
      "UPDATE database_archive_credentials SET expires_at=?,created_at=? WHERE database_id=?",
    )
      .bind(
        new Date(Date.now() - 1000).toISOString(),
        new Date(Date.now() - 2000).toISOString(),
        db.id,
      )
      .run();
    expect(await entry(f, db.id)).toBeUndefined();
    await grantCredential(db.id, { lifetimeMs: 60_000 });
    const renewed = (await entry(f, db.id))!;
    expect(Date.parse(renewed.archive.credential.expires_at)).toBeGreaterThan(
      Date.now(),
    );
    // The newest valid credential is the one named.
    const newer = await grantCredential(db.id, { lifetimeMs: 3 * 86_400_000 });
    expect((await entry(f, db.id))!.archive.credential).toEqual(newer);
    // A read-only credential of the same path is no write credential.
    await env.DB.prepare(
      "DELETE FROM database_archive_credentials WHERE database_id=?",
    )
      .bind(db.id)
      .run();
    await grantCredential(db.id, { access: "read_only" });
    expect(await entry(f, db.id)).toBeUndefined();
    await env.DB.prepare(
      "DELETE FROM database_archive_credentials WHERE database_id=?",
    )
      .bind(db.id)
      .run();
    await grantCredential(db.id, { lifetimeMs: 60_000 });
    expect(
      (await request(`/v1/databases/${db.id}`, f.integrator, "DELETE")).status,
    ).toBe(202);
    await env.DB.prepare(
      "UPDATE database_archive_credentials SET expires_at=?,created_at=? WHERE database_id=?",
    )
      .bind(
        new Date(Date.now() - 1000).toISOString(),
        new Date(Date.now() - 2000).toISOString(),
        db.id,
      )
      .run();
    const deleted = (await entry(f, db.id))!;
    expect(deleted.desired_state).toBe("deleted");
    expect(deleted.roles).toEqual([]);
  });

  it("stops asking for a create once the database was ready", async () => {
    const f = await fixture();
    const db = await served(f);
    expect((await entry(f, db.id))!.origin).toEqual({ kind: "create" });
    expect((await report(f, db.id, 1)).status).toBe(200);
    expect((await entry(f, db.id))!.origin).toBeUndefined();
  });

  it("keeps the operation of the generation that asked: a role change names none of its own", async () => {
    const f = await fixture();
    const db = await served(f);
    expect(
      (
        await request(
          `/v1/databases/${db.id}/roles`,
          f.integrator,
          "POST",
          { name: "reader" },
          crypto.randomUUID(),
        )
      ).status,
    ).toBe(201);
    const database = (await entry(f, db.id))!;
    expect(database.generation).toBe(2);
    expect(database.operation).toBe(db.operation);
    expect(database.roles.map((role) => role.name)).toEqual(["app", "reader"]);
  });

  it("shows a manual suspend as suspended and an idle sleeper as running", async () => {
    const f = await fixture();
    const db = await served(f);
    await report(f, db.id, 1);
    const suspended = DatabaseWithOperation.parse(
      await (
        await request(
          `/v1/databases/${db.id}/suspend`,
          f.integrator,
          "POST",
          undefined,
          crypto.randomUUID(),
        )
      ).json(),
    );
    const manual = (await entry(f, db.id))!;
    expect(manual).toMatchObject({
      desired_state: "suspended",
      generation: 2,
      operation: suspended.operation.id,
    });
    await env.DB.prepare(
      "UPDATE databases SET suspension_reason='idle' WHERE id=?",
    )
      .bind(db.id)
      .run();
    expect((await entry(f, db.id))!.desired_state).toBe("running");
  });

  it("names a deleted role without its credential", async () => {
    const f = await fixture();
    const db = await served(f);
    await request(
      `/v1/databases/${db.id}/roles`,
      f.integrator,
      "POST",
      { name: "reader" },
      crypto.randomUUID(),
    );
    expect(
      (
        await request(
          `/v1/databases/${db.id}/roles/reader`,
          f.integrator,
          "DELETE",
          undefined,
          crypto.randomUUID(),
        )
      ).status,
    ).toBe(202);
    const roles = (await entry(f, db.id))!.roles;
    expect(roles.find((role) => role.name === "reader")).toEqual({
      name: "reader",
      state: "absent",
    });
  });

  it("pages by identifier and pulls named databases", async () => {
    const f = await fixture();
    const ids = [] as string[];
    for (const name of ["one", "two", "three"])
      ids.push((await served(f, name)).id);
    ids.sort();
    const first = await pull(f, "?limit=2");
    expect(first.databases.map((database) => database.id)).toEqual(
      ids.slice(0, 2),
    );
    expect(first.next).toBe(ids[1]);
    const second = await pull(f, `?limit=2&after=${first.next}`);
    expect(second.databases.map((database) => database.id)).toEqual([ids[2]]);
    expect(second.next).toBeNull();
    const named = await pull(f, `?ids=${ids[2]},${ids[0]}`);
    expect(named.databases.map((database) => database.id)).toEqual([
      ids[0],
      ids[2],
    ]);
    expect(
      (await nodeRequest(f, `/node/v1/desired?ids=${ids[0]}&after=${ids[1]}`))
        .status,
    ).toBe(400);
    expect((await nodeRequest(f, "/node/v1/desired?limit=0")).status).toBe(400);
  });

  it("carries the effective idle time: the database's own, else its class's, else none", async () => {
    const f = await fixture();
    const db = await served(f);
    const set = (
      table: "databases" | "size_classes",
      id: string,
      value: number | null,
    ) =>
      env.DB.prepare(`UPDATE ${table} SET sleep_after_seconds=? WHERE id=?`)
        .bind(value, id)
        .run();
    const idle = async () => (await entry(f, db.id))!.sleep_after_seconds;
    expect(await idle()).toBeNull();
    await set("size_classes", f.size, 1800);
    expect(await idle()).toBe(1800);
    await set("databases", db.id, 600);
    expect(await idle()).toBe(600);
    await set("size_classes", f.size, null);
    expect(await idle()).toBe(600);
    await set("databases", db.id, null);
    expect(await idle()).toBeNull();
  });

  it("serves the databases of its own node only", async () => {
    const f = await fixture();
    const other = await fixture();
    const db = await served(f);
    await setNodePolicy(other);
    expect(await entry(other, db.id)).toBeUndefined();
    expect((await entry(f, db.id))!.id).toBe(db.id);
  });
});

describe("the release and the orders on a node's page", () => {
  it("carries the release of the node's region: the id, the four binaries and the operating system", async () => {
    const f = await fixture();
    await setNodePolicy(f);
    const id = await assignRelease(f, "release-one");
    const page = await pull(f);
    expect(page.release).toMatchObject({
      id,
      os: { image_version: "1.2.0", debian_snapshot: "20261015T000000Z" },
    });
    expect(Object.keys(page.release!.binaries)).toEqual([
      "pgcf-agent",
      "pgcf-native-gateway",
      "pgcf-archive",
      "pgcf-wal-fetch",
    ]);
    // The image only installs a node; no node reads it.
    expect(JSON.stringify(page)).not.toContain("raw.zst");
  });

  it("orders a wake for a pending resume and ends it when the operation does", async () => {
    const f = await fixture();
    const db = await served(f);
    await report(f, db.id, 1);
    await request(
      `/v1/databases/${db.id}/suspend`,
      f.integrator,
      "POST",
      undefined,
      crypto.randomUUID(),
    );
    await report(f, db.id, 2, "asleep");
    const resumed = DatabaseWithOperation.parse(
      await (
        await request(
          `/v1/databases/${db.id}/resume`,
          f.integrator,
          "POST",
          undefined,
          crypto.randomUUID(),
        )
      ).json(),
    );
    expect((await pull(f)).orders).toEqual([
      {
        type: "wake",
        operation: resumed.operation.id,
        database: db.id,
        generation: 3,
      },
    ]);
    await env.DB.prepare(
      "UPDATE operations SET status='failed',error_code='no_room',completed_at=? WHERE id=?",
    )
      .bind(new Date().toISOString(), resumed.operation.id)
      .run();
    expect((await pull(f)).orders).toEqual([]);
  });

  it("lists the open orders that have no other row, and keeps a retired generation after its result", async () => {
    const f = await fixture();
    const db = await served(f);
    const move = newOperationId(),
      superseded = newOperationId(),
      maintenance = newOperationId(),
      done = newOperationId();
    const now = new Date().toISOString(),
      later = (milliseconds: number) =>
        new Date(Date.parse(now) + milliseconds).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO node_orders(operation,node_id,type,database_id,storage_generation,remove_volume,created_at) VALUES(?,?,'move',?,1,0,?)",
      ).bind(move, f.node, db.id, now),
      env.DB.prepare(
        "INSERT INTO node_orders(operation,node_id,type,database_id,storage_generation,remove_volume,created_at) VALUES(?,?,'superseded',?,0+1,1,?)",
      ).bind(superseded, f.node, db.id, later(1)),
      env.DB.prepare(
        "INSERT INTO node_orders(operation,node_id,type,created_at) VALUES(?,?,'maintenance',?)",
      ).bind(maintenance, f.node, later(2)),
      env.DB.prepare(
        "INSERT INTO node_orders(operation,node_id,type,created_at,result,resulted_at) VALUES(?,?,'maintenance',?,'done',?)",
      ).bind(done, f.node, now, now),
    ]);
    // A retired generation of a database the page still serves must be an older one.
    await nextStorage(db.id);
    const page = await pull(f);
    expect(page.orders).toEqual([
      { type: "move", operation: move, database: db.id, storage_generation: 1 },
      {
        type: "superseded",
        operation: superseded,
        database: db.id,
        storage_generation: 1,
        remove_volume: true,
      },
      { type: "maintenance", operation: maintenance },
    ]);
    // The result ends a move and a maintenance cycle; a retired generation never ends.
    await env.DB.prepare(
      "UPDATE node_orders SET result='done',resulted_at=? WHERE operation IN(?,?,?)",
    )
      .bind(now, move, superseded, maintenance)
      .run();
    expect((await pull(f)).orders).toEqual([
      {
        type: "superseded",
        operation: superseded,
        database: db.id,
        storage_generation: 1,
        remove_volume: true,
      },
    ]);
  });

  it("holds the fence, the retired generations and nothing else for a node declared lost", async () => {
    const f = await fixture();
    const db = await served(f);
    await assignRelease(f);
    const superseded = newOperationId();
    await env.DB.prepare(
      "INSERT INTO node_orders(operation,node_id,type,database_id,storage_generation,remove_volume,created_at) VALUES(?,?,'superseded',?,1,0,?)",
    )
      .bind(superseded, f.node, db.id, new Date().toISOString())
      .run();
    await env.DB.prepare(
      "INSERT INTO node_orders(operation,node_id,type,created_at) VALUES(?,?,'maintenance',?)",
    )
      .bind(newOperationId(), f.node, new Date().toISOString())
      .run();
    await env.DB.prepare(
      "UPDATE nodes SET lost_at=?,lost_reason='test',ready=0,schedulable=0 WHERE id=?",
    )
      .bind(new Date().toISOString(), f.node)
      .run();
    const page = await pull(f);
    expect(page.databases).toEqual([]);
    expect(page.release).toBeNull();
    expect(page.next).toBeNull();
    expect(page.orders).toEqual([
      { type: "fence", operation: await fenceOperation(f.node) },
      {
        type: "superseded",
        operation: superseded,
        database: db.id,
        storage_generation: 1,
        remove_volume: false,
      },
    ]);
    expect(await fenceOperation(f.node)).toMatch(/^op_[0-9a-f]{20}$/);
    expect(await fenceOperation(f.node)).not.toBe(
      await fenceOperation(`nod_${"a".repeat(20)}`),
    );
  });
});

describe("a restore on the page", () => {
  it("names the source archive and its read-only credential until the restore is verified", async () => {
    const f = await fixture();
    const source = await served(f, "source");
    const target = await served(f, "target");
    const operation = newOperationId(),
      now = new Date().toISOString();
    const sourcePath = (await env.DB.prepare(
      "SELECT archive_path FROM databases WHERE id=?",
    )
      .bind(source.id)
      .first<string>("archive_path"))!;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at) SELECT ?,'database.restore','pending',project_id,id,1,?,? FROM databases WHERE id=?",
      ).bind(operation, now, now, target.id),
      env.DB.prepare(
        "INSERT INTO database_restores(target_database_id,operation_id,source_database_id,source_archive_path,source_storage_generation,backup_id,target_time,created_at) VALUES(?,?,?,?,1,?,?,?)",
      ).bind(
        target.id,
        operation,
        source.id,
        sourcePath,
        "20261017T110000",
        "2026-10-17T11:30:00.000Z",
        now,
      ),
    ]);
    // Without the read-only credential of the source the restore cannot start.
    expect(await entry(f, target.id)).toBeUndefined();
    const read = await grantCredential(target.id, {
      path: sourcePath,
      access: "read_only",
    });
    expect((await entry(f, target.id))!.origin).toEqual({
      kind: "restore",
      source: {
        database_id: source.id,
        path: sourcePath,
        backup_id: "20261017T110000",
        target_time: "2026-10-17T11:30:00.000Z",
        credential: read,
      },
    });
    await env.DB.prepare(
      "UPDATE database_restores SET verified_at=? WHERE target_database_id=?",
    )
      .bind(now, target.id)
      .run();
    expect((await entry(f, target.id))!.origin).toBeUndefined();
  });
});
