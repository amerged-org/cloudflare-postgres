// SPDX-License-Identifier: Apache-2.0
/* global crypto, Request, URL */
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

// Test-only regional publisher uses the actual authenticated API observation handler.
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
          observed_at: new Date().toISOString(),
          nodes: [],
          orphans: [],
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
