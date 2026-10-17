// SPDX-License-Identifier: Apache-2.0
import {
  archiveDestinationPath,
  DatabaseId,
  NodeId,
  newOperationId,
  ProvenSleepRecord,
  type DatabaseOrigin,
  type NodeDatabaseObservation,
  type NodeObservationReport,
} from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { Env } from "../env.ts";
import { withAdmissionMutation } from "./admission-mutations.ts";
import {
  archiveCredentialStatement,
  ensureArchiveCredential,
  newArchiveCredentialId,
} from "./archive-credentials.ts";
import { supersededStatement } from "./lifecycle-orders.ts";
import { isConstraintError } from "./rows.ts";

/**
 * A move (ULTRA plan 9.5): one database changes node, or volume on the same node, and keeps its
 * ID. D1 stays the authority at every step, and the node only ever reports.
 *
 * 1. `proving`: the source gets a `move` order. It proves the sleep of its storage generation,
 *    holds its wakes with 57P03, and reports the order done together with the database asleep and
 *    its proven-sleep record.
 * 2. `restoring`: D1 bumps the generation behind the admission fence. The database now belongs to
 *    the target with the next storage generation and a fresh archive path, the source gets a
 *    superseded order and no longer lists the database, and the target's page carries the move
 *    origin (the newest DONE backup of the source and its proven end) and credentials. The
 *    target restores through admission, replays to that end and takes its first base backup.
 * 3. `done`: the target reports the new storage generation ready, which includes the DONE backup.
 *    The source is told to remove its volume.
 *
 * A move that fails while proving leaves everything as it was. One that fails while restoring
 * leaves the source's volume in place, retired but unremoved, for the operator.
 */
export type MoveStatus = "proving" | "restoring" | "done" | "failed";
export interface DatabaseMove {
  operation: string;
  database_id: string;
  source_node_id: string;
  target_node_id: string;
  status: MoveStatus;
  failure: string | null;
  source_storage_generation: number;
  target_storage_generation: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}
interface MoveRow extends DatabaseMove {
  source_acknowledged_at: string | null;
  target_generation: number | null;
}
const VIEW_COLUMNS =
  "operation,database_id,source_node_id,target_node_id,status,failure,source_storage_generation,target_storage_generation,created_at,updated_at,completed_at";
const iso = (ms: number) => new Date(ms).toISOString();

export async function listDatabaseMoves(
  db: D1Database,
  databaseId: string,
  limit = 20,
): Promise<DatabaseMove[]> {
  return (
    await db
      .prepare(
        `SELECT ${VIEW_COLUMNS} FROM database_moves WHERE database_id=? ORDER BY created_at DESC,operation DESC LIMIT ?`,
      )
      .bind(databaseId, limit)
      .all<DatabaseMove>()
  ).results;
}
const activeMove = (db: D1Database, databaseId: string) =>
  db
    .prepare(
      `SELECT ${VIEW_COLUMNS} FROM database_moves WHERE database_id=? AND status IN('proving','restoring')`,
    )
    .bind(databaseId)
    .first<DatabaseMove>();

interface StartRow {
  id: string;
  node_id: string | null;
  region_id: string;
  generation: number;
  storage_generation: number;
  desired_state: string;
  observed_state: string;
  observed_generation: number;
  observed_power: string;
  deleted_at: string | null;
}
const liveNodeSql = `n.lost_at IS NULL AND NOT EXISTS(SELECT 1 FROM node_losses l WHERE l.node_id=n.id)`;

/**
 * Starts the move of a database to `targetNodeId`, which may be its own node: a move from one
 * volume to another is how the first node is tested. The request is answered by the existing
 * move when the same one is already running.
 */
