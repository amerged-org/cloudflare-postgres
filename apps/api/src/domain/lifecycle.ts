// SPDX-License-Identifier: Apache-2.0
import {
  newOperationId,
  DatabaseId,
  OperationId,
  RoleName,
  Timestamp,
} from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { ApiContext, Env } from "../env.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import {
  databaseOperationResponse,
  hint,
  thinStorageTurnsFor,
} from "./databases.ts";
import { databaseForRequest, type DatabaseRow } from "./rows.ts";
import {
  databaseStartupHeadroomSql,
  startupReservationStatement,
} from "./startup-admission.ts";

import {
  withAdmissionMutation,
  type AdmissionSqlGuard,
} from "./admission-mutations.ts";
export type PowerAction = "suspend" | "resume" | "hibernate" | "wake";
export function powerTransitionStatements(
  db: D1Database,
  row: DatabaseRow,
  action: PowerAction,
  operation: string,
  now: string,
  wakeRole?: string,
  admission?: AdmissionSqlGuard,
): D1PreparedStatement[] {
  const sleeping = action === "suspend" || action === "hibernate";
  // A wake claims no start headroom (pool design 2026-10-16): a pool hit starts in an already
  // running slot, and the controller's miss path keeps its own start checks. The start
  // reservation below stays, because the miss path's start tokens need it.
  const authorizedRole = action === "wake" ? RoleName.parse(wakeRole) : null;
  const statements = [
    db
      .prepare(
        `UPDATE databases SET desired_state=?,suspension_reason=?,power_operation=?,generation=generation+1,observed_state='provisioning',status_message=NULL,updated_at=?
      WHERE (id=? AND project_id=? AND node_id IS ? AND generation=? AND desired_state=? AND observed_state=? AND updated_at=? AND power_operation IS ? AND suspension_reason IS ? AND observed_power=? AND observed_generation=? AND deleted_at IS NULL)
      AND (EXISTS(SELECT 1 FROM projects WHERE id=databases.project_id AND deleted_at IS NULL)
      AND (?=0 OR (observed_state='ready' AND observed_generation=generation AND observed_power='awake') OR (?='suspend' AND observed_state='provisioning' AND observed_power='hibernated' AND observed_generation=generation AND desired_state='suspended' AND suspension_reason='idle'))
      AND (?=0 OR EXISTS(SELECT 1 FROM roles r WHERE r.database_id=databases.id AND r.name=? AND r.deleted_at IS NULL)))
      AND ${sleeping || action === "wake" ? "1=1" : databaseStartupHeadroomSql("databases")}
      AND (${admission?.sql ?? "1=1"})`,
      )
      .bind(
        sleeping ? "suspended" : "running",
        sleeping ? (action === "suspend" ? "manual" : "idle") : null,
        operation,
        now,
        row.id,
        row.project_id,
        row.node_id,
        row.generation,
        row.desired_state,
        row.observed_state,
        row.updated_at,
        row.power_operation ?? null,
        row.suspension_reason ?? null,
        row.observed_power,
        row.observed_generation,
        Number(sleeping),
        action,
        Number(action === "wake"),
        authorizedRole,
        ...(admission?.bindings ?? []),
      ),
    db
      .prepare(
        `INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at)
      SELECT ?,?,'pending',project_id,id,generation,?,? FROM databases WHERE changes()=1 AND id=? AND project_id=? AND generation=? AND power_operation=? AND (${admission?.sql ?? "1=1"})`,
      )
      .bind(
        operation,
        `database.${action}`,
        now,
        now,
        row.id,
        row.project_id,
        row.generation + 1,
        operation,
        ...(admission?.bindings ?? []),
      ),
    db
      .prepare(
        `UPDATE operations SET status='failed',error_code='superseded',error_message='Power intent superseded',updated_at=?,completed_at=?
      WHERE database_id=? AND generation<? AND kind IN ('database.suspend','database.resume','database.hibernate','database.wake') AND status IN ('pending','running')
      AND EXISTS(SELECT 1 FROM databases WHERE id=? AND power_operation=? AND generation=?) AND (${admission?.sql ?? "1=1"})`,
      )
      .bind(
        now,
        now,
        row.id,
        row.generation + 1,
        row.id,
        operation,
        row.generation + 1,
        ...(admission?.bindings ?? []),
      ),
  ];
  if (!sleeping && row.node_id !== null)
    statements.splice(
      2,
      0,
      startupReservationStatement(db, {
        databaseId: row.id,
        operationId: operation,
        generation: row.generation + 1,
        nodeId: row.node_id,
        now,
      }),
    );
  return statements;
}

async function hasStartupHeadroom(
  db: D1Database,
  id: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT ${databaseStartupHeadroomSql("d")} headroom FROM databases d WHERE d.id=?`,
    )
    .bind(id)
    .first<{ headroom: number }>();
  return row?.headroom === 1;
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
            `INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at,completed_at) SELECT ?,'database.resume','succeeded',project_id,id,generation,?,?,? FROM databases WHERE id=? AND generation=? AND updated_at=? AND desired_state='running' AND observed_state='ready' AND observed_generation=generation ON CONFLICT DO NOTHING`,
          )
            .bind(op, now, now, now, id, row.generation, row.updated_at)
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
          const guard = mutation.guard(id);
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
        if (!sleeping && !(await hasStartupHeadroom(c.env.DB, id)))
          throw new ApiError(
            "conflict",
            "Current node has insufficient memory, CPU or storage",
            { reason: "node_capacity" },
          );
        throw new ApiError("conflict", "Database changed; retry the request", {
          reason: "generation_changed",
        });
      }
      hint(c, row.region_id, [id]);
      if (!sleeping) c.executionCtx.waitUntil(thinStorageTurnsFor(c.env, [id]));
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
): Promise<{ operation: string; revision: number; regionId: string } | null> {
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
    const mayRestart = reason === "unknown" || reason === "timeout";
    const statements = [
      db
        .prepare(
          `UPDATE databases SET desired_state='running',suspension_reason=NULL,power_operation=?,generation=generation+1,observed_state='provisioning',status_message='Power transition refused',updated_at=? WHERE id=? AND generation=? AND updated_at=? AND desired_state='suspended' AND power_operation=?
          AND observed_state=? AND observed_generation=? AND observed_power=? AND suspension_reason IS ? AND node_id IS ?
          AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM projects WHERE id=databases.project_id AND deleted_at IS NULL)
          AND EXISTS(SELECT 1 FROM operations o WHERE o.id=databases.power_operation AND o.database_id=databases.id AND o.project_id=databases.project_id
            AND o.generation<=databases.generation AND o.kind IN('database.suspend','database.hibernate') AND o.status IN('pending','running'))
          AND ${mayRestart ? databaseStartupHeadroomSql() : "1=1"} AND (${guard.sql})`,
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
    if (mayRestart && row.node_id !== null)
      statements.splice(
        2,
        0,
        startupReservationStatement(db, {
          databaseId: row.id,
          operationId: operation,
          generation: row.generation + 1,
          nodeId: row.node_id,
          now,
        }),
      );
    const result = await mutation.batch(statements);
    return result[0]!.meta.changes === 1
      ? { operation, revision: row.generation + 1, regionId: row.region_id }
      : null;
  });
}
