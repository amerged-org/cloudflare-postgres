// SPDX-License-Identifier: Apache-2.0
import type { NodeObservationReport } from "@pgcf/contracts";
import type { Env } from "../env.ts";
import { progressMoves } from "./database-moves.ts";
import { isNodeFenced, recordOrderResults } from "./lifecycle-orders.ts";
import { hintNode } from "./node-hints.ts";

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
  if (await isNodeFenced(env.DB, nodeId)) return taken;
  await progressMoves(env, nodeId, report, now);
  await recordRecoveryPoints(env.DB, nodeId, report, now);
  return taken;
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
