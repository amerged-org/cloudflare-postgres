// SPDX-License-Identifier: Apache-2.0
/* global crypto, Request, URL, btoa, TextEncoder */
export { NodeActor } from "../../api/src/node-actor.ts";
export { DatabaseActor } from "../../api/src/database-actor.ts";
export { default } from "../src/index.ts";
import {
  newDatabaseId,
  newNodeId,
  newOperationId,
  newProjectId,
  nodePublicKey,
} from "@pgcf/contracts";
import { publishDatabaseAdmission } from "../../api/src/domain/database-admission-snapshot.ts";

// Trusted fixture setup only; the Edge request entry never seeds actors. The API's own publisher
// seeds the Actor's presence and its admission snapshot from D1.
export async function seedKnownDatabase(env, id) {
  if (!(await publishDatabaseAdmission(env, id)))
    throw new Error("database_fixture_missing");
}

// Trusted fixture setup only: one running database with the role "app" on a region and an
// enrolled node that the rows name, and its Actor seeded from them. Returns the database id and
// the node with the key it signs its reports with.
export async function seedFixtureDatabase(
  env,
  { region, gatewayUrl, gatewayBinding },
) {
  const database = newDatabaseId();
  const project = newProjectId();
  const node = newNodeId();
  const now = new Date().toISOString();
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  const enrolled = {
    id: node,
    uid: crypto.randomUUID(),
    key: pair.privateKey,
  };
  const password = crypto.randomUUID();
  const iv = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12))),
  );
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).bind(project, "edge-test", now, now),
    env.DB.prepare(
      `INSERT INTO size_classes (id, memory_mib, cpu_millicores, storage_gib,
      max_connections, archive_timeout_seconds, backup_retention_days, created_at, updated_at)
      VALUES ('small', 512, 250, 1, 20, 300, 7, ?, ?)`,
    ).bind(now, now),
    env.DB.prepare(
      `INSERT INTO regions (id, provider, provider_region, gateway_url,
      gateway_binding, created_at, updated_at)
      VALUES (?, 'test-provider', 'test-region', ?, ?, ?, ?)`,
    ).bind(region, gatewayUrl, gatewayBinding, now, now),
    env.DB.prepare(
      `INSERT INTO nodes (id, region_id, hostname, ready, schedulable,
       allocatable_memory_mib, allocatable_cpu_millicores, platform_reserved_memory_mib,
       storage_gib_total, created_at, updated_at, node_uid, last_observed_at, platform_reserved_cpu_millicores,
       public_key, enrolled_at)
       VALUES (?, ?, 'edge-fixture-node', 1, 1, 4096, 2000, 128, 20, ?, ?, ?, ?, 100, ?, ?)`,
    ).bind(
      node,
      region,
      now,
      now,
      enrolled.uid,
      now,
      await nodePublicKey(pair.publicKey),
      now,
    ),
    env.DB.prepare(
      `INSERT INTO databases (id, project_id, region_id, node_id, name, size_class_id,
      desired_state, observed_state, generation, observed_generation, archive_path, created_at, updated_at,
      runtime_json)
      VALUES (?, ?, ?, ?, 'edge-test', 'small', 'running', 'ready', 2, 2, ?, ?, ?, ?)`,
    ).bind(
      database,
      project,
      region,
      node,
      `s3://test-backups/${region}/${database}/g1-${newOperationId()}`,
      now,
      now,
      JSON.stringify({
        database_id: database,
        node_id: node,
        generation: 2,
        storage_generation: 1,
        instance: crypto.randomUUID(),
        observed_at: Date.now(),
      }),
    ),
    env.DB.prepare(
      `INSERT INTO operations (id, kind, status, project_id, database_id, generation,
      created_at, updated_at, completed_at) VALUES (?, 'database.create', 'succeeded', ?, ?, 1, ?, ?, ?)`,
    ).bind(newOperationId(), project, database, now, now, now),
    env.DB.prepare(
      `INSERT INTO roles (database_id, name, owner, password_ciphertext,
      password_iv, password_kid, created_at, updated_at) VALUES (?, 'app', 1, ?, ?, 'v1', ?, ?)`,
    ).bind(database, password, iv, now, now),
  ]);
  await seedKnownDatabase(env, database);
  return { database, node: enrolled };
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

// Test-only node report: the node signs its observation with its own key, and the actual API
// handler takes it. `node` is `{ id, uid, key }` of an enrolled node.
export async function publishPowerObservation(
  env,
  ctx,
  node,
  database,
  revision,
  operation,
  state,
) {
  const { createApp } = await import("../../api/src/app.ts");
  const { signNodeRequest, nodeRequestClaims } =
    await import("@pgcf/contracts");
  const path = "/node/v1/observations";
  const body = new TextEncoder().encode(
    JSON.stringify({
      observed_at: new Date().toISOString(),
      databases: [
        {
          id: database,
          generation: revision,
          operation,
          storage_generation: 1,
          state: state === "awake" ? "ready" : "asleep",
          ...(state === "awake" ? { instance: crypto.randomUUID() } : {}),
          proven_sleep:
            state === "awake"
              ? null
              : {
                  system_identifier: "7428512345678901234",
                  timeline: 1,
                  checkpoint_lsn: "0/3000028",
                  last_archived_segment: "000000010000000000000002",
                  proven_at: new Date().toISOString(),
                },
          // A ready database has the DONE base backup of its storage generation.
          backup:
            state === "awake"
              ? {
                  backup_id: "20261017T110000",
                  timeline: 1,
                  completed_at: new Date().toISOString(),
                }
              : null,
          archive: { last_segment: null, ready_files: 0, failing_since: null },
        },
      ],
      orders: [],
    }),
  );
  const token = await signNodeRequest(
    node.key,
    await nodeRequestClaims({
      node: node.id,
      uid: node.uid,
      method: "POST",
      path,
      body,
    }),
  );
  return createApp().fetch(
    new Request(new URL(path, `https://${["api", "invalid"].join(".")}`), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
    }),
    env,
    ctx,
  );
}
