// SPDX-License-Identifier: Apache-2.0
import { DatabaseId, RegionId, DESIRED_PAGE_LIMIT_MAX } from "@pgcf/contracts";
import type { Env } from "./env.ts";
import { reconcileDatabaseActors } from "./domain/database-actor-sync.ts";
import { recoverQuiescence } from "./domain/lifecycle.ts";
import { runUsageCron, type UsageCronResult } from "./domain/usage-cron.ts";
import { cleanupRetainedArchives } from "./domain/retained-archives.ts";
import { runFleetRollouts } from "./domain/fleet-rollouts.ts";
import { runFleetUpdates } from "./domain/fleet-updates.ts";
import { purgeIdempotency } from "./middleware/idempotency.ts";
import { runInfrastructureBackupCron } from "./domain/infrastructure-backups.ts";
import { runInfrastructureHealthAlerts } from "./domain/infrastructure-alerts.ts";
import { runNodeCapacityCron } from "./domain/node-capacity.ts";
import { runResourceProfileRollouts } from "./domain/resource-profiles.ts";

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
  await runResourceProfileRollouts(env, now);
  await env.DB.prepare(
    "INSERT INTO power_timeout_cursor(singleton,database_id) VALUES(1,NULL) ON CONFLICT(singleton) DO NOTHING",
  ).run();
  const powerCursor = await env.DB.prepare(
    "SELECT database_id cursor FROM power_timeout_cursor WHERE singleton=1",
  ).first<{ cursor: string | null }>();
  if (!powerCursor) throw new Error("power_timeout_cursor_missing");
  if (powerCursor.cursor !== null) DatabaseId.parse(powerCursor.cursor);
  // Eight compensations leave room for the existing Actor and usage pages in D1's statement budget.
  const expiredPower = await env.DB.prepare(
    `SELECT d.id,d.generation,d.power_operation FROM databases d
      JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL
      JOIN operations o ON o.id=d.power_operation AND o.database_id=d.id AND o.project_id=d.project_id
      WHERE d.id>? AND d.desired_state='suspended' AND d.deleted_at IS NULL
      AND o.kind IN('database.suspend','database.hibernate') AND o.generation<=d.generation
      AND o.status IN('pending','running') AND o.updated_at<? ORDER BY d.id LIMIT 9`,
  )
    .bind(powerCursor.cursor ?? "", cutoff)
    .all<{ id: string; generation: number; power_operation: string }>();
  let recovered = 0;
  const recoveredRegions = new Map<string, Set<string>>();
  for (const row of expiredPower.results.slice(0, 8)) {
    const recovery = await recoverQuiescence(
      env.DB,
      {
        databaseId: row.id,
        operation: row.power_operation,
        revision: row.generation,
      },
      "timeout",
      timestamp,
    );
    if (recovery) {
      recovered++;
      const ids = recoveredRegions.get(recovery.regionId) ?? new Set<string>();
      ids.add(row.id);
      recoveredRegions.set(recovery.regionId, ids);
    }
  }
  const nextPower =
    expiredPower.results.length > 8 ? expiredPower.results[7]!.id : null;
  await env.DB.prepare(
    "UPDATE power_timeout_cursor SET database_id=? WHERE singleton=1 AND database_id IS ?",
  )
    .bind(nextPower, powerCursor.cursor)
    .run();
  const result = await env.DB.prepare(
    `UPDATE operations SET status='failed',error_code='operation_timeout',error_message='Regional operation exceeded 20 minutes',updated_at=?,completed_at=? WHERE status IN('pending','running') AND updated_at<?
      AND NOT EXISTS(SELECT 1 FROM databases u WHERE u.id=operations.database_id AND u.node_id IS NULL AND u.desired_state='running' AND u.deleted_at IS NULL AND operations.kind IN('database.create','database.restore'))
      AND NOT EXISTS(SELECT 1 FROM databases d JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL
        WHERE d.power_operation=operations.id AND d.id=operations.database_id AND d.project_id=operations.project_id
        AND d.desired_state='suspended' AND d.deleted_at IS NULL AND operations.generation<=d.generation
        AND operations.kind IN('database.suspend','database.hibernate'))`,
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
    `SELECT d.region_id,d.id FROM databases d WHERE d.node_id IS NOT NULL AND (d.generation>d.observed_generation OR EXISTS(SELECT 1 FROM operations o WHERE o.database_id=d.id AND o.status IN('pending','running')))
      AND (d.region_id>? OR (d.region_id=? AND d.id>?)) ORDER BY d.region_id,d.id LIMIT 201`,
  )
    .bind(
      hintCursor.region_id ?? "",
      hintCursor.region_id ?? "",
      hintCursor.database_id ?? "",
    )
    .all<{ region_id: string; id: string }>();
  const hintPage = pending.results.slice(0, 200);
  const regions = recoveredRegions;
  for (const db of hintPage) {
    RegionId.parse(db.region_id);
    DatabaseId.parse(db.id);
    const ids = regions.get(db.region_id) ?? new Set<string>();
    ids.add(db.id);
    regions.set(db.region_id, ids);
  }
  let hinted = 0;
  for (const [regionId, ids] of regions) {
    const stub = env.REGION_LINK.get(env.REGION_LINK.idFromName(regionId));
    hinted += await stub.notify(
      ids.size <= DESIRED_PAGE_LIMIT_MAX ? [...ids] : undefined,
    );
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
  const usage = await runUsageCron(env.DB, now, env);
  await runNodeCapacityCron(env);
  await cleanupRetainedArchives(env, now);
  await runFleetUpdates(env, now);
  await runFleetRollouts(env);
  await runInfrastructureBackupCron(env, now);
  await runInfrastructureHealthAlerts(env, now);
  return { failed: result.meta.changes + recovered, purged, hinted, usage };
}
