// SPDX-License-Identifier: Apache-2.0
import {
  Database,
  Operation,
  Role,
  SizeClass,
  serializeStorage,
  type DesiredState,
  type ObservedState,
} from "@pgcf/contracts";
import { ApiError } from "../api-error.ts";
import type { ApiContext } from "../env.ts";
import { assertProjectAccess, getAuth } from "../middleware/auth.ts";
import {
  databaseHealthOf,
  latestAgentSampleSql,
  latestFilesystemSampleSql,
  type DatabaseHealthSource,
} from "./operational-health.ts";
import type { Page } from "../platform/pagination.ts";
import { effectiveOf, effectiveResourcesColumnsSql } from "./resources.ts";

export interface DatabaseRow extends DatabaseHealthSource {
  id: string;
  project_id: string;
  region_id: string;
  node_id: string | null;
  name: string;
  size_class_id: string;
  /** The database's own resources; null takes the size class's. */
  own_memory_mib?: number | null;
  own_cpu_millicores?: number | null;
  own_storage_mib?: number | null;
  /** When the database was placed on its node; null before it is. */
  placed_at?: string | null;
  /** Read with effectiveResourcesColumnsSql. */
  effective_memory_mib?: number;
  effective_cpu_millicores?: number;
  effective_storage_mib?: number;
  sleep_after_seconds?: number | null;
  /** Read with effectiveSleepAfterSql. */
  effective_sleep_after_seconds?: number | null;
  pg_major: 18;
  observed_postgres_image?: string | null;
  observed_postgres_image_id?: string | null;
  desired_state: DesiredState;
  observed_state: ObservedState;
  generation: number;
  storage_generation?: number;
  storage_profile_json?: string | null;
  storage_volume_json?: string | null;
  runtime_json?: string | null;
  observed_generation: number;
  status_message: string | null;
  archive_path: string;
  archiving_health: "ok" | "failing" | "unknown";
  archiving_health_since: string | null;
  /** The size of the database's filesystem as its node last told it; null until it has. */
  observed_storage_bytes?: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  suspension_reason?: "manual" | "idle" | null;
  observed_power?: "awake" | "hibernated";
  power_operation?: string | null;
}
export interface RoleRow {
  database_id: string;
  name: string;
  owner: number;
  password_ciphertext: string;
  password_iv: string;
  password_kid: string;
  password_revision: number;
  created_at: string;
  updated_at: string;
  /** Set when the role was deleted through the API; the row stays until PostgreSQL confirms. */
  deleted_at: string | null;
  valid_until: string | null;
  connection_limit: number | null;
  /** A JSON array of role names, ordered. */
  member_of_json: string;
  /** Bit 1 INHERIT, bit 0 SET, uniform across member_of; ADMIN is never granted. */
  membership_options: number;
  bypass_rls: number;
  created_by_key_id: string | null;
  deleted_by_key_id: string | null;
  delete_operation_id: string | null;
}
export interface OperationRow {
  id: string;
  kind: Operation["kind"];
  status: Operation["status"];
  project_id: string;
  database_id: string;
  generation: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}
export interface RegionRow {
  id: string;
}
export interface SizeRow extends Omit<
  SizeClass,
  "enabled" | "storage_gib" | "storage_mib"
> {
  enabled: number;
  storage_mib: number;
}
/** The idle time before a database sleeps: its own, else its size class's; null is always warm. */
export function effectiveSleepAfterSql(database: string): string {
  return `COALESCE(${database}.sleep_after_seconds,(SELECT sleep_after_seconds FROM size_classes WHERE id=${database}.size_class_id))`;
}

/**
 * `now` is read once by a list so that every row is judged at the same instant. Backup and disk
 * health and the storage figures come from the producers of the operator listing; a row read
 * without the newest agent sample reports them unknown.
 */
