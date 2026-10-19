// SPDX-License-Identifier: Apache-2.0
// The statements of a power transition. Their own module: the DatabaseActor claims a wake ticket
// with them in the moment it answers, so they must not pull in the routes (lifecycle.ts).
import { RoleName } from "@pgcf/contracts";
import type { AdmissionSqlGuard } from "./admission-mutations.ts";
import { databaseResumeFitsSql } from "./placement.ts";
import type { DatabaseRow } from "./rows.ts";

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
  // Only a resume asks whether its node can start the database now. A wake is the claim of a
  // connection the Edge held, and the node admits every start itself (plan 4.6).
  const authorizedRole = action === "wake" ? RoleName.parse(wakeRole) : null;
  const statements = [
    db
      .prepare(
        `UPDATE databases SET desired_state=?,suspension_reason=?,power_operation=?,generation=generation+1,observed_state='provisioning',status_message=NULL,updated_at=?
      WHERE (id=? AND project_id=? AND node_id IS ? AND generation=? AND desired_state=? AND observed_state=? AND updated_at=? AND power_operation IS ? AND suspension_reason IS ? AND observed_power=? AND observed_generation=? AND deleted_at IS NULL)
      AND (EXISTS(SELECT 1 FROM projects WHERE id=databases.project_id AND deleted_at IS NULL)
      AND (?=0 OR (observed_state='ready' AND observed_generation=generation AND observed_power='awake') OR (?='suspend' AND observed_state='provisioning' AND observed_power='hibernated' AND observed_generation=generation AND desired_state='suspended' AND suspension_reason='idle') OR (?='hibernate' AND observed_state='provisioning' AND observed_power='awake' AND observed_generation=generation))
      AND (?=0 OR EXISTS(SELECT 1 FROM roles r WHERE r.database_id=databases.id AND r.name=? AND r.deleted_at IS NULL)))
      AND ${action === "resume" ? databaseResumeFitsSql("databases") : "1=1"}
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
  return statements;
}
