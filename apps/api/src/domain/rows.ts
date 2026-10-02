// SPDX-License-Identifier: Apache-2.0
import {
  Database,
  Operation,
  Role,
  SizeClass,
  type DesiredState,
  type ObservedState,
} from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { assertProjectAccess, getAuth } from "../middleware/auth.ts";

export interface DatabaseRow {
  id: string;
  project_id: string;
  region_id: string;
  node_id: string | null;
  name: string;
  size_class_id: string;
  pg_major: 18;
  desired_state: DesiredState;
  observed_state: ObservedState;
  generation: number;
  observed_generation: number;
  status_message: string | null;
  archive_path: string;
  archiving_health: "ok" | "failing" | "unknown";
  archiving_health_since: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
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
  deleted_at: string | null;
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
  backup_bucket: string;
  backup_endpoint_url: string;
  agent_key_hash: string;
}
export interface SizeRow extends Omit<SizeClass, "enabled"> {
  enabled: number;
}

export function databaseView(row: DatabaseRow): Database {
  return Database.parse({
    id: row.id,
    project_id: row.project_id,
    region_id: row.region_id,
    name: row.name,
    size_class_id: row.size_class_id,
    desired_state: row.desired_state,
    observed_state: row.observed_state,
    generation: row.generation,
    observed_generation: row.observed_generation,
    status_message: row.status_message,
    health: {
      archiving: row.archiving_health,
      since: row.archiving_health_since,
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
  });
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
    `SELECT d.* FROM databases d JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL WHERE d.id=? ${includeDeleted ? "" : "AND d.deleted_at IS NULL"}`,
  )
    .bind(id)
    .first<DatabaseRow>();
  if (!row) throw new ApiError("not_found", "Database not found");
  await assertProjectAccess(c, row.project_id);
  return row;
}
export async function operationForRequest(
  c: ApiContext,
  id: string,
): Promise<OperationRow> {
  await getAuth(c);
  const row = await c.env.DB.prepare(
    "SELECT o.* FROM operations o JOIN projects p ON p.id=o.project_id AND p.deleted_at IS NULL JOIN databases d ON d.id=o.database_id AND d.project_id=o.project_id WHERE o.id=?",
  )
    .bind(id)
    .first<OperationRow>();
  if (!row) throw new ApiError("not_found", "Operation not found");
  await assertProjectAccess(c, row.project_id);
  return row;
}
export function isConstraintError(error: unknown): boolean {
  return (
    error instanceof Error && /UNIQUE constraint failed/.test(error.message)
  );
}
