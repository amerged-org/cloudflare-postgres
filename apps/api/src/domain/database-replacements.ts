// SPDX-License-Identifier: Apache-2.0
import {
  archiveDestinationPath,
  newOperationId,
  parseArchivePath,
  ProvenSleepRecord,
  DatabaseRuntime,
  NODE_STALE_MS,
  type DatabaseOrigin,
  type NodeDatabaseObservation,
  type NodeObservationReport,
} from "@pgcf/contracts";
import { ApiError } from "../api-error.ts";
import {
  databaseNeedsExtended,
  requireExtendedNative,
} from "./native-capabilities.ts";
import type { ApiContext, Env } from "../env.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import {
  databaseForRequest,
  databaseView,
  operationForRequest,
  operationView,
} from "./rows.ts";
import { archiveBucket } from "./archive-bucket.ts";
import { validatedArchivePrefix } from "./archive.ts";
import { restoreBackup } from "./restore-catalog.ts";
import { ensureArchiveCredential } from "./archive-credentials.ts";
import {
  publishForAnswer,
  withAdmissionMutation,
} from "./admission-mutations.ts";
import { hintNode } from "./node-hints.ts";
import { sourceArchiveHolds } from "./database-moves.ts";
import { supersededStatement } from "./lifecycle-orders.ts";
import { USAGE_SNAPSHOT_SQL } from "./resources.ts";
import {
  choosePlacement,
  placementNodes,
  placementGuard,
} from "./placement.ts";

export const ACTIVE_REPLACEMENT =
  "phase IN('proving','restoring','rolling_back')";
interface Replacement {
  operation: string;
  database_id: string;
  node_id: string;
  project_id: string;
  region_id: string;
  phase: "proving" | "restoring" | "rolling_back" | "succeeded" | "failed";
  source_generation: number;
  source_storage_generation: number;
  source_archive_path: string;
  source_backup_id: string | null;
  source_proof_json: string | null;
  source_acknowledged_at: string | null;
  requested_backup_id: string;
  target_time: string;
  target_generation: number | null;
  target_storage_generation: number | null;
  target_archive_path: string | null;
  rollback_generation: number | null;
  rollback_storage_generation: number | null;
  rollback_archive_path: string | null;
  failure: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  retained_until: string | null;
}
const active = (db: D1Database, id: string) =>
  db
    .prepare(
      `SELECT * FROM database_replacements WHERE database_id=? AND ${ACTIVE_REPLACEMENT}`,
    )
    .bind(id)
    .first<Replacement>();