export async function startDatabaseMove(
  env: Pick<Env, "DB">,
  input: { databaseId: string; targetNodeId: string },
  now = Date.now(),
): Promise<DatabaseMove> {
  const db = env.DB;
  const databaseId = DatabaseId.parse(input.databaseId),
    targetNodeId = NodeId.parse(input.targetNodeId);
  const row = await db
    .prepare(
      "SELECT id,node_id,region_id,generation,storage_generation,desired_state,observed_state,observed_generation,observed_power,deleted_at FROM databases WHERE id=?",
    )
    .bind(databaseId)
    .first<StartRow>();
  if (!row) throw new ApiError("not_found", "Database not found");
  if (row.deleted_at !== null || row.desired_state === "deleted")
    throw new ApiError("conflict", "Database is deleted", {
      reason: "database_deleted",
    });
  const sameOrRefuse = (active: DatabaseMove | null): DatabaseMove => {
    if (active?.target_node_id === targetNodeId) return active;
    throw new ApiError("conflict", "Another move of this database is running", {
      reason: "mutation_in_progress",
    });
  };
  const running = await activeMove(db, databaseId);
  if (running) return sameOrRefuse(running);
  // Settled: no change of its own is still being applied.
  const settled =
    row.observed_generation === row.generation &&
    (row.observed_state === "ready" ||
      (row.desired_state === "suspended" &&
        row.observed_power === "hibernated"));
  if (row.node_id === null || !settled)
    throw new ApiError("conflict", "Database configuration is not ready", {
      reason: "not_ready",
    });
  const nodes = (
    await db
      .prepare(
        `SELECT n.id,n.region_id,CASE WHEN ${liveNodeSql} THEN 1 ELSE 0 END live FROM nodes n WHERE n.id IN(?,?)`,
      )
      .bind(row.node_id, targetNodeId)
      .all<{ id: string; region_id: string; live: number }>()
  ).results;
  const target = nodes.find((node) => node.id === targetNodeId),
    source = nodes.find((node) => node.id === row.node_id);
  if (!target) throw new ApiError("not_found", "Target node not found");
  if (target.region_id !== row.region_id)
    throw new ApiError("invalid_request", "A database moves within its region");
  if (target.live !== 1 || source?.live !== 1)
    throw new ApiError(
      "conflict",
      "The source and the target must be nodes that are neither lost nor fenced",
    );
  const operation = newOperationId(),
    at = iso(now);
  let results: D1Result[];
  try {
    results = await db.batch([
      db
        .prepare(
          `INSERT INTO database_moves(operation,database_id,project_id,region_id,source_node_id,target_node_id,source_storage_generation,source_archive_path,status,created_at,updated_at)
          SELECT ?,d.id,d.project_id,d.region_id,d.node_id,?,d.storage_generation,d.archive_path,'proving',?,?
          FROM databases d WHERE d.id=? AND d.generation=? AND d.storage_generation=? AND d.node_id=? AND d.deleted_at IS NULL`,
        )
        .bind(
          operation,
          targetNodeId,
          at,
          at,
          databaseId,
          row.generation,
          row.storage_generation,
          row.node_id,
        ),
      db
        .prepare(
          `INSERT INTO lifecycle_orders(operation,node_id,type,database_id,storage_generation,created_at)
          SELECT m.operation,m.source_node_id,'move',m.database_id,m.source_storage_generation,? FROM database_moves m WHERE m.operation=?`,
        )
        .bind(at, operation),
    ]);
  } catch (error) {
    // A concurrent start won the unique slot of the database.
    if (isConstraintError(error))
      return sameOrRefuse(await activeMove(db, databaseId));
    throw error;
  }
  if (results[0]!.meta.changes !== 1)
    throw new ApiError("conflict", "Database changed; retry the request", {
      reason: "generation_changed",
    });
  return (await activeMove(db, databaseId))!;
}

/**
 * The origin of every database whose move restores onto this node now, with the operation that
 * made its generation. The node's page lists these entries with `origin`; once the target is
 * ready the entry has none. The credential reads the source archive only.
 */
export async function moveOrigins(
  db: D1Database,
  nodeId: string,
  now: number,
): Promise<Map<string, { operation: string; origin: DatabaseOrigin }>> {
  const rows = (
    await db
      .prepare(
        `SELECT operation,database_id,source_archive_path,backup_id,proven_sleep_json FROM database_moves
        WHERE target_node_id=? AND status='restoring' ORDER BY database_id`,
      )
      .bind(nodeId)
      .all<{
        operation: string;
        database_id: string;
        source_archive_path: string;
        backup_id: string;
        proven_sleep_json: string;
      }>()
  ).results;
  const origins = new Map<
    string,
    { operation: string; origin: DatabaseOrigin }
  >();
  for (const row of rows)
    origins.set(row.database_id, {
      operation: row.operation,
      origin: {
        kind: "move",
        source: {
          database_id: row.database_id,
          path: row.source_archive_path,
          backup_id: row.backup_id,
          credential: await ensureArchiveCredential(
            db,
            {
              nodeId,
              archivePath: row.source_archive_path,
              access: "read_only",
            },
            now,
          ),
          end: ProvenSleepRecord.parse(JSON.parse(row.proven_sleep_json)),
        },
      },
    });
  return origins;
}

