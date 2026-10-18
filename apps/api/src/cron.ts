// SPDX-License-Identifier: Apache-2.0
import { DatabaseId, RegionId } from "@pgcf/contracts";
import type { Env } from "./env.ts";
import { reconcileDatabaseActors } from "./domain/database-actor-sync.ts";
import { recoverAdmissionMutations } from "./domain/admission-mutations.ts";
import { recoverQuiescence } from "./domain/lifecycle.ts";
import { runUsageCron, type UsageCronResult } from "./domain/usage-cron.ts";
import { cleanupRetainedArchives } from "./domain/retained-archives.ts";
import { hintNode } from "./domain/node-hints.ts";
import { purgeIdempotency } from "./middleware/idempotency.ts";
import { runInfrastructureBackupCron } from "./domain/infrastructure-backups.ts";
import {
  runCapacityAlertsCron,
  runInfrastructureHealthAlerts,
} from "./domain/infrastructure-alerts.ts";
import { runNodeCapacityCron } from "./domain/node-capacity.ts";
import { runResourceProfileRollouts } from "./domain/resource-profiles.ts";
import {
  beginCronRun,
  cronErrorCode,
  cronErrorMessage,
  finishCronRun,
  type CronStep,
  type CronStepFailure,
} from "./domain/cron-health.ts";
import { armCronWatchdog } from "./cron-watchdog.ts";

/** Time one run may spend sending alert notifications; the rest wait for the next minute. */
export const ALERT_DELIVERY_BUDGET_MS = 20_000;

const noUsage: UsageCronResult = {
  databases: 0,
  hours: 0,
  finalized: 0,
  failed: 0,
  statements: 0,
  exhausted: false,
  overlap: false,
  next: null,
  pruned: 0,
  backupMeasured: 0,
  backupUnavailable: 0,
};

/**
 * One minute of control-plane work. Every step runs in its own failure boundary: a step that throws
 * is logged (`cron_step_failed`), counted in the heartbeat and reported in the result, and the steps
 * after it still run. The heartbeat records when a run started and when it attempted every step; the
 * CronWatchdog alarm reads it independently of this cron.
 */
