// SPDX-License-Identifier: Apache-2.0
/* global crypto, Request, URL, btoa */
export { RegionLink } from "../../api/src/region-link.ts";
export { DatabaseActor } from "../../api/src/database-actor.ts";
export { default } from "../src/index.ts";
import {
  newDatabaseId,
  newNodeId,
  newOperationId,
  newProjectId,
} from "@pgcf/contracts";
import { readDatabasePresence } from "../../api/src/domain/database-actor-sync.ts";

// Trusted fixture setup only; the Edge request entry never seeds actors.
export async function seedKnownDatabase(db, namespace, id) {
  const snapshot = await readDatabasePresence(db, id);
  if (!snapshot) throw new Error("database_fixture_missing");
  await namespace.get(namespace.idFromName(id)).seed(snapshot);
}

// Trusted fixture setup only: one running database with the role "app" on a region and a node
// that the rows name, and its Actor seeded from them. Returns the database id.
export async function seedFixtureDatabase(
  db,
  namespace,
  { region, gatewayUrl, gatewayBinding },
) {
  const database = newDatabaseId();
  const project = newProjectId();
  const node = newNodeId();
  const now = new Date().toISOString();
  const randomHash = Array.from(
    crypto.getRandomValues(new Uint8Array(32)),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
  const password = crypto.randomUUID();
  const iv = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12))),
  );
  await db.batch([
    db
      .prepare(
        "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .bind(project, "edge-test", now, now),
    db
      .prepare(
        `INSERT INTO size_classes (id, memory_mib, cpu_millicores, storage_gib,
      max_connections, archive_timeout_seconds, backup_retention_days, created_at, updated_at)
      VALUES ('small', 512, 250, 1, 20, 300, 7, ?, ?)`,
      )
      .bind(now, now),
    db
      .prepare(
        `INSERT INTO regions (id, provider, provider_region, gateway_url,
      gateway_binding, backup_bucket, backup_endpoint_url, agent_key_hash, created_at, updated_at)
      VALUES (?, 'test-provider', 'test-region', ?, ?, 'test-backups', ?, ?, ?, ?)`,
      )
      .bind(
        region,
        gatewayUrl,
        gatewayBinding,
        `https://${["backup", "invalid"].join(".")}`,
        randomHash,
        now,
        now,
      ),
    db
      .prepare(
        `INSERT INTO nodes (id, region_id, k8s_node_name, ready, schedulable,
       allocatable_memory_mib, allocatable_cpu_millicores, platform_reserved_memory_mib,
       storage_gib_total, created_at, updated_at, node_uid, last_observed_at, platform_reserved_cpu_millicores)
       VALUES (?, ?, 'edge-fixture-node', 1, 1, 4096, 2000, 128, 20, ?, ?, ?, ?, 100)`,
      )
      .bind(node, region, now, now, crypto.randomUUID(), now),
    db
      .prepare(
        `INSERT INTO databases (id, project_id, region_id, node_id, name, size_class_id,
      desired_state, observed_state, generation, observed_generation, archive_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'edge-test', 'small', 'running', 'ready', 2, 2, ?, ?, ?)`,
      )
      .bind(
        database,
        project,
        region,
        node,
        `s3://test-backups/${region}/${database}/g1-${newOperationId()}`,
        now,
        now,
      ),
    db
      .prepare(
        `INSERT INTO roles (database_id, name, owner, password_ciphertext,
      password_iv, password_kid, created_at, updated_at) VALUES (?, 'app', 1, ?, ?, 'v1', ?, ?)`,
      )
      .bind(database, password, iv, now, now),
  ]);
  await seedKnownDatabase(db, namespace, database);
  return database;
}

// Test-only management call uses the actual authenticated role writer and Actor publisher.
export async function createUnrelatedRole(env, ctx, database) {
  const { createApp } = await import("../../api/src/app.ts");
  const { hashApiKey, newApiKey, newApiKeyId } =
    await import("@pgcf/contracts");
  const project = await env.DB.prepare(
    "SELECT project_id FROM databases WHERE id=?",
  )
    .bind(database)
    .first("project_id");
  if (!project) throw new Error("database_fixture_missing");
  const key = newApiKey().key,
    keyId = newApiKeyId(),
    pepper = crypto.randomUUID(),
    material = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  await env.DB.prepare(
    "INSERT INTO api_keys(id,lookup_id,key_hash,scope,project_id,name,created_at) VALUES(?,?,?,'integrator',?,'edge-role-fixture',?)",
  )
    .bind(
      keyId,
      key.split("_")[2],
      await hashApiKey(pepper, key),
      project,
      new Date().toISOString(),
    )
    .run();
  try {
    return await createApp().fetch(
      new Request(`https://api.invalid/v1/databases/${database}/roles`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ name: "unrelated" }),
      }),
      {
        ...env,
        API_KEY_PEPPER: pepper,
        CREDENTIAL_KEYS: JSON.stringify({
          active: "v1",
          keys: { v1: material },
        }),
      },
      ctx,
    );
  } finally {
    // The key's retained idempotency record references it.
    await env.DB.prepare("DELETE FROM idempotency_keys WHERE api_key_id=?")
      .bind(keyId)
      .run();
    await env.DB.prepare("DELETE FROM api_keys WHERE id=?").bind(keyId).run();
  }
}

// Test-only regional publisher sends the controller's partial database update to the actual API handler.
export async function publishPowerObservation(
  env,
  ctx,
  database,
  revision,
  operation,
  state,
) {
  const { createApp } = await import("../../api/src/app.ts");
  const { hashApiKey, newAgentKey } = await import("@pgcf/contracts");
  const row = await env.DB.prepare("SELECT region_id FROM databases WHERE id=?")
    .bind(database)
    .first();
  if (!row) throw new Error("database_fixture_missing");
  const key = newAgentKey(row.region_id);
  const pepper = crypto.randomUUID();
  await env.DB.prepare("UPDATE regions SET agent_key_hash=? WHERE id=?")
    .bind(await hashApiKey(pepper, key), row.region_id)
    .run();
  return createApp().fetch(
    new Request(
      new URL(
        "/agent/v1/observations",
        `https://${["api", "invalid"].join(".")}`,
      ),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          coverage: "databases",
          observed_at: new Date().toISOString(),
          databases: [
            {
              id: database,
              generation: revision,
              state: state === "awake" ? "ready" : "hibernated",
              power: { operation, revision, state },
              archive: { continuous: true, ready_wal_files: 0 },
            },
          ],
        }),
      },
    ),
    { ...env, API_KEY_PEPPER: pepper },
    ctx,
  );
}
