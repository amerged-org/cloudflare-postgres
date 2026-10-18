// SPDX-License-Identifier: Apache-2.0
/* global crypto, Request, URL, btoa, TextEncoder */
export { NodeActor } from "../../api/src/node-actor.ts";
export { DatabaseActor } from "../../api/src/database-actor.ts";
export { default } from "../src/index.ts";
import { publishDatabaseAdmission } from "../../api/src/domain/database-admission-snapshot.ts";

// Trusted fixture setup only; the Edge request entry never seeds actors. The API's own publisher
// seeds the Actor's presence and its admission snapshot from D1.
export async function seedKnownDatabase(env, id) {
  if (!(await publishDatabaseAdmission(env, id)))
    throw new Error("database_fixture_missing");
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
          backup: null,
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
