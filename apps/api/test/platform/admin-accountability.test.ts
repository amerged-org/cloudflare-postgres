// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  ADMIN_KEY_DEFAULT_LIFETIME_DAYS,
  ADMIN_KEY_MAX_LIFETIME_DAYS,
  AUDIT_RETENTION_DAYS,
  ApiKeyCreated,
  AuditEvent,
  ErrorBody,
  hashApiKey,
  listEnvelope,
  newApiKey,
  newApiKeyId,
} from "@pgcf/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupFixtures, fixture, request } from "../domain/fixtures.ts";

const DAY = 86_400_000;
const AuditPage = listEnvelope(AuditEvent);
type F = Awaited<ReturnType<typeof fixture>>;

/** A key made through the API, named so that the cleanup finds it. */
async function mint(key: string, body: Record<string, unknown>) {
  const response = await request("/v1/api-keys", key, "POST", {
    name: "acct-key",
    ...body,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return ApiKeyCreated.parse(await response.json());
}
const auditRows = () =>
  env.DB.prepare("SELECT * FROM audit_events ORDER BY rowid").all<
    Record<string, unknown>
  >();
const rowsOf = async () => (await auditRows()).results;
const keyIdOf = (key: string) =>
  env.DB.prepare("SELECT id FROM api_keys WHERE lookup_id=?")
    .bind(key.split("_")[2])
    .first<string>("id");
const code = async (response: Response) =>
  ErrorBody.parse(await response.json()).error.code;
const count = (table: string) =>
  env.DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first<number>("n");
const size = {
  memory_mib: 512,
  cpu_millicores: 500,
  storage_gib: 5,
  max_connections: 50,
  sleep_after_seconds: null,
  archive_timeout_seconds: 300,
  backup_retention_days: 7,
  enabled: true,
};

afterEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DROP TRIGGER IF EXISTS audit_refuses_insert"),
    env.DB.prepare("DROP TRIGGER IF EXISTS audit_refuses_update"),
    env.DB.prepare("DROP TRIGGER IF EXISTS audit_refuses_delete"),
    env.DB.prepare("DELETE FROM audit_events"),
    env.DB.prepare(
      "DELETE FROM idempotency_keys WHERE api_key_id IN (SELECT id FROM api_keys WHERE name GLOB 'acct-*')",
    ),
    env.DB.prepare("DELETE FROM api_keys WHERE name GLOB 'acct-*'"),
    env.DB.prepare("DELETE FROM projects WHERE name GLOB 'acct-*'"),
    env.DB.prepare("DELETE FROM size_classes WHERE id='acct-size'"),
  ]);
  await cleanupFixtures();
});

describe("a read-only administrator key", () => {
  it("reads operational data and changes nothing", async () => {
    const f = await fixture();
    const reader = await mint(f.admin, { scope: "admin_read" });
    expect(reader.api_key).toMatchObject({
      scope: "admin_read",
      project_id: null,
    });
    for (const path of [
      "/v1/nodes",
      `/v1/nodes/${f.node}`,
      `/v1/nodes/${f.node}/diagnostics`,
      "/v1/operational-health?scope=regions",
      "/v1/api-keys",
      "/v1/audit-events",
      "/v1/fleet/releases",
    ])
      expect((await request(path, reader.key)).status, `GET ${path}`).toBe(200);
    // The administrator's view of the regions, not the integrator's placement list.
    const regions = await request("/v1/regions", reader.key);
    expect(regions.status).toBe(200);
    const listed = (await regions.json<{ data: Record<string, unknown>[] }>())
      .data;
    expect(listed.length).toBeGreaterThan(0);
    for (const region of listed) expect(region).toHaveProperty("gateway_url");

    const before = {
      projects: await count("projects"),
      keys: await count("api_keys"),
      databases: await count("databases"),
    };
    const adminId = await keyIdOf(f.admin);
    const attempts: [string, string, unknown][] = [
      ["POST", "/v1/projects", { name: "acct-project" }],
      ["POST", "/v1/api-keys", { name: "acct-key", scope: "admin" }],
      ["DELETE", `/v1/api-keys/${adminId}`, undefined],
      ["PUT", "/v1/size-classes/acct-size", size],
      [
        "POST",
        "/v1/databases",
        {
          project_id: f.project,
          region_id: f.region,
          name: "acct-database",
          size_class_id: f.size,
        },
      ],
      [
        "POST",
        `/v1/nodes/${f.node}/mark-lost`,
        { expected_node_uid: f.nodeUid, reason: "acct" },
      ],
      // Reading a probe's answer is allowed to this key; asking for one is a change.
      ["POST", `/v1/nodes/${f.node}/diagnostics`, { probe: "pool" }],
    ];
    for (const [method, path, body] of attempts) {
      const response = await request(path, reader.key, method, body);
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await code(response)).toBe("forbidden");
    }
    expect({
      projects: await count("projects"),
      keys: await count("api_keys"),
      databases: await count("databases"),
    }).toEqual(before);
    expect(
      await env.DB.prepare("SELECT lost_at FROM nodes WHERE id=?")
        .bind(f.node)
        .first("lost_at"),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT revoked_at FROM api_keys WHERE lookup_id=?")
        .bind(f.admin.split("_")[2])
        .first("revoked_at"),
    ).toBeNull();
  });

  it("is not an integrator key and an integrator key is not an administrator", async () => {
    const f = await fixture();
    expect((await request("/v1/audit-events", f.integrator)).status).toBe(403);
    expect((await request("/v1/audit-events", f.admin)).status).toBe(200);
    expect((await request("/v1/audit-events", newApiKey().key)).status).toBe(
      401,
    );
  });
});

