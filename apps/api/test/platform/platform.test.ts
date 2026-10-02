// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  ApiKeyCreated,
  ErrorBody,
  Project,
  RegionCreated,
  RolePassword,
  bytesToBase64url,
  hashApiKey,
  newApiKey,
  newDatabaseId,
  newNodeId,
  newProjectId,
  newRolePassword,
  type ApiKeyCreate,
  type Project as ProjectView,
} from "@pgcf/contracts";
import {
  deriveRegionKeyring,
  parseRouteKeyring,
  serializeRouteKeyring,
} from "@pgcf/contracts/route-token";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { keyring } from "../../src/crypto/keyring.ts";
import {
  purgeIdempotency,
  withIdempotency,
} from "../../src/middleware/idempotency.ts";

const origin = () => `https://${["api", "invalid"].join(".")}`;
const url = (prefix: string) => `https://${[prefix, "invalid"].join(".")}`;
const app = () => createApp();
function request(
  path: string,
  key?: string,
  method = "GET",
  body?: unknown,
  idempotency?: string,
): Request {
  const headers = new Headers();
  if (key) headers.set("Authorization", `Bearer ${key}`);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (idempotency) headers.set("Idempotency-Key", idempotency);
  return new Request(new URL(path, origin()), {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function bootstrap() {
  const response = await app().fetch(
    request("/v1/api-keys", env.BOOTSTRAP_TOKEN, "POST", {
      name: "bootstrap",
      scope: "admin",
    }),
    env,
  );
  expect(response.status).toBe(201);
  return ApiKeyCreated.parse(await response.json());
}
async function project(key: string, name = "project") {
  const response = await app().fetch(
    request("/v1/projects", key, "POST", { name }),
    env,
  );
  expect(response.status).toBe(201);
  return Project.parse(await response.json());
}
async function createKey(key: string, body: ApiKeyCreate) {
  const response = await app().fetch(
    request("/v1/api-keys", key, "POST", body),
    env,
  );
  expect(response.status).toBe(201);
  return ApiKeyCreated.parse(await response.json());
}
function regionBody() {
  return {
    id: "region-test",
    provider: "contabo",
    provider_region: "test",
    gateway_url: url("gateway"),
    backup_bucket: `backup-${crypto.randomUUID()}`,
    backup_endpoint_url: url("archive"),
  };
}
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

async function errorCode(response: Response): Promise<string> {
  return ErrorBody.parse(await response.json()).error.code;
}

describe("API platform on real Workers D1", () => {
  beforeEach(async () => {
    await env.DB.batch(
      [
        "lifecycle_events",
        "operations",
        "roles",
        "databases",
        "nodes",
        "regions",
        "idempotency_keys",
        "api_keys",
        "size_classes",
        "projects",
      ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
    );
  });
  it("guards concurrent bootstrap with exactly one real admin row", async () => {
    const worker = app();
    const responses = await Promise.all([
      worker.fetch(
        request("/v1/api-keys", env.BOOTSTRAP_TOKEN, "POST", {
          name: "first",
          scope: "admin",
        }),
        env,
      ),
      worker.fetch(
        request("/v1/api-keys", env.BOOTSTRAP_TOKEN, "POST", {
          name: "second",
          scope: "admin",
        }),
        env,
      ),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 401,
    ]);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM api_keys",
    ).first("count");
    expect(count).toBe(1);
    const winner = ApiKeyCreated.parse(
      await responses.find((response) => response.status === 201)!.json(),
    );
    const stored = await env.DB.prepare(
      "SELECT key_hash, lookup_id FROM api_keys WHERE id = ?",
    )
      .bind(winner.api_key.id)
      .first<{ key_hash: string; lookup_id: string }>();
    expect(stored!.key_hash).toBe(
      await hashApiKey(env.API_KEY_PEPPER, winner.key),
    );
    expect(stored!.key_hash).not.toContain(winner.key);
    expect(winner.key).toContain(stored!.lookup_id);
    const retried = await worker.fetch(
      request("/v1/api-keys", env.BOOTSTRAP_TOKEN, "POST", {
        name: "first",
        scope: "admin",
      }),
      env,
    );
    expect(retried.status).toBe(401);
    expect(await errorCode(retried)).toBe("unauthorized");
  });

  it("rejects bootstrap of integrator keys and cannot bootstrap again after revocation", async () => {
    const invalid = await app().fetch(
      request("/v1/api-keys", env.BOOTSTRAP_TOKEN, "POST", {
        name: "wrong",
        scope: "integrator",
        project_id: newProjectId(),
      }),
      env,
    );
    expect(invalid.status).toBe(403);
    const admin = await bootstrap();
    expect(
      (
        await app().fetch(
          request(`/v1/api-keys/${admin.api_key.id}`, admin.key, "DELETE"),
          env,
        )
      ).status,
    ).toBe(204);
    const retry = await app().fetch(
      request("/v1/api-keys", env.BOOTSTRAP_TOKEN, "POST", {
        name: "again",
        scope: "admin",
      }),
      env,
    );
    expect(retry.status).toBe(401);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM api_keys").first(
        "count",
      ),
    ).toBe(1);
  });

  it("authenticates hashed keys, rejects unknown, wrong and revoked keys, and records use", async () => {
    const admin = await bootstrap();
    const unknown = newApiKey().key;
    const wrong =
      admin.key.slice(0, admin.key.lastIndexOf("_") + 1) + newRolePassword();
    // Preserve the lookup ID while changing the entire canonical secret.
    const wrongSecret = `${admin.key.slice(0, "pgcf_sk_".length + 12 + 1)}${newRolePassword()}`;
    for (const key of [undefined, unknown, wrong, wrongSecret]) {
      const response = await app().fetch(request("/v1/projects", key), env);
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe("unauthorized");
    }
    expect(
      (await app().fetch(request("/v1/projects", admin.key), env)).status,
    ).toBe(200);
    expect(
      await env.DB.prepare("SELECT last_used_at FROM api_keys WHERE id = ?")
        .bind(admin.api_key.id)
        .first("last_used_at"),
    ).toBeTypeOf("string");
    const extra = await createKey(admin.key, { scope: "admin", name: "extra" });
    expect(
      (
        await app().fetch(
          request(`/v1/api-keys/${extra.api_key.id}`, admin.key, "DELETE"),
          env,
        )
      ).status,
    ).toBe(204);
    expect(
      (await app().fetch(request("/v1/projects", extra.key), env)).status,
    ).toBe(401);
  });

  it("enforces project ownership and admin-only scope on every platform route", async () => {
    const admin = await bootstrap();
    const own = await project(admin.key, "own");
    const other = await project(admin.key, "other");
    const integrator = await createKey(admin.key, {
      scope: "integrator",
      project_id: own.id,
      name: "own",
    });
    const cases: [string, string, unknown, number][] = [
      [`/v1/projects/${other.id}`, "GET", undefined, 404],
      [`/v1/projects/${other.id}`, "DELETE", undefined, 404],
      ["/v1/projects", "POST", { name: "forbidden" }, 403],
      ["/v1/api-keys", "GET", undefined, 403],
      ["/v1/api-keys", "POST", { name: "forbidden", scope: "admin" }, 403],
      [`/v1/api-keys/${admin.api_key.id}`, "DELETE", undefined, 403],
      ["/v1/size-classes/small", "PUT", size, 403],
      ["/v1/regions", "GET", undefined, 403],
      ["/v1/regions", "POST", regionBody(), 403],
      ["/v1/nodes", "GET", undefined, 403],
    ];
    for (const [path, method, body, expected] of cases) {
      const response = await app().fetch(
        request(path, integrator.key, method, body),
        env,
      );
      expect(response.status, `${method} ${path}`).toBe(expected);
    }
    const listing = await app().fetch(
      request("/v1/projects", integrator.key),
      env,
    );
    expect(listing.status).toBe(200);
    expect(
      (await listing.json<{ data: ProjectView[] }>()).data.map((row) => row.id),
    ).toEqual([own.id]);
    expect(
      (
        await app().fetch(
          request(`/v1/projects/${own.id}`, integrator.key),
          env,
        )
      ).status,
    ).toBe(200);
    expect(
      (await app().fetch(request("/v1/size-classes", integrator.key), env))
        .status,
    ).toBe(200);
    expect(
      (
        await app().fetch(
          request(`/v1/projects/${own.id}`, integrator.key, "DELETE"),
          env,
        )
      ).status,
    ).toBe(204);
    expect(
      (await app().fetch(request("/v1/projects", integrator.key), env)).status,
    ).toBe(401);
    expect(
      (await app().fetch(request(`/v1/projects/${other.id}`, admin.key), env))
        .status,
    ).toBe(200);
  });

  it("replays project mutations without duplicate resources and conflicts on changed requests", async () => {
    const admin = await bootstrap();
    const idempotency = crypto.randomUUID();
    const worker = app();
    const input = { name: "replay", external_id: crypto.randomUUID() };
    const first = await worker.fetch(
      request("/v1/projects", admin.key, "POST", input, idempotency),
      env,
    );
    const body = Project.parse(await first.json());
    const second = await worker.fetch(
      request(
        "/v1/projects",
        admin.key,
        "POST",
        { external_id: input.external_id, name: input.name },
        idempotency,
      ),
      env,
    );
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(body);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM projects").first(
        "count",
      ),
    ).toBe(1);
    const conflict = await worker.fetch(
      request(
        "/v1/projects",
        admin.key,
        "POST",
        { name: "changed" },
        idempotency,
      ),
      env,
    );
    expect(conflict.status).toBe(409);
    expect(await errorCode(conflict)).toBe("idempotency_conflict");
    const deletionKey = crypto.randomUUID();
    expect(
      (
        await worker.fetch(
          request(
            `/v1/projects/${body.id}`,
            admin.key,
            "DELETE",
            undefined,
            deletionKey,
          ),
          env,
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await worker.fetch(
          request(
            `/v1/projects/${body.id}`,
            admin.key,
            "DELETE",
            undefined,
            deletionKey,
          ),
          env,
        )
      ).status,
    ).toBe(204);
    const row = await env.DB.prepare(
      "SELECT request_hash, resource_id, response_status FROM idempotency_keys WHERE key = ?",
    )
      .bind(idempotency)
      .first();
    expect(row).toEqual({
      request_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      resource_id: body.id,
      response_status: 201,
    });
  });

  it("returns in-progress while the same idempotency mutation is active", async () => {
    const admin = await bootstrap();
    const worker = app();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    worker.post("/test/idempotency", (c) =>
      withIdempotency(c, {
        replay: async () => c.json({ replayed: true }),
        execute: async (lease) => {
          entered();
          await gate;
          const id = newProjectId();
          const now = new Date().toISOString();
          await env.DB.batch([
            env.DB.prepare(
              "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
            ).bind(id, "concurrent", now, now),
            lease.completeStatement(id, 201),
          ]);
          return c.json({ id }, 201);
        },
      }),
    );
    const idempotency = crypto.randomUUID();
    const first = worker.fetch(
      request(
        "/test/idempotency",
        admin.key,
        "POST",
        { value: 1 },
        idempotency,
      ),
      env,
    );
    await started;
    try {
      const second = await worker.fetch(
        request(
          "/test/idempotency",
          admin.key,
          "POST",
          { value: 1 },
          idempotency,
        ),
        env,
      );
      expect(second.status).toBe(409);
      expect(await errorCode(second)).toBe("idempotency_in_progress");
    } finally {
      release();
    }
    expect((await first).status).toBe(201);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM projects").first(
        "count",
      ),
    ).toBe(1);
  });

  it("recovers failed idempotency reservations without weakening unique external IDs", async () => {
    const admin = await bootstrap();
    const external = crypto.randomUUID();
    const worker = app();
    expect(
      (
        await worker.fetch(
          request("/v1/projects", admin.key, "POST", {
            name: "original",
            external_id: external,
          }),
          env,
        )
      ).status,
    ).toBe(201);
    const idempotency = crypto.randomUUID();
    const conflict = await worker.fetch(
      request(
        "/v1/projects",
        admin.key,
        "POST",
        { name: "duplicate", external_id: external },
        idempotency,
      ),
      env,
    );
    expect(conflict.status).toBe(409);
    expect(await errorCode(conflict)).toBe("conflict");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM idempotency_keys WHERE key = ?",
      )
        .bind(idempotency)
        .first("count"),
    ).toBe(0);
    expect(
      (
        await worker.fetch(
          request(
            "/v1/projects",
            admin.key,
            "POST",
            { name: "new", external_id: crypto.randomUUID() },
            idempotency,
          ),
          env,
        )
      ).status,
    ).toBe(201);
    const invalidHeader = await worker.fetch(
      request(
        "/v1/projects",
        admin.key,
        "POST",
        { name: "invalid" },
        "contains a space",
      ),
      env,
    );
    expect(invalidHeader.status).toBe(400);
  });

  it("returns API and region credentials once, hides hashes, and refuses secret replays", async () => {
    const admin = await bootstrap();
    const worker = app();
    const keyIdempotency = crypto.randomUUID();
    const keyBody = { scope: "admin", name: "one-time" };
    const created = await worker.fetch(
      request("/v1/api-keys", admin.key, "POST", keyBody, keyIdempotency),
      env,
    );
    const credential = ApiKeyCreated.parse(await created.json());
    const repeated = await worker.fetch(
      request("/v1/api-keys", admin.key, "POST", keyBody, keyIdempotency),
      env,
    );
    expect(repeated.status).toBe(409);
    expect(await errorCode(repeated)).toBe("idempotency_conflict");
    const keys = await worker.fetch(request("/v1/api-keys", admin.key), env);
    const keysJson = JSON.stringify(await keys.json());
    for (const hidden of [credential.key, "key_hash"])
      expect(keysJson).not.toContain(hidden);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM api_keys").first(
        "count",
      ),
    ).toBe(2);
    const body = regionBody();
    const regionIdempotency = crypto.randomUUID();
    const regionResponse = await worker.fetch(
      request("/v1/regions", admin.key, "POST", body, regionIdempotency),
      env,
    );
    expect(regionResponse.status).toBe(201);
    const region = RegionCreated.parse(await regionResponse.json());
    const expected = JSON.parse(
      serializeRouteKeyring(
        await deriveRegionKeyring(
          parseRouteKeyring(env.ROUTE_MASTER_KEYS),
          body.id,
        ),
      ),
    );
    expect(region.route_keyring).toEqual(expected);
    const replay = await worker.fetch(
      request("/v1/regions", admin.key, "POST", body, regionIdempotency),
      env,
    );
    expect(replay.status).toBe(409);
    expect(await errorCode(replay)).toBe("idempotency_conflict");
    const regions = await worker.fetch(request("/v1/regions", admin.key), env);
    const listed = JSON.stringify(await regions.json());
    for (const hidden of [
      region.agent_key,
      "agent_key_hash",
      "route_keyring",
      ...Object.values(region.route_keyring.keys),
    ])
      expect(listed).not.toContain(hidden);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM regions").first(
        "count",
      ),
    ).toBe(1);
    expect(
      (await worker.fetch(request("/v1/regions", admin.key, "POST", body), env))
        .status,
    ).toBe(409);
  });

  it("paginates ties without omissions and validates cursors and limits", async () => {
    const admin = await bootstrap();
    const now = new Date().toISOString();
    const ids = Array.from({ length: 3 }, () => newProjectId())
      .sort()
      .reverse();
    await env.DB.batch(
      ids.map((id) =>
        env.DB.prepare(
          "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        ).bind(id, "tie", now, now),
      ),
    );
    const first = await app().fetch(
      request("/v1/projects?limit=2", admin.key),
      env,
    );
    const listing = await first.json<{
      data: ProjectView[];
      next_cursor: string | null;
    }>();
    expect(listing.data.map((row) => row.id)).toEqual(ids.slice(0, 2));
    expect(listing.next_cursor).toBeTypeOf("string");
    const second = await app().fetch(
      request(`/v1/projects?limit=2&cursor=${listing.next_cursor}`, admin.key),
      env,
    );
    const rest = await second.json<{
      data: ProjectView[];
      next_cursor: string | null;
    }>();
    expect(rest.data.map((row) => row.id)).toEqual(ids.slice(2));
    expect(rest.next_cursor).toBeNull();
    for (const query of [
      "limit=0",
      "limit=101",
      "cursor=bad",
      "limit=2&extra=1",
    ]) {
      const invalid = await app().fetch(
        request(`/v1/projects?${query}`, admin.key),
        env,
      );
      expect(invalid.status).toBe(400);
    }
  });

  it("upserts sizes without seeds and uses real node data with boolean conversion", async () => {
    const admin = await bootstrap();
    const worker = app();
    expect(
      await (
        await worker.fetch(request("/v1/size-classes", admin.key), env)
      ).json(),
    ).toEqual({ data: [], next_cursor: null });
    const idempotency = crypto.randomUUID();
    const response = await worker.fetch(
      request("/v1/size-classes/small", admin.key, "PUT", size, idempotency),
      env,
    );
    expect(response.status).toBe(200);
    const created = await response.json();
    expect(
      await (
        await worker.fetch(
          request(
            "/v1/size-classes/small",
            admin.key,
            "PUT",
            size,
            idempotency,
          ),
          env,
        )
      ).json(),
    ).toEqual(created);
    const updated = await worker.fetch(
      request("/v1/size-classes/small", admin.key, "PUT", {
        ...size,
        enabled: false,
      }),
      env,
    );
    expect((await updated.json<{ enabled: boolean }>()).enabled).toBe(false);
    expect(
      await (await worker.fetch(request("/v1/nodes", admin.key), env)).json(),
    ).toEqual({ data: [], next_cursor: null });
    const region = regionBody();
    expect(
      (
        await worker.fetch(
          request("/v1/regions", admin.key, "POST", region),
          env,
        )
      ).status,
    ).toBe(201);
    const node = newNodeId();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO nodes
      (id, region_id, k8s_node_name, ready, schedulable, allocatable_memory_mib, allocatable_cpu_millicores, storage_gib_total, created_at, updated_at)
      VALUES (?, ?, ?, 1, 0, 8192, 4000, 120, ?, ?)`,
    )
      .bind(node, region.id, `node-${crypto.randomUUID()}`, now, now)
      .run();
    const listing = await worker.fetch(request("/v1/nodes", admin.key), env);
    const observed = (
      await listing.json<{
        data: {
          id: string;
          ready: boolean;
          schedulable: boolean;
          storage_gib_total: number;
        }[];
      }>()
    ).data;
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      id: node,
      ready: true,
      schedulable: false,
      storage_gib_total: 120,
    });
  });

  it("keeps referenced size resources and policies immutable while allowing enable toggles and replay", async () => {
    const admin = await bootstrap();
    const owned = await project(admin.key);
    const worker = app();
    const region = regionBody();
    expect(
      (
        await worker.fetch(
          request("/v1/regions", admin.key, "POST", region),
          env,
        )
      ).status,
    ).toBe(201);
    const originalKey = crypto.randomUUID();
    expect(
      (
        await worker.fetch(
          request(
            "/v1/size-classes/small",
            admin.key,
            "PUT",
            size,
            originalKey,
          ),
          env,
        )
      ).status,
    ).toBe(200);
    const database = newDatabaseId();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO databases
      (id, project_id, region_id, name, size_class_id, desired_state, observed_state, archive_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'small', 'running', 'pending', ?, ?, ?)`,
    )
      .bind(
        database,
        owned.id,
        region.id,
        "referenced",
        `s3://${region.backup_bucket}/${region.id}/${database}/archive`,
        now,
        now,
      )
      .run();
    const resourceMutation = await worker.fetch(
      request(
        "/v1/size-classes/small",
        admin.key,
        "PUT",
        { ...size, memory_mib: 1024 },
        crypto.randomUUID(),
      ),
      env,
    );
    expect(resourceMutation.status).toBe(409);
    expect(await errorCode(resourceMutation)).toBe("conflict");
    const policyMutation = await worker.fetch(
      request(
        "/v1/size-classes/small",
        admin.key,
        "PUT",
        { ...size, archive_timeout_seconds: 60 },
        crypto.randomUUID(),
      ),
      env,
    );
    expect(policyMutation.status).toBe(409);
    expect(await errorCode(policyMutation)).toBe("conflict");
    expect(
      (
        await worker.fetch(
          request(
            "/v1/size-classes/small",
            admin.key,
            "PUT",
            size,
            originalKey,
          ),
          env,
        )
      ).status,
    ).toBe(200);
    const toggleKey = crypto.randomUUID();
    const disabled = await worker.fetch(
      request(
        "/v1/size-classes/small",
        admin.key,
        "PUT",
        { ...size, enabled: false },
        toggleKey,
      ),
      env,
    );
    expect(disabled.status).toBe(200);
    expect((await disabled.json<{ enabled: boolean }>()).enabled).toBe(false);
    expect(
      (
        await worker.fetch(
          request(
            "/v1/size-classes/small",
            admin.key,
            "PUT",
            { ...size, enabled: false },
            toggleKey,
          ),
          env,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await worker.fetch(
          request("/v1/size-classes/small", admin.key, "PUT", size),
          env,
        )
      ).status,
    ).toBe(200);
    await env.DB.prepare(
      "UPDATE databases SET desired_state = 'deleted', observed_state = 'deleted', observed_generation = generation, deleted_at = ? WHERE id = ?",
    )
      .bind(now, database)
      .run();
    expect(
      (
        await worker.fetch(
          request("/v1/size-classes/small", admin.key, "PUT", {
            ...size,
            backup_retention_days: 30,
          }),
          env,
        )
      ).status,
    ).toBe(409);
    expect(
      await env.DB.prepare(
        "SELECT memory_mib, archive_timeout_seconds, backup_retention_days, enabled FROM size_classes WHERE id = 'small'",
      ).first(),
    ).toEqual({
      memory_mib: size.memory_mib,
      archive_timeout_seconds: size.archive_timeout_seconds,
      backup_retention_days: size.backup_retention_days,
      enabled: 1,
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM idempotency_keys WHERE state = 'in_progress'",
      ).first("count"),
    ).toBe(0);
    expect(
      (
        await worker.fetch(
          request("/v1/size-classes/larger", admin.key, "PUT", {
            ...size,
            memory_mib: 1024,
          }),
          env,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await worker.fetch(
          request("/v1/size-classes/larger", admin.key, "PUT", {
            ...size,
            memory_mib: 2048,
          }),
          env,
        )
      ).status,
    ).toBe(200);
  });

  it("refuses project deletion until owned databases are observed deleted", async () => {
    const admin = await bootstrap();
    const owned = await project(admin.key);
    const worker = app();
    const body = regionBody();
    expect(
      (await worker.fetch(request("/v1/regions", admin.key, "POST", body), env))
        .status,
    ).toBe(201);
    expect(
      (
        await worker.fetch(
          request("/v1/size-classes/small", admin.key, "PUT", size),
          env,
        )
      ).status,
    ).toBe(200);
    const database = newDatabaseId();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO databases
      (id, project_id, region_id, name, size_class_id, desired_state, observed_state, archive_path, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, 'small', 'deleted', 'deleting', ?, ?, ?, ?)`,
    )
      .bind(
        database,
        owned.id,
        body.id,
        "waiting",
        `s3://${body.backup_bucket}/${body.id}/${database}/archive`,
        now,
        now,
        now,
      )
      .run();
    const idempotency = crypto.randomUUID();
    const refused = await worker.fetch(
      request(
        `/v1/projects/${owned.id}`,
        admin.key,
        "DELETE",
        undefined,
        idempotency,
      ),
      env,
    );
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("conflict");
    expect(
      await env.DB.prepare("SELECT deleted_at FROM projects WHERE id = ?")
        .bind(owned.id)
        .first("deleted_at"),
    ).toBeNull();
    await env.DB.prepare(
      "UPDATE databases SET observed_state = 'deleted', observed_generation = generation WHERE id = ?",
    )
      .bind(database)
      .run();
    expect(
      (
        await worker.fetch(
          request(
            `/v1/projects/${owned.id}`,
            admin.key,
            "DELETE",
            undefined,
            idempotency,
          ),
          env,
        )
      ).status,
    ).toBe(204);
  });

  it("purges only idempotency entries older than 24 hours", async () => {
    const admin = await bootstrap();
    const worker = app();
    const stale = crypto.randomUUID();
    const fresh = crypto.randomUUID();
    await worker.fetch(
      request("/v1/projects", admin.key, "POST", { name: "stale" }, stale),
      env,
    );
    await worker.fetch(
      request("/v1/projects", admin.key, "POST", { name: "fresh" }, fresh),
      env,
    );
    const now = Date.now();
    await env.DB.prepare(
      "UPDATE idempotency_keys SET created_at = ? WHERE key = ?",
    )
      .bind(new Date(now - 24 * 3600 * 1000 - 1).toISOString(), stale)
      .run();
    expect(await purgeIdempotency(env.DB, now)).toBe(1);
    expect(
      await env.DB.prepare("SELECT key FROM idempotency_keys").first("key"),
    ).toBe(fresh);
  });
});

