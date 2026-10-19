// SPDX-License-Identifier: Apache-2.0
import {
  archiveDestinationPath,
  DatabaseId,
  NodeId,
  newOperationId,
  ProvenSleepRecord,
  type ArchiveCredentialReference,
  type DatabaseOrigin,
  type NodeDatabaseObservation,
  type NodeObservationReport,
} from "@pgcf/contracts";
import { ApiError } from "../api-error.ts";
import type { Env } from "../env.ts";
import { withAdmissionMutation } from "./admission-mutations.ts";
import { archiveBucket } from "./archive-bucket.ts";
import { BACKUP_DATA, keysOf, walRangeArchived } from "./archive-chain.ts";
import { validatedArchivePrefix } from "./archive.ts";
import {
  archiveCredentialStatement,
  ensureArchiveCredential,
  newArchiveCredentialId,
} from "./archive-credentials.ts";
import { supersededStatement } from "./lifecycle-orders.ts";
import { hintNode } from "./node-hints.ts";
import {
  choosePlacement,
  placementGuard,
  placementNodes,
} from "./placement.ts";
import { parseBackupInfo } from "./restore-catalog.ts";
import { isConstraintError } from "./rows.ts";

/**
 * A move (ULTRA plan 9.5): one database changes node, or volume on the same node, and keeps its
 * ID. D1 stays the authority at every step, and the node only ever reports. Until the target is
 * ready the database stays what D1 says it is, served by the source from its storage generation;
 * a move that fails leaves it there.
 *
 * 1. `proving`: the source gets a `move` order. It proves the sleep of its storage generation,
 *    holds its wakes with 57P03 until the order ends, and reports the order done together with
 *    the database asleep and its proven-sleep record.
 * 2. `restoring`: D1 checks that the source archive holds the newest DONE backup and the WAL
 *    through the proof, and that the target is still eligible (plan 4.8). It then stages the next
 *    storage generation in the move: a fresh archive path, the move origin (the backup and the
 *    proven end of the source) and the credentials of the target. The database row is not
 *    touched: the target's page carries the staged entry (`moveTargets`), the source's page its
 *    unchanged one, and the source keeps holding. The target restores through admission, replays
 *    to the proven end and takes its first base backup.
 * 3. `done`: the target reports the staged storage generation ready, or asleep after the proven
 *    sleep of a later timeline of the same cluster; either includes the DONE backup, which is on a
 *    timeline after the source's proof. A ready target without such a backup never promoted, and
 *    the move fails. Behind the
 *    admission fence, one batch then moves the database to the target with the staged
 *    generation, ends the `move` order, and orders the source to retire its storage generation
 *    and remove the volume.
 *
 * A move that fails while proving or restoring leaves everything as it was and ends the `move`
 * order, so the source serves again. So does any change D1 makes to the database after the move
 * staged its generation (a resize, a suspend, a wake claim): the target's work is then moot. A
 * target that is another node is told to retire and remove the storage generation it staged; on
 * the same node that cannot be said without retiring the source's own, so the staged volume
 * stays for the operator.
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
  source_archive_path: string;
  target_generation: number | null;
  target_archive_path: string | null;
  backup_id: string | null;
  proven_sleep_json: string | null;
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
 * The guard of a write that places the database `d` on the node `target`, or null when it may not
 * be placed there now (ULTRA plan 4.8): by the rules that create and resize apply, the node is
 * online, open for new databases, with an open pool and room for the database's memory and
 * storage as a database of its own resources, which on the database's own node is the second
 * volume of the move. The guard holds only while nothing else was placed on the node meanwhile.
 */