export async function assertNoReplacement(db: D1Database, id: string) {
  if (await active(db, id))
    throw new ApiError("conflict", "An in-place restore holds this database", {
      reason: "mutation_in_progress",
    });
}
/** Capability is committed with this link's hello/release; samples cannot enable it. */
export async function replacementCapable(
  db: D1Database,
  nodeId: string,
  now = Date.now(),
  requireFreshSample = true,
) {
  return !!(await db
    .prepare(
      `SELECT 1 FROM nodes n JOIN fleet_region_releases f ON f.region_id=n.region_id
 WHERE n.id=? AND n.reported_release_id=f.release_id AND n.lost_at IS NULL
 ${requireFreshSample ? "AND n.ready=1 AND n.last_observed_at>=? AND n.last_observed_at<=?" : ""}
 AND n.restore_in_place_capable=1
 AND NOT EXISTS(SELECT 1 FROM node_losses WHERE node_id=n.id)`,
    )
    .bind(
      nodeId,
      ...(requireFreshSample
        ? [
            new Date(now - NODE_STALE_MS).toISOString(),
            new Date(now + 5000).toISOString(),
          ]
        : []),
    )
    .first());
}
async function answer(c: ApiContext, operationId: string, status = 202) {
  const operation = await operationForRequest(c, operationId),
    database = await databaseForRequest(c, operation.database_id);
  await publishForAnswer(c, database.id);
  c.header("Location", `/v1/operations/${operationId}`);
  return Response.json(
    { database: databaseView(database), operation: operationView(operation) },
    { status, headers: c.res.headers },
  );
}
export async function startDatabaseReplacement(
  c: ApiContext,
  id: string,
  body: { mode: "pitr"; target_time: string },
) {
  await databaseForRequest(c, id);
  return withIdempotency(c, {
    replay: (op, status) => answer(c, op, status),
    execute: async (lease) => {
      const source = await databaseForRequest(c, id),
        now = Date.now(),
        at = new Date(now).toISOString();
      await assertNoReplacement(c.env.DB, id);
      if (body.target_time > at)
        throw new ApiError(
          "invalid_request",
          "Recovery time must not be in the future",
        );
      if (
        !source.node_id ||
        !(await replacementCapable(c.env.DB, source.node_id, now))
      )
        throw new ApiError(
          "conflict",
          "The owning node must be converged and advertise in-place restore support",
          { reason: "not_ready" },
        );
      if (
        source.generation !== source.observed_generation ||
        !(
          source.observed_state === "ready" ||
          source.observed_power === "hibernated"
        )
      )
        throw new ApiError("conflict", "Database configuration is not ready", {
          reason: "not_ready",
        });
      const native = await requireExtendedNative(
        c.env,
        { nodeId: source.node_id },
        await databaseNeedsExtended(c.env, id),
        now,
      );
      const resources = await c.env.DB.prepare(
        "SELECT memory_mib,cpu_millicores,storage_mib FROM database_resources WHERE database_id=?",
      )
        .bind(id)
        .first<{
          memory_mib: number;
          cpu_millicores: number;
          storage_mib: number;
        }>();
      const node = (await placementNodes(c.env.DB, source.region_id, now)).find(
        (n) => n.id === source.node_id,
      );
      if (!resources || !node || !choosePlacement([node], resources, now))
        throw new ApiError(
          "conflict",
          "The node needs room for a retained source and replacement",
          { reason: "node_capacity" },
        );
      const capacity = placementGuard("n", {
        nodeId: node.id,
        pendingMemoryMib: node.pending_memory_mib,
        pendingStorageMib: node.pending_storage_mib,
        now,
      });
      const selected = archiveBucket(c.env),
        backup = await restoreBackup(
          selected.bucket,
          validatedArchivePrefix(source, selected.bucketName),
          body.target_time,
        );
      const op = newOperationId();
      const result = await withAdmissionMutation(
        c.env,
        [id],
        async (mutation) => {
          const guard = mutation.guard(id);
          return mutation.batch([
            c.env.DB.prepare(
              `INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at)
     SELECT ?,'database.restore','running',d.project_id,d.id,d.generation,?,? FROM databases d
     WHERE d.id=? AND d.generation=? AND d.node_id=? AND d.archive_path=? AND d.deleted_at IS NULL
     AND NOT EXISTS(SELECT 1 FROM database_replacements WHERE database_id=d.id AND ${ACTIVE_REPLACEMENT})
     AND NOT EXISTS(SELECT 1 FROM database_moves WHERE database_id=d.id AND status IN('proving','restoring'))
     AND NOT EXISTS(SELECT 1 FROM operations WHERE database_id=d.id AND status IN('pending','running'))
     AND EXISTS(SELECT 1 FROM nodes n WHERE ${capacity.sql}) AND ${guard.sql} AND ${lease.guard.sql} AND (${native.sql})`,
            ).bind(
              op,
              at,
              at,
              id,
              source.generation,
              source.node_id,
              source.archive_path,
              ...capacity.bindings,
              ...guard.bindings,
              ...lease.guard.bindings,
              ...native.bindings,
            ),
            c.env.DB.prepare(
              `INSERT INTO database_replacements(operation,database_id,node_id,project_id,region_id,phase,source_generation,source_storage_generation,source_archive_path,requested_backup_id,target_time,created_at,updated_at)
     SELECT o.id,d.id,d.node_id,d.project_id,d.region_id,'proving',d.generation,d.storage_generation,d.archive_path,?,?,?,? FROM operations o JOIN databases d ON d.id=o.database_id WHERE o.id=?`,
            ).bind(backup.id, body.target_time, at, at, op),
            c.env.DB.prepare(
              `INSERT INTO lifecycle_orders(operation,node_id,type,database_id,storage_generation,created_at)
     SELECT operation,node_id,'move',database_id,source_storage_generation,? FROM database_replacements WHERE operation=?`,
            ).bind(at, op),
            lease.completeStatement(op, 202, {
              sql: "EXISTS(SELECT 1 FROM database_replacements WHERE operation=?)",
              bindings: [op],
            }),
          ]);
        },
      );
      if (result[0]!.meta.changes !== 1)
        throw new ApiError(
          "conflict",
          "Database or placement changed; retry the request",
          { reason: "generation_changed" },
        );
      await hintNode(c.env, source.node_id).catch(() => 0);
      return answer(c, op);
    },
  });
}
export async function replacementHistory(c: ApiContext, id: string) {
  await databaseForRequest(c, id, true);
  const rows = await c.env.DB.prepare(
    `SELECT operation,phase,target_time,failure,created_at,completed_at,retained_until FROM database_replacements WHERE database_id=? ORDER BY created_at DESC,operation DESC LIMIT 50`,
  )
    .bind(id)
    .all();
  return c.json({ data: rows.results, next_cursor: null });
}
/** Staged generations never change the public identity or the source row before readiness. */
export async function replacementTargets(
  env: Env,
  nodeId: string,
  now: number,
) {
  const result = new Map<
    string,
    {
      operation: string;
      generation: number;
      storage_generation: number;
      archive: {
        path: string;
        credential: Awaited<ReturnType<typeof ensureArchiveCredential>>;
      };
      origin: DatabaseOrigin;
    }
  >();
  const rows = (
    await env.DB.prepare(
      "SELECT * FROM database_replacements WHERE node_id=? AND phase IN('restoring','rolling_back')",
    )
      .bind(nodeId)
      .all<Replacement>()
  ).results;
  // Recovery starts from the first desired page, before this process can emit a sample.
  if (
    rows.length === 0 ||
    !(await replacementCapable(env.DB, nodeId, now, false))
  )
    return result;
  for (const row of rows) {
    const rollback = row.phase === "rolling_back",
      path = (rollback ? row.rollback_archive_path : row.target_archive_path)!;
    const source = {
      database_id: row.database_id,
      path: row.source_archive_path,
      backup_id: (rollback ? row.source_backup_id : row.requested_backup_id)!,
      credential: await ensureArchiveCredential(
        env.DB,
        { nodeId, archivePath: row.source_archive_path, access: "read_only" },
        now,
      ),
    };
    const end = ProvenSleepRecord.parse(JSON.parse(row.source_proof_json!));
    result.set(row.database_id, {
      operation: row.operation,
      generation: (rollback ? row.rollback_generation : row.target_generation)!,
      storage_generation: (rollback
        ? row.rollback_storage_generation
        : row.target_storage_generation)!,
      archive: {
        path,
        credential: await ensureArchiveCredential(
          env.DB,
          { nodeId, archivePath: path, access: "read_write" },
          now,
        ),
      },
      origin: rollback
        ? {
            kind: "replace_rollback",
            source,
            previous: {
              storage_generation: row.source_storage_generation,
              end,
            },
            replacement_generation: row.target_storage_generation!,
          }
        : {
            kind: "replace",
            source: { ...source, target_time: row.target_time },
            previous: {
              storage_generation: row.source_storage_generation,
              end,
            },
          },
    });
  }
  return result;
}
async function highestStorage(db: D1Database, id: string, current: number) {
  const row = await db
    .prepare(
      `SELECT MAX(g) highest FROM (
 SELECT storage_generation g FROM databases WHERE id=? UNION ALL SELECT target_storage_generation FROM database_moves WHERE database_id=?
 UNION ALL SELECT target_storage_generation FROM database_replacements WHERE database_id=? UNION ALL SELECT rollback_storage_generation FROM database_replacements WHERE database_id=?)`,
    )
    .bind(id, id, id, id)
    .first<{ highest: number }>();
  return Math.max(current, row?.highest ?? 0);
}
async function finish(
  env: Env,
  row: Replacement,
  success: boolean,
  observed: NodeDatabaseObservation,
  now: number,
  observedAt: string,
) {
  const at = new Date(now).toISOString(),
    rolled = row.phase === "rolling_back";
  const generation = rolled ? row.rollback_generation : row.target_generation,
    storage = rolled
      ? row.rollback_storage_generation
      : row.target_storage_generation,
    path = rolled ? row.rollback_archive_path : row.target_archive_path;
  const awake = observed.state === "ready";
  const runtime = awake
    ? JSON.stringify(
        DatabaseRuntime.parse({
          database_id: row.database_id,
          node_id: row.node_id,
          generation,
          storage_generation: storage,
          instance: observed.instance,
          observed_at: now,
        }),
      )
    : null;
  const terminal = {
    sql: `EXISTS(SELECT 1 FROM database_replacements rp JOIN databases d ON d.id=rp.database_id
      WHERE rp.operation=? AND rp.phase=? AND rp.completed_at=? AND d.generation=? AND d.storage_generation=? AND d.archive_path=?)`,
    bindings: [
      row.operation,
      success ? "succeeded" : "failed",
      at,
      generation,
      storage,
      path,
    ],
  };
  await withAdmissionMutation(env, [row.database_id], async (mutation) => {
    const guard = mutation.guard(row.database_id);
    return mutation.batch([
      env.DB.prepare(
        `UPDATE databases SET generation=?,storage_generation=?,archive_path=?,observed_generation=?,observed_state=?,observed_power=?,
        desired_state=CASE WHEN ?=1 AND suspension_reason='idle' THEN 'running' ELSE desired_state END,
        power_operation=CASE WHEN ?=1 AND suspension_reason='idle' THEN NULL ELSE power_operation END,
        suspension_reason=CASE WHEN ?=1 AND suspension_reason='idle' THEN NULL ELSE suspension_reason END,
        status_message=NULL,runtime_json=?,backup_last_completed_at=?,backup_observed_at=?,updated_at=?
    WHERE id=? AND node_id=? AND storage_generation=? AND archive_path=? AND generation=? AND deleted_at IS NULL
      AND EXISTS(SELECT 1 FROM database_replacements rp WHERE rp.operation=? AND rp.phase=?)
      AND EXISTS(SELECT 1 FROM nodes n WHERE n.id=? AND n.lost_at IS NULL AND NOT EXISTS(SELECT 1 FROM node_losses l WHERE l.node_id=n.id))
      AND ${guard.sql}`,
      ).bind(
        generation,
        storage,
        path,
        generation,
        awake ? "ready" : "provisioning",
        awake ? "awake" : "hibernated",
        Number(awake),
        Number(awake),
        Number(awake),
        runtime,
        observed.backup!.completed_at,
        at,
        at,
        row.database_id,
        row.node_id,
        row.source_storage_generation,
        row.source_archive_path,
        row.source_generation,
        row.operation,
        row.phase,
        row.node_id,
        ...guard.bindings,
      ),
      // Consume the database update's result before the optional Ready insert changes it.
      env.DB.prepare(
        `UPDATE database_replacements SET phase=?,completed_at=?,updated_at=?,retained_until=strftime('%Y-%m-%dT%H:%M:%fZ',?,'+'||(SELECT s.backup_retention_days FROM databases d JOIN size_classes s ON s.id=d.size_class_id WHERE d.id=database_replacements.database_id)||' days')
    WHERE operation=? AND phase=? AND changes()=1`,
      ).bind(
        success ? "succeeded" : "failed",
        at,
        at,
        at,
        row.operation,
        row.phase,
      ),
      env.DB.prepare(
        `INSERT INTO lifecycle_events(database_id,kind,node_id,size_class_id,generation,occurred_at,resource_snapshot)
         SELECT d.id,'ready',d.node_id,d.size_class_id,d.generation,?,${USAGE_SNAPSHOT_SQL}
         FROM databases d JOIN database_resources r ON r.database_id=d.id
         WHERE d.id=? AND d.node_id=? AND d.generation=? AND ?=1 AND changes()=1
         AND ${terminal.sql}
         AND NOT EXISTS(SELECT 1 FROM lifecycle_events WHERE database_id=d.id AND kind='ready' AND generation=d.generation)`,
      ).bind(
        observedAt,
        row.database_id,
        row.node_id,
        generation,
        Number(awake),
        ...terminal.bindings,
      ),
      env.DB.prepare(
        `UPDATE operations SET generation=?,status=?,error_code=?,error_message=?,updated_at=?,completed_at=? WHERE id=? AND ${terminal.sql}`,
      ).bind(
        generation,
        success ? "succeeded" : "failed",
        success ? null : row.failure,
        success
          ? null
          : "In-place restore failed; the proven prior state was recovered",
        at,
        at,
        row.operation,
        ...terminal.bindings,
      ),
      env.DB.prepare(
        `UPDATE lifecycle_orders SET closed_at=? WHERE operation=? AND closed_at IS NULL AND ${terminal.sql}`,
      ).bind(at, row.operation, ...terminal.bindings),
      supersededStatement(
        env.DB,
        {
          nodeId: row.node_id,
          databaseId: row.database_id,
          storageGeneration: storage! - 1,
          removeVolume: true,
          now: at,
        },
        terminal,
      ),
    ]);
  });
}
/** Every transition is driven by the matching authenticated node report and a guarded D1 write. */
export async function progressReplacements(
  env: Env,
  nodeId: string,
  report: NodeObservationReport,
  now = Date.now(),
) {
  const rows = (
    await env.DB.prepare(
      `SELECT * FROM database_replacements WHERE node_id=? AND ${ACTIVE_REPLACEMENT}`,
    )
      .bind(nodeId)
      .all<Replacement>()
  ).results;
  const at = new Date(now).toISOString();
  for (const row of rows) {
    const observed = report.databases.find((db) => db.id === row.database_id);
    const database = await env.DB.prepare(
      "SELECT id,node_id,region_id,generation,storage_generation,archive_path,deleted_at FROM databases WHERE id=?",
    )
      .bind(row.database_id)
      .first<{
        id: string;
        node_id: string;
        region_id: string;
        generation: number;
        storage_generation: number;
        archive_path: string;
        deleted_at: string | null;
      }>();
    if (
      !database ||
      database.deleted_at !== null ||
      database.node_id !== nodeId
    )
      continue;
    await env.DB.prepare(
      "UPDATE operations SET updated_at=? WHERE id=? AND status IN('pending','running')",
    )
      .bind(at, row.operation)
      .run();
    if (row.phase === "proving") {
      const result = report.orders.find((o) => o.operation === row.operation);
      if (result?.status === "failed") {
        // No new storage was staged: the unchanged source can serve again.
        const failedHere = {
          sql: "EXISTS(SELECT 1 FROM database_replacements WHERE operation=? AND phase='failed' AND failure=? AND completed_at=?)",
          bindings: [row.operation, result.reason!, at],
        };
        await withAdmissionMutation(env, [row.database_id], (m) =>
          m.batch([
            env.DB.prepare(
              "UPDATE database_replacements SET phase='failed',failure=?,completed_at=?,updated_at=? WHERE operation=? AND phase='proving'",
            ).bind(result.reason!, at, at, row.operation),
            env.DB.prepare(
              `UPDATE operations SET status='failed',error_code=?,error_message='Source could not prove sleep',updated_at=?,completed_at=? WHERE id=? AND ${failedHere.sql}`,
            ).bind(
              result.reason!,
              at,
              at,
              row.operation,
              ...failedHere.bindings,
            ),
            env.DB.prepare(
              `UPDATE lifecycle_orders SET closed_at=? WHERE operation=? AND closed_at IS NULL AND ${failedHere.sql}`,
            ).bind(at, row.operation, ...failedHere.bindings),
          ]),
        );
        await hintNode(env, nodeId).catch(() => 0);
        continue;
      }
      if (result?.status === "done") {
        await env.DB.prepare(
          "UPDATE database_replacements SET source_acknowledged_at=? WHERE operation=? AND phase='proving'",
        )
          .bind(at, row.operation)
          .run();
        row.source_acknowledged_at = at;
      }
      if (
        !row.source_acknowledged_at ||
        !observed ||
        observed.state !== "asleep" ||
        !observed.proven_sleep ||
        !observed.backup ||
        observed.storage_generation !== row.source_storage_generation ||
        observed.operation !== row.operation ||
        observed.generation !== database.generation
      )
        continue;
      if (!(await sourceArchiveHolds(env, database, observed))) continue;
      if (!(await replacementCapable(env.DB, nodeId, now))) continue;
      const storage =
        (await highestStorage(
          env.DB,
          row.database_id,
          row.source_storage_generation,
        )) + 1;
      const path = archiveDestinationPath(
        archiveBucket(env).bucketName,
        row.region_id,
        row.database_id,
        storage,
        row.operation,
      );
      await env.DB.prepare(
        `UPDATE database_replacements SET phase='restoring',source_generation=?,source_backup_id=?,source_proof_json=?,target_generation=?,target_storage_generation=?,target_archive_path=?,updated_at=? WHERE operation=? AND phase='proving' AND EXISTS(SELECT 1 FROM databases WHERE id=? AND generation=? AND storage_generation=? AND archive_path=?)`,
      )
        .bind(
          database.generation,
          observed.backup.backup_id,
          JSON.stringify(observed.proven_sleep),
          database.generation + 1,
          storage,
          path,
          at,
          row.operation,
          row.database_id,
          database.generation,
          row.source_storage_generation,
          row.source_archive_path,
        )
        .run();
    } else {
      const rollback = row.phase === "rolling_back",
        storage = (
          rollback
            ? row.rollback_storage_generation
            : row.target_storage_generation
        )!,
        generation = (
          rollback ? row.rollback_generation : row.target_generation
        )!;
      if (
        !observed ||
        observed.operation !== row.operation ||
        observed.storage_generation !== storage ||
        observed.generation !== generation
      )
        continue;
      if (observed.state === "error") {
        if (rollback) continue; // Source remains retained; an unavailable archive never becomes a false success.
        const rollbackStorage =
          (await highestStorage(env.DB, row.database_id, storage)) + 1;
        const path = archiveDestinationPath(
          archiveBucket(env).bucketName,
          row.region_id,
          row.database_id,
          rollbackStorage,
          row.operation,
        );
        await env.DB.prepare(
          `UPDATE database_replacements SET phase='rolling_back',failure=?,rollback_generation=?,rollback_storage_generation=?,rollback_archive_path=?,updated_at=? WHERE operation=? AND phase='restoring'`,
        )
          .bind(
            observed.error ?? "build_failed",
            generation + 1,
            rollbackStorage,
            path,
            at,
            row.operation,
          )
          .run();
      } else if (
        (observed.state === "ready" || observed.state === "asleep") &&
        observed.backup
      ) {
        const end = ProvenSleepRecord.parse(JSON.parse(row.source_proof_json!));
        // A rollback must promote past the proven source timeline; PITR can replay an earlier timeline.
        if (rollback && observed.backup.timeline <= end.timeline) continue;
        if (
          observed.state === "asleep" &&
          observed.proven_sleep?.system_identifier !== end.system_identifier
        )
          continue;
        await finish(env, row, !rollback, observed, now, report.observed_at);
      }
    }
    await hintNode(env, nodeId).catch(() => 0);
  }
}