export function databaseView(row: DatabaseRow, now = Date.now()): Database {
  const { backup, disk, sample } = databaseHealthOf(row, now);
  const { storage_mib, ...resources } = effectiveOf(row);
  return Database.parse({
    id: row.id,
    project_id: row.project_id,
    region_id: row.region_id,
    node_id: row.node_id,
    name: row.name,
    size_class_id: row.size_class_id,
    resources: { ...resources, ...serializeStorage(storage_mib) },
    sleep_after_seconds: row.sleep_after_seconds ?? null,
    effective_sleep_after_seconds: row.effective_sleep_after_seconds,
    desired_state: row.desired_state,
    observed_state:
      row.desired_state === "suspended" &&
      row.observed_state === "provisioning" &&
      row.observed_generation === row.generation &&
      row.observed_power === "hibernated"
        ? "hibernated"
        : row.observed_state,
    suspension_reason: row.suspension_reason ?? null,
    generation: row.generation,
    storage_generation: row.storage_generation ?? 1,
    observed_generation: row.observed_generation,
    status_message: row.status_message,
    health: {
      archiving: row.archiving_health,
      since: row.archiving_health_since,
      backup: {
        status: backup.status,
        last_base_backup_at: backup.last_completed_at,
      },
      disk: { status: disk.status, used_ratio: disk.used_fraction },
    },
    storage:
      sample === null
        ? null
        : {
            used_bytes: sample.storage_used_bytes,
            allocated_bytes: sample.storage_allocated_bytes,
            observed_at: sample.observed_at,
          },
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}
export function roleView(row: RoleRow): Role {
  return Role.parse({
    database_id: row.database_id,
    name: row.name,
    owner: Boolean(row.owner),
    password_revision: row.password_revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
    valid_until: row.valid_until,
    connection_limit: row.connection_limit,
    member_of: JSON.parse(row.member_of_json) as string[],
    ...roleMembershipOptions(row.membership_options),
    bypass_rls: Boolean(row.bypass_rls),
  });
}

/** Keep default responses compatible with the original role contract. */
export function roleMembershipOptions(options: number) {
  return options === 3
    ? {}
    : {
        membership_options: {
          inherit: (options & 2) !== 0,
          set: (options & 1) !== 0,
        },
      };
}
export function operationView(row: OperationRow): Operation {
  return Operation.parse({
    id: row.id,
    kind: row.kind,
    status: row.status,
    project_id: row.project_id,
    database_id: row.database_id,
    generation: row.generation,
    error:
      row.error_code === null
        ? null
        : { code: row.error_code, message: row.error_message ?? "" },
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  });
}
export async function databaseForRequest(
  c: ApiContext,
  id: string,
  includeDeleted = false,
): Promise<DatabaseRow> {
  await getAuth(c);
  const row = await c.env.DB.prepare(
    `SELECT d.*,${latestAgentSampleSql("d")} agent_sample,${latestFilesystemSampleSql("d")} filesystem_sample,${effectiveSleepAfterSql("d")} effective_sleep_after_seconds,${effectiveResourcesColumnsSql("d")} FROM databases d JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL WHERE d.id=? ${includeDeleted ? "" : "AND d.deleted_at IS NULL"}`,
  )
    .bind(id)
    .first<DatabaseRow>();
  if (!row) throw new ApiError("not_found", "Database not found");
  await assertProjectAccess(c, row.project_id);
  return row;
}
/** Every operation an integrator can read: the table of the lifecycle and that of role removals. */
const OPERATION_COLUMNS =
  "id,kind,status,project_id,database_id,generation,error_code,error_message,created_at,updated_at,completed_at";
const OPERATIONS_OF_ALL_KINDS = `(SELECT ${OPERATION_COLUMNS} FROM operations
      UNION ALL SELECT ${OPERATION_COLUMNS} FROM role_deletions)`;
export async function operationForRequest(
  c: ApiContext,
  id: string,
): Promise<OperationRow> {
  await getAuth(c);
  const row = await c.env.DB.prepare(
    `SELECT o.* FROM ${OPERATIONS_OF_ALL_KINDS} o
      JOIN projects p ON p.id=o.project_id AND p.deleted_at IS NULL JOIN databases d ON d.id=o.database_id AND d.project_id=o.project_id WHERE o.id=?`,
  )
    .bind(id)
    .first<OperationRow>();
  if (!row) throw new ApiError("not_found", "Operation not found");
  await assertProjectAccess(c, row.project_id);
  return row;
}
/** One page of the operations of a database, newest first, with the extra row that marks a next page. */
export async function operationsForDatabase(
  c: ApiContext,
  databaseId: string,
  pagination: Page,
): Promise<OperationRow[]> {
  // A deleted database keeps its operations readable.
  const database = await databaseForRequest(c, databaseId, true);
  const cursor = pagination.where("o.created_at", "o.id");
  return (
    await c.env.DB.prepare(
      `SELECT o.* FROM ${OPERATIONS_OF_ALL_KINDS} o WHERE o.database_id=? AND o.project_id=? AND ${cursor.sql}
        ORDER BY o.created_at DESC,o.id DESC LIMIT ?`,
    )
      .bind(
        database.id,
        database.project_id,
        ...cursor.bindings,
        pagination.limit + 1,
      )
      .all<OperationRow>()
  ).results;
}
export function isConstraintError(error: unknown): boolean {
  return (
    error instanceof Error && /UNIQUE constraint failed/.test(error.message)
  );
}