describe("credential encryption inside the Workers runtime", () => {
  it("binds credentials to database, role and key ID and supports key rotation", async () => {
    const oldKey = bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));
    const nextKey = bytesToBase64url(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const original = keyring(
      JSON.stringify({ active: "old", keys: { old: oldKey } }),
    );
    const rotated = keyring(
      JSON.stringify({ active: "next", keys: { old: oldKey, next: nextKey } }),
    );
    const database = newDatabaseId();
    const password = newRolePassword();
    expect(RolePassword.parse(password)).toBe(password);
    const encrypted = await original.encrypt(database, "app", password);
    const twice = await original.encrypt(database, "app", password);
    expect(encrypted.iv).toHaveLength(16);
    expect(twice.iv).not.toBe(encrypted.iv);
    expect(encrypted.ciphertext).not.toContain(password);
    expect(await rotated.decrypt(database, "app", encrypted)).toBe(password);
    expect((await rotated.encrypt(database, "app", password)).kid).toBe("next");
    await expect(
      rotated.decrypt(newDatabaseId(), "app", encrypted),
    ).rejects.toThrow();
    await expect(
      rotated.decrypt(database, "different", encrypted),
    ).rejects.toThrow();
    await expect(
      rotated.decrypt(database, "app", { ...encrypted, kid: "next" }),
    ).rejects.toThrow();
    const retired = keyring(
      JSON.stringify({ active: "next", keys: { next: nextKey } }),
    );
    await expect(retired.decrypt(database, "app", encrypted)).rejects.toThrow(
      "version is unavailable",
    );
  });
  it("rejects invalid keyring configuration and malformed encrypted values", async () => {
    expect(() => keyring("not-json")).toThrow("configuration");
    expect(() =>
      keyring(JSON.stringify({ active: "missing", keys: {} })),
    ).toThrow("missing");
    expect(() =>
      keyring(JSON.stringify({ active: "bad", keys: { bad: "short" } })),
    ).toThrow("32 bytes");
    const credentials = keyring(env.CREDENTIAL_KEYS);
    await expect(
      credentials.decrypt(newDatabaseId(), "app", {
        kid: "v1",
        iv: "bad",
        ciphertext: "bad",
      }),
    ).rejects.toThrow("Invalid encrypted");
  });
});