/** Retained prior states and abandoned targets expire only after a claim excludes new readers. */
export async function expireReplacementArchives(
  env: Env,
  now: number,
  limit = 1000,
) {
  const at = new Date(now).toISOString(),
    selected = archiveBucket(env);
  let archives = 0,
    objects = 0;
  for (const side of ["source", "target", "rollback"] as const) {
    const path = `${side}_archive_path`,
      deleted = `${side}_archive_deleted_at`,
      claim = `${side}_cleanup_claim`;
    const idle = `NOT EXISTS(SELECT 1 FROM databases d WHERE d.archive_path=p.${path})
   AND NOT EXISTS(SELECT 1 FROM database_restores x JOIN operations o ON o.id=x.operation_id WHERE x.source_archive_path=p.${path} AND x.verified_at IS NULL AND o.status IN('pending','running'))
   AND NOT EXISTS(SELECT 1 FROM database_replacements a WHERE a.source_archive_path=p.${path}
     AND (a.phase IN('proving','restoring','rolling_back') OR (a.retained_until>? AND a.source_archive_deleted_at IS NULL)))
   AND NOT EXISTS(SELECT 1 FROM database_moves m WHERE m.source_archive_path=p.${path} AND m.status IN('proving','restoring'))`;
    const rows = (
      await env.DB.prepare(
        `SELECT operation,${path} archive_path,${claim} claim FROM database_replacements p
   WHERE phase IN('succeeded','failed') ${side === "target" ? "AND phase='failed'" : ""} AND retained_until<=? AND ${deleted} IS NULL AND ${path} IS NOT NULL AND ${idle}
   ORDER BY retained_until,operation LIMIT 1`,
      )
        .bind(at, at)
        .all<{
          operation: string;
          archive_path: string;
          claim: string | null;
        }>()
    ).results;
    for (const row of rows) {
      const parsed = parseArchivePath(row.archive_path);
      if (!parsed || parsed.bucket !== selected.bucketName) continue;
      const token = row.claim ?? crypto.randomUUID();
      const held = await env.DB.prepare(
        `UPDATE database_replacements AS p SET ${claim}=? WHERE operation=? AND ${claim} IS ? AND retained_until<=? AND ${deleted} IS NULL AND ${idle}`,
      )
        .bind(token, row.operation, row.claim, at, at)
        .run();
      if (held.meta.changes !== 1) continue;
      const prefix = `${parsed.region}/${parsed.database}/g${parsed.generation}-${parsed.operation}/`;
      const page = await selected.bucket.list({
        prefix,
        limit: Math.min(limit, 1000),
      });
      if (page.objects.some((object) => !object.key.startsWith(prefix)))
        throw new Error("archive_cleanup_listing_invalid");
      if (page.objects.length) {
        await selected.bucket.delete(page.objects.map((object) => object.key));
        objects += page.objects.length;
      } else {
        await env.DB.prepare(
          `UPDATE database_replacements SET ${deleted}=? WHERE operation=? AND ${claim}=?`,
        )
          .bind(at, row.operation, token)
          .run();
        archives++;
      }
    }
  }
  return { archives, objects };
}