/** Ends a move that did not finish, and with it its order. `failure` is a short lowercase class. */
export async function failMove(
  db: D1Database,
  operation: string,
  failure: string,
  at: string,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "UPDATE database_moves SET status='failed',failure=?,completed_at=?,updated_at=? WHERE operation=? AND status IN('proving','restoring')",
      )
      .bind(failure, at, at, operation),
    db
      .prepare(
        "UPDATE lifecycle_orders SET closed_at=? WHERE operation=? AND type='move' AND closed_at IS NULL AND EXISTS(SELECT 1 FROM database_moves m WHERE m.operation=? AND m.status='failed')",
      )
      .bind(at, operation, operation),
  ]);
}

/**
 * Fails the moves that a lost node can no longer carry out: those still proving on it or toward
 * it, and those restoring onto it. A move restoring away from it has nothing left to wait for.
 */
export async function failMovesOfLostNode(
  db: D1Database,
  nodeId: string,
  at: string,
): Promise<number> {
  const moves = (
    await db
      .prepare(
        `SELECT operation FROM database_moves WHERE (status='proving' AND (source_node_id=? OR target_node_id=?)) OR (status='restoring' AND target_node_id=?)`,
      )
      .bind(nodeId, nodeId, nodeId)
      .all<{ operation: string }>()
  ).results;
  for (const move of moves) await failMove(db, move.operation, "node_lost", at);
  return moves.length;
}

interface DatabaseState {
  id: string;
  node_id: string | null;
  region_id: string;
  generation: number;
  storage_generation: number;
  archive_path: string;
  deleted_at: string | null;
  backup_bucket: string;
}

/**
 * Step 2: the generation bump. Behind the admission fence, one batch moves the database to the
 * target with the next storage generation and a fresh archive path, ends the `move` order, retires
 * the source's generation and issues the target its credentials. Returns whether it applied.
 */
async function beginRestore(
  env: Env,
  move: MoveRow,
  database: DatabaseState,
  observed: NodeDatabaseObservation,
  now: number,
): Promise<boolean> {
  const at = iso(now),
    storageGeneration = move.source_storage_generation + 1,
    generation = database.generation + 1,
    path = archiveDestinationPath(
      database.backup_bucket,
      database.region_id,
      database.id,
      storageGeneration,
      move.operation,
    );
  const restoring = {
    sql: "EXISTS(SELECT 1 FROM database_moves m WHERE m.operation=? AND m.status='restoring')",
    bindings: [move.operation],
  };
  const results = await withAdmissionMutation(
    env,
    [database.id],
    async (mutation) => {
      const guard = mutation.guard(database.id);
      return mutation.batch([
        env.DB.prepare(
          `UPDATE databases SET node_id=?,generation=generation+1,storage_generation=?,archive_path=?,observed_state='provisioning',status_message=NULL,updated_at=?
          WHERE id=? AND generation=? AND storage_generation=? AND node_id=? AND archive_path=? AND deleted_at IS NULL AND desired_state IN('running','suspended')
          AND EXISTS(SELECT 1 FROM database_moves m WHERE m.operation=? AND m.status='proving')
          AND EXISTS(SELECT 1 FROM nodes n WHERE n.id=? AND ${liveNodeSql}) AND (${guard.sql})`,
        ).bind(
          move.target_node_id,
          storageGeneration,
          path,
          at,
          database.id,
          database.generation,
          move.source_storage_generation,
          move.source_node_id,
          database.archive_path,
          move.operation,
          move.target_node_id,
          ...guard.bindings,
        ),
        env.DB.prepare(
          `UPDATE database_moves SET status='restoring',target_generation=?,target_storage_generation=?,target_archive_path=?,backup_id=?,proven_sleep_json=?,updated_at=?
          WHERE operation=? AND status='proving' AND changes()=1 AND (${guard.sql})`,
        ).bind(
          generation,
          storageGeneration,
          path,
          observed.backup!.backup_id,
          JSON.stringify(observed.proven_sleep),
          at,
          move.operation,
          ...guard.bindings,
        ),
        env.DB.prepare(
          `UPDATE lifecycle_orders SET closed_at=? WHERE operation=? AND type='move' AND closed_at IS NULL AND ${restoring.sql}`,
        ).bind(at, move.operation, ...restoring.bindings),
        supersededStatement(
          env.DB,
          {
            nodeId: move.source_node_id,
            databaseId: database.id,
            storageGeneration: move.source_storage_generation,
            removeVolume: false,
            now: at,
          },
          restoring,
        ),
        archiveCredentialStatement(
          env.DB,
          {
            nodeId: move.target_node_id,
            archivePath: path,
            access: "read_write",
          },
          newArchiveCredentialId(),
          now,
        ),
        archiveCredentialStatement(
          env.DB,
          {
            nodeId: move.target_node_id,
            archivePath: database.archive_path,
            access: "read_only",
          },
          newArchiveCredentialId(),
          now,
        ),
      ]);
    },
  );
  return results[0]!.meta.changes === 1;
}

