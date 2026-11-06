// SPDX-License-Identifier: Apache-2.0
/** Cancelling a clean snapshot never releases the source until both native readers are gone. */
import { newOperationId } from "@pgcf/contracts";
import { ApiError } from "../api-error.ts";
import type { Env } from "../env.ts";
import { withAdmissionMutation } from "./admission-mutations.ts";
import { databaseResumeFitsSql } from "./placement.ts";
import { hintNode } from "./node-hints.ts";
import type {
  ColdDatabase,
  ColdStorageRow,
  ColdWakeOptions,
  ColdWakeResult,
} from "./cold-storage.ts";

const conflict = () =>
  new ApiError("conflict", "Database changed; retry the request", {
    reason: "generation_changed",
  });
const cleanSql = (
  alias: string,
) => `(${alias}.capture_dispatched_at IS NULL OR ${alias}.capture_cleaned_at IS NOT NULL)
  AND (${alias}.verification_dispatched_at IS NULL OR ${alias}.verification_cleaned_at IS NOT NULL)`;
const cleaned = (row: ColdStorageRow) =>
  (row.capture_dispatched_at === null || row.capture_cleaned_at !== null) &&
  (row.verification_dispatched_at === null ||
    row.verification_cleaned_at !== null);

export async function beginColdCancellation(
  env: Env,
  row: ColdStorageRow,
  d: ColdDatabase,
  options: ColdWakeOptions,
): Promise<ColdWakeResult> {
  const at = new Date(options.now ?? Date.now()).toISOString();
  const role =
    options.manualResume || options.internalWake
      ? { sql: "1=1", bindings: [] as (string | number | null)[] }
      : {
          sql: "EXISTS(SELECT 1 FROM roles WHERE database_id=? AND name=? AND deleted_at IS NULL AND (valid_until IS NULL OR substr(valid_until,1,19)>substr(?,1,19)))",
          bindings: [d.id, options.role ?? "", at],
        };
  const lease = options.idempotency?.guard ?? { sql: "1=1", bindings: [] };
  const results = await withAdmissionMutation(
    env,
    [d.id],
    async (mutation) => {
      const g = mutation.guard(d.id);
      const accepted = {
        sql: "EXISTS(SELECT 1 FROM database_cold_storage WHERE operation=? AND phase='cancelling' AND wake_requested=1)",
        bindings: [row.operation],
      };
      return mutation.batch([
        env.DB.prepare(
          `UPDATE database_cold_storage SET phase='cancelling',failure='wake_requested',wake_requested=1,
        manual_resume_requested=MAX(manual_resume_requested,?),updated_at=?,completed_at=NULL
        WHERE operation=? AND phase IN('capturing','verifying','cancelling')
          AND EXISTS(SELECT 1 FROM databases d JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL
            WHERE d.id=? AND d.generation=? AND d.storage_operation_id=? AND d.storage_residency='archiving'
              AND d.deleted_at IS NULL AND d.desired_state='suspended' AND (d.suspension_reason IS NOT 'manual' OR ?=1
                OR EXISTS(SELECT 1 FROM database_cold_storage accepted JOIN cold_storage_operations o ON o.id=accepted.operation
                  WHERE accepted.operation=d.storage_operation_id AND accepted.manual_resume_requested=1 AND accepted.wake_requested=1 AND o.status IN('pending','running'))))
          AND (${g.sql}) AND (${role.sql}) AND (${lease.sql})`,
        ).bind(
          Number(options.manualResume ?? false),
          at,
          row.operation,
          d.id,
          d.generation,
          row.operation,
          Number(options.manualResume ?? false),
          ...g.bindings,
          ...role.bindings,
          ...lease.bindings,
        ),
        env.DB.prepare(
          `UPDATE cold_storage_operations SET status='running',error_code=NULL,error_message=NULL,completed_at=NULL,updated_at=?
        WHERE id=? AND changes()=1 AND (${accepted.sql})`,
        ).bind(at, row.operation, ...accepted.bindings),
        ...(options.idempotency
          ? [
              options.idempotency.completeStatement(row.operation, 202, {
                sql: `changes()=1 AND (${accepted.sql}) AND (${g.sql}) AND (${role.sql}) AND (${lease.sql})`,
                bindings: [
                  ...accepted.bindings,
                  ...g.bindings,
                  ...role.bindings,
                  ...lease.bindings,
                ],
              }),
            ]
          : []),
      ]);
    },
    undefined,
    options.localActor,
  );
  if (results[0]!.meta.changes !== 1) throw conflict();
  // The next desired page carries cancellation tombstones, never another capture/verification.
  await Promise.allSettled(
    [
      ...new Set(
        [row.source_node_id, row.verification_node_id].filter(
          (id): id is string => id !== null,
        ),
      ),
    ].map((id) => hintNode(env, id)),
  );
  return { handled: true, waiting: true, operationId: row.operation };
}