export async function runCron(
  env: Env,
  now = Date.now(),
  deliveryBudgetMs = ALERT_DELIVERY_BUDGET_MS,
): Promise<{
  failed: number;
  purged: number;
  hinted: number;
  usage: UsageCronResult;
  step_failures: CronStepFailure[];
}> {
  const timestamp = new Date(now).toISOString(),
    cutoff = new Date(now - 20 * 60_000).toISOString(),
    step_failures: CronStepFailure[] = [];
  const attempt = async <T>(
    step: CronStep,
    fallback: T,
    run: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      const error_code = cronErrorCode(error);
      step_failures.push({ step, error_code });
      // The log line also carries the redacted message; the heartbeat and alerts carry the code.
      console.error(
        JSON.stringify({
          event: "cron_step_failed",
          step,
          error_code,
          message: cronErrorMessage(error),
        }),
      );
      return fallback;
    }
  };
  // The heartbeat is bookkeeping: a fault there must never stop the work it describes.
  let previous: Awaited<ReturnType<typeof beginCronRun>> | null = null;
  try {
    previous = await beginCronRun(env.DB, now);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "cron_heartbeat_failed",
        phase: "start",
        error_code: cronErrorCode(error),
      }),
    );
  }
  await armCronWatchdog(env);

  // Alerting needs only D1 and a bounded send, so it runs first and a slow or failing step below
  // cannot starve it; the daily backup dispatch follows, ahead of the steps that call out. Alerting
  // in turn may not hold the steps after it back: once the budget is spent a notification stays
  // unclaimed and the next minute's run sends it.
  const deliverBefore = Date.now() + deliveryBudgetMs;
  await attempt("health_alerts", undefined, () =>
    runInfrastructureHealthAlerts(env, now, fetch, deliverBefore),
  );
  await attempt("capacity_alerts", undefined, () =>
    runCapacityAlertsCron(env, now, fetch, deliverBefore),
  );
  await attempt("infrastructure_backup_dispatch", undefined, () =>
    runInfrastructureBackupCron(env, now),
  );
  await attempt("admission_recovery", undefined, () =>
    recoverAdmissionMutations(env, now),
  );
  await attempt("resource_profile_rollouts", undefined, () =>
    runResourceProfileRollouts(env, now),
  );
  const power = await attempt(
    "power_timeouts",
    { recovered: 0, nodes: new Map<string, Set<string>>() },
    async () => {
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
      const nodes = new Map<string, Set<string>>();
      for (const row of expiredPower.results.slice(0, 8)) {
        const recovery = await recoverQuiescence(
          env,
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
          if (recovery.nodeId !== null) {
            const ids = nodes.get(recovery.nodeId) ?? new Set<string>();
            ids.add(row.id);
            nodes.set(recovery.nodeId, ids);
          }
        }
      }
      const nextPower =
        expiredPower.results.length > 8 ? expiredPower.results[7]!.id : null;
      await env.DB.prepare(
        "UPDATE power_timeout_cursor SET database_id=? WHERE singleton=1 AND database_id IS ?",
      )
        .bind(nextPower, powerCursor.cursor)
        .run();
      return { recovered, nodes };
    },
  );
  const expired = await attempt("operation_timeouts", 0, async () => {
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
    return result.meta.changes;
  });
  // A role removal the region never reported ends like any other regional operation; the role
  // stays unroutable and the region is still asked, so a later report can still free its name.
  const expiredRoleDeletions = await attempt(
    "role_deletion_timeouts",
    0,
    async () => {
      const result = await env.DB.prepare(
        `UPDATE role_deletions SET status='failed',error_code='operation_timeout',error_message='Regional operation exceeded 20 minutes',updated_at=?,completed_at=? WHERE status IN('pending','running') AND updated_at<?`,
      )
        .bind(timestamp, timestamp, cutoff)
        .run();
      return result.meta.changes;
    },
  );
  const purged = await attempt("idempotency_purge", 0, () =>
    purgeIdempotency(env.DB, now),
  );
  const hinted = await attempt("node_hints", 0, async () => {
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
      `SELECT d.region_id,d.id,d.node_id FROM databases d WHERE d.node_id IS NOT NULL AND (d.generation>d.observed_generation OR (EXISTS(SELECT 1 FROM operations o WHERE o.database_id=d.id AND o.status IN('pending','running')) OR EXISTS(SELECT 1 FROM role_deletions rd WHERE rd.database_id=d.id AND rd.status IN('pending','running'))))
      AND (d.region_id>? OR (d.region_id=? AND d.id>?)) ORDER BY d.region_id,d.id LIMIT 201`,
    )
      .bind(
        hintCursor.region_id ?? "",
        hintCursor.region_id ?? "",
        hintCursor.database_id ?? "",
      )
      .all<{ region_id: string; id: string; node_id: string }>();
    const hintPage = pending.results.slice(0, 200);
    const nodes = power.nodes;
    for (const db of hintPage) {
      RegionId.parse(db.region_id);
      DatabaseId.parse(db.id);
      const ids = nodes.get(db.node_id) ?? new Set<string>();
      ids.add(db.id);
      nodes.set(db.node_id, ids);
    }
    let notified = 0;
    for (const [nodeId, ids] of nodes)
      notified += await hintNode(env, nodeId, [...ids]);
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
    return notified;
  });
  await attempt("database_actors", undefined, async () => {
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
  });
  const usage = await attempt("usage", { ...noUsage }, () =>
    runUsageCron(env.DB, now, env),
  );
  await attempt("node_capacity", undefined, () => runNodeCapacityCron(env));
  await attempt("retained_archives", undefined, () =>
    cleanupRetainedArchives(env, now),
  );

  if (previous !== null)
    try {
      await finishCronRun(
        env.DB,
        previous,
        step_failures,
        Math.max(now, Date.now()),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "cron_heartbeat_failed",
          phase: "finish",
          error_code: cronErrorCode(error),
        }),
      );
    }
  return {
    failed: expired + expiredRoleDeletions + power.recovered,
    purged,
    hinted,
    usage,
    step_failures,
  };
}
