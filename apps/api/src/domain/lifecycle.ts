// SPDX-License-Identifier: Apache-2.0
import {
  newOperationId,
  DatabaseId,
  OperationId,
  Timestamp,
} from "@pgcf/contracts";
import { ApiError } from "../api-error.ts";
import type { ApiContext, Env } from "../env.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import { databaseOperationResponse, hint } from "./databases.ts";
import { databaseForRequest, type DatabaseRow } from "./rows.ts";
import { databaseResumeFitsSql } from "./placement.ts";
import { powerTransitionStatements } from "./power-transition.ts";
import { withAdmissionMutation } from "./admission-mutations.ts";

async function nodeCanResume(db: D1Database, id: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT ${databaseResumeFitsSql("d")} fits FROM databases d WHERE d.id=?`,
    )
    .bind(id)
    .first<{ fits: number }>();
  return row?.fits === 1;
}

export async function changePower(
  c: ApiContext,
  id: string,
  action: "suspend" | "resume",
): Promise<Response> {
  await databaseForRequest(c, id, true);
  return withIdempotency(c, {
    replay: (op, status) => databaseOperationResponse(c, op, status),
    execute: async (lease) => {
      const row = await databaseForRequest(c, id, true);
      if (row.desired_state === "deleted" || row.deleted_at !== null)
        throw new ApiError("conflict", "Database is deleted", {
          reason: "database_deleted",
        });
      const sleeping = action === "suspend";
      const same = sleeping
        ? row.desired_state === "suspended" &&
          row.suspension_reason === "manual"
        : row.desired_state === "running";
      if (same) {
        const existing = await c.env.DB.prepare(
          `SELECT id FROM operations WHERE database_id=? AND project_id=? AND generation=? AND kind IN (?,?) ORDER BY created_at DESC,id DESC LIMIT 1`,
        )
          .bind(
            id,
            row.project_id,
            row.generation,
            `database.${action}`,
            sleeping ? "database.suspend" : "database.wake",
          )
          .first<{ id: string }>();
        let op = existing?.id;
        if (
          !op &&
          !sleeping &&
          row.observed_state === "ready" &&
          row.observed_generation === row.generation &&
          row.observed_power === "awake"
        ) {
          op = newOperationId();
          const now = new Date().toISOString();
          await c.env.DB.prepare(
            `INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at,completed_at) SELECT ?,'database.resume','succeeded',project_id,id,generation,?,?,? FROM databases WHERE id=? AND generation=? AND updated_at=? AND desired_state='running' AND observed_state='ready' AND observed_generation=generation AND (${lease.guard.sql}) ON CONFLICT DO NOTHING`,
          )
            .bind(
              op,
              now,
              now,
              now,
              id,
              row.generation,
              row.updated_at,
              ...lease.guard.bindings,
            )
            .run();
          op = (
            await c.env.DB.prepare(
              `SELECT id FROM operations WHERE database_id=? AND generation=? AND kind='database.resume'`,
            )
              .bind(id, row.generation)
              .first<{ id: string }>()
          )?.id;
        }
        if (!op)
          throw new ApiError(
            "conflict",
            "Database configuration is not ready",
            { reason: "not_ready" },
          );
        await lease
          .completeStatement(op, 202, {
            sql: "EXISTS(SELECT 1 FROM operations WHERE id=? AND project_id=?)",
            bindings: [op, row.project_id],
          })
          .run();
        return databaseOperationResponse(c, op);
      }
      const verifiedIdle =
        row.desired_state === "suspended" &&
        row.suspension_reason === "idle" &&
        row.observed_power === "hibernated" &&
        row.observed_state === "provisioning" &&
        row.observed_generation === row.generation;
      if (
        sleeping &&
        !verifiedIdle &&
        (row.observed_state !== "ready" ||
          row.observed_generation !== row.generation ||
          row.observed_power !== "awake")
      )
        throw new ApiError("conflict", "Database configuration is not ready", {
          reason: "not_ready",
        });
      const op = newOperationId(),
        now = new Date().toISOString();
      const result = await withAdmissionMutation(
        c.env,
        [id],
        async (mutation) => {
          const admission = mutation.guard(id);
          const guard = {
            sql: `(${admission.sql}) AND (${lease.guard.sql})`,
            bindings: [...admission.bindings, ...lease.guard.bindings],
          };
          return mutation.batch([
            ...powerTransitionStatements(
              c.env.DB,
              row,
              action,
              op,
              now,
              undefined,
              guard,
            ),
            lease.completeStatement(op, 202, {
              sql: `EXISTS(SELECT 1 FROM operations WHERE id=? AND project_id=?) AND (${guard.sql})`,
              bindings: [op, row.project_id, ...guard.bindings],
            }),
          ]);
        },
      );
      if (result[0]!.meta.changes !== 1) {
        // A start that the node cannot hold is told apart from a change that raced the request.
        if (!sleeping && !(await nodeCanResume(c.env.DB, id)))
          throw new ApiError(
            "conflict",
            "Current node has insufficient memory, CPU or storage",
            { reason: "node_capacity" },
          );
        throw new ApiError("conflict", "Database changed; retry the request", {
          reason: "generation_changed",
        });
      }
      hint(c, [id]);
      return databaseOperationResponse(c, op);
    },
  });
}

/** Exact compensation for a refused/timed-out quiesce. It never invents an awake observation. */
export async function recoverQuiescence(
  env: Env,
  expected: { databaseId: string; operation: string; revision: number },
  reason: "busy" | "archive" | "unknown" | "timeout",
  now = new Date().toISOString(),
): Promise<{
  operation: string;
  revision: number;
  nodeId: string | null;
} | null> {
  const db = env.DB;
  DatabaseId.parse(expected.databaseId);
  OperationId.parse(expected.operation);
  Timestamp.parse(now);
  if (
    !Number.isSafeInteger(expected.revision) ||
    expected.revision < 1 ||
    !["busy", "archive", "unknown", "timeout"].includes(reason)
  )
    throw new Error("invalid_power_recovery");
  const row = await db
    .prepare(
      `SELECT d.* FROM databases d JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL JOIN operations o ON o.id=d.power_operation AND o.database_id=d.id AND o.project_id=d.project_id AND o.generation<=d.generation AND o.kind IN('database.suspend','database.hibernate') AND o.status IN('pending','running') WHERE d.id=? AND d.generation=? AND d.power_operation=? AND d.desired_state='suspended' AND d.deleted_at IS NULL`,
    )
    .bind(expected.databaseId, expected.revision, expected.operation)
    .first<DatabaseRow>();
  if (!row) return null;
  return withAdmissionMutation(env, [row.id], async (mutation) => {
    const guard = mutation.guard(row.id);
    const operation = newOperationId();
    const statements = [
      db
        .prepare(
          `UPDATE databases SET desired_state='running',suspension_reason=NULL,power_operation=?,generation=generation+1,observed_state='provisioning',status_message='Power transition refused',updated_at=? WHERE id=? AND generation=? AND updated_at=? AND desired_state='suspended' AND power_operation=?
          AND observed_state=? AND observed_generation=? AND observed_power=? AND suspension_reason IS ? AND node_id IS ?
          AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM projects WHERE id=databases.project_id AND deleted_at IS NULL)
          AND EXISTS(SELECT 1 FROM operations o WHERE o.id=databases.power_operation AND o.database_id=databases.id AND o.project_id=databases.project_id
            AND o.generation<=databases.generation AND o.kind IN('database.suspend','database.hibernate') AND o.status IN('pending','running'))
          AND (${guard.sql})`,
        )
        .bind(
          operation,
          now,
          row.id,
          row.generation,
          row.updated_at,
          row.power_operation,
          row.observed_state,
          row.observed_generation,
          row.observed_power,
          row.suspension_reason ?? null,
          row.node_id,
          ...guard.bindings,
        ),
      db
        .prepare(
          `INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at) SELECT ?,?,'pending',project_id,id,generation,?,? FROM databases WHERE changes()=1 AND id=? AND power_operation=? AND (${guard.sql})`,
        )
        .bind(
          operation,
          row.suspension_reason === "idle"
            ? "database.wake"
            : "database.resume",
          now,
          now,
          row.id,
          operation,
          ...guard.bindings,
        ),
      db
        .prepare(
          `UPDATE operations SET status='failed',error_code=?,error_message='Power transition refused',updated_at=?,completed_at=? WHERE id=? AND database_id=? AND generation<=? AND status IN('pending','running') AND EXISTS(SELECT 1 FROM databases WHERE id=? AND power_operation=? AND generation=?) AND (${guard.sql})`,
        )
        .bind(
          `power_${reason}`,
          now,
          now,
          row.power_operation,
          row.id,
          row.generation,
          row.id,
          operation,
          row.generation + 1,
          ...guard.bindings,
        ),
    ];
    const result = await mutation.batch(statements);
    return result[0]!.meta.changes === 1
      ? { operation, revision: row.generation + 1, nodeId: row.node_id }
      : null;
  });
}

/**
 * Ends a resume or a wake the node could not carry out, and puts the database back as it was before
 * it: a database that is to run and sleeps, with no operation left that wakes it, is one nothing
 * wakes (a connection wakes only an idle sleeper, and the node runs a resume's order once and a
 * wake's ticket once per connection). So the resume or wake fails with the reason, and the
 * database is suspended again at the next generation, as its last suspension was, manual or idle,
 * by an operation the node's report of the sleep ends like any suspension. A wake is always of an
 * idle sleeper, so it returns to its idle sleep and the next connection wakes it with a new
 * ticket. A node that starts the database late finds the newer generation suspended and puts it to
 * sleep again. Only a database that D1 knows asleep is put back: one that runs (a resume made by a
 * refused sleep, `recoverQuiescence`) is not stuck, its ready report admits it, and a suspension
 * would stop what the owner wants running; this answers `null` and the caller ends the operation
 * alone. The compare-and-set is on the row the start left; a later change of the database wins,
 * and so does the end of this start by another way.
 */
export async function recoverFailedResume(
  env: Env,
  expected: { databaseId: string; operation: string; revision: number },
  reason: string,
  now = new Date().toISOString(),
): Promise<{
  operation: string;
  revision: number;
  nodeId: string | null;
} | null> {
  const db = env.DB;
  DatabaseId.parse(expected.databaseId);
  OperationId.parse(expected.operation);
  Timestamp.parse(now);
  if (
    !Number.isSafeInteger(expected.revision) ||
    expected.revision < 1 ||
    !/^[a-z0-9_]{1,64}$/.test(reason)
  )
    throw new Error("invalid_power_recovery");
  const row = await db
    .prepare(
      `SELECT d.*,o.kind start_kind FROM databases d JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL JOIN operations o ON o.id=d.power_operation AND o.database_id=d.id AND o.project_id=d.project_id AND o.generation<=d.generation AND o.kind IN('database.resume','database.wake') AND o.status IN('pending','running') WHERE d.id=? AND d.generation=? AND d.power_operation=? AND d.desired_state='running' AND d.observed_power='hibernated' AND d.deleted_at IS NULL`,
    )
    .bind(expected.databaseId, expected.revision, expected.operation)
    .first<DatabaseRow & { start_kind: "database.resume" | "database.wake" }>();
  if (!row) return null;
  // What it was before: the suspension that the start undid.
  const before = await db
    .prepare(
      `SELECT kind FROM operations WHERE database_id=? AND kind IN('database.suspend','database.hibernate') AND generation<? ORDER BY generation DESC,created_at DESC,id DESC LIMIT 1`,
    )
    .bind(row.id, row.generation)
    .first<{ kind: "database.suspend" | "database.hibernate" }>();
  const kind = before?.kind ?? "database.suspend";
  return withAdmissionMutation(env, [row.id], async (mutation) => {
    const guard = mutation.guard(row.id);
    const operation = newOperationId();
    const statements = [
      db
        .prepare(
          `UPDATE databases SET desired_state='suspended',suspension_reason=?,power_operation=?,generation=generation+1,observed_state='provisioning',status_message=?,updated_at=? WHERE id=? AND generation=? AND updated_at=? AND desired_state='running' AND power_operation=?
          AND observed_state=? AND observed_generation=? AND observed_power=? AND suspension_reason IS ? AND node_id IS ?
          AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM projects WHERE id=databases.project_id AND deleted_at IS NULL)
          AND EXISTS(SELECT 1 FROM operations o WHERE o.id=databases.power_operation AND o.database_id=databases.id AND o.project_id=databases.project_id
            AND o.generation<=databases.generation AND o.kind IN('database.resume','database.wake') AND o.status IN('pending','running'))
          AND (${guard.sql})`,
        )
        .bind(
          kind === "database.hibernate" ? "idle" : "manual",
          operation,
          `${row.start_kind === "database.wake" ? "Wake" : "Resume"} failed: ${reason}`,
          now,
          row.id,
          row.generation,
          row.updated_at,
          row.power_operation,
          row.observed_state,
          row.observed_generation,
          row.observed_power,
          row.suspension_reason ?? null,
          row.node_id,
          ...guard.bindings,
        ),
      db
        .prepare(
          `INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at) SELECT ?,?,'pending',project_id,id,generation,?,? FROM databases WHERE changes()=1 AND id=? AND power_operation=? AND (${guard.sql})`,
        )
        .bind(operation, kind, now, now, row.id, operation, ...guard.bindings),
      db
        .prepare(
          `UPDATE operations SET status='failed',error_code=?,error_message=?,updated_at=?,completed_at=? WHERE id=? AND database_id=? AND generation<=? AND status IN('pending','running') AND EXISTS(SELECT 1 FROM databases WHERE id=? AND power_operation=? AND generation=?) AND (${guard.sql})`,
        )
        .bind(
          reason,
          `The node could not start the database: ${reason}`,
          now,
          now,
          row.power_operation,
          row.id,
          row.generation,
          row.id,
          operation,
          row.generation + 1,
          ...guard.bindings,
        ),
    ];
    const result = await mutation.batch(statements);
    return result[0]!.meta.changes === 1
      ? { operation, revision: row.generation + 1, nodeId: row.node_id }
      : null;
  });
}
