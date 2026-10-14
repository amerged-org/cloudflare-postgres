// SPDX-License-Identifier: Apache-2.0
import type { AdmissionSqlGuard } from "./admission-mutations.ts";

/** Choose a cold owner only inside its existing guarded start transaction.
 * The terminal binding/report stays retained for actual Lease/Pod/creator cleanup. */
export function postgresPoolCnpgSelectionStatements(
  db: D1Database,
  input: {
    databaseId: string;
    generation: number;
    now: number;
    guard?: AdmissionSqlGuard;
    roleOperationId?: string;
    operationId?: string;
  },
): D1PreparedStatement[] {
  const guard = input.guard ?? { sql: "1", bindings: [] };
  const eligible = (
    holder: string,
  ) => `(${holder}.kind='pool' AND ${holder}.state IN('released','refused')
    AND EXISTS(SELECT 1 FROM databases d JOIN operations o ON o.id=d.power_operation AND o.database_id=d.id AND o.project_id=d.project_id AND o.generation=d.generation
      JOIN pool_bindings b ON b.id=${holder}.binding_id AND b.database_id=d.id
      WHERE d.id=${holder}.database_id AND d.id=? AND d.generation=? AND d.desired_state='running' AND d.deleted_at IS NULL
        AND (? IS NULL OR d.power_operation=?)
        AND o.kind IN('database.wake','database.resume','database.resize') AND o.status IN('pending','running')
        AND b.state=${holder}.state AND b.holder_revision=${holder}.revision AND b.node_report_json IS NOT NULL
        AND json_extract(b.node_report_json,'$.binding_id')=b.id AND json_extract(b.node_report_json,'$.scope_sha256')=b.scope_sha256
        AND json_extract(b.node_report_json,'$.state')=b.state AND json_extract(b.node_report_json,'$.kernel_proof.dm_open_count')=0
        AND json_extract(b.node_report_json,'$.kernel_proof.foreign_mounts')=0 AND json_extract(b.node_report_json,'$.kernel_proof.named_namespace_scan_complete')=1)
    AND NOT EXISTS(SELECT 1 FROM pool_bindings active WHERE active.database_id=${holder}.database_id AND active.state NOT IN('released','refused'))
    AND NOT EXISTS(SELECT 1 FROM postgres_pool_qualification_runs q WHERE q.database_id=${holder}.database_id AND q.status IN('running','cleanup'))
    AND NOT EXISTS(SELECT 1 FROM pool_role_mutations q WHERE q.database_id=${holder}.database_id AND q.status IN('pending','running') AND q.id IS NOT ?)
    AND (${guard.sql}))`;
  const bindings = [
    input.databaseId,
    input.generation,
    input.operationId ?? null,
    input.operationId ?? null,
    input.roleOperationId ?? null,
    ...guard.bindings,
  ];
  return [
    db
      .prepare(
        `UPDATE database_runtime_holders SET kind='cnpg',binding_id=NULL,state='active',revision=revision+1,clean_stop=NULL,sleep_json=NULL,updated_at=? WHERE ${eligible("database_runtime_holders")}`,
      )
      .bind(input.now, ...bindings),
    db
      .prepare(
        `SELECT json(CASE WHEN NOT EXISTS(SELECT 1 FROM database_runtime_holders h WHERE ${eligible("h")}) THEN 'true' ELSE '' END)`,
      )
      .bind(...bindings),
  ];
}
