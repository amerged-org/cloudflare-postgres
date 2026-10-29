// SPDX-License-Identifier: Apache-2.0
import { DatabaseId } from "@pgcf/contracts";
import { DatabasePresence } from "../database-actor.ts";
import type { ApiContext, Env } from "../env.ts";

/**
 * The DatabaseActor of a database. A new object is created at the installation's configured
 * DATABASE_ACTOR_LOCATION_HINT (for example near its regions and D1); an existing one never moves.
 */
export function databaseActor(
  env: Pick<Env, "DATABASE_ACTOR" | "DATABASE_ACTOR_LOCATION_HINT">,
  id: string,
) {
  const hint = env.DATABASE_ACTOR_LOCATION_HINT;
  return env.DATABASE_ACTOR.get(
    env.DATABASE_ACTOR.idFromName(id),
    hint ? { locationHint: hint as DurableObjectLocationHint } : undefined,
  );
}

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
    (SELECT json_group_array(json_object('name',name,'valid_until',valid_until)) FROM (SELECT name,valid_until FROM roles WHERE database_id=d.id AND deleted_at IS NULL ORDER BY name)) roles_json
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
  const { publishDatabaseAdmission } =
    await import("./database-admission-snapshot.ts");
  return publishDatabaseAdmission(env, id);
}

/**
 * How many publishes of a page are under way at once. Each waits mostly on D1 and on its own
 * Actor, whose cold publish takes 250-1100 ms (measured on EU1): one after the other, a page of
 * 200 took 50-220 s, which is more than the minute the cron has; 8 at a time (as the intake of
 * observations does) it takes a fraction of that.
 */
export const ACTOR_RECONCILE_CONCURRENCY = 8;
/**
 * How long a page may keep starting publishes: the step shares its minute with the steps after
 * it. The budget stops new starts only, and the page goes on after the last one that was
 * published, in the next minute.
 */
export const ACTOR_RECONCILE_BUDGET_MS = 20_000;

/**
 * One bounded keyset page; the cron and trusted callers decide when to read the next. The
 * publishes of the page overlap (`ACTOR_RECONCILE_CONCURRENCY`) and start only until the budget is
 * spent: `ids` are the databases whose publish was attempted, the head of the page, and `next` the
 * cursor after them (the page's last, or `null` after the last page of the table). A publish that
 * fails is named in `failed` and does not stop the others: one Actor that cannot publish must not
 * hold the cursor and with it the reconciliation of every database behind it. The cursor moves on
 * and the failed one is tried again when the cursor comes round.
 */
export interface ActorPublishFailure {
  readonly database_id: string;
  readonly message: string;
}

export async function reconcileDatabaseActors(
  env: Env,
  after?: string,
  limit = 200,
  budgetMs = ACTOR_RECONCILE_BUDGET_MS,
): Promise<{
  ids: string[];
  next: string | null;
  failed: ActorPublishFailure[];
}> {
  if (after !== undefined) DatabaseId.parse(after);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new Error("invalid_actor_page_limit");
  const until = Date.now() + budgetMs;
  // Not a static import: a ticket claim loads this module (`actor-admission-imports.test.ts` pins
  // how little else it loads), and only the cron reads a page.
  const { eachBounded } = await import("./bounded.ts");
  const { cronErrorMessage } = await import("./cron-health.ts");
  const page = await env.DB.prepare(
    `SELECT id FROM databases ${after ? "WHERE id>?" : ""} ORDER BY id LIMIT ?`,
  )
    .bind(...(after ? [after, limit] : [limit]))
    .all<{ id: string }>();
  const found = page.results.map((row) => row.id);
  const failed: ActorPublishFailure[] = [];
  const started = await eachBounded(
    found,
    ACTOR_RECONCILE_CONCURRENCY,
    until,
    async (id) => {
      try {
        await sync(env, DatabaseId.parse(id));
      } catch (error) {
        failed.push({ database_id: id, message: cronErrorMessage(error) });
      }
    },
  );
  const ids = found.slice(0, started);
  failed.sort((a, b) => (a.database_id < b.database_id ? -1 : 1));
  return {
    ids,
    failed,
    next:
      started < found.length
        ? (ids.at(-1) ?? after ?? null)
        : found.length === limit
          ? ids.at(-1)!
          : null,
  };
}
