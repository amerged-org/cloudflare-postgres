// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  archiveDestinationPath,
  bytesToBase64url,
  newApiKeyId,
  newDatabaseId,
  newNodeId,
  newOperationId,
  newProjectId,
  newSecret,
  hashApiKey,
  isDatabaseId,
} from "../src/index.ts";

const MIGRATION = readFileSync(
  new URL("../../../apps/api/migrations/0001_init.sql", import.meta.url),
  "utf8",
);
const NOW = "2026-10-02T10:46:00.000Z";
const gatewayUrl = `https://${["gateway", "example", "com"].join(".")}`;
const backupEndpoint = `https://${["r2", "example", "com"].join(".")}`;

let db: DatabaseSync;
let projectId: string;
let nodeId: string;

const run = (sql: string, ...params: (string | number | null)[]) =>
  db.prepare(sql).run(...params);

function insertDatabase(
  id: string,
  overrides: Record<string, string | number | null> = {},
) {
  const row: Record<string, string | number | null> = {
    id,
    project_id: projectId,
    region_id: "eu-1",
    node_id: nodeId,
    name: id,
    size_class_id: "small",
    desired_state: "running",
    // Bad IDs under test still need a well-formed path so only the ID column fails.
    archive_path: archiveDestinationPath(
      "pgcf-backups",
      "eu-1",
      isDatabaseId(id) ? id : newDatabaseId(),
      1,
      newOperationId(),
    ),
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
  const columns = Object.keys(row);
  run(
    `INSERT INTO databases (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    ...Object.values(row),
  );
}

function insertRole(databaseId: string, name: string, owner = 0) {
  run(
    `INSERT INTO roles (database_id, name, owner, password_ciphertext, password_iv, password_kid, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'k1', ?, ?)`,
    databaseId,
    name,
    owner,
    newSecret(),
    bytesToBase64url(crypto.getRandomValues(new Uint8Array(12))),
    NOW,
    NOW,
  );
}

async function insertApiKey(scope = "admin", project: string | null = null) {
  const id = newApiKeyId();
  run(
    `INSERT INTO api_keys (id, lookup_id, key_hash, scope, project_id, name, created_at)
     VALUES (?, ?, ?, ?, ?, 'k', ?)`,
    id,
    newApiKeyId().slice(4, 16),
    await hashApiKey(newSecret(), newSecret()),
    scope,
    project,
    NOW,
  );
  return id;
}

function insertOperation(databaseId: string) {
  const id = newOperationId();
  run(
    `INSERT INTO operations (id, kind, status, project_id, database_id, generation, created_at, updated_at)
     VALUES (?, 'database.create', 'pending', ?, ?, 1, ?, ?)`,
    id,
    projectId,
    databaseId,
    NOW,
    NOW,
  );
  return id;
}

beforeEach(async () => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(MIGRATION);
  projectId = newProjectId();
  nodeId = newNodeId();
  run(
    "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, 'p', ?, ?)",
    projectId,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO size_classes (id, memory_mib, cpu_millicores, storage_gib, max_connections,
       archive_timeout_seconds, backup_retention_days, created_at, updated_at)
     VALUES ('small', 512, 500, 10, 100, 60, 7, ?, ?)`,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO regions (id, provider, provider_region, gateway_url, backup_bucket, backup_endpoint_url,
       agent_key_hash, created_at, updated_at)
     VALUES ('eu-1', 'contabo', 'EU', ?, 'pgcf-backups', ?, ?, ?, ?)`,
    gatewayUrl,
    backupEndpoint,
    await hashApiKey(newSecret(), newSecret()),
    NOW,
    NOW,
  );
  run(
    `INSERT INTO nodes (id, region_id, k8s_node_name, allocatable_memory_mib, allocatable_cpu_millicores,
       created_at, updated_at) VALUES (?, 'eu-1', 'talos-lab-1', 7600, 3900, ?, ?)`,
    nodeId,
    NOW,
    NOW,
  );
});

afterEach(() => db.close());

describe("0001_init.sql", () => {
  it("creates every table", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual([
      "api_keys",
      "databases",
      "idempotency_keys",
      "lifecycle_events",
      "nodes",
      "operations",
      "projects",
      "regions",
      "roles",
      "size_classes",
    ]);
  });

  it("rejects NULL primary identities in every TEXT-id table", async () => {
    const databaseId = newDatabaseId();
    insertDatabase(databaseId);
    insertOperation(databaseId);
    await insertApiKey();
    const rejectsNullIdentity = (table: string) => {
      const row = db.prepare(`SELECT * FROM ${table} LIMIT 1`).get()!;
      const columns = Object.keys(row);
      const params = columns.map((column) =>
        column === "id" ? null : row[column]!,
      );
      expect(() =>
        db
          .prepare(
            `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
          )
          .run(...params),
      ).toThrow(new RegExp(`NOT NULL constraint failed: ${table}\\.id`));
    };
    rejectsNullIdentity("projects");
    rejectsNullIdentity("api_keys");
    rejectsNullIdentity("size_classes");
    rejectsNullIdentity("regions");
    rejectsNullIdentity("nodes");
    rejectsNullIdentity("databases");
    rejectsNullIdentity("operations");
  });

  it("stores an API key's optional last-used UTC timestamp", async () => {
    const id = await insertApiKey();
    const column = db
      .prepare("PRAGMA table_info(api_keys)")
      .all()
      .find((row) => row.name === "last_used_at");
    expect(column).toMatchObject({ type: "TEXT", notnull: 0 });
    const read = db.prepare("SELECT last_used_at FROM api_keys WHERE id = ?");
    expect(read.get(id)).toEqual({ last_used_at: null });
    run("UPDATE api_keys SET last_used_at = ? WHERE id = ?", NOW, id);
    expect(read.get(id)).toEqual({ last_used_at: NOW });
  });

  it("routes (database, user) through roles -> databases -> regions", () => {
    const id = newDatabaseId();
    insertDatabase(id, { observed_state: "ready", observed_generation: 1 });
    insertRole(id, "app", 1);
    const route = db.prepare(
      `SELECT d.id, d.desired_state, d.observed_state, g.gateway_url, g.id AS region_id
         FROM roles r
         JOIN databases d ON d.id = r.database_id
         JOIN regions g ON g.id = d.region_id
        WHERE r.database_id = ? AND r.name = ? AND r.deleted_at IS NULL AND d.deleted_at IS NULL`,
    );
    expect(route.get(id, "app")).toEqual({
      id,
      desired_state: "running",
      observed_state: "ready",
      gateway_url: gatewayUrl,
      region_id: "eu-1",
    });
    expect(route.get(id, "intruder")).toBeUndefined();
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT 1 FROM roles WHERE database_id = ? AND name = ?`,
      )
      .all(id, "app")
      .map((row) => String(row.detail));
    expect(plan.join(" ")).toMatch(
      /USING (COVERING )?INDEX sqlite_autoindex_roles_1 \(database_id=\? AND name=\?\)/,
    );
  });

  it("rejects bad database rows", () => {
    expect(() => insertDatabase("a".repeat(19))).toThrow(/CHECK/);
    expect(() => insertDatabase("1" + "a".repeat(19))).toThrow(/CHECK/);
    expect(() => insertDatabase("A" + "a".repeat(19))).toThrow(/CHECK/);
    expect(() =>
      insertDatabase(newDatabaseId(), { desired_state: "sleeping" }),
    ).toThrow(/CHECK/);
    expect(() =>
      insertDatabase(newDatabaseId(), { observed_state: "running" }),
    ).toThrow(/CHECK/);
    expect(() =>
      insertDatabase(newDatabaseId(), { observed_generation: 2 }),
    ).toThrow(/CHECK/);
    expect(() =>
      insertDatabase(newDatabaseId(), { created_at: "2026-10-02 10:46:00" }),
    ).toThrow(/CHECK/);
    expect(() =>
      insertDatabase(newDatabaseId(), { desired_state: "deleted" }),
    ).toThrow(/CHECK/);
    expect(() =>
      insertDatabase(newDatabaseId(), { size_class_id: "huge" }),
    ).toThrow(/FOREIGN KEY/);
  });

  it("keeps live database names unique per project but frees them after delete", () => {
    const first = newDatabaseId();
    insertDatabase(first, { name: "main" });
    expect(() => insertDatabase(newDatabaseId(), { name: "main" })).toThrow(
      /UNIQUE/,
    );
    run(
      "UPDATE databases SET desired_state = 'deleted', deleted_at = ? WHERE id = ?",
      NOW,
      first,
    );
    expect(() =>
      insertDatabase(newDatabaseId(), { name: "main" }),
    ).not.toThrow();
  });

  it("rejects reserved and duplicate roles and a second owner", () => {
    const id = newDatabaseId();
    insertDatabase(id);
    insertRole(id, "app", 1);
    for (const name of [
      "postgres",
      "streaming_replica",
      "pg_monitor",
      "cnpg_pooler_pgbouncer",
      "App",
      "_x",
    ]) {
      expect(() => insertRole(id, name)).toThrow(/CHECK/);
    }
    expect(() => insertRole(id, "app")).toThrow(/UNIQUE/);
    expect(() => insertRole(id, "other", 1)).toThrow(/UNIQUE/);
    expect(() => insertRole(id, "reader")).not.toThrow();
  });

  it("binds integrator keys to a project and admin keys to none", async () => {
    const key = (scope: string, project: string | null) =>
      hashApiKey(newSecret(), newSecret()).then((hash) =>
        run(
          `INSERT INTO api_keys (id, lookup_id, key_hash, scope, project_id, name, created_at)
           VALUES (?, ?, ?, ?, ?, 'k', ?)`,
          newApiKeyId(),
          newApiKeyId().slice(4, 16),
          hash,
          scope,
          project,
          NOW,
        ),
      );
    await expect(key("admin", null)).resolves.toBeDefined();
    await expect(key("integrator", projectId)).resolves.toBeDefined();
    await expect(key("integrator", null)).rejects.toThrow(/CHECK/);
    await expect(key("admin", projectId)).rejects.toThrow(/CHECK/);
    await expect(key("owner", null)).rejects.toThrow(/CHECK/);
  });

  it("enforces operation completion and failure state", () => {
    const id = newDatabaseId();
    insertDatabase(id);
    const op = (
      status: string,
      completedAt: string | null,
      errorCode: string | null = null,
    ) =>
      run(
        `INSERT INTO operations (id, kind, status, project_id, database_id, generation, error_code,
           created_at, updated_at, completed_at) VALUES (?, 'database.create', ?, ?, ?, 1, ?, ?, ?, ?)`,
        newOperationId(),
        status,
        projectId,
        id,
        errorCode,
        NOW,
        NOW,
        completedAt,
      );
    expect(() => op("pending", null)).not.toThrow();
    expect(() => op("failed", NOW, "timeout")).not.toThrow();
    expect(() => op("succeeded", null)).toThrow(/CHECK/);
    expect(() => op("running", NOW)).toThrow(/CHECK/);
    expect(() => op("succeeded", NOW, "timeout")).toThrow(/CHECK/);
    expect(() => op("done", NOW)).toThrow(/CHECK/);
  });

  it("scopes idempotency keys to the API key and enforces valid state transitions", async () => {
    const apiKeyId = await insertApiKey();
    const otherApiKeyId = await insertApiKey();
    const requestHash = await hashApiKey(newSecret(), newSecret());
    const resourceId = newProjectId();
    const insert = (
      apiKey: string,
      key: string,
      state = "in_progress",
      responseStatus: number | null = null,
      hash = requestHash,
    ) =>
      run(
        `INSERT INTO idempotency_keys (api_key_id, key, request_hash, state, resource_id, response_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
        apiKey,
        key,
        hash,
        state,
        state === "completed" ? resourceId : null,
        responseStatus,
        NOW,
      );
    insert(apiKeyId, "create-1");
    expect(() => insert(apiKeyId, "create-1")).toThrow(/UNIQUE/);
    expect(() => insert(otherApiKeyId, "create-1")).not.toThrow();
    expect(() => insert(newApiKeyId(), "unknown-key")).toThrow(/FOREIGN KEY/);
    expect(() => insert(apiKeyId, "")).toThrow(/CHECK/);
    expect(() => insert(apiKeyId, "contains space")).toThrow(/CHECK/);
    expect(() => insert(apiKeyId, "x".repeat(129))).toThrow(/CHECK/);
    expect(() =>
      insert(apiKeyId, "bad-hash", "in_progress", null, "x"),
    ).toThrow(/CHECK/);
    expect(() => insert(apiKeyId, "bad-state", "pending")).toThrow(/CHECK/);
    expect(() => insert(apiKeyId, "missing-status", "completed")).toThrow(
      /CHECK/,
    );
    expect(() => insert(apiKeyId, "early-status", "in_progress", 201)).toThrow(
      /CHECK/,
    );
    expect(() => insert(apiKeyId, "bad-status", "completed", 600)).toThrow(
      /CHECK/,
    );
    expect(() =>
      run(
        "UPDATE idempotency_keys SET state = 'completed' WHERE api_key_id = ? AND key = ?",
        apiKeyId,
        "create-1",
      ),
    ).toThrow(/CHECK/);
    run(
      "UPDATE idempotency_keys SET state = 'completed', resource_id = ?, response_status = ? WHERE api_key_id = ? AND key = ?",
      resourceId,
      201,
      apiKeyId,
      "create-1",
    );
    expect(
      db
        .prepare(
          "SELECT state, resource_id, response_status, request_hash FROM idempotency_keys WHERE api_key_id = ? AND key = ?",
        )
        .get(apiKeyId, "create-1"),
    ).toEqual({
      state: "completed",
      resource_id: resourceId,
      response_status: 201,
      request_hash: requestHash,
    });
    expect(
      db
        .prepare(
          "SELECT state, response_status FROM idempotency_keys WHERE api_key_id = ? AND key = ?",
        )
        .get(otherApiKeyId, "create-1"),
    ).toEqual({ state: "in_progress", response_status: null });
  });

  it("enforces unique project external IDs only among live projects", () => {
    const insert = (id: string) =>
      run(
        "INSERT INTO projects (id, name, external_id, created_at, updated_at) VALUES (?, 'p', 'ext-1', ?, ?)",
        id,
        NOW,
        NOW,
      );
    const first = newProjectId();
    insert(first);
    expect(() => insert(newProjectId())).toThrow(/UNIQUE/);
    run("UPDATE projects SET deleted_at = ? WHERE id = ?", NOW, first);
    expect(() => insert(newProjectId())).not.toThrow();
  });
});
