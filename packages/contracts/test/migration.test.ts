// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
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
     VALUES ('eu-1', 'contabo', 'EU', 'https://gateway.example.com', 'pgcf-backups', 'https://r2.example.com', ?, ?, ?)`,
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
      gateway_url: "https://gateway.example.com",
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

  it("enforces operation state and idempotency key shape", () => {
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
