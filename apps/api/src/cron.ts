// SPDX-License-Identifier: Apache-2.0
import { DatabaseId, RegionId } from "@pgcf/contracts";
import type { Env } from "./env.ts";
import { armActorWarmers } from "./domain/actor-warm.ts";
import { reconcileDatabaseActors } from "./domain/database-actor-sync.ts";
import { recoverAdmissionMutations } from "./domain/admission-mutations.ts";
import { recoverFailedResume, recoverQuiescence } from "./domain/lifecycle.ts";
import { runUsageCron, type UsageCronResult } from "./domain/usage-cron.ts";
import { cleanupRetainedArchives } from "./domain/retained-archives.ts";
import { hintNode } from "./domain/node-hints.ts";
import { runBackupRetention } from "./domain/backup-retention.ts";
import { runWebhookEvents } from "./domain/webhook-events.ts";
import { runNodeFencingCron } from "./domain/node-loss.ts";
import { purgeIdempotency } from "./middleware/idempotency.ts";
import { runInfrastructureBackupCron } from "./domain/infrastructure-backups.ts";
import { runNodeCapacityCron } from "./domain/node-capacity.ts";
import { runResourceProfileRollouts } from "./domain/resource-profiles.ts";
import {
  beginCronRun,
  cronErrorCode,
  cronErrorMessage,
  finishCronRun,
  runWithin,
  type CronStep,
  type CronStepFailure,
} from "./domain/cron-health.ts";
import { armCronWatchdog } from "./cron-watchdog.ts";

/**
 * How long one step may take before the run leaves it behind. It is a guarantee, not an answer to
 * a hung step that was seen: Cloudflare's invocation analytics (sampled; rows with
 * `requestDurationP50` 0 and at least 5 subrequests, see docs/operations/infrastructure-backups.md)
 * list 351 runs between 11:00 and 18:15 UTC on 2026-10-23, and the longest took 340 s in all
 * (median 97 s, because the platform ran them in Asia-Pacific and US colos while D1 is in WEUR);
 * the five `cron_step_failed` lines that could be matched to their run came 3 to 157 s after it
 * began, and none of those runs lasted longer than 169 s. Without a bound a step that does hang
 * would hold back every step after it. Only 4 of those 351 runs took longer than 240 s (249, 262,
 * 277 and 340 s), so a step meets the bound only when it is nearly all of a slow run, and the
 * bound is below the 300 s after which the stall alarm fires. The step is counted as failed
 * (`step_timeout`) and the next one starts; what the step left unfinished is picked up by the
 * next minute's run, as after any failure. `step_ms` in the `cron_completed` line is what shows
 * whether a step comes near it.
 */
export const CRON_STEP_TIMEOUT_MS = 240_000;

/**
 * How long after its placement a create or a restore may still be building. A node reports
 * `building` with every pull for as long as its build task is not ended, which restarts the
 * 20-minute clock of the operation (`Statements.running`), so a build that never ends keeps its
 * operation running for ever; this ceiling ends it. It is generous: the restores of a whole
 * node's population, requested in batches as the recovery runbook says, take the sum of their
 * time in the node's one big-job slot (extrapolated at 2.2 to 3.3 h for the 167 databases of
 * EU1), and the operations of one batch are far younger than that.
 */
export const BUILD_CEILING_MS = 24 * 3_600_000;

/**
 * The power operations that the power timeout undoes itself, so that the generic operation sweep
 * leaves them to it: a suspension of a database that D1 does not know asleep (it may still run,
 * and the database goes back to running), and a resume or a wake of one it knows asleep (the
 * database goes back to sleep). The two statements share this text, so that every timed-out power
 * operation is taken by exactly one of them. A suspension of a database that D1 knows asleep needs
 * no undo: the sleep it asks for is what is known, so the sweep only fails the operation, and the
 * database stays suspended. Undoing it would turn it into a resume and make a cycle with the
 * resume's revert for as long as no node reports on the database.
 */
