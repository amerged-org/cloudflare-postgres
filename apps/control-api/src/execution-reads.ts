// SPDX-License-Identifier: Apache-2.0
import {
  error,
  fields,
  json,
  sha256,
  timestamp,
  type AccountingDb,
} from "./accounting";
import {
  actorBindings,
  actorPredicate,
  authorize,
  uid,
  type Actor,
} from "./execution-auth";
import { publicEnvironment, type EnvironmentRow } from "./environments";
import {
  publicRole,
  publicOperation as publicRoleOperation,
  type Role,
} from "./roles";
import {
  publicDatabase,
  publicOperation as publicDatabaseOperation,
  type Database,
} from "./databases";

import { publicBackup, publicBackupOperation, type Backup } from "./backups";
import { publicResizeOperation } from "./resize";
import { deletionReadColumns, deletionReadJoins } from "./environment-deletion";

export interface ProjectRow {
  id: string;
  organization_id: string;
  name: string;
  status: string;
  created_at: string;
}
export interface LegacyOperationRow {
  id: string;
  organization_id: string;
  project_id: string;
  kind: string;
  status: string;
  created_at: string;
  observed_at: string | null;
  result_code: string | null;
  environment_id?: string | null;
}
export function projectFromRow(row: ProjectRow) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
  };
}
export function operationFromRow(row: LegacyOperationRow) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
    observedAt: row.observed_at,
    resultCode: row.result_code,
    ...(row.environment_id ? { environmentId: row.environment_id } : {}),
  };
}
type Collection =
  "projects" | "environments" | "roles" | "databases" | "backups";
interface Scope {
  collection: Collection;
  organizationId: string;
  projectId: string | null;
  environmentId: string | null;
}
interface Cursor {
  domain: "execution-recovery";
  version: 1;
  binding: string;
  limit: number;
  createdAt: string;
  id: string;
}
type PageRow = (ProjectRow | EnvironmentRow | Role | Database | Backup) & {
  operation_count: number;
  current_operation_id: string | null;
};
interface OperationRow extends LegacyOperationRow {
  source: "legacy" | "role" | "database" | "backup" | "resize";
  backup_id: string | null;
  environment_id: string | null;
  role_id: string | null;
  database_id: string | null;
  credential_revision: number | null;
  cause: string | null;
  compute_revision: number | null;
  from_size_id: string | null;
  target_size_id: string | null;
}
function base64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function bytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0),
  );
}
async function cursorKey(env: Cloudflare.Env): Promise<CryptoKey> {
  if (!env.INSTALLATION_BOOTSTRAP_TOKEN)
    throw new Error("recovery_cursor_key_unavailable");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.INSTALLATION_BOOTSTRAP_TOKEN),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
