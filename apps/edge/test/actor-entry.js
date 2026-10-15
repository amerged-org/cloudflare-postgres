// SPDX-License-Identifier: Apache-2.0
/* global crypto, Request, URL, btoa */
export { RegionLink } from "../../api/src/region-link.ts";
export { DatabaseActor } from "../../api/src/database-actor.ts";
export { default } from "../src/index.ts";
import { readDatabasePresence } from "../../api/src/domain/database-actor-sync.ts";

// Trusted fixture setup only; the Edge request entry never seeds actors.
export async function seedKnownDatabase(db, namespace, id) {
  const snapshot = await readDatabasePresence(db, id);
  if (!snapshot) throw new Error("database_fixture_missing");
  await namespace.get(namespace.idFromName(id)).seed(snapshot);
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
