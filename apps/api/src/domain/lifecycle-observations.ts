// SPDX-License-Identifier: Apache-2.0
import type { NodeObservationReport } from "@pgcf/contracts";
import type { Env } from "../env.ts";
import { progressMoves } from "./database-moves.ts";
import {
  progressColdStorage,
  acknowledgeColdStorageCleanup,
} from "./cold-storage.ts";
import { progressReplacements } from "./database-replacements.ts";
import { isNodeFenced, recordOrderResults } from "./lifecycle-orders.ts";
import { hintNode } from "./node-hints.ts";
import { archiveBucket } from "./archive-bucket.ts";
import { validatedArchivePrefix } from "./archive.ts";
import { recordBackupDigest } from "./archive-digests.ts";

/**
 * What the lifecycle takes from a node's observation report (`POST /node/v1/observations`): the
 * results of its orders, the move steps they unlock, and the newest recovery point of each of its
 * databases. The intake of observations calls this once per authenticated report from the node,
 * after its own bookkeeping of the databases' observed state; a fenced node's report is read for
 * its orders only. Returns how many results of orders it took. Every step is idempotent, so a
 * report may be applied twice.
 */
export async function applyLifecycleObservations(
  env: Env,
  nodeId: string,
  report: NodeObservationReport,
  now = Date.now(),
): Promise<number> {
  const { taken, maintenanceEnded } = await recordOrderResults(
    env.DB,
    nodeId,
    report.orders,
    new Date(now).toISOString(),
  );
  // The node refuses wakes until it pulls a whole page without the order; it would wait for its
  // next full pull.
  if (maintenanceEnded) await hintNode(env, nodeId).catch(() => 0);
  if (await isNodeFenced(env.DB, nodeId)) {
    await acknowledgeColdStorageCleanup(env, nodeId, report, now);
    return taken;
  }
  await progressColdStorage(env, nodeId, report, now);
  await progressReplacements(env, nodeId, report, now);
  await progressMoves(env, nodeId, report, now);
  await recordRecoveryPoints(env.DB, nodeId, report, now);
  await recordReportedBackups(env, nodeId, report, now);
  return taken;
}

/**
 * The Worker records the digest of each base backup a node reports done, the first time it reports it,
 * from the archive as it stands then: recovery and retention trust only a backup that still matches.
 * A backup it cannot record (its descriptor is not there yet, or its listing is incomplete) is
 * reported again with the next report, and stays untrusted until then.
 */
async function recordReportedBackups(
  env: Env,
  nodeId: string,
  report: NodeObservationReport,
  now: number,
): Promise<void> {
  const selected = archiveBucket(env);
  const reported = report.databases.flatMap((observed) =>
    observed.state === "deleted" || observed.backup === null
      ? []
      : [
          {
            id: observed.id,
            storage_generation: observed.storage_generation,
            backup_id: observed.backup.backup_id,
          },
        ],
  );
  if (reported.length === 0) return;
  const rows = await env.DB.batch<{
    id: string;
    region_id: string;
    archive_path: string;
    storage_generation: number;
    backup_id: string;
    recorded: number;
  }>(
    reported.map((entry) =>
      env.DB.prepare(
        `SELECT d.id,d.region_id,d.archive_path,d.storage_generation,? AS backup_id,
          EXISTS(SELECT 1 FROM archive_backup_digests g WHERE g.archive_path=d.archive_path AND g.backup_id=?) AS recorded
        FROM databases d WHERE d.id=? AND d.node_id=? AND d.storage_generation=?`,
      ).bind(
        entry.backup_id,
        entry.backup_id,
        entry.id,
        nodeId,
        entry.storage_generation,
      ),
    ),
  );
  for (const result of rows)
    for (const row of result.results) {
      if (row.recorded === 1) continue;
      try {
        await recordBackupDigest(
          selected.bucket,
          env.DB,
          row.archive_path,
          validatedArchivePrefix(row, selected.bucketName),
          row.backup_id,
          now,
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "backup_digest_not_recorded",
            database_id: row.id,
            error_code:
              error instanceof Error &&
              /^[a-z][a-z0-9_]{2,63}$/.test(error.message)
                ? error.message
                : "digest_unrecorded",
          }),
        );
      }
    }
}

/**
 * The proven-sleep record and the newest DONE backup of the current storage generation of each
 * database the node serves, with the generation the report answered. A report for a generation
 * older than D1's is stale and ignored (`observationVerdict`); a newer storage generation replaces
 * an older point, and within one storage generation the later report of an equal or newer
 * generation wins. Only a change is written.
 */
async function recordRecoveryPoints(
  db: D1Database,
  nodeId: string,
  report: NodeObservationReport,
  now: number,
): Promise<void> {
  const received = new Date(now).toISOString();
  const statements = report.databases
    .filter((observed) => observed.state !== "deleted")
    .map((observed) =>
      db
        .prepare(
          `INSERT INTO database_recovery_points(database_id,node_id,storage_generation,generation,state,proven_sleep_json,backup_json,observed_at,received_at)
          SELECT d.id,?,?,?,?,?,?,?,? FROM databases d WHERE d.id=? AND d.node_id=? AND d.storage_generation=? AND d.generation<=?
          ON CONFLICT(database_id) DO UPDATE SET node_id=excluded.node_id,storage_generation=excluded.storage_generation,generation=excluded.generation,state=excluded.state,
            proven_sleep_json=excluded.proven_sleep_json,backup_json=excluded.backup_json,observed_at=excluded.observed_at,received_at=excluded.received_at
          WHERE excluded.storage_generation>database_recovery_points.storage_generation
            OR (excluded.storage_generation=database_recovery_points.storage_generation AND excluded.generation>=database_recovery_points.generation
              AND excluded.observed_at>=database_recovery_points.observed_at
              AND (excluded.node_id<>database_recovery_points.node_id OR excluded.generation<>database_recovery_points.generation
                OR excluded.state<>database_recovery_points.state
                OR excluded.proven_sleep_json IS NOT database_recovery_points.proven_sleep_json OR excluded.backup_json IS NOT database_recovery_points.backup_json))`,
        )
        .bind(
          nodeId,
          observed.storage_generation,
          observed.generation,
          observed.state,
          observed.proven_sleep === null
            ? null
            : JSON.stringify(observed.proven_sleep),
          observed.backup === null ? null : JSON.stringify(observed.backup),
          report.observed_at,
          received,
          observed.id,
          nodeId,
          observed.storage_generation,
          observed.generation,
        ),
    );
  for (let i = 0; i < statements.length; i += 50)
    await db.batch(statements.slice(i, i + 50));
}