async function encodeCursor(
  env: Cloudflare.Env,
  value: Cursor,
): Promise<string> {
  const content = new TextEncoder().encode(JSON.stringify(value));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await cursorKey(env),
    content,
  );
  return `${base64(content)}.${base64(new Uint8Array(signature))}`;
}
async function decodeCursor(
  env: Cloudflare.Env,
  value: string,
  binding: string,
  limit: number,
): Promise<Cursor | null> {
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value))
    return null;
  const key = await cursorKey(env);
  try {
    const [payload, signature] = value.split(".");
    const content = bytes(payload!);
    if (!(await crypto.subtle.verify("HMAC", key, bytes(signature!), content)))
      return null;
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        content,
      ),
    );
    if (
      !fields(parsed, [
        "domain",
        "version",
        "binding",
        "limit",
        "createdAt",
        "id",
      ]) ||
      parsed.domain !== "execution-recovery" ||
      parsed.version !== 1 ||
      parsed.binding !== binding ||
      parsed.limit !== limit ||
      timestamp(parsed.createdAt) === null ||
      !uid(parsed.id)
    )
      return null;
    return parsed as unknown as Cursor;
  } catch {
    return null;
  }
}
function actorRead(db: AccountingDb, actor: Actor): D1PreparedStatement {
  return db
    .prepare(`SELECT 1 AS authorized WHERE ${actorPredicate(actor)}`)
    .bind(...actorBindings(actor));
}
function parentRead(
  db: AccountingDb,
  actor: Actor,
  scope: Scope,
): D1PreparedStatement {
  if (scope.collection === "projects")
    return db
      .prepare(
        `SELECT id FROM organizations WHERE id = ? AND ${actorPredicate(actor)}`,
      )
      .bind(scope.organizationId, ...actorBindings(actor));
  if (scope.collection === "environments")
    return db
      .prepare(
        `SELECT id FROM projects WHERE id = ? AND organization_id = ? AND ${actorPredicate(actor)}`,
      )
      .bind(scope.projectId, scope.organizationId, ...actorBindings(actor));
  return db
    .prepare(
      `SELECT e.id FROM environments e JOIN projects p ON p.id = e.project_id AND p.organization_id = e.organization_id WHERE e.id = ? AND e.project_id = ? AND e.organization_id = ? AND ${actorPredicate(actor)}`,
    )
    .bind(
      scope.environmentId,
      scope.projectId,
      scope.organizationId,
      ...actorBindings(actor),
    );
}
function pageRead(
  db: AccountingDb,
  actor: Actor,
  scope: Scope,
  cursor: Cursor | null,
  limit: number,
): D1PreparedStatement {
  const table =
    scope.collection === "roles"
      ? "database_roles"
      : scope.collection === "databases"
        ? "logical_databases"
        : scope.collection === "backups"
          ? "environment_backups"
          : scope.collection;
  const predicates = ["r.organization_id = ?"];
  const bindings: Array<string | number> = [scope.organizationId];
  if (scope.collection !== "projects") {
    predicates.push("r.project_id = ?");
    bindings.push(scope.projectId!);
  }
  if (
    scope.collection === "roles" ||
    scope.collection === "databases" ||
    scope.collection === "backups"
  ) {
    predicates.push("r.environment_id = ?");
    bindings.push(scope.environmentId!);
  }
  if (cursor) {
    predicates.push("(r.created_at < ? OR (r.created_at = ? AND r.id < ?))");
    bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  predicates.push(actorPredicate(actor));
  bindings.push(...actorBindings(actor), limit + 1);
  let links: string;
  if (scope.collection === "projects")
    links = `FROM idempotency_requests q JOIN operations o
    ON o.id = q.operation_id AND o.organization_id = q.organization_id AND o.project_id = q.project_id
    WHERE q.project_id = page.id AND q.organization_id = page.organization_id
    AND o.kind = 'project.create' AND o.environment_id IS NULL`;
  else if (scope.collection === "environments")
    links = `FROM operations o WHERE o.organization_id=page.organization_id AND o.project_id=page.project_id
    AND o.environment_id=page.id AND o.region_id=page.region_id AND (
      (o.kind='environment.delete' AND EXISTS (SELECT 1 FROM environment_deletions d WHERE d.environment_id=page.id AND d.operation_id=o.id))
      OR (o.kind='environment.create' AND NOT EXISTS (SELECT 1 FROM environment_deletions d WHERE d.environment_id=page.id)
        AND EXISTS (SELECT 1 FROM environment_requests q
          WHERE q.operation_id=o.id AND q.organization_id=page.organization_id AND q.project_id=page.project_id AND q.environment_id=page.id)))`;
  else if (scope.collection === "roles")
    links =
      "FROM role_operations o WHERE o.role_id = page.id AND o.credential_revision = page.desired_credential_revision";
  else if (scope.collection === "backups")
    links = "FROM backup_operations o WHERE o.backup_id = page.id";
  else
    links =
      "FROM database_operations o WHERE o.database_id = page.id AND o.owner_role_id = page.owner_role_id";
  return db
    .prepare(
      `WITH page AS (SELECT r.* FROM ${table} r WHERE ${predicates.join(" AND ")}
    ORDER BY r.created_at DESC, r.id DESC LIMIT ?)
    SELECT page.*, ${scope.collection === "environments" ? deletionReadColumns + "," : ""} (SELECT COUNT(DISTINCT o.id) ${links}) AS operation_count,
    (SELECT MIN(o.id) ${links}) AS current_operation_id FROM page ${scope.collection === "environments" ? deletionReadJoins("page") : ""} ORDER BY page.created_at DESC, page.id DESC`,
    )
    .bind(...bindings);
}
function entry(scope: Scope, row: PageRow) {
  const currentOperationId = row.current_operation_id;
  if (
    !uid(row.id) ||
    timestamp(row.created_at) === null ||
    !Number.isSafeInteger(row.operation_count) ||
    row.operation_count < 0 ||
    row.operation_count > 1 ||
    (row.operation_count === 0 && currentOperationId !== null) ||
    (row.operation_count === 1 && !uid(currentOperationId))
  )
    throw new Error("recovery_state_inconsistent");
  switch (scope.collection) {
    case "projects":
      return { project: projectFromRow(row as ProjectRow), currentOperationId };
    case "environments":
      return {
        environment: publicEnvironment(row as EnvironmentRow),
        currentOperationId,
      };
    case "roles":
      return { role: publicRole(row as Role), currentOperationId };
    case "databases":
      return { database: publicDatabase(row as Database), currentOperationId };
    case "backups":
      return { backup: publicBackup(row as Backup), currentOperationId };
  }
}
async function collection(
  request: Request,
  env: Cloudflare.Env,
  db: AccountingDb,
  scope: Scope,
): Promise<Response> {
  const actor = await authorize(
    request,
    db,
    "organization",
    scope.organizationId,
    "projects:read",
  );
  if (actor instanceof Response) return actor;
  const parameters = new URL(request.url).searchParams;
  if (
    [...parameters.keys()].some(
      (key) =>
        !["limit", "cursor"].includes(key) ||
        parameters.getAll(key).length !== 1,
    )
  )
    return error(400, "invalid_request");
  const limitText = parameters.get("limit") ?? "50";
  if (!/^[1-9][0-9]{0,2}$/.test(limitText) || Number(limitText) > 100)
    return error(400, "invalid_request");
  const limit = Number(limitText);
  const binding = await sha256(
    JSON.stringify({
      domain: "execution-recovery",
      version: 1,
      ...scope,
      limit,
    }),
  );
  const cursorText = parameters.get("cursor");
  const cursor =
    cursorText === null
      ? null
      : await decodeCursor(env, cursorText, binding, limit);
  if (cursorText !== null && cursor === null)
    return error(400, "invalid_request");
  const result = await db.batch([
    actorRead(db, actor),
    parentRead(db, actor, scope),
    pageRead(db, actor, scope, cursor, limit),
  ]);
  if (result.length !== 3 || result.some((value) => !value.success))
    throw new Error("recovery_read_failed");
  if (result[0]!.results.length !== 1) return error(401, "unauthorized");
  if (result[1]!.results.length !== 1) return error(404, "not_found");
  const observedAt = new Date().toISOString();
  const rows = result[2]!.results as unknown as PageRow[];
  const records = rows.map((row) => entry(scope, row)).slice(0, limit);
  const last = rows[Math.min(rows.length, limit) - 1];
  const nextCursor =
    rows.length > limit && last
      ? await encodeCursor(env, {
          domain: "execution-recovery",
          version: 1,
          binding,
          limit,
          createdAt: last.created_at,
          id: last.id,
        })
      : null;
  // Signing occurs after the observed primary page. Recheck only authorization;
  // a later resource state change does not turn this into a cross-page snapshot.
  if (!(await actorRead(db, actor).first())) return error(401, "unauthorized");
  return json({
    [scope.collection]: records,
    consistency: "observed-page",
    observedAt,
    nextCursor,
  });
}
function operationRead(
  db: AccountingDb,
  actor: Actor,
  organizationId: string,
  operationId: string,
): D1PreparedStatement {
  const guard = actorPredicate(actor);
  const values = [operationId, organizationId, ...actorBindings(actor)];
  return db
    .prepare(
      `SELECT * FROM (
    SELECT 'legacy' AS source, o.id, o.organization_id, o.project_id, o.environment_id,
      NULL AS role_id, NULL AS database_id, NULL AS backup_id, NULL AS credential_revision,
      o.kind, o.status, o.created_at, o.observed_at, o.result_code,
      NULL AS cause, NULL AS compute_revision, NULL AS from_size_id, NULL AS target_size_id
    FROM operations o JOIN projects p ON p.id = o.project_id AND p.organization_id = o.organization_id
      LEFT JOIN environments e ON e.id = o.environment_id AND e.organization_id = o.organization_id AND e.project_id = o.project_id
    WHERE o.id = ? AND o.organization_id = ? AND (o.environment_id IS NULL OR e.id IS NOT NULL) AND ${guard}
    UNION ALL
    SELECT 'role', o.id, r.organization_id, r.project_id, r.environment_id,
      r.id, NULL, NULL, o.credential_revision, o.kind, o.status, o.created_at, o.observed_at, o.result_code,
      NULL, NULL, NULL, NULL
    FROM role_operations o JOIN database_roles r ON r.id = o.role_id
      JOIN projects p ON p.id = r.project_id AND p.organization_id = r.organization_id
      JOIN environments e ON e.id = r.environment_id AND e.organization_id = r.organization_id AND e.project_id = r.project_id
    WHERE o.id = ? AND r.organization_id = ? AND ${guard}
    UNION ALL
    SELECT 'database', o.id, d.organization_id, d.project_id, d.environment_id,
      d.owner_role_id, d.id, NULL, NULL, o.kind, o.status, o.created_at, o.observed_at, o.result_code,
      NULL, NULL, NULL, NULL
    FROM database_operations o JOIN logical_databases d ON d.id = o.database_id AND d.owner_role_id = o.owner_role_id
      JOIN projects p ON p.id = d.project_id AND p.organization_id = d.organization_id
      JOIN environments e ON e.id = d.environment_id AND e.organization_id = d.organization_id AND e.project_id = d.project_id
    WHERE o.id = ? AND d.organization_id = ? AND ${guard}
    UNION ALL
    SELECT 'backup', o.id, b.organization_id, b.project_id, b.environment_id,
      NULL, NULL, b.id, NULL, o.kind, o.status, o.created_at, o.observed_at, o.result_code,
      NULL, NULL, NULL, NULL
    FROM backup_operations o JOIN environment_backups b ON b.id=o.backup_id
      JOIN projects p ON p.id=b.project_id AND p.organization_id=b.organization_id
      JOIN environments e ON e.id=b.environment_id AND e.organization_id=b.organization_id AND e.project_id=b.project_id
    WHERE o.id=? AND b.organization_id=? AND ${guard}
    UNION ALL
    SELECT 'resize', o.id, o.organization_id, o.project_id, o.environment_id,
      NULL, NULL, NULL, NULL, o.kind, o.status, o.created_at, o.observed_at, o.result_code,
      o.cause, o.compute_revision, o.from_size_id, o.target_size_id
    FROM resize_operations o JOIN projects p ON p.id=o.project_id AND p.organization_id=o.organization_id
      JOIN environments e ON e.id=o.environment_id AND e.organization_id=o.organization_id AND e.project_id=o.project_id
    WHERE o.id=? AND o.organization_id=? AND ${guard}
  ) LIMIT 2`,
    )
    .bind(...values, ...values, ...values, ...values, ...values);
}
function publicTask(row: OperationRow) {
  if (row.source === "legacy") return operationFromRow(row);
  const ownership = {
    organizationId: row.organization_id,
    projectId: row.project_id,
    environmentId: row.environment_id,
  };
  if (row.source === "backup")
    return {
      ...publicBackupOperation({
        id: row.id,
        backup_id: row.backup_id!,
        kind: "environment.backup",
        status: row.status as "queued" | "running" | "completed" | "failed",
        created_at: row.created_at,
        observed_at: row.observed_at,
        result_code: row.result_code,
      }),
      ...ownership,
    };
  if (row.source === "resize")
    return {
      ...publicResizeOperation({
        id: row.id,
        kind: "environment.resize",
        cause: "manual",
        status: row.status as "queued" | "running" | "completed" | "failed",
        compute_revision: row.compute_revision!,
        from_size_id: row.from_size_id!,
        target_size_id: row.target_size_id!,
        created_at: row.created_at,
        observed_at: row.observed_at,
        result_code: row.result_code,
      }),
      ...ownership,
    };
  if (row.source === "role")
    return {
      ...publicRoleOperation({
        id: row.id,
        role_id: row.role_id!,
        credential_revision: row.credential_revision!,
        kind: "database.role.apply",
        status: row.status as "queued" | "running" | "applied" | "failed",
        created_at: row.created_at,
        observed_at: row.observed_at,
        result_code: row.result_code,
      }),
      ...ownership,
    };
  return {
    ...publicDatabaseOperation({
      id: row.id,
      database_id: row.database_id!,
      kind: "database.create",
      status: row.status as "queued" | "running" | "applied" | "failed",
      created_at: row.created_at,
      observed_at: row.observed_at,
      result_code: row.result_code,
    }),
    ...ownership,
    ownerRoleId: row.role_id,
  };
}
async function operation(
  request: Request,
  db: AccountingDb,
  organizationId: string,
  operationId: string,
): Promise<Response> {
  const actor = await authorize(
    request,
    db,
    "organization",
    organizationId,
    "operations:read",
  );
  if (actor instanceof Response) return actor;
  if (new URL(request.url).searchParams.size > 0)
    return error(400, "invalid_request");
  const result = await db.batch([
    actorRead(db, actor),
    operationRead(db, actor, organizationId, operationId),
  ]);
  if (result.length !== 2 || result.some((value) => !value.success))
    throw new Error("recovery_read_failed");
  if (result[0]!.results.length !== 1) return error(401, "unauthorized");
  if (result[1]!.results.length > 1) return error(500, "state_inconsistent");
  const row = result[1]!.results[0] as OperationRow | undefined;
  if (!row) return error(404, "not_found");
  return json({ operation: publicTask(row) });
}
export async function executionReads(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> {
  if (request.method !== "GET") return null;
  try {
    const path = new URL(request.url).pathname;
    const projects = /^\/v1\/organizations\/([^/]+)\/projects$/.exec(path);
    const environments =
      /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/environments$/.exec(
        path,
      );
    const children =
      /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/environments\/([^/]+)\/(roles|databases|backups)$/.exec(
        path,
      );
    const task = /^\/v1\/organizations\/([^/]+)\/operations\/([^/]+)$/.exec(
      path,
    );
    if (!projects && !environments && !children && !task) return null;
    const identifiers = projects
      ? [projects[1]]
      : environments
        ? [environments[1], environments[2]]
        : children
          ? [children[1], children[2], children[3]]
          : [task![1], task![2]];
    if (!identifiers.every(uid)) return error(400, "invalid_request");
    const db = env.DB.withSession("first-primary");
    if (task) return await operation(request, db, task[1]!, task[2]!);
    const scope: Scope = projects
      ? {
          collection: "projects",
          organizationId: projects[1]!,
          projectId: null,
          environmentId: null,
        }
      : environments
        ? {
            collection: "environments",
            organizationId: environments[1]!,
            projectId: environments[2]!,
            environmentId: null,
          }
        : {
            collection: children![4] as "roles" | "databases" | "backups",
            organizationId: children![1]!,
            projectId: children![2]!,
            environmentId: children![3]!,
          };
    return await collection(request, env, db, scope);
  } catch (failure) {
    return error(
      failure instanceof Error &&
        failure.message === "recovery_cursor_key_unavailable"
        ? 503
        : 500,
      failure instanceof Error &&
        failure.message === "recovery_state_inconsistent"
        ? "state_inconsistent"
        : "recovery_read_unavailable",
    );
  }
}