/** Complete a deferred manual resume only when its actual normal power operation ended. */
async function finishResumeLedger(env: Env, row: ColdStorageRow, at: string) {
  if (!row.cancel_resume_operation) return;
  await env.DB.prepare(
    `UPDATE cold_storage_operations SET
      status=(SELECT status FROM operations WHERE id=?),
      error_code=(SELECT error_code FROM operations WHERE id=?),
      error_message=(SELECT error_message FROM operations WHERE id=?),updated_at=?,completed_at=?
    WHERE id=? AND status IN('pending','running') AND EXISTS(SELECT 1 FROM operations o
      WHERE o.id=? AND o.database_id=cold_storage_operations.database_id AND o.project_id=cold_storage_operations.project_id
        AND o.kind='database.resume' AND o.status IN('succeeded','failed'))`,
  )
    .bind(
      row.cancel_resume_operation,
      row.cancel_resume_operation,
      row.cancel_resume_operation,
      at,
      at,
      row.operation,
      row.cancel_resume_operation,
    )
    .run();
}

/** Called after cleanup observations and by cron; caller disconnection has no effect on this work. */
export async function finishColdCancellation(
  env: Env,
  row: ColdStorageRow,
  now = Date.now(),
): Promise<void> {
  const at = new Date(now).toISOString();
  if (row.phase === "cancelled") {
    await finishResumeLedger(env, row, at);
    return;
  }
  if (row.phase !== "cancelling" || !cleaned(row)) return;
  const requested = row.wake_requested === 1,
    manual = requested && row.manual_resume_requested === 1,
    phase = requested ? "cancelled" : "failed",
    reason = requested ? "cancelled" : (row.failure ?? "snapshot_failed"),
    resume = manual ? newOperationId() : null;
  const outcome = await withAdmissionMutation(
    env,
    [row.database_id],
    async (mutation) => {
      const g = mutation.guard(row.database_id);
      const accepted = {
        sql: "EXISTS(SELECT 1 FROM database_cold_storage WHERE operation=? AND phase=? AND cancel_resume_operation IS ?)",
        bindings: [row.operation, phase, resume],
      };
      return mutation.batch([
        env.DB.prepare(
          `UPDATE databases SET storage_residency='local',
          desired_state=CASE WHEN ?=1 THEN 'running' ELSE desired_state END,
          suspension_reason=CASE WHEN ?=1 THEN NULL ELSE suspension_reason END,
          generation=generation+?,power_operation=CASE WHEN ?=1 THEN ? ELSE power_operation END,status_message=NULL,updated_at=?
        WHERE id=? AND node_id=? AND generation=? AND storage_generation=? AND storage_operation_id=?
          AND storage_residency='archiving' AND desired_state='suspended' AND observed_power='hibernated' AND observed_generation=generation
          AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM projects p WHERE p.id=databases.project_id AND p.deleted_at IS NULL)
          AND EXISTS(SELECT 1 FROM database_cold_storage c WHERE c.operation=? AND c.phase='cancelling'
            AND c.wake_requested=? AND c.manual_resume_requested=? AND ${cleanSql("c")})
          AND (?=0 OR ${databaseResumeFitsSql("databases")}) AND (${g.sql})`,
        ).bind(
          Number(manual),
          Number(manual),
          Number(manual),
          Number(manual),
          resume,
          at,
          row.database_id,
          row.source_node_id,
          row.source_generation,
          row.source_storage_generation,
          row.operation,
          row.operation,
          Number(requested),
          Number(manual),
          Number(manual),
          ...g.bindings,
        ),
        ...(manual
          ? [
              env.DB.prepare(
                `INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at)
        SELECT ?,'database.resume','pending',project_id,id,generation,?,? FROM databases WHERE changes()=1 AND id=? AND power_operation=?
          AND EXISTS(SELECT 1 FROM database_cold_storage WHERE operation=? AND phase='cancelling' AND manual_resume_requested=1)`,
              ).bind(resume, at, at, row.database_id, resume, row.operation),
            ]
          : []),
        env.DB.prepare(
          `UPDATE database_cold_storage SET phase=?,cancel_resume_operation=?,completed_at=?,updated_at=?
        WHERE operation=? AND phase='cancelling' AND changes()=1`,
        ).bind(phase, resume, at, at, row.operation),
        ...(manual
          ? [
              env.DB.prepare(
                `UPDATE operations SET status='failed',error_code='superseded',error_message='Power intent superseded',updated_at=?,completed_at=?
          WHERE database_id=? AND kind IN('database.suspend','database.resume','database.hibernate','database.wake') AND status IN('pending','running')
            AND generation<(SELECT generation FROM databases WHERE id=?) AND (${accepted.sql})`,
              ).bind(
                at,
                at,
                row.database_id,
                row.database_id,
                ...accepted.bindings,
              ),
            ]
          : []),
        env.DB.prepare(
          `UPDATE lifecycle_orders SET closed_at=? WHERE operation=? AND type='move' AND closed_at IS NULL AND (${accepted.sql})`,
        ).bind(at, row.operation, ...accepted.bindings),
        env.DB.prepare(
          `UPDATE archive_pins SET released_at=? WHERE operation=? AND released_at IS NULL AND (${accepted.sql})`,
        ).bind(at, row.operation, ...accepted.bindings),
        env.DB.prepare(
          manual
            ? `UPDATE cold_storage_operations SET updated_at=? WHERE id=? AND (${accepted.sql})`
            : `UPDATE cold_storage_operations SET status='failed',error_code=?,error_message=?,updated_at=?,completed_at=? WHERE id=? AND (${accepted.sql})`,
        ).bind(
          ...(manual
            ? [at, row.operation, ...accepted.bindings]
            : [
                reason,
                requested
                  ? "Archival cancelled by a wake"
                  : "Snapshot failed; local source retained",
                at,
                at,
                row.operation,
                ...accepted.bindings,
              ]),
        ),
      ]);
    },
  );
  if (outcome[0]!.meta.changes === 1)
    await hintNode(env, row.source_node_id).catch(() => 0);
  else if (manual)
    await env.DB.prepare(
      `UPDATE databases SET status_message='Waiting for source capacity after snapshot cleanup'
      WHERE id=? AND storage_operation_id=? AND storage_residency='archiving'
        AND EXISTS(SELECT 1 FROM database_cold_storage c WHERE c.operation=? AND c.phase='cancelling' AND ${cleanSql("c")})`,
    )
      .bind(row.database_id, row.operation, row.operation)
      .run();
}