/** Declared node loss uses the existing fenced-node recovery boundary, never a fictitious rollback. */
export async function failReplacementsOfLostNode(
  env: Env,
  nodeId: string,
  at: string,
) {
  const rows = (
    await env.DB.prepare(
      `SELECT database_id,operation FROM database_replacements WHERE node_id=? AND ${ACTIVE_REPLACEMENT}`,
    )
      .bind(nodeId)
      .all<{ database_id: string; operation: string }>()
  ).results;
  for (const row of rows)
    await withAdmissionMutation(env, [row.database_id], (mutation) =>
      mutation.batch([
        env.DB.prepare(
          `UPDATE database_replacements SET phase='failed',failure='node_lost',completed_at=?,updated_at=?,
   retained_until=strftime('%Y-%m-%dT%H:%M:%fZ',?,'+'||(SELECT s.backup_retention_days FROM databases d JOIN size_classes s ON s.id=d.size_class_id WHERE d.id=database_replacements.database_id)||' days')
   WHERE operation=? AND ${ACTIVE_REPLACEMENT} AND EXISTS(SELECT 1 FROM nodes n JOIN node_losses l ON l.node_id=n.id WHERE n.id=? AND n.lost_at IS NOT NULL)`,
        ).bind(at, at, at, row.operation, nodeId),
        env.DB.prepare(
          `UPDATE operations SET status='failed',error_code='node_lost',error_message='Owning node was declared lost; recover the retained source through fenced-node recovery',updated_at=?,completed_at=?
   WHERE id=? AND EXISTS(SELECT 1 FROM database_replacements WHERE operation=? AND phase='failed' AND failure='node_lost')`,
        ).bind(at, at, row.operation, row.operation),
        env.DB.prepare(
          `UPDATE lifecycle_orders SET closed_at=? WHERE operation=? AND closed_at IS NULL
   AND EXISTS(SELECT 1 FROM database_replacements WHERE operation=? AND phase='failed' AND failure='node_lost')`,
        ).bind(at, row.operation, row.operation),
      ]),
    );
}