const undoneByPowerTimeout = (database: string, operation: string) =>
  `((${database}.desired_state='suspended' AND ${database}.observed_power<>'hibernated' AND ${operation}.kind IN('database.suspend','database.hibernate'))
        OR (${database}.desired_state='running' AND ${database}.observed_power='hibernated' AND ${operation}.kind IN('database.resume','database.wake')))`;

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
 * One minute of control-plane work. Every step runs in its own failure boundary: a step that throws,
 * or does not answer within `stepTimeoutMs`, is logged (`cron_step_failed`), counted in the
 * heartbeat and reported in the result, and the steps after it still run. The heartbeat records
 * when a run started and when it attempted every step; the CronWatchdog alarm reads it
 * independently of this cron. The alerts are not a step: the same alarm evaluates them every
 * minute (`evaluateAlerts`), so that neither a slow step nor a run that does not start holds them
 * back. `step_ms` is the time each step took, in the order they ran.
 */
export async function runCron(
  env: Env,
  now = Date.now(),
  stepTimeoutMs = CRON_STEP_TIMEOUT_MS,
): Promise<{
  failed: number;
  purged: number;
  hinted: number;
  usage: UsageCronResult;
  step_failures: CronStepFailure[];
  step_ms: Partial<Record<CronStep, number>>;
}> {
  const timestamp = new Date(now).toISOString(),
    cutoff = new Date(now - 20 * 60_000).toISOString(),
    buildCeiling = new Date(now - BUILD_CEILING_MS).toISOString(),
    step_failures: CronStepFailure[] = [],
    step_ms: Partial<Record<CronStep, number>> = {};
  const attempt = async <T>(
    step: CronStep,
    fallback: T,
    run: () => Promise<T>,
  ): Promise<T> => {
    const began = Date.now();
    try {
      return await runWithin(stepTimeoutMs, "step_timeout", run);
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
          ms: Date.now() - began,
        }),
      );
      return fallback;
    } finally {
      step_ms[step] = Date.now() - began;
    }
  };
  // The heartbeat is bookkeeping: a fault or lost response must never stop the work it describes.
  let previous: Awaited<ReturnType<typeof beginCronRun>> | null = null;
  try {
    previous = await runWithin(stepTimeoutMs, "cron_heartbeat_timeout", () =>
      beginCronRun(env.DB, now),
    );
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

  // The daily backup dispatch leads, ahead of the steps that call out to other systems.
  await attempt("infrastructure_backup_dispatch", undefined, () =>
    runInfrastructureBackupCron(env, now),
  );
  await attempt("admission_recovery", undefined, () =>
    recoverAdmissionMutations(env, now),
  );
  await attempt("node_fencing", undefined, () => runNodeFencingCron(env, now));
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
        `SELECT d.id,d.generation,d.power_operation,o.kind FROM databases d
      JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL
      JOIN operations o ON o.id=d.power_operation AND o.database_id=d.id AND o.project_id=d.project_id
      WHERE d.id>? AND d.deleted_at IS NULL AND o.generation<=d.generation
      AND o.status IN('pending','running') AND o.updated_at<?
      AND ${undoneByPowerTimeout("d", "o")}
      ORDER BY d.id LIMIT 9`,
      )
        .bind(powerCursor.cursor ?? "", cutoff)
        .all<{
          id: string;
          generation: number;
          power_operation: string;
          kind: string;
        }>();
      let recovered = 0;
      const nodes = new Map<string, Set<string>>();
      for (const row of expiredPower.results.slice(0, 8)) {
        // A suspension the node did not prove is undone; a resume or a wake it did not carry out,
        // of a database that sleeps, puts the database back to sleep (nothing else would wake it).
        const expected = {
          databaseId: row.id,
          operation: row.power_operation,
          revision: row.generation,
        };
        const recovery =
          row.kind === "database.suspend" || row.kind === "database.hibernate"
            ? await recoverQuiescence(env, expected, "timeout", timestamp)
            : await recoverFailedResume(
                env,
                expected,
                "operation_timeout",
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
  // An operation's `updated_at` is its clock: placement, the first report that moves it to
  // running, and, for a create or a restore the node reports `building`, each such report (a
  // build waits for the node's one big-job slot behind others; `Statements.running`). A node
  // that reports `building` for ever (the task of the build ended, a call of it hangs) keeps that
  // clock young, so a create or a restore also ends at a ceiling after its placement.
  // An accepted delete cannot be undone: the node continues removing its resources until done.
  // Keep its operation open until that confirmation, rather than claim failure and delete later.
  // The independent database_delete_incomplete alert reports a stalled cleanup after ten minutes.
  const expired = await attempt("operation_timeouts", 0, async () => {
    // A resize that the node reported and that is still running has a filesystem that did not
    // reach the storage it asked for (`Statements.resizeRunning`): its own code says so.
    const result = await env.DB.prepare(
      `UPDATE operations SET status='failed',
      error_code=CASE WHEN kind='database.resize' AND status='running' THEN 'filesystem_not_grown' ELSE 'operation_timeout' END,
      error_message=CASE WHEN kind='database.resize' AND status='running' THEN 'The filesystem did not reach the requested storage within 20 minutes; the node tries again'
        WHEN updated_at<? THEN 'Regional operation exceeded 20 minutes' ELSE 'Build exceeded 24 hours after its placement' END,
      updated_at=?,completed_at=? WHERE status IN('pending','running') AND kind<>'database.delete' AND (updated_at<?
        OR (kind IN('database.create','database.restore') AND EXISTS(SELECT 1 FROM databases b WHERE b.id=operations.database_id AND b.node_id IS NOT NULL AND b.placed_at<?)))
      AND NOT EXISTS(SELECT 1 FROM databases u WHERE u.id=operations.database_id AND u.node_id IS NULL AND u.desired_state='running' AND u.deleted_at IS NULL AND operations.kind IN('database.create','database.restore'))
      AND NOT EXISTS(SELECT 1 FROM database_replacements rp WHERE rp.operation=operations.id AND rp.phase IN('proving','restoring','rolling_back'))
      AND NOT EXISTS(SELECT 1 FROM databases d JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL
        WHERE d.power_operation=operations.id AND d.id=operations.database_id AND d.project_id=operations.project_id
        AND d.deleted_at IS NULL AND operations.generation<=d.generation
        AND ${undoneByPowerTimeout("d", "operations")})`,
    )
      .bind(cutoff, timestamp, timestamp, cutoff, buildCeiling)
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
    // The cursor has moved on; the step still fails, so the heartbeat and the alerts see it, and
    // each Actor that did not publish is named in the log.
    for (const failure of actorPage.failed)
      console.error(
        JSON.stringify({ event: "actor_publish_failed", ...failure }),
      );
    if (actorPage.failed.length > 0) throw new Error("actor_publish_failed");
  });
  // Keeps the DatabaseActors warm; its own failure boundary, since a Worker without the binding
  // must still reconcile and meter.
  await attempt("actor_warmers", undefined, async () => {
    await armActorWarmers(env);
  });
  const usage = await attempt("usage", { ...noUsage }, () =>
    runUsageCron(env.DB, now, env),
  );
  await attempt("node_capacity", undefined, () => runNodeCapacityCron(env));
  await attempt("retained_archives", undefined, () =>
    cleanupRetainedArchives(env, now),
  );
  await attempt("backup_retention", undefined, () =>
    runBackupRetention(env, now),
  );
  // After the steps that finish operations, so that one minute's events leave in that minute.
  await attempt("webhook_events", undefined, () => runWebhookEvents(env));

  if (previous !== null)
    try {
      await runWithin(stepTimeoutMs, "cron_heartbeat_timeout", () =>
        finishCronRun(
          env.DB,
          previous,
          step_failures,
          Math.max(now, Date.now()),
        ),
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
    step_ms,
  };
}