/** A local outcome continues normal authenticated wake admission; it never authorizes a route. */
export async function coldCancellationOutcome(
  env: Env,
  id: string,
  initial: ColdStorageRow,
  d: ColdDatabase,
): Promise<"pending" | "local" | "failed" | null> {
  if (
    initial.kind !== "archive" ||
    !["cancelling", "cancelled"].includes(initial.phase)
  )
    return null;
  if (
    initial.database_id !== id ||
    d.id !== id ||
    d.storage_operation_id !== initial.operation ||
    d.deleted_at ||
    d.node_id !== initial.source_node_id ||
    d.storage_generation !== initial.source_storage_generation
  )
    return "failed";
  if (initial.phase === "cancelling")
    return d.storage_residency === "archiving" && initial.wake_requested === 1
      ? "pending"
      : "failed";
  if (
    d.storage_residency !== "local" ||
    !cleaned(initial) ||
    initial.wake_requested !== 1
  )
    return "failed";
  const released = await env.DB.prepare(
    "SELECT 1 FROM lifecycle_orders WHERE operation=? AND node_id=? AND type='move' AND closed_at IS NOT NULL",
  )
    .bind(initial.operation, initial.source_node_id)
    .first();
  if (!released) return "pending";
  if (initial.cancel_resume_operation) {
    const resume = await env.DB.prepare(
      "SELECT status FROM operations WHERE id=? AND database_id=? AND kind='database.resume'",
    )
      .bind(initial.cancel_resume_operation, id)
      .first<{ status: string }>();
    if (!resume || resume.status === "failed") return "failed";
  }
  return d.suspension_reason === "manual" ? "failed" : "local";
}