/** Step 3: the target is ready; the source's retired generation may now lose its volume. */
async function completeMove(
  db: D1Database,
  move: MoveRow,
  at: string,
): Promise<void> {
  const finished = {
    sql: "EXISTS(SELECT 1 FROM database_moves m WHERE m.operation=? AND m.status='done')",
    bindings: [move.operation],
  };
  await db.batch([
    db
      .prepare(
        "UPDATE database_moves SET status='done',completed_at=?,updated_at=? WHERE operation=? AND status='restoring'",
      )
      .bind(at, at, move.operation),
    db
      .prepare(
        `UPDATE lifecycle_orders SET closed_at=? WHERE node_id=? AND type='superseded' AND database_id=? AND storage_generation=? AND remove_volume=0 AND closed_at IS NULL AND ${finished.sql}`,
      )
      .bind(
        at,
        move.source_node_id,
        move.database_id,
        move.source_storage_generation,
        ...finished.bindings,
      ),
    supersededStatement(
      db,
      {
        nodeId: move.source_node_id,
        databaseId: move.database_id,
        storageGeneration: move.source_storage_generation,
        removeVolume: true,
        now: at,
      },
      finished,
    ),
  ]);
}

/**
 * Moves the active moves of `nodeId` one step on what its report says. Idempotent: a report that
 * arrives again, late or from a node that is not the one a step waits for changes nothing.
 */
export async function progressMoves(
  env: Env,
  nodeId: string,
  report: NodeObservationReport,
  now: number,
): Promise<void> {
  const at = iso(now);
  const active = (
    await env.DB.prepare(
      `SELECT ${VIEW_COLUMNS},source_acknowledged_at,target_generation FROM database_moves
      WHERE status IN('proving','restoring') AND (source_node_id=? OR target_node_id=?) ORDER BY operation`,
    )
      .bind(nodeId, nodeId)
      .all<MoveRow>()
  ).results;
  for (const move of active) {
    const database = await env.DB.prepare(
      "SELECT d.id,d.node_id,d.region_id,d.generation,d.storage_generation,d.archive_path,d.deleted_at,r.backup_bucket FROM databases d JOIN regions r ON r.id=d.region_id WHERE d.id=?",
    )
      .bind(move.database_id)
      .first<DatabaseState>();
    if (!database || database.deleted_at !== null) {
      await failMove(env.DB, move.operation, "database_deleted", at);
      continue;
    }
    const observed = report.databases.find((d) => d.id === move.database_id);
    if (move.status === "proving") {
      if (move.source_node_id !== nodeId) continue;
      const result = report.orders.find((o) => o.operation === move.operation);
      if (result?.status === "failed") {
        await failMove(env.DB, move.operation, result.reason!, at);
        continue;
      }
      if (result?.status === "done" && move.source_acknowledged_at === null) {
        await env.DB.prepare(
          "UPDATE database_moves SET source_acknowledged_at=?,updated_at=? WHERE operation=? AND status='proving' AND source_acknowledged_at IS NULL",
        )
          .bind(at, at, move.operation)
          .run();
        move.source_acknowledged_at = at;
      }
      if (
        move.source_acknowledged_at === null ||
        !observed ||
        database.node_id !== nodeId ||
        database.storage_generation !== move.source_storage_generation ||
        observed.storage_generation !== move.source_storage_generation ||
        observed.generation !== database.generation ||
        observed.state !== "asleep" ||
        observed.proven_sleep === null ||
        observed.backup === null
      )
        continue;
      try {
        if (!(await beginRestore(env, move, database, observed, now)))
          await failMove(env.DB, move.operation, "database_changed", at);
      } catch (error) {
        // Another change holds the database for the moment; the next report tries again.
        if (
          !(error instanceof ApiError) ||
          error.details?.reason !== "mutation_in_progress"
        )
          throw error;
      }
    } else {
      if (
        move.target_node_id !== nodeId ||
        !observed ||
        database.node_id !== nodeId ||
        observed.storage_generation !== move.target_storage_generation ||
        observed.generation < move.target_generation!
      )
        continue;
      if (observed.state === "ready") await completeMove(env.DB, move, at);
      else if (observed.state === "error")
        await failMove(
          env.DB,
          move.operation,
          observed.error ?? "build_failed",
          at,
        );
    }
  }
}