async function targetOpen(
  db: D1Database,
  databaseId: string,
  targetNodeId: string,
  now: number,
): Promise<{ sql: string; bindings: (string | number)[] } | null> {
  const need = await db
    .prepare(
      `SELECT d.region_id,r.memory_mib,r.cpu_millicores,r.storage_gib FROM databases d
      JOIN database_resources r ON r.database_id=d.id WHERE d.id=?`,
    )
    .bind(databaseId)
    .first<{
      region_id: string;
      memory_mib: number;
      cpu_millicores: number;
      storage_gib: number;
    }>();
  if (!need) return null;
  const node = (await placementNodes(db, need.region_id, now)).find(
    (value) => value.id === targetNodeId,
  );
  if (!node || choosePlacement([node], need, now) === null) return null;
  const guard = placementGuard("n", {
    nodeId: targetNodeId,
    pendingMemoryMib: node.pending_memory_mib,
    pendingStorageGib: node.pending_storage_gib,
    now,
  });
  return {
    sql: `EXISTS(SELECT 1 FROM nodes n WHERE n.region_id=d.region_id AND ${liveNodeSql} AND ${guard.sql})`,
    bindings: guard.bindings,
  };
}

async function targetFits(
  db: D1Database,
  databaseId: string,
  targetNodeId: string,
  now: number,
): Promise<boolean> {
  return (await targetOpen(db, databaseId, targetNodeId, now)) !== null;
}

/**
 * Starts the move of a database to `targetNodeId`, which may be its own node: a move from one
 * volume to another is how the first node is tested. The request is answered by the existing
 * move when the same one is already running.
 */
