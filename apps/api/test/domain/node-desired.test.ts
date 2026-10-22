// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  DatabaseWithOperation,
  NodeDesiredPage,
  newOperationId,
} from "@pgcf/contracts";
import { FleetRelease } from "@pgcf/contracts/releases";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keyring } from "../../src/crypto/keyring.ts";
import type { Env } from "../../src/env.ts";
import { fenceOperation } from "../../src/domain/node-desired.ts";
import {
  credentialsRevision,
  nodeRouteKeyring,
} from "../../src/domain/node-credentials.ts";
import {
  HOST_FILES,
  assignRelease,
  cleanupFixtures,
  fixture,
  grantCredential,
  nodePolicy,
  nodeRequest,
  report,
  reportBody,
  request,
  served,
  setNodePolicy,
} from "./fixtures.ts";

afterEach(cleanupFixtures);

/** A key pair made for these tests; its private half was deleted. */
const SHELL_CA =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDNcY+bgo/xfpIZts7k+ekO/ruRsypcSnZW0qomRI8bp";

type F = Awaited<ReturnType<typeof fixture>>;
async function pull(f: F, query = "") {
  const response = await nodeRequest(f, `/node/v1/desired${query}`);
  expect(response.status).toBe(200);
  return NodeDesiredPage.parse(await response.json());
}
/** The database moves to its second storage generation: a new archive path. */
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

  it("raises the credentials revision once for every change of the operator shell's state, which is how a running node learns it", async () => {
    const f = await fixture();
    await setNodePolicy(f);
    const other = SHELL_CA.replace("AAAAIDNc", "AAAAIDNd");
    const revision = async (bindings: Partial<Env>) => {
      const response = await nodeRequest(f, "/node/v1/desired", { bindings });
      expect(response.status).toBe(200);
      return NodeDesiredPage.parse(await response.json()).credentials_revision;
    };
    const on = { NODE_SHELL_HOSTNAME: "true" };
    // Off is what a node starts with: no change, no new revision.
    expect(await revision({})).toBe(1);
    expect(await revision({ NODE_SSH_USER_CA_PUBLIC_KEY: SHELL_CA })).toBe(1);
    // On with a key, then the same again: one new revision.
    const key = { ...on, NODE_SSH_USER_CA_PUBLIC_KEY: SHELL_CA };
    expect(await revision(key)).toBe(2);
    expect(await revision(key)).toBe(2);
    // Another key, one that is not valid (the hostname stays, the key goes), and off again.
    expect(await revision({ ...on, NODE_SSH_USER_CA_PUBLIC_KEY: other })).toBe(
      3,
    );
    expect(
      await revision({ ...on, NODE_SSH_USER_CA_PUBLIC_KEY: `${other} x` }),
    ).toBe(4);
    expect(await revision({ ...on })).toBe(4);
    expect(await revision({})).toBe(5);
    expect(await revision({})).toBe(5);
    expect(
      await env.DB.prepare(
        "SELECT credentials_revision r FROM nodes WHERE id=?",
      )
        .bind(f.node)
        .first<number>("r"),
    ).toBe(5);
  });

  it("raises the credentials revision once for every change of the route keyring derived for the node, and orders no database to stop", async () => {
    const f = await fixture();
    const db = await served(f);
    const key = () =>
      btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
    const first = JSON.parse(env.ROUTE_MASTER_KEYS) as {
      active: string;
      keys: Record<string, string>;
    };
    const ring = (active: string, keys: Record<string, string>) => ({
      ROUTE_MASTER_KEYS: JSON.stringify({ active, keys }),
    });
    const page = async (bindings: Partial<Env>) => {
      const response = await nodeRequest(f, "/node/v1/desired", { bindings });
      expect(response.status).toBe(200);
      return NodeDesiredPage.parse(await response.json());
    };
    const revision = async (bindings: Partial<Env>) =>
      (await page(bindings)).credentials_revision;
    const second = key();
    // The keyring a node starts with is no change.
    expect(await revision({})).toBe(1);
    expect(await revision(ring(first.active, first.keys))).toBe(1);
    // A rotation, as credentials.md has it: the new key beside the old one, the old one still
    // active; the same keys in another order are the same keyring.
    const both = { ...first.keys, v2: second };
    expect(await revision(ring(first.active, both))).toBe(2);
    expect(await revision(ring(first.active, both))).toBe(2);
    expect(
      await revision(ring(first.active, { v2: second, ...first.keys })),
    ).toBe(2);
    // The new key active, the old one retired, and a key that changes under its own id.
    expect(await revision(ring("v2", both))).toBe(3);
    const retired = await page(ring("v2", { v2: second }));
    expect(retired.credentials_revision).toBe(4);
    const replaced = key();
    expect(await revision(ring("v2", { v2: replaced }))).toBe(5);
    expect(await revision(ring("v2", { v2: replaced }))).toBe(5);
    // No order stops a database: the page orders nothing and the database is still running.
    expect(retired.orders).toEqual([]);
    expect(
      retired.databases.map((database) => [
        database.id,
        database.desired_state,
      ]),
    ).toEqual([[db.id, "running"]]);
    // D1 holds a digest of the keyring and none of its keys.
    const held = (await env.DB.prepare(
      "SELECT route_keyring_state s FROM nodes WHERE id=?",
    )
      .bind(f.node)
      .first<string>("s"))!;
    expect(held).toMatch(/^[0-9a-f]{64}$/);
    expect(held).not.toContain(second);
  });

  it("answers the page of a node when the route keyring cannot be read, and the shell's state still raises the revision", async () => {
    const f = await fixture();
    await setNodePolicy(f);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const revision = async (bindings: Partial<Env>) => {
        const response = await nodeRequest(f, "/node/v1/desired", {
          bindings,
        });
        expect(response.status).toBe(200);
        return NodeDesiredPage.parse(await response.json())
          .credentials_revision;
      };
      expect(await revision({ ROUTE_MASTER_KEYS: "{" })).toBe(1);
      expect(
        await revision({ ROUTE_MASTER_KEYS: "{", NODE_SHELL_HOSTNAME: "true" }),
      ).toBe(2);
      const lines = log.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("node_keyring_unreadable"));
      expect(lines.length).toBeGreaterThan(0);
      expect(JSON.parse(lines[0]!)).toMatchObject({
        event: "node_keyring_unreadable",
        node_id: f.node,
      });
    } finally {
      log.mockRestore();
    }
  });

  it("names the revision at which D1 holds its own state even when the row moved since the node was read", async () => {
    const f = await fixture();
    await setNodePolicy(f);
    const row = {
      id: f.node,
      uid: "",
      credentials_revision: 1,
      shell_state: "off",
      route_keyring_state: null,
    };
    row.uid = (await env.DB.prepare("SELECT node_uid u FROM nodes WHERE id=?")
      .bind(f.node)
      .first<string>("u"))!;
    const other = SHELL_CA.replace("AAAAIDNc", "AAAAIDNd");
    // Another Worker version wrote its state, a key this one does not have, after this one read.
    await env.DB.prepare(
      "UPDATE nodes SET credentials_revision=2,shell_state=? WHERE id=?",
    )
      .bind(`on ${other}`, f.node)
      .run();
    const mine: Env = {
      ...env,
      NODE_SHELL_HOSTNAME: "true",
      NODE_SSH_USER_CA_PUBLIC_KEY: SHELL_CA,
    };
    // The revision 2 names the other key: this version's key needs a revision of its own.
    expect(await credentialsRevision(mine, row, null)).toBe(3);
    const held = () =>
      env.DB.prepare(
        "SELECT credentials_revision r,shell_state s FROM nodes WHERE id=?",
      )
        .bind(f.node)
        .first<{ r: number; s: string }>();
    expect(await held()).toEqual({ r: 3, s: `on ${SHELL_CA}` });
    // A read that finds D1 already holding its state takes that revision and raises nothing.
    expect(await credentialsRevision(mine, row, null)).toBe(3);
    expect(await held()).toEqual({ r: 3, s: `on ${SHELL_CA}` });
    // The same for the keyring: another version recorded its own, and a version with another
    // raises the revision once, whatever the row it read said.
    const digests = () =>
      env.DB.prepare(
        "SELECT credentials_revision r,route_keyring_state k FROM nodes WHERE id=?",
      )
        .bind(f.node)
        .first<{ r: number; k: string | null }>();
    await env.DB.prepare("UPDATE nodes SET route_keyring_state=? WHERE id=?")
      .bind("a".repeat(64), f.node)
      .run();
    const keyring = await nodeRouteKeyring(env, f.node);
    expect(await credentialsRevision(mine, row, keyring)).toBe(4);
    const recorded = await digests();
    expect(recorded?.r).toBe(4);
    expect(recorded?.k).toMatch(/^[0-9a-f]{64}$/);
    expect(recorded?.k).not.toBe("a".repeat(64));
    expect(await credentialsRevision(mine, row, keyring)).toBe(4);
  });

  it("leaves the credentials revision of a fenced node alone", async () => {
    const f = await fixture();
    await setNodePolicy(f);
    await env.DB.prepare(
      "UPDATE nodes SET lost_at=?,lost_reason='test' WHERE id=?",
    )
      .bind(new Date().toISOString(), f.node)
      .run();
    const response = await nodeRequest(f, "/node/v1/desired", {
      bindings: {
        NODE_SHELL_HOSTNAME: "true",
        NODE_SSH_USER_CA_PUBLIC_KEY: SHELL_CA,
      },
    });
    expect(response.status).toBe(200);
    expect(
      NodeDesiredPage.parse(await response.json()).credentials_revision,
    ).toBe(1);
  });

  it("names a database with the credential it issues, its class resources, roles and archive", async () => {
    const f = await fixture();
    await setNodePolicy(f);
    const created = DatabaseWithOperation.parse(
      await (await f.create("page")).json(),
    );
    const id = created.database.id;
    const database = (await entry(f, id))!;
    const credential = database.archive.credential;
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

  it("issues the credential of a database on the first pull, names it again while it is young and renews it after a third of its life", async () => {
    const f = await fixture();
    const db = await served(f);
    const stored = (access = "read_write") =>
      env.DB.prepare(
        "SELECT id,node_id,access,archive_path FROM archive_credentials WHERE database_id=? AND access=? ORDER BY issued_at,id",
      )
        .bind(db.id, access)
        .all();
    expect((await stored()).results).toEqual([]);
    const first = (await entry(f, db.id))!.archive.credential;
    const path = (await env.DB.prepare(
      "SELECT archive_path FROM databases WHERE id=?",
    )
      .bind(db.id)
      .first<string>("archive_path"))!;
    expect((await stored()).results).toEqual([
      {
        id: first.id,
        node_id: f.node,
        access: "read_write",
        archive_path: path,
      },
    ]);
    expect(Date.parse(first.expires_at)).toBeGreaterThan(
      Date.now() + 6 * 86_400_000,
    );
    // Young: the same credential, nothing new issued.
    expect((await entry(f, db.id))!.archive.credential).toEqual(first);
    expect((await stored()).results).toHaveLength(1);
    // Past a third of its life: a new one is named, and the old one stays valid until it expires.
    await env.DB.prepare(
      "UPDATE archive_credentials SET issued_at=? WHERE id=?",
    )
      .bind(new Date(Date.now() - 3 * 86_400_000).toISOString(), first.id)
      .run();
    const renewed = (await entry(f, db.id))!.archive.credential;
    expect(renewed.id).not.toBe(first.id);
    expect((await stored()).results).toHaveLength(2);
    // An expired credential is never named.
    await env.DB.prepare(
      "UPDATE archive_credentials SET issued_at=?,expires_at=? WHERE database_id=?",
    )
      .bind(
        new Date(Date.now() - 9 * 86_400_000).toISOString(),
        new Date(Date.now() - 1000).toISOString(),
        db.id,
      )
      .run();
    const again = (await entry(f, db.id))!.archive.credential;
    expect([first.id, renewed.id]).not.toContain(again.id);
    expect(Date.parse(again.expires_at)).toBeGreaterThan(Date.now());
  });

  it("names a write credential for the database's archive although a read-only one exists for it", async () => {
    const f = await fixture();
    const db = await served(f);
    const read = await grantCredential(db.id, { access: "read_only" });
    const write = (await entry(f, db.id))!.archive.credential;
    expect(write.id).not.toBe(read.id);
    expect(
      await env.DB.prepare("SELECT access FROM archive_credentials WHERE id=?")
        .bind(write.id)
        .first<string>("access"),
    ).toBe("read_write");
  });

  it("keeps a deleted database on the page with a credential", async () => {
    const f = await fixture();
    const db = await served(f);
    const written = await grantCredential(db.id, {
      lifetimeMs: 60_000,
      issuedAgoMs: 30 * 86_400_000,
    });
    expect(
      (await request(`/v1/databases/${db.id}`, f.integrator, "DELETE")).status,
    ).toBe(202);
    const deleted = (await entry(f, db.id))!;
    expect(deleted.desired_state).toBe("deleted");
    expect(deleted.roles).toEqual([]);
    expect(deleted.archive.credential.id).not.toBe(written.id);
  });

  it("reads the credentials of a whole page in one query and writes the missing ones together", async () => {
    const f = await fixture();
    for (const name of ["one", "two", "three"]) await served(f, name);
    const prototype = Object.getPrototypeOf(env.DB),
      prepare = prototype.prepare;
    const counted = async () => {
      const queries: string[] = [];
      const spy = vi.spyOn(prototype, "prepare").mockImplementation(function (
        this: D1Database,
        ...args: unknown[]
      ) {
        queries.push(String(args[0]));
        return prepare.apply(this, args);
      });
      try {
        expect((await pull(f)).databases).toHaveLength(3);
      } finally {
        spy.mockRestore();
      }
      return {
        reads: queries.filter((q) =>
          /^\s*SELECT[^]*FROM archive_credentials/.test(q),
        ).length,
        writes: queries.filter((q) =>
          q.includes("INSERT INTO archive_credentials"),
        ).length,
      };
    };
    expect(await counted()).toEqual({ reads: 1, writes: 3 });
    expect(await counted()).toEqual({ reads: 1, writes: 0 });
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
      // The release id is also the image version the node enrolled as.
      os: { image_version: id, debian_snapshot: "20261015T000000Z" },
    });
    expect(Object.keys(page.release!.binaries)).toEqual([
      "pgcf-agent",
      "pgcf-native-gateway",
      "pgcf-archive",
      "pgcf-wal-fetch",
    ]);
    // The image only installs a node; no node reads it. Its four facts are on the page, because
    // the release key signs them with the rest of the release and the agent builds that text from
    // its page, and its URL and format are not.
    const { spec } = FleetRelease.parse(
      await (await request(`/v1/fleet/releases/${id}`, f.admin)).json(),
    );
    expect(page.release!.image).toEqual({
      sha256: spec.image.sha256,
      size_bytes: spec.image.size_bytes,
      raw_sha256: spec.image.raw_sha256,
      raw_bytes: spec.image.raw_bytes,
    });
    expect(JSON.stringify(page)).not.toContain("raw.zst");
    // The host files are on the page, to be signed over and written, and what a node is expected
    // to report back of them is not: that stays with the API, as the packages' digest does.
    expect(page.release!.os.host_files).toEqual(HOST_FILES);
    expect(JSON.stringify(page)).not.toContain("host_files_sha256");
    expect(JSON.stringify(page)).not.toContain("https://releases.invalid/host");
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

  it("lists the open orders that have no other row, and drops them as their results are reported", async () => {
    const f = await fixture();
    const db = await served(f);
    const move = newOperationId(),
      superseded = newOperationId(),
      maintenance = newOperationId(),
      closed = newOperationId();
    const now = new Date().toISOString(),
      later = (milliseconds: number) =>
        new Date(Date.parse(now) + milliseconds).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO lifecycle_orders(operation,node_id,type,database_id,storage_generation,remove_volume,created_at) VALUES(?,?,'move',?,1,0,?)",
      ).bind(move, f.node, db.id, now),
      env.DB.prepare(
        "INSERT INTO lifecycle_orders(operation,node_id,type,database_id,storage_generation,remove_volume,created_at) VALUES(?,?,'superseded',?,0+1,1,?)",
      ).bind(superseded, f.node, db.id, later(1)),
      env.DB.prepare(
        "INSERT INTO lifecycle_orders(operation,node_id,type,created_at) VALUES(?,?,'maintenance',?)",
      ).bind(maintenance, f.node, later(2)),
      env.DB.prepare(
        "INSERT INTO lifecycle_orders(operation,node_id,type,created_at,closed_at,result_status) VALUES(?,?,'maintenance',?,?,'done')",
      ).bind(closed, f.node, now, now),
    ]);
    // A retired generation of a database the page still serves must be an older one.
    await nextStorage(db.id);
    const open = [
      { type: "move", operation: move, database: db.id, storage_generation: 1 },
      { type: "maintenance", operation: maintenance },
      {
        type: "superseded",
        operation: superseded,
        database: db.id,
        storage_generation: 1,
        remove_volume: true,
      },
    ];
    expect((await pull(f)).orders).toEqual(open);
    // The node reports the results. A maintenance cycle and a retired generation end with theirs;
    // a move ends with the move, which closes its order itself.
    const reported = await nodeRequest(f, "/node/v1/observations", {
      method: "POST",
      body: reportBody(
        [],
        [move, superseded, maintenance].map((operation) => ({
          operation,
          status: "done",
        })),
      ),
    });
    expect(await reported.json()).toEqual({ databases: [], orders: 3 });
    expect((await pull(f)).orders).toEqual([open[0]]);
    await env.DB.prepare(
      "UPDATE lifecycle_orders SET closed_at=? WHERE operation=?",
    )
      .bind(now, move)
      .run();
    expect((await pull(f)).orders).toEqual([]);
  });

  it("holds the fence, the retired generations and nothing else for a node declared lost", async () => {
    const f = await fixture();
    const db = await served(f);
    await assignRelease(f);
    const superseded = newOperationId();
    await env.DB.prepare(
      "INSERT INTO lifecycle_orders(operation,node_id,type,database_id,storage_generation,remove_volume,created_at) VALUES(?,?,'superseded',?,1,0,?)",
    )
      .bind(superseded, f.node, db.id, new Date().toISOString())
      .run();
    await env.DB.prepare(
      "INSERT INTO lifecycle_orders(operation,node_id,type,created_at) VALUES(?,?,'maintenance',?)",
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
    const origin = (await entry(f, target.id))!.origin as {
      kind: "restore";
      source: { credential: { id: string; expires_at: string } };
    };
    expect(origin).toEqual({
      kind: "restore",
      source: {
        database_id: source.id,
        path: sourcePath,
        backup_id: "20261017T110000",
        target_time: "2026-10-17T11:30:00.000Z",
        credential: origin.source.credential,
      },
    });
    // The page issued it: read-only, for the source's archive, to this node.
    expect(
      await env.DB.prepare(
        "SELECT node_id,access,archive_path FROM archive_credentials WHERE id=?",
      )
        .bind(origin.source.credential.id)
        .first(),
    ).toEqual({
      node_id: f.node,
      access: "read_only",
      archive_path: sourcePath,
    });
    await env.DB.prepare(
      "UPDATE database_restores SET verified_at=? WHERE target_database_id=?",
    )
      .bind(now, target.id)
      .run();
    expect((await entry(f, target.id))!.origin).toBeUndefined();
  });

  it("leaves out a restore whose source archive lies in another region, which this node holds no credential for", async () => {
    const f = await fixture();
    const source = await served(f, "source");
    const target = await served(f, "target");
    const operation = newOperationId(),
      now = new Date().toISOString();
    const foreignPath = (await env.DB.prepare(
      "SELECT archive_path FROM databases WHERE id=?",
    )
      .bind(source.id)
      .first<string>("archive_path"))!.replace(
      `/${f.region}/`,
      `/${f.foreign}/`,
    );
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at) SELECT ?,'database.restore','pending',project_id,id,1,?,? FROM databases WHERE id=?",
      ).bind(operation, now, now, target.id),
      env.DB.prepare(
        "INSERT INTO database_restores(target_database_id,operation_id,source_database_id,source_archive_path,source_storage_generation,backup_id,created_at) VALUES(?,?,?,?,1,?,?)",
      ).bind(
        target.id,
        operation,
        source.id,
        foreignPath,
        "20261017T110000",
        now,
      ),
    ]);
    expect(await entry(f, target.id)).toBeUndefined();
    expect(await entry(f, source.id)).toBeDefined();
  });
});
