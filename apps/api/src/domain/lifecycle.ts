// SPDX-License-Identifier: Apache-2.0
import {
  newOperationId,
  DatabaseId,
  OperationId,
  RoleName,
  Timestamp,
} from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import { databaseOperationResponse, hint } from "./databases.ts";
import { databaseForRequest, type DatabaseRow } from "./rows.ts";

export type PowerAction = "suspend" | "resume" | "hibernate" | "wake";
export function powerTransitionStatements(
  db: D1Database,
  row: DatabaseRow,
  action: PowerAction,
  operation: string,
  now: string,
  wakeRole?: string,
): D1PreparedStatement[] {
  const sleeping = action === "suspend" || action === "hibernate";
  const authorizedRole = action === "wake" ? RoleName.parse(wakeRole) : null;
  return [
    db
      .prepare(
        `UPDATE databases SET desired_state=?,suspension_reason=?,power_operation=?,generation=generation+1,observed_state='provisioning',status_message=NULL,updated_at=?
      WHERE id=? AND project_id=? AND generation=? AND desired_state=? AND observed_state=? AND updated_at=? AND power_operation IS ? AND suspension_reason IS ? AND observed_power=? AND observed_generation=? AND deleted_at IS NULL
      AND EXISTS(SELECT 1 FROM projects WHERE id=databases.project_id AND deleted_at IS NULL)
      AND (?=0 OR (observed_state='ready' AND observed_generation=generation AND observed_power='awake') OR (?='suspend' AND desired_state='suspended' AND suspension_reason='idle' AND observed_state='provisioning' AND observed_power='hibernated' AND observed_generation=generation))
      AND (?=0 OR EXISTS(SELECT 1 FROM roles r WHERE r.database_id=databases.id AND r.name=? AND r.deleted_at IS NULL))`,
      )
      .bind(
        sleeping ? "suspended" : "running",
        sleeping ? (action === "suspend" ? "manual" : "idle") : null,
        operation,
        now,
        row.id,
        row.project_id,
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
      ),
    db
      .prepare(
        `INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at)
      SELECT ?,?,'pending',project_id,id,generation,?,? FROM databases WHERE changes()=1 AND id=? AND project_id=? AND generation=? AND power_operation=?`,
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
      ),
    db
      .prepare(
        `UPDATE operations SET status='failed',error_code='superseded',error_message='Power intent superseded',updated_at=?,completed_at=?
      WHERE database_id=? AND generation<? AND kind IN ('database.suspend','database.resume','database.hibernate','database.wake') AND status IN ('pending','running')
      AND EXISTS(SELECT 1 FROM databases WHERE id=? AND power_operation=? AND generation=?)`,
      )
      .bind(
        now,
        now,
        row.id,
        row.generation + 1,
        row.id,
        operation,
        row.generation + 1,
      ),
  ];
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
        throw new ApiError("conflict", "Database is deleted");
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
          throw new ApiError("conflict", "Database configuration is not ready");
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
        throw new ApiError("conflict", "Database configuration is not ready");
      const op = newOperationId(),
        now = new Date().toISOString();
      const result = await c.env.DB.batch([
        ...powerTransitionStatements(c.env.DB, row, action, op, now),
        lease.completeStatement(op, 202, {
          sql: "EXISTS(SELECT 1 FROM operations WHERE id=? AND project_id=?)",
          bindings: [op, row.project_id],
        }),
      ]);
      if (result[0]!.meta.changes !== 1)
        throw new ApiError("conflict", "Database changed; retry the request");
      hint(c, row.region_id, [id]);
      return databaseOperationResponse(c, op);
    },
  });
}

/** Exact compensation for a refused/timed-out quiesce. It never invents an awake observation. */
export async function recoverQuiescence(
  db: D1Database,
  expected: { databaseId: string; operation: string; revision: number },
  reason: "busy" | "archive" | "unknown" | "timeout",
  now = new Date().toISOString(),
): Promise<{ operation: string; revision: number; regionId: string } | null> {
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
  const operation = newOperationId();
  const result = await db.batch([
    db
      .prepare(
        `UPDATE databases SET desired_state='running',suspension_reason=NULL,power_operation=?,generation=generation+1,observed_state='provisioning',status_message='Power transition refused',updated_at=? WHERE id=? AND generation=? AND updated_at=? AND desired_state='suspended' AND power_operation=? AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM projects WHERE id=databases.project_id AND deleted_at IS NULL)`,
      )
      .bind(
        operation,
        now,
        row.id,
        row.generation,
        row.updated_at,
        row.power_operation,
      ),
    db
      .prepare(
        `INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at) SELECT ?,?,'pending',project_id,id,generation,?,? FROM databases WHERE changes()=1 AND id=? AND power_operation=?`,
      )
      .bind(
        operation,
        row.suspension_reason === "idle" ? "database.wake" : "database.resume",
        now,
        now,
        row.id,
        operation,
      ),
    db
      .prepare(
        `UPDATE operations SET status='failed',error_code=?,error_message='Power transition refused',updated_at=?,completed_at=? WHERE id=? AND database_id=? AND generation<=? AND status IN('pending','running') AND EXISTS(SELECT 1 FROM databases WHERE id=? AND power_operation=? AND generation=?)`,
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
      ),
  ]);
  return result[0]!.meta.changes === 1
    ? { operation, revision: row.generation + 1, regionId: row.region_id }
    : null;
}