export async function startDatabaseMove(
  env: Pick<Env, "DB" | "NODE_ACTOR">,
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
  const open = await targetOpen(db, databaseId, targetNodeId, now);
  if (open === null)
    throw new ApiError(
      "conflict",
      "The target node cannot take the database now: it is not open for placement, has no fresh sample or no room",
      { reason: "node_capacity" },
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
          FROM databases d WHERE d.id=? AND d.generation=? AND d.storage_generation=? AND d.node_id=? AND d.deleted_at IS NULL
          AND EXISTS(SELECT 1 FROM nodes n WHERE n.id=d.node_id AND ${liveNodeSql}) AND ${open.sql}`,
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
          ...open.bindings,
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
  // The database or a node changed since the checks above; asking again says which.
  if (results[0]!.meta.changes !== 1)
    throw new ApiError("conflict", "Database changed; retry the request", {
      reason: "generation_changed",
    });
  const move = (await activeMove(db, databaseId))!;
  // The source pulls its page to find the order and prove its sleep.
  await hintNode(env, move.source_node_id).catch(() => 0);
  return move;
}

/**
 * The entry a move target's page carries for a database it restores: the staged generation, not
 * the one D1 serves. `operation` is the move, which made the staged generation. The page lists
 * this entry in place of any other entry for the database, also on the source's own node; once
 * the move is done the database row says the same and the entry is gone. The credentials read
 * the source archive and write the staged one.
 */
export interface MoveTarget {
  operation: string;
  generation: number;
  storage_generation: number;
  archive: { path: string; credential: ArchiveCredentialReference };
  origin: DatabaseOrigin;
}

/** The staged entry of every database whose move restores onto this node now. */
export async function moveTargets(
  db: D1Database,
  nodeId: string,
  now: number,
): Promise<Map<string, MoveTarget>> {
  const rows = (
    await db
      .prepare(
        `SELECT operation,database_id,source_archive_path,backup_id,proven_sleep_json,target_generation,target_storage_generation,target_archive_path
        FROM database_moves WHERE target_node_id=? AND status='restoring' ORDER BY database_id`,
      )
      .bind(nodeId)
      .all<{
        operation: string;
        database_id: string;
        source_archive_path: string;
        backup_id: string;
        proven_sleep_json: string;
        target_generation: number;
        target_storage_generation: number;
        target_archive_path: string;
      }>()
  ).results;
  const targets = new Map<string, MoveTarget>();
  for (const row of rows)
    targets.set(row.database_id, {
      operation: row.operation,
      generation: row.target_generation,
      storage_generation: row.target_storage_generation,
      archive: {
        path: row.target_archive_path,
        credential: await ensureArchiveCredential(
          db,
          {
            nodeId,
            archivePath: row.target_archive_path,
            access: "read_write",
          },
          now,
        ),
      },
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
  return targets;
}

/**
 * Ends a move that did not finish, and with it its `move` order, so that the source serves
 * again. `failure` is a short lowercase class. A target that staged a storage generation on
 * another node is told to retire it and remove its volume. Returns the nodes whose pages changed.
 */
export async function failMove(
  db: D1Database,
  operation: string,
  failure: string,
  at: string,
): Promise<string[]> {
  const move = await db
    .prepare(
      "SELECT status,database_id,source_node_id,target_node_id,target_storage_generation FROM database_moves WHERE operation=?",
    )
    .bind(operation)
    .first<{
      status: MoveStatus;
      database_id: string;
      source_node_id: string;
      target_node_id: string;
      target_storage_generation: number | null;
    }>();
  if (!move || (move.status !== "proving" && move.status !== "restoring"))
    return [];
  const statements: D1PreparedStatement[] = [];
  if (
    move.status === "restoring" &&
    move.target_node_id !== move.source_node_id
  )
    statements.push(
      supersededStatement(
        db,
        {
          nodeId: move.target_node_id,
          databaseId: move.database_id,
          storageGeneration: move.target_storage_generation!,
          removeVolume: true,
          now: at,
        },
        {
          sql: "EXISTS(SELECT 1 FROM database_moves m WHERE m.operation=? AND m.status='restoring')",
          bindings: [operation],
        },
      ),
    );
  await db.batch([
    ...statements,
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
  return [move.source_node_id, move.target_node_id];
}

/**
 * Fails the moves that a lost node can no longer carry out or serve: every move still running
 * from it or toward it. The database of a move restoring away from a lost node stays on it,
 * and its recovery is the node's. Returns the other nodes of those moves, whose pages changed.
 */
export async function failMovesOfLostNode(
  db: D1Database,
  nodeId: string,
  at: string,
): Promise<string[]> {
  const moves = (
    await db
      .prepare(
        `SELECT operation FROM database_moves WHERE status IN('proving','restoring') AND (source_node_id=? OR target_node_id=?)`,
      )
      .bind(nodeId, nodeId)
      .all<{ operation: string }>()
  ).results;
  const nodes = new Set<string>();
  for (const move of moves)
    for (const node of await failMove(db, move.operation, "node_lost", at))
      nodes.add(node);
  nodes.delete(nodeId);
  return [...nodes];
}

interface DatabaseState {
  id: string;
  node_id: string | null;
  region_id: string;
  generation: number;
  storage_generation: number;
  archive_path: string;
  deleted_at: string | null;
}

/**
 * Whether the source archive can serve the move as the source's report says: the backup is DONE
 * with its data, and the WAL is archived from the backup's first segment through the last one of
 * the proof. A fault of R2 or of the binding is thrown, not answered.
 */
async function sourceArchiveHolds(
  env: Env,
  database: DatabaseState,
  observed: NodeDatabaseObservation,
): Promise<boolean> {
  const selected = archiveBucket(env);
  const prefix = validatedArchivePrefix(database, selected.bucketName);
  const backupId = observed.backup!.backup_id,
    last = observed.proven_sleep!.last_archived_segment;
  const described = await selected.bucket.get(
    `${prefix}base/${backupId}/backup.info`,
  );
  const info =
    described && described.size <= 65536
      ? parseBackupInfo(await described.text(), backupId)
      : null;
  if (!info || info.endWal > last) return false;
  let data = false;
  for await (const key of keysOf(selected.bucket, `${prefix}base/${backupId}/`))
    if (BACKUP_DATA.test(key)) {
      data = true;
      break;
    }
  return (
    data &&
    (await walRangeArchived(selected.bucket, prefix, {
      first: info.beginWal,
      last,
      segmentBytes: info.segmentBytes,
    }))
  );
}

/**
 * Step 2: stages the next storage generation in the move, in one batch that holds only while the
 * database, both nodes and the target's eligibility are what they were: a fresh archive path, the
 * origin of the target, and its credentials. The storage generation is above every one this
 * database has been staged with, so a node that retired one never meets it again. Returns whether
 * it applied.
 */
async function beginRestore(
  env: Env,
  move: MoveRow,
  database: DatabaseState,
  observed: NodeDatabaseObservation,
  now: number,
): Promise<boolean> {
  const at = iso(now),
    staged = await env.DB.prepare(
      "SELECT COALESCE(MAX(target_storage_generation),0) highest FROM database_moves WHERE database_id=?",
    )
      .bind(database.id)
      .first<{ highest: number }>(),
    storageGeneration =
      Math.max(move.source_storage_generation, staged!.highest) + 1,
    generation = database.generation + 1,
    path = archiveDestinationPath(
      archiveBucket(env).bucketName,
      database.region_id,
      database.id,
      storageGeneration,
      move.operation,
    ),
    open = await targetOpen(env.DB, database.id, move.target_node_id, now);
  if (open === null) return false;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE database_moves SET status='restoring',target_generation=?,target_storage_generation=?,target_archive_path=?,backup_id=?,proven_sleep_json=?,updated_at=?
      WHERE operation=? AND status='proving' AND EXISTS(SELECT 1 FROM databases d WHERE d.id=? AND d.generation=? AND d.storage_generation=? AND d.node_id=? AND d.archive_path=?
        AND d.deleted_at IS NULL AND d.desired_state IN('running','suspended')
        AND EXISTS(SELECT 1 FROM nodes n WHERE n.id=d.node_id AND ${liveNodeSql}) AND ${open.sql})`,
    ).bind(
      generation,
      storageGeneration,
      path,
      observed.backup!.backup_id,
      JSON.stringify(observed.proven_sleep),
      at,
      move.operation,
      database.id,
      database.generation,
      move.source_storage_generation,
      move.source_node_id,
      database.archive_path,
      ...open.bindings,
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
  return results[0]!.meta.changes === 1;
}

/**
 * Step 3: the target is ready. Behind the admission fence, one batch moves the database to the
 * target with the staged generation, ends the `move` order and retires the source's storage
 * generation with its volume. It applies only while the database is as the move staged it, and
 * the target is live. Returns whether it applied.
 */
async function completeMove(
  env: Env,
  move: MoveRow,
  database: DatabaseState,
  now: number,
): Promise<boolean> {
  const at = iso(now);
  const finished = {
    sql: "EXISTS(SELECT 1 FROM database_moves m WHERE m.operation=? AND m.status='done')",
    bindings: [move.operation],
  };
  const results = await withAdmissionMutation(
    env,
    [database.id],
    async (mutation) => {
      const guard = mutation.guard(database.id);
      return mutation.batch([
        env.DB.prepare(
          `UPDATE databases SET node_id=?,generation=?,storage_generation=?,archive_path=?,observed_state='provisioning',status_message=NULL,updated_at=?
          WHERE id=? AND generation=? AND storage_generation=? AND node_id=? AND archive_path=? AND deleted_at IS NULL AND desired_state IN('running','suspended')
          AND EXISTS(SELECT 1 FROM database_moves m WHERE m.operation=? AND m.status='restoring')
          AND EXISTS(SELECT 1 FROM nodes n WHERE n.id=? AND ${liveNodeSql}) AND (${guard.sql})`,
        ).bind(
          move.target_node_id,
          move.target_generation,
          move.target_storage_generation,
          move.target_archive_path,
          at,
          database.id,
          move.target_generation! - 1,
          move.source_storage_generation,
          move.source_node_id,
          move.source_archive_path,
          move.operation,
          move.target_node_id,
          ...guard.bindings,
        ),
        env.DB.prepare(
          `UPDATE database_moves SET status='done',completed_at=?,updated_at=?
          WHERE operation=? AND status='restoring' AND changes()=1 AND (${guard.sql})`,
        ).bind(at, at, move.operation, ...guard.bindings),
        env.DB.prepare(
          `UPDATE lifecycle_orders SET closed_at=? WHERE operation=? AND type='move' AND closed_at IS NULL AND ${finished.sql}`,
        ).bind(at, move.operation, ...finished.bindings),
        supersededStatement(
          env.DB,
          {
            nodeId: move.source_node_id,
            databaseId: database.id,
            storageGeneration: move.source_storage_generation,
            removeVolume: true,
            now: at,
          },
          finished,
        ),
      ]);
    },
  );
  return results[0]!.meta.changes === 1;
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
  const at = iso(now),
    touched = new Set<string>();
  const fail = async (move: MoveRow, failure: string) => {
    for (const node of await failMove(env.DB, move.operation, failure, at))
      touched.add(node);
  };
  const active = (
    await env.DB.prepare(
      `SELECT ${VIEW_COLUMNS},source_acknowledged_at,source_archive_path,target_generation,target_archive_path,backup_id,proven_sleep_json FROM database_moves
      WHERE status IN('proving','restoring') AND (source_node_id=? OR target_node_id=?) ORDER BY operation`,
    )
      .bind(nodeId, nodeId)
      .all<MoveRow>()
  ).results;
  for (const move of active) {
    const database = await env.DB.prepare(
      "SELECT id,node_id,region_id,generation,storage_generation,archive_path,deleted_at FROM databases WHERE id=?",
    )
      .bind(move.database_id)
      .first<DatabaseState>();
    if (!database || database.deleted_at !== null) {
      await fail(move, "database_deleted");
      continue;
    }
    const observed = report.databases.find((d) => d.id === move.database_id);
    if (move.status === "proving") {
      if (move.source_node_id !== nodeId) continue;
      const result = report.orders.find((o) => o.operation === move.operation);
      if (result?.status === "failed") {
        await fail(move, result.reason!);
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
        if (!(await sourceArchiveHolds(env, database, observed))) {
          await fail(move, "no_recovery_point");
          continue;
        }
      } catch (error) {
        // R2 or its binding failed: the next report asks again, the source keeps holding.
        console.error(
          JSON.stringify({
            event: "move_archive_check_failed",
            database_id: move.database_id,
            error_code:
              error instanceof Error &&
              /^[a-z][a-z0-9_]{2,63}$/.test(error.message)
                ? error.message
                : "archive_check_failed",
          }),
        );
        continue;
      }
      if (await beginRestore(env, move, database, observed, now))
        touched.add(move.target_node_id);
      else
        await fail(
          move,
          (await targetFits(env.DB, move.database_id, move.target_node_id, now))
            ? "database_changed"
            : "target_not_eligible",
        );
    } else {
      if (move.target_node_id !== nodeId || !observed) continue;
      // Anything D1 did to the database since it staged the move makes the target's work moot.
      if (
        database.node_id !== move.source_node_id ||
        database.storage_generation !== move.source_storage_generation ||
        database.archive_path !== move.source_archive_path ||
        database.generation !== move.target_generation! - 1
      ) {
        await fail(move, "database_changed");
        continue;
      }
      if (
        observed.storage_generation !== move.target_storage_generation ||
        observed.generation < move.target_generation!
      )
        continue;
      if (observed.state === "error") {
        await fail(move, observed.error ?? "build_failed");
        continue;
      }
      const end = ProvenSleepRecord.parse(JSON.parse(move.proven_sleep_json!));
      // The target promoted this cluster on a later timeline and holds its first DONE backup, which
      // it took after the promotion, so on that later timeline too.
      const promoted =
        observed.backup !== null &&
        observed.backup.timeline > end.timeline &&
        (observed.state === "ready" ||
          (observed.state === "asleep" &&
            observed.proven_sleep!.timeline > end.timeline));
      if (
        observed.state === "asleep" &&
        observed.proven_sleep!.system_identifier !== end.system_identifier
      ) {
        await fail(move, "identity_mismatch");
        continue;
      }
      // A target that runs the staged generation without having promoted it cannot serve it; the
      // source serves again.
      if (observed.state === "ready" && observed.backup !== null && !promoted) {
        await fail(move, "not_promoted");
        continue;
      }
      if (!promoted) continue;
      try {
        if (await completeMove(env, move, database, now)) {
          touched.add(move.source_node_id);
          touched.add(move.target_node_id);
        } else if (
          (await activeMove(env.DB, move.database_id))?.operation ===
          move.operation
        )
          await fail(move, "database_changed");
      } catch (error) {
        // Another change holds the database for the moment; the next report tries again.
        if (
          !(error instanceof ApiError) ||
          error.details?.reason !== "mutation_in_progress"
        )
          throw error;
      }
    }
  }
  // Each node whose order or staged entry changed pulls its page.
  await Promise.allSettled([...touched].map((node) => hintNode(env, node)));
}
