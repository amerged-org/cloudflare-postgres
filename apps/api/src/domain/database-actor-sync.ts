// SPDX-License-Identifier: Apache-2.0
import { DatabaseId } from "@pgcf/contracts";
import { DatabasePresence } from "../database-actor.ts";
import type { ApiContext, Env } from "../env.ts";

export async function readDatabasePresence(
  db: D1Database,
  id: string,
): Promise<DatabasePresence | null> {
  DatabaseId.parse(id);
  const row = await db
    .prepare(
      `SELECT d.id database_id,d.generation revision,
    CASE WHEN p.updated_at>d.updated_at THEN p.updated_at ELSE d.updated_at END updated_at,
    CASE WHEN d.deleted_at IS NOT NULL OR d.desired_state='deleted' OR p.id IS NULL OR p.deleted_at IS NOT NULL THEN 1 ELSE 0 END deleted,
    (SELECT json_group_array(name) FROM (SELECT name FROM roles WHERE database_id=d.id AND deleted_at IS NULL ORDER BY name)) roles_json
    FROM databases d LEFT JOIN projects p ON p.id=d.project_id WHERE d.id=?`,
    )
    .bind(id)
    .first<{
      database_id: string;
      revision: number;
      updated_at: string;
      deleted: number;
      roles_json: string;
    }>();
  if (!row) return null;
  return DatabasePresence.parse({
    database_id: row.database_id,
    revision: row.revision,
    updated_at: row.updated_at,
    deleted: Boolean(row.deleted),
    roles: row.deleted ? [] : JSON.parse(row.roles_json),
  });
}

export async function syncDatabaseActor(
  c: ApiContext,
  id: string,
): Promise<boolean> {
  return sync(c.env, id);
}
async function sync(env: Env, id: string): Promise<boolean> {
  DatabaseId.parse(id);
  const snapshot = await readDatabasePresence(env.DB, id);
  if (!snapshot) return false;
  await env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id)).seed(
    snapshot,
  );
  return true;
}

/** One bounded keyset page; the cron and trusted callers decide when to read the next. */
export async function reconcileDatabaseActors(
  env: Env,
  after?: string,
  limit = 200,
): Promise<{ ids: string[]; next: string | null }> {
  if (after !== undefined) DatabaseId.parse(after);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new Error("invalid_actor_page_limit");
  const page = await env.DB.prepare(
    `SELECT id FROM databases ${after ? "WHERE id>?" : ""} ORDER BY id LIMIT ?`,
  )
    .bind(...(after ? [after, limit] : [limit]))
    .all<{ id: string }>();
  for (const row of page.results) await sync(env, DatabaseId.parse(row.id));
  const ids = page.results.map((row) => row.id);
  return { ids, next: ids.length === limit ? ids.at(-1)! : null };
}
