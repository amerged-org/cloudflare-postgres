// SPDX-License-Identifier: Apache-2.0
import { DatabaseId, RegionId } from "@pgcf/contracts";
import type { Env } from "./env.ts";
import { reconcileDatabaseActors } from "./domain/database-actor-sync.ts";
import { runUsageCron, type UsageCronResult } from "./domain/usage-cron.ts";
import { purgeIdempotency } from "./middleware/idempotency.ts";

export async function runCron(
  env: Env,
  now = Date.now(),
): Promise<{
  failed: number;
  purged: number;
  hinted: number;
  usage: UsageCronResult;
}> {
  const timestamp = new Date(now).toISOString(),
    cutoff = new Date(now - 20 * 60_000).toISOString();
  const result = await env.DB.prepare(
    `UPDATE operations SET status='failed',error_code='operation_timeout',error_message='Regional operation exceeded 20 minutes',updated_at=?,completed_at=? WHERE status IN('pending','running') AND updated_at<?`,
  )
    .bind(timestamp, timestamp, cutoff)
    .run();
  const purged = await purgeIdempotency(env.DB, now);
  await env.DB.prepare(
    "INSERT INTO region_hint_cursor(singleton,region_id,database_id) VALUES(1,NULL,NULL) ON CONFLICT(singleton) DO NOTHING",
  ).run();
  const hintCursor = await env.DB.prepare(
    "SELECT region_id,database_id FROM region_hint_cursor WHERE singleton=1",
  ).first<{ region_id: string | null; database_id: string | null }>();
  if (
    !hintCursor ||
    (hintCursor.region_id === null) !== (hintCursor.database_id === null)
  )
    throw new Error("invalid_region_hint_cursor");
  if (hintCursor.region_id !== null) {
    RegionId.parse(hintCursor.region_id);
    DatabaseId.parse(hintCursor.database_id);
  }
  const pending = await env.DB.prepare(
    `SELECT d.region_id,d.id FROM databases d WHERE (d.generation>d.observed_generation OR EXISTS(SELECT 1 FROM operations o WHERE o.database_id=d.id AND o.status IN('pending','running')))
      AND (d.region_id>? OR (d.region_id=? AND d.id>?)) ORDER BY d.region_id,d.id LIMIT 201`,
  )
    .bind(
      hintCursor.region_id ?? "",
      hintCursor.region_id ?? "",
      hintCursor.database_id ?? "",
    )
    .all<{ region_id: string; id: string }>();
  const hintPage = pending.results.slice(0, 200);
  const regions = new Map<string, string[]>();
  for (const db of hintPage) {
    RegionId.parse(db.region_id);
    DatabaseId.parse(db.id);
    const ids = regions.get(db.region_id) ?? [];
    ids.push(db.id);
    regions.set(db.region_id, ids);
  }
  let hinted = 0;
  for (const [regionId, ids] of regions) {
    const stub = env.REGION_LINK.get(env.REGION_LINK.idFromName(regionId));
    hinted += await stub.notify(ids);
  }
  const lastHint = pending.results.length > 200 ? hintPage.at(-1)! : null;
  await env.DB.prepare(
    "UPDATE region_hint_cursor SET region_id=?,database_id=? WHERE singleton=1 AND region_id IS ? AND database_id IS ?",
  )
    .bind(
      lastHint?.region_id ?? null,
      lastHint?.id ?? null,
      hintCursor.region_id,
      hintCursor.database_id,
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO reconciliation_cursors(name,cursor) VALUES('database_actors',NULL) ON CONFLICT(name) DO NOTHING",
  ).run();
  const cursor = await env.DB.prepare(
    "SELECT cursor FROM reconciliation_cursors WHERE name='database_actors'",
  ).first<{ cursor: string | null }>();
  if (!cursor) throw new Error("actor_reconciliation_cursor_missing");
  const actorPage = await reconcileDatabaseActors(
    env,
    cursor.cursor ?? undefined,
  );
  await env.DB.prepare(
    "UPDATE reconciliation_cursors SET cursor=? WHERE name='database_actors' AND cursor IS ?",
  )
    .bind(actorPage.next, cursor.cursor)
    .run();
  const usage = await runUsageCron(env.DB, now);
  return { failed: result.meta.changes, purged, hinted, usage };
}