describe("key expiry", () => {
  it("gives an administrator key 90 days unless told otherwise and an integrator key none", async () => {
    const f = await fixture();
    const near = (value: string | null, days: number) =>
      Math.abs(Date.parse(value!) - (Date.now() + days * DAY)) < 60_000;
    expect(ADMIN_KEY_DEFAULT_LIFETIME_DAYS).toBe(90);
    const admin = await mint(f.admin, { scope: "admin" });
    expect(near(admin.api_key.expires_at, 90)).toBe(true);
    const reader = await mint(f.admin, { scope: "admin_read" });
    expect(near(reader.api_key.expires_at, 90)).toBe(true);
    const integrator = await mint(f.admin, {
      scope: "integrator",
      project_id: f.project,
    });
    expect(integrator.api_key.expires_at).toBeNull();
    const chosen = new Date(Date.now() + 30 * DAY).toISOString();
    const short = await mint(f.admin, { scope: "admin", expires_at: chosen });
    expect(short.api_key.expires_at).toBe(chosen);
    // An integrator may pick any later time; the list shows every key's expiry.
    const far = new Date(Date.now() + 1000 * DAY).toISOString();
    expect(
      (
        await mint(f.admin, {
          scope: "integrator",
          project_id: f.project,
          expires_at: far,
        })
      ).api_key.expires_at,
    ).toBe(far);
    const listed = await request("/v1/api-keys?limit=100", f.admin);
    const rows = (await listed.json<{ data: Record<string, unknown>[] }>())
      .data;
    expect(rows.find((row) => row.id === short.api_key.id)).toMatchObject({
      expires_at: chosen,
    });
  });

  it("refuses an expiry that is past, or too far for an administrator key", async () => {
    const f = await fixture();
    expect(ADMIN_KEY_MAX_LIFETIME_DAYS).toBe(366);
    for (const [expires_at, scope] of [
      [new Date(Date.now() - 1000).toISOString(), "admin"],
      [new Date(Date.now() - 1000).toISOString(), "integrator"],
      [new Date(Date.now() + 367 * DAY).toISOString(), "admin"],
      [new Date(Date.now() + 367 * DAY).toISOString(), "admin_read"],
    ] as const) {
      const response = await request("/v1/api-keys", f.admin, "POST", {
        name: "acct-key",
        scope,
        ...(scope === "integrator" ? { project_id: f.project } : {}),
        expires_at,
      });
      expect(response.status, `${scope} ${expires_at}`).toBe(400);
    }
    expect(await count("api_keys")).toBe(3);
  });

  it("refuses an expired key like an unknown one", async () => {
    const f = await fixture();
    const soon = await mint(f.admin, {
      scope: "admin",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect((await request("/v1/nodes", soon.key)).status).toBe(200);
    await env.DB.prepare("UPDATE api_keys SET expires_at=? WHERE id=?")
      .bind(new Date(Date.now() - 1000).toISOString(), soon.api_key.id)
      .run();
    const refused = await request("/v1/nodes", soon.key);
    expect(refused.status).toBe(401);
    expect(await code(refused)).toBe("unauthorized");
    const integrator = await mint(f.admin, {
      scope: "integrator",
      project_id: f.project,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect((await request("/v1/projects", integrator.key)).status).toBe(200);
    await env.DB.prepare("UPDATE api_keys SET expires_at=? WHERE id=?")
      .bind(new Date(Date.now() - 1000).toISOString(), integrator.api_key.id)
      .run();
    expect((await request("/v1/projects", integrator.key)).status).toBe(401);
  });
});

describe("the audit log", () => {
  it("records what an administrator key asked for, never what it sent", async () => {
    const f = await fixture();
    const keyId = (await keyIdOf(f.admin))!;
    const created = await request(
      "/v1/projects",
      f.admin,
      "POST",
      { name: "acct-secret-project-name" },
      undefined,
      { "X-Request-Id": "audit-request-1" },
    );
    expect(created.status).toBe(201);
    const victim = await mint(f.admin, { scope: "admin" });
    const revoked = await request(
      `/v1/api-keys/${victim.api_key.id}`,
      f.admin,
      "DELETE",
    );
    expect(revoked.status).toBe(204);
    expect((await request("/v1/nodes", f.admin)).status).toBe(200);
    // Authenticated, then refused for the body: the outcome is the refusal, not 2xx.
    const missing = await request("/v1/api-keys", f.admin, "POST", {
      name: "acct-key",
      scope: "integrator",
      project_id: "prj_aaaaaaaaaaaaaaaaaaaa",
    });
    expect(missing.status).toBe(404);

    const rows = await rowsOf();
    expect(
      rows.map((row) => [row.method, row.route, row.status, row.scope]),
    ).toEqual([
      ["POST", "/v1/projects", 201, "admin"],
      ["POST", "/v1/api-keys", 201, "admin"],
      ["DELETE", "/v1/api-keys/{id}", 204, "admin"],
      ["POST", "/v1/api-keys", 404, "admin"],
    ]);
    expect(rows[0]).toMatchObject({
      key_id: keyId,
      request_id: "audit-request-1",
    });
    expect(Object.keys(rows[0]!).sort()).toEqual([
      "created_at",
      "id",
      "key_id",
      "method",
      "request_id",
      "route",
      "scope",
      "status",
    ]);
    // No body, no concrete path, no key material, no address.
    const text = JSON.stringify(rows);
    for (const secret of [
      "acct-secret-project-name",
      victim.api_key.id,
      victim.key,
      f.admin,
      f.admin.split("_")[2]!,
    ])
      expect(text).not.toContain(secret);
  });

  it("records the write a read-only key was refused", async () => {
    const f = await fixture();
    const reader = await mint(f.admin, { scope: "admin_read" });
    await env.DB.prepare("DELETE FROM audit_events").run();
    const refused = await request("/v1/projects", reader.key, "POST", {
      name: "acct-x",
    });
    expect(refused.status).toBe(403);
    expect(
      (await rowsOf()).map((row) => [
        row.key_id,
        row.scope,
        row.method,
        row.route,
        row.status,
      ]),
    ).toEqual([[reader.api_key.id, "admin_read", "POST", "/v1/projects", 403]]);
  });

  it("records an administrator key that was refused with its real secret, and nothing for any other refused key", async () => {
    const f = await fixture();
    const revoked = await mint(f.admin, { scope: "admin" });
    await request(`/v1/api-keys/${revoked.api_key.id}`, f.admin, "DELETE");
    const expired = await mint(f.admin, { scope: "admin" });
    await env.DB.prepare("UPDATE api_keys SET expires_at=? WHERE id=?")
      .bind(new Date(Date.now() - 1000).toISOString(), expired.api_key.id)
      .run();
    // The lookup identifier is in every key string and listed to every admin_read holder, so it is
    // not a secret: a request that only knows it must not be able to write a row.
    const wrongSecret = `${f.admin.slice(0, "pgcf_sk_".length + 12 + 1)}${newApiKey().key.slice(-43)}`;
    const integrator = await mint(f.admin, {
      scope: "integrator",
      project_id: f.project,
    });
    await request(`/v1/api-keys/${integrator.api_key.id}`, f.admin, "DELETE");
    await env.DB.prepare("DELETE FROM audit_events").run();

    for (const key of [revoked.key, expired.key, wrongSecret])
      expect((await request("/v1/nodes", key)).status).toBe(401);
    // A wrong secret (above), a lookup identifier that names no row and an integrator's key leave no row.
    expect((await request("/v1/nodes", newApiKey().key)).status).toBe(401);
    expect((await request("/v1/projects", integrator.key)).status).toBe(401);

    expect(
      (await rowsOf()).map((row) => [
        row.key_id,
        row.scope,
        row.method,
        row.route,
        row.status,
      ]),
    ).toEqual([
      [revoked.api_key.id, "admin", "GET", "/v1/nodes", 401],
      [expired.api_key.id, "admin", "GET", "/v1/nodes", 401],
    ]);
  });

  it("fails closed: a state-changing request whose audit row cannot be written does not run", async () => {
    const f = await fixture();
    // Made before the log is taken away: it takes writes of its own.
    const revoked = await mint(f.admin, { scope: "admin" });
    await request(`/v1/api-keys/${revoked.api_key.id}`, f.admin, "DELETE");
    const rowsBefore = (await count("audit_events")) ?? 0;
    await env.DB.prepare(
      "CREATE TRIGGER audit_refuses_insert BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_unavailable'); END",
    ).run();
    const before = await count("projects");
    const refused = await request("/v1/projects", f.admin, "POST", {
      name: "acct-not-created",
    });
    expect(refused.status).toBe(500);
    expect(await code(refused)).toBe("internal");
    expect(await count("projects")).toBe(before);
    // Reading and being refused do not depend on the log. The revoked key has its real secret, so
    // its refusal is one that is recorded, and the insert of that row fails: the answer is still 401.
    expect((await request("/v1/nodes", f.admin)).status).toBe(200);
    const stale = await request("/v1/nodes", revoked.key);
    expect(stale.status).toBe(401);
    expect(await code(stale)).toBe("unauthorized");
    expect((await request("/v1/nodes", newApiKey().key)).status).toBe(401);
    expect(await count("audit_events")).toBe(rowsBefore);
    // The log is back: the same request runs and is recorded.
    await env.DB.prepare("DROP TRIGGER audit_refuses_insert").run();
    const created = await request("/v1/projects", f.admin, "POST", {
      name: "acct-created",
    });
    expect(created.status).toBe(201);
    expect(await count("audit_events")).toBe(rowsBefore + 1);
  });

  it("does not claim an outcome it could not record, and does not undo the change", async () => {
    const f = await fixture();
    await env.DB.prepare(
      "CREATE TRIGGER audit_refuses_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_unavailable'); END",
    ).run();
    const created = await request("/v1/projects", f.admin, "POST", {
      name: "acct-created",
    });
    expect(created.status).toBe(201);
    const rows = await rowsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ route: "/v1/projects", status: null });
  });

  it("lists newest first with a cursor, for administrator keys only", async () => {
    const f = await fixture();
    const keyId = (await keyIdOf(f.admin))!;
    const reader = await mint(f.admin, { scope: "admin_read" });
    await env.DB.prepare("DELETE FROM audit_events").run();
    const at = (minutes: number) =>
      new Date(Date.UTC(2030, 0, 1, 9, minutes)).toISOString();
    await env.DB.batch(
      [1, 2, 3].map((minute) =>
        env.DB.prepare(
          `INSERT INTO audit_events(id,key_id,scope,method,route,status,request_id,created_at)
           VALUES(?,?,'admin','POST',?,?,?,?)`,
        ).bind(
          crypto.randomUUID(),
          keyId,
          `/v1/example-${minute}`,
          minute === 3 ? null : 200,
          `request-${minute}`,
          at(minute),
        ),
      ),
    );
    const first = await request("/v1/audit-events?limit=2", reader.key);
    expect(first.status).toBe(200);
    const page = AuditPage.parse(await first.json());
    expect(page.data.map((event) => event.route)).toEqual([
      "/v1/example-3",
      "/v1/example-2",
    ]);
    expect(page.data[0]).toMatchObject({
      key_id: keyId,
      scope: "admin",
      method: "POST",
      status: null,
      request_id: "request-3",
      created_at: at(3),
    });
    expect(page.next_cursor).toBeTruthy();
    const second = AuditPage.parse(
      await (
        await request(
          `/v1/audit-events?limit=2&cursor=${page.next_cursor}`,
          f.admin,
        )
      ).json(),
    );
    expect(second.data.map((event) => event.route)).toEqual(["/v1/example-1"]);
    expect(second.next_cursor).toBeNull();
    expect((await request("/v1/audit-events?limit=0", f.admin)).status).toBe(
      400,
    );
    expect(
      (await request("/v1/audit-events?cursor=garbage", f.admin)).status,
    ).toBe(400);
    // Listing is a read: it adds no row.
    expect(await count("audit_events")).toBe(3);
  });

  /** Two events, one of each age, written for the key of the fixture's administrator. */
  async function aged(f: F) {
    const keyId = (await keyIdOf(f.admin))!;
    const now = Date.now();
    await env.DB.batch(
      [
        ["old", 91],
        ["recent", 89],
      ].map(([name, days]) =>
        env.DB.prepare(
          `INSERT INTO audit_events(id,key_id,scope,method,route,status,request_id,created_at)
           VALUES(?,?,'admin','POST',?,200,'r',?)`,
        ).bind(
          crypto.randomUUID(),
          keyId,
          `/v1/${name}`,
          new Date(now - Number(days) * DAY).toISOString(),
        ),
      ),
    );
  }

  it("keeps an event 90 days: an older one is never listed, and the next change deletes it", async () => {
    const f = await fixture();
    expect(AUDIT_RETENTION_DAYS).toBe(90);
    await aged(f);
    const listed = AuditPage.parse(
      await (await request("/v1/audit-events", f.admin)).json(),
    );
    expect(listed.data.map((event) => event.route)).toEqual(["/v1/recent"]);
    // Reading deletes nothing.
    expect(await count("audit_events")).toBe(2);
    const created = await request("/v1/projects", f.admin, "POST", {
      name: "acct-prunes",
    });
    expect(created.status).toBe(201);
    expect((await rowsOf()).map((row) => row.route)).toEqual([
      "/v1/recent",
      "/v1/projects",
    ]);
  });

  it("does not let a failed deletion of old events stop the change that asked", async () => {
    const f = await fixture();
    await aged(f);
    await env.DB.prepare(
      "CREATE TRIGGER audit_refuses_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_unavailable'); END",
    ).run();
    try {
      const created = await request("/v1/projects", f.admin, "POST", {
        name: "acct-prunes",
      });
      expect(created.status).toBe(201);
      expect(await count("audit_events")).toBe(3);
    } finally {
      await env.DB.prepare("DROP TRIGGER audit_refuses_delete").run();
    }
  });
});

describe("the key table after its rebuild", () => {
  it("keeps the foreign key of idempotency records and the uniqueness of keys", async () => {
    const f = await fixture();
    const keyId = (await keyIdOf(f.admin))!;
    await expect(
      env.DB.prepare(
        "INSERT INTO idempotency_keys(api_key_id,key,request_hash,state,created_at) VALUES (?,?,?,'in_progress',?)",
      )
        .bind(newApiKeyId(), "orphan", "0".repeat(64), new Date().toISOString())
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);
    const duplicate = env.DB.prepare(
      "INSERT INTO api_keys(id,lookup_id,key_hash,scope,project_id,name,created_at) VALUES (?,?,?,?,NULL,?,?)",
    ).bind(
      newApiKeyId(),
      f.admin.split("_")[2],
      await hashApiKey(env.API_KEY_PEPPER, newApiKey().key),
      "admin_read",
      "acct-duplicate",
      new Date().toISOString(),
    );
    await expect(duplicate.run()).rejects.toThrow(/UNIQUE/);
    expect(keyId).toBeTruthy();
    // A project is for integrators only, the scopes are the three named ones.
    await expect(
      env.DB.prepare(
        "INSERT INTO api_keys(id,lookup_id,key_hash,scope,project_id,name,created_at) VALUES (?,?,?,?,?,?,?)",
      )
        .bind(
          newApiKeyId(),
          newApiKey().lookupId,
          await hashApiKey(env.API_KEY_PEPPER, newApiKey().key),
          "admin_read",
          f.project,
          "acct-bound",
          new Date().toISOString(),
        )
        .run(),
    ).rejects.toThrow(/CHECK/);
    await expect(
      env.DB.prepare(
        "INSERT INTO api_keys(id,lookup_id,key_hash,scope,project_id,name,created_at) VALUES (?,?,?,?,NULL,?,?)",
      )
        .bind(
          newApiKeyId(),
          newApiKey().lookupId,
          await hashApiKey(env.API_KEY_PEPPER, newApiKey().key),
          "root",
          "acct-root",
          new Date().toISOString(),
        )
        .run(),
    ).rejects.toThrow(/CHECK/);
  });
});
