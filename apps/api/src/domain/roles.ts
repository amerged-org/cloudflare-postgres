// SPDX-License-Identifier: Apache-2.0
import {
  ConnectionUri,
  newRolePassword,
  newOperationId,
  OWNER_ROLE_NAME,
  ROLE_LIMIT,
  roleExpiryInstant,
  type RoleCreate,
} from "@pgcf/contracts";
import { MAINTENANCE_ROLE } from "@pgcf/contracts/maintenance";
import { ApiError } from "../app.ts";
import { keyring } from "../crypto/keyring.ts";
import type { ApiContext, Env } from "../env.ts";
import { getAuth } from "../middleware/auth.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import { databaseOperationResponse, hint } from "./databases.ts";
import { syncDatabaseActor } from "./database-actor-sync.ts";
import type { IdempotencyLease } from "../middleware/idempotency.ts";
import {
  PoolBindingScope,
  PoolNodeReport,
  POSTGRES_POOL,
  poolBindingScopeHash,
} from "@pgcf/contracts/postgres-pool";
import { hasNonterminalPoolHolderSql } from "./postgres-pool.ts";
import { postgresPoolCnpgSelectionStatements } from "./postgres-pool-cold-start.ts";
import {
  databaseStartupHeadroomSql,
  startupReservationStatement,
} from "./startup-admission.ts";
import { withAdmissionMutation } from "./admission-mutations.ts";
import {
  databaseForRequest,
  isConstraintError,
  roleView,
  type RoleRow,
  type DatabaseRow,
  type OperationRow,
} from "./rows.ts";

async function roleForRequest(
  c: ApiContext,
  id: string,
  name: string,
): Promise<RoleRow> {
  await databaseForRequest(c, id);
  const row = await c.env.DB.prepare(
    "SELECT * FROM roles WHERE database_id=? AND name=? AND deleted_at IS NULL",
  )
    .bind(id, name)
    .first<RoleRow>();
  if (!row) throw new ApiError("not_found", "Role not found");
  return row;
}
async function roleResponse(
  c: ApiContext,
  id: string,
  name: string,
  status: 200 | 201 = 200,
): Promise<Response> {
  const role = await roleForRequest(c, id, name);
  await syncDatabaseActor(c, id);
  return c.json(roleView(role), status);
}
export async function listRoles(c: ApiContext, id: string): Promise<Response> {
  await databaseForRequest(c, id);
  const result = await c.env.DB.prepare(
    "SELECT * FROM roles WHERE database_id=? AND deleted_at IS NULL ORDER BY name",
  )
    .bind(id)
    .all<RoleRow>();
  return c.json({ data: result.results.map(roleView), next_cursor: null });
}
/** A mutation that starts long-running regional work states its retry identity up front. */
function requireIdempotencyKey(c: ApiContext, what: string): void {
  if (!c.req.header("Idempotency-Key"))
    throw new ApiError(
      "invalid_request",
      `${what} requires an Idempotency-Key`,
    );
}
/** What a role is created with; the defaults are those of a plain login role. */
interface RoleAttributes {
  validUntil: string | null;
  connectionLimit: number | null;
  memberOf: string[];
  bypassRls: boolean;
}
/**
 * Time and database dependent checks that the contract cannot make. They run when the request
 * executes, never on an idempotent replay, which answers from the retained result.
 */
async function roleAttributes(
  c: ApiContext,
  databaseId: string,
  body: RoleCreate,
): Promise<RoleAttributes> {
  // PostgreSQL applies the expiry at its whole second, so that is the instant that must lie ahead.
  if (
    body.valid_until !== undefined &&
    roleExpiryInstant(body.valid_until) <= Date.now()
  )
    throw new ApiError(
      "invalid_request",
      "valid_until must be in the future, at whole seconds",
    );
  const memberOf = [...(body.member_of ?? [])].sort();
  if (memberOf.length) {
    const live = await c.env.DB.prepare(
      `SELECT COUNT(*) count FROM roles WHERE database_id=? AND owner=0 AND deleted_at IS NULL AND name IN(SELECT value FROM json_each(?))`,
    )
      .bind(databaseId, JSON.stringify(memberOf))
      .first<number>("count");
    if (live !== memberOf.length)
      throw new ApiError(
        "invalid_request",
        "member_of must name live roles of this database that are neither the owner nor being deleted",
      );
  }
  return {
    validUntil: body.valid_until ?? null,
    connectionLimit: body.connection_limit ?? null,
    memberOf,
    bypassRls: body.bypass_rls ?? false,
  };
}
/** The atomic form of the member_of check: every target is still a live role at commit. */
const MEMBER_TARGETS_SQL = `(SELECT COUNT(*) FROM roles t WHERE t.database_id=? AND t.owner=0 AND t.deleted_at IS NULL AND t.name IN(SELECT value FROM json_each(?)))=?`;
interface DeferredRoleRow extends OperationRow {
  expected_generation: number;
  binding_id: string;
  holder_revision: number;
  name: string;
  expected_password_revision: number;
  password_ciphertext: string | null;
  password_iv: string | null;
  password_kid: string | null;
  drain_deadline: number;
  resume_operation_id: string | null;
}
/** A pool holder keeps its immutable generation and active credentials while genuine sessions drain. */
async function deferPoolRoleChange(
  c: ApiContext,
  db: DatabaseRow,
  name: string,
  kind: "create" | "reset",
  revision: number,
  lease: IdempotencyLease,
  attributes: RoleAttributes = {
    validUntil: null,
    connectionLimit: null,
    memberOf: [],
    bypassRls: false,
  },
): Promise<Response | undefined> {
  if (
    await c.env.DB.prepare(
      "SELECT 1 FROM pool_role_mutations WHERE database_id=? AND status IN('pending','running')",
    )
      .bind(db.id)
      .first()
  )
    throw new ApiError(
      "conflict",
      "A role change is already waiting for pool release",
    );
  const holder = await c.env.DB.prepare(
    "SELECT b.id,b.state,b.scope_json,b.holder_revision FROM pool_bindings b JOIN database_runtime_holders h ON h.binding_id=b.id AND h.database_id=b.database_id AND h.kind='pool' AND h.revision=b.holder_revision WHERE b.database_id=? AND b.state NOT IN('released','refused')",
  )
    .bind(db.id)
    .first<{
      id: string;
      state: string;
      scope_json: string;
      holder_revision: number;
    }>();
  if (!holder) {
    if (
      await c.env.DB.prepare(
        `SELECT 1 FROM databases d WHERE d.id=? AND ${hasNonterminalPoolHolderSql("d")}`,
      )
        .bind(db.id)
        .first()
    )
      throw new ApiError("conflict", "Pool holder requires physical recovery");
    return undefined;
  }
  const scope = PoolBindingScope.parse(JSON.parse(holder.scope_json));
  if (
    !["claimed", "mounted", "serving"].includes(holder.state) ||
    scope.generation !== db.generation ||
    scope.database_id !== db.id
  )
    throw new ApiError("conflict", "Pool holder requires physical recovery");
  const operation = newOperationId(),
    now = new Date().toISOString(),
    deadline =
      Date.now() +
      (scope.storage.backend === "lvm-thin-v1"
        ? scope.storage.profile.drain_seconds * 1000
        : POSTGRES_POOL.permission_ms);
  const password = await keyring(c.env.CREDENTIAL_KEYS).encrypt(
    db.id,
    name,
    newRolePassword(),
  );
  const issuer = (await getAuth(c)).id;
  await withAdmissionMutation(c.env, [db.id], async (mutation) => {
    const guard = mutation.guard(db.id);
    const results = await mutation.batch([
      c.env.DB.prepare(
        `INSERT INTO pool_role_mutations(id,kind,status,project_id,database_id,generation,expected_generation,binding_id,holder_revision,name,expected_password_revision,password_ciphertext,password_iv,password_kid,drain_deadline,created_at,updated_at,valid_until,connection_limit,member_of_json,bypass_rls,created_by_key_id)
        SELECT ?,?,'pending',d.project_id,d.id,d.generation+1,d.generation,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM databases d JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL
        JOIN pool_bindings b ON b.database_id=d.id JOIN database_runtime_holders h ON h.binding_id=b.id AND h.database_id=d.id AND h.revision=b.holder_revision
        WHERE d.id=? AND d.project_id=? AND d.generation=? AND d.deleted_at IS NULL AND b.id=? AND b.state='detaching' AND h.state='detaching' AND b.holder_revision=?
        AND ((?='create' AND NOT EXISTS(SELECT 1 FROM roles WHERE database_id=d.id AND name=?) AND (SELECT COUNT(*) FROM roles WHERE database_id=d.id)<${ROLE_LIMIT} AND ${MEMBER_TARGETS_SQL})
          OR (?='reset' AND EXISTS(SELECT 1 FROM roles WHERE database_id=d.id AND name=? AND password_revision=? AND deleted_at IS NULL))) AND ${guard.sql}`,
      ).bind(
        operation,
        kind === "create"
          ? "database.role.create"
          : "database.role.reset_password",
        holder.id,
        holder.holder_revision,
        name,
        revision,
        password.ciphertext,
        password.iv,
        password.kid,
        deadline,
        now,
        now,
        attributes.validUntil,
        attributes.connectionLimit,
        JSON.stringify(attributes.memberOf),
        Number(attributes.bypassRls),
        issuer,
        db.id,
        db.project_id,
        db.generation,
        holder.id,
        holder.holder_revision,
        kind,
        name,
        db.id,
        JSON.stringify(attributes.memberOf),
        attributes.memberOf.length,
        kind,
        name,
        revision,
        ...guard.bindings,
      ),
      lease.completeStatement(operation, 202, {
        sql: "EXISTS(SELECT 1 FROM pool_role_mutations WHERE id=? AND database_id=? AND status='pending')",
        bindings: [operation, db.id],
      }),
    ]);
    if (results[0]!.meta.changes !== 1)
      throw new ApiError("conflict", "Database, role or pool holder changed");
  });
  hint(c, db.region_id, [db.id]);
  return databaseOperationResponse(c, operation);
}

export async function desiredDeferredPoolRole(env: Env, id: string) {
  const row = await env.DB.prepare(
    "SELECT id,binding_id,expected_generation,kind,name,drain_deadline FROM pool_role_mutations WHERE database_id=? AND status='pending'",
  )
    .bind(id)
    .first<
      Pick<
        DeferredRoleRow,
        | "id"
        | "binding_id"
        | "expected_generation"
        | "kind"
        | "name"
        | "drain_deadline"
      >
    >();
  return row
    ? {
        operation_id: row.id,
        binding_id: row.binding_id,
        generation: row.expected_generation,
        kind:
          row.kind === "database.role.create"
            ? ("create" as const)
            : ("reset" as const),
        name: row.name,
        drain_deadline: row.drain_deadline,
      }
    : undefined;
}

/** Only a positively recorded terminal physical release may commit the requested credentials. */
export async function finalizeDeferredPoolRoleChange(
  env: Env,
  id: string,
): Promise<boolean> {
  await refreshDeferredPoolRoleOperations(env, id);
  const pending = await env.DB.prepare(
    "SELECT * FROM pool_role_mutations WHERE database_id=? AND status='pending'",
  )
    .bind(id)
    .first<DeferredRoleRow>();
  if (!pending) return false;
  const held = await env.DB.prepare(
    "SELECT b.state,b.scope_json,b.scope_sha256,b.node_report_json,h.state holder_state,h.clean_stop,h.revision,n.node_uid current_node_uid,n.lost_at FROM pool_bindings b JOIN database_runtime_holders h ON h.database_id=b.database_id AND h.binding_id=b.id JOIN nodes n ON n.id=b.node_id WHERE b.id=? AND b.database_id=?",
  )
    .bind(pending.binding_id, id)
    .first<{
      state: string;
      scope_json: string;
      scope_sha256: string;
      node_report_json: string | null;
      holder_state: string;
      clean_stop: number | null;
      revision: number;
      current_node_uid: string | null;
      lost_at: string | null;
    }>();
  const db = await env.DB.prepare("SELECT * FROM databases WHERE id=?")
    .bind(id)
    .first<DatabaseRow>();
  if (!held || !db) return false;
  const scope = PoolBindingScope.parse(JSON.parse(held.scope_json));
  if (
    scope.database_id !== id ||
    scope.binding_id !== pending.binding_id ||
    (await poolBindingScopeHash(scope)) !== held.scope_sha256
  )
    return false;
  const holderLost =
    ["failed", "lost"].includes(held.state) ||
    held.lost_at !== null ||
    held.current_node_uid !== scope.node_uid ||
    (held.state === "released" &&
      held.holder_state === "released" &&
      held.revision === pending.holder_revision &&
      held.clean_stop === 0);
  if (
    holderLost ||
    db.generation !== pending.expected_generation ||
    db.deleted_at !== null ||
    db.desired_state === "deleted"
  ) {
    await env.DB.prepare(
      "UPDATE pool_role_mutations SET status='failed',error_code=?,error_message='Role change cannot apply to the retained pool holder',password_ciphertext=NULL,password_iv=NULL,password_kid=NULL,updated_at=?,completed_at=? WHERE id=? AND status='pending'",
    )
      .bind(
        holderLost ? "pool_holder_unproved" : "superseded",
        new Date().toISOString(),
        new Date().toISOString(),
        pending.id,
      )
      .run();
    return false;
  }
  if (
    !["released", "refused"].includes(held.state) ||
    held.holder_state !== held.state ||
    held.revision !== pending.holder_revision ||
    !held.node_report_json
  )
    return false;
  const report = PoolNodeReport.safeParse(JSON.parse(held.node_report_json));
  if (
    !report.success ||
    report.data.state !== held.state ||
    report.data.binding_id !== pending.binding_id ||
    report.data.scope_sha256 !== held.scope_sha256 ||
    report.data.node_uid !== scope.node_uid ||
    report.data.pool_pod_uid !== scope.pool_pod_uid ||
    scope.generation !== pending.expected_generation ||
    (held.state === "released" &&
      (report.data.clean_stop !== true || held.clean_stop !== 1)) ||
    (held.state === "refused" &&
      !report.data.kernel_proof.never_attached_verified)
  )
    return false;
  return withAdmissionMutation(env, [id], async (mutation) => {
    const guard = mutation.guard(id),
      now = new Date().toISOString(),
      resume = newOperationId();
    const allowed = `EXISTS(SELECT 1 FROM pool_role_mutations q JOIN databases d ON d.id=q.database_id JOIN projects p ON p.id=q.project_id AND p.deleted_at IS NULL
      JOIN pool_bindings b ON b.id=q.binding_id JOIN database_runtime_holders h ON h.database_id=d.id AND h.binding_id=b.id
      WHERE q.id=? AND q.status='pending' AND d.generation=q.expected_generation AND d.deleted_at IS NULL AND d.desired_state='running' AND EXISTS(SELECT 1 FROM operations restart WHERE restart.id=? AND restart.database_id=d.id AND restart.generation=q.generation AND restart.kind='database.resume' AND restart.status='pending')
      AND b.node_report_json=? AND b.state=? AND h.state=b.state AND h.revision=q.holder_revision)
      AND NOT EXISTS(SELECT 1 FROM pool_bindings WHERE database_id=? AND state NOT IN('released','refused')) AND ${guard.sql}`;
    const bindings = [
      pending.id,
      resume,
      held.node_report_json,
      held.state,
      id,
      ...guard.bindings,
    ];
    const role =
      pending.kind === "database.role.create"
        ? env.DB.prepare(
            `INSERT INTO roles(database_id,name,owner,password_ciphertext,password_iv,password_kid,password_revision,created_at,updated_at,valid_until,connection_limit,member_of_json,bypass_rls,created_by_key_id)
          SELECT database_id,name,0,password_ciphertext,password_iv,password_kid,1,?,?,valid_until,connection_limit,member_of_json,bypass_rls,created_by_key_id FROM pool_role_mutations WHERE id=? AND ${allowed}
          AND NOT EXISTS(SELECT 1 FROM roles r WHERE r.database_id=pool_role_mutations.database_id AND r.name=pool_role_mutations.name)
          AND (SELECT COUNT(*) FROM roles r WHERE r.database_id=pool_role_mutations.database_id)<${ROLE_LIMIT}
          AND (SELECT COUNT(*) FROM roles t WHERE t.database_id=pool_role_mutations.database_id AND t.owner=0 AND t.deleted_at IS NULL AND t.name IN(SELECT value FROM json_each(pool_role_mutations.member_of_json)))=json_array_length(pool_role_mutations.member_of_json)`,
          ).bind(now, now, pending.id, ...bindings)
        : env.DB.prepare(
            `UPDATE roles SET password_ciphertext=?,password_iv=?,password_kid=?,password_revision=password_revision+1,updated_at=? WHERE database_id=? AND name=? AND password_revision=? AND deleted_at IS NULL AND ${allowed}`,
          ).bind(
            pending.password_ciphertext,
            pending.password_iv,
            pending.password_kid,
            now,
            id,
            pending.name,
            pending.expected_password_revision,
            ...bindings,
          );
    const eligibleRole =
      pending.kind === "database.role.create"
        ? `NOT EXISTS(SELECT 1 FROM roles r WHERE r.database_id=d.id AND r.name=q.name) AND (SELECT COUNT(*) FROM roles r WHERE r.database_id=d.id)<${ROLE_LIMIT}`
        : "EXISTS(SELECT 1 FROM roles r WHERE r.database_id=d.id AND r.name=q.name AND r.password_revision=q.expected_password_revision AND r.deleted_at IS NULL)";
    const results = await mutation.batch([
      env.DB.prepare(
        `INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at)
        SELECT ?,'database.resume','pending',d.project_id,d.id,d.generation+1,?,? FROM databases d WHERE d.id=?
        AND (d.generation=? AND d.desired_state='running' AND d.deleted_at IS NULL AND EXISTS(SELECT 1 FROM projects p WHERE p.id=d.project_id AND p.deleted_at IS NULL)
          AND EXISTS(SELECT 1 FROM pool_role_mutations q JOIN pool_bindings b ON b.id=q.binding_id JOIN database_runtime_holders h ON h.database_id=q.database_id AND h.binding_id=b.id
            WHERE q.id=? AND q.database_id=d.id AND q.status='pending' AND q.expected_generation=d.generation AND b.node_report_json=? AND b.state=? AND h.state=b.state AND h.revision=q.holder_revision AND (${eligibleRole})))
        AND ${databaseStartupHeadroomSql("d")} AND ${guard.sql}`,
      ).bind(
        resume,
        now,
        now,
        id,
        pending.expected_generation,
        pending.id,
        held.node_report_json,
        held.state,
        ...guard.bindings,
      ),
      role,
      env.DB.prepare(
        `UPDATE databases SET generation=generation+1,power_operation=?,observed_state='provisioning',updated_at=? WHERE changes()=1 AND id=? AND generation=? AND ${guard.sql}`,
      ).bind(resume, now, id, pending.expected_generation, ...guard.bindings),
      startupReservationStatement(env.DB, {
        databaseId: id,
        operationId: resume,
        generation: pending.generation,
        nodeId: scope.node_id,
        now,
      }),
      env.DB.prepare(
        `UPDATE pool_role_mutations SET status='running',resume_operation_id=?,password_ciphertext=NULL,password_iv=NULL,password_kid=NULL,updated_at=? WHERE id=? AND status='pending' AND EXISTS(SELECT 1 FROM databases d JOIN operations o ON o.id=d.power_operation WHERE d.id=? AND d.generation=? AND d.power_operation=? AND o.kind='database.resume' AND o.status='pending') AND ${guard.sql}`,
      ).bind(
        resume,
        now,
        pending.id,
        id,
        pending.generation,
        resume,
        ...guard.bindings,
      ),
      env.DB.prepare(
        `UPDATE pool_role_mutations SET status='failed',error_code='superseded',error_message='Database or role changed before physical release',password_ciphertext=NULL,password_iv=NULL,password_kid=NULL,updated_at=?,completed_at=? WHERE id=? AND status='pending' AND NOT EXISTS(SELECT 1 FROM databases d WHERE d.id=pool_role_mutations.database_id AND d.generation=pool_role_mutations.expected_generation AND d.deleted_at IS NULL AND d.desired_state='running' AND ((pool_role_mutations.kind='database.role.create' AND NOT EXISTS(SELECT 1 FROM roles r WHERE r.database_id=d.id AND r.name=pool_role_mutations.name)) OR (pool_role_mutations.kind='database.role.reset_password' AND EXISTS(SELECT 1 FROM roles r WHERE r.database_id=d.id AND r.name=pool_role_mutations.name AND r.password_revision=pool_role_mutations.expected_password_revision AND r.deleted_at IS NULL)))) AND ${guard.sql}`,
      ).bind(now, now, pending.id, ...guard.bindings),
      ...postgresPoolCnpgSelectionStatements(env.DB, {
        databaseId: id,
        generation: pending.generation,
        now: Date.parse(now),
        guard,
        roleOperationId: pending.id,
        operationId: resume,
      }),
    ]);
    return results[4]!.meta.changes === 1;
  });
}

/** Runtime completion comes from the existing resume operation's accepted regional facts. */
export async function refreshDeferredPoolRoleOperations(env: Env, id: string) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE pool_role_mutations SET status='failed',error_code='superseded',error_message='Role generation changed before runtime readiness',updated_at=?,completed_at=?
    WHERE database_id=? AND status='running' AND EXISTS(SELECT 1 FROM databases d WHERE d.id=pool_role_mutations.database_id AND (d.generation<>pool_role_mutations.generation OR d.deleted_at IS NOT NULL OR d.desired_state='deleted'))`,
  )
    .bind(now, now, id)
    .run();
  await env.DB.prepare(
    `UPDATE pool_role_mutations SET status=(SELECT o.status FROM operations o WHERE o.id=resume_operation_id),
      error_code=(SELECT o.error_code FROM operations o WHERE o.id=resume_operation_id),error_message=(SELECT o.error_message FROM operations o WHERE o.id=resume_operation_id),updated_at=?,completed_at=?
    WHERE database_id=? AND status='running' AND EXISTS(SELECT 1 FROM operations o WHERE o.id=pool_role_mutations.resume_operation_id AND o.database_id=pool_role_mutations.database_id
      AND o.project_id=pool_role_mutations.project_id AND o.generation=pool_role_mutations.generation AND o.status IN('succeeded','failed'))`,
  )
    .bind(now, now, id)
    .run();
}

/** Bounded cursor recovery handles lost callbacks without replaying any credential mutation. */
export async function recoverDeferredPoolRoleChanges(
  env: Env,
): Promise<number> {
  const cursor = await env.DB.prepare(
    "SELECT cursor FROM pool_role_mutation_cursor WHERE singleton=1",
  ).first<string | null>("cursor");
  const rows = await env.DB.prepare(
    "SELECT id,database_id FROM pool_role_mutations WHERE status IN('pending','running') AND id>? ORDER BY id LIMIT 9",
  )
    .bind(cursor ?? "")
    .all<{ id: string; database_id: string }>();
  let completed = 0;
  for (const row of rows.results.slice(0, 8)) {
    try {
      if (await finalizeDeferredPoolRoleChange(env, row.database_id))
        completed++;
    } catch (error) {
      if (!(error instanceof ApiError && error.code === "conflict"))
        throw error;
    }
  }
  await env.DB.prepare(
    "UPDATE pool_role_mutation_cursor SET cursor=? WHERE singleton=1 AND cursor IS ?",
  )
    .bind(rows.results.length > 8 ? rows.results[7]!.id : null, cursor)
    .run();
  return completed;
}
export async function createRole(
  c: ApiContext,
  id: string,
  body: RoleCreate,
): Promise<Response> {
  const db = await databaseForRequest(c, id);
  requireIdempotencyKey(c, "Role creation");
  return withIdempotency(c, {
    replay: async (name, status) =>
      status === 202
        ? databaseOperationResponse(c, name)
        : roleResponse(c, id, name, 201),
    execute: async (lease) => {
      const attributes = await roleAttributes(c, id, body);
      const deferred = await deferPoolRoleChange(
        c,
        db,
        body.name,
        "create",
        0,
        lease,
        attributes,
      );
      if (deferred) return deferred;
      const now = new Date().toISOString(),
        generation = db.generation + 1,
        issuer = (await getAuth(c)).id;
      const password = await keyring(c.env.CREDENTIAL_KEYS).encrypt(
        id,
        body.name,
        newRolePassword(),
      );
      let result: D1Result[];
      try {
        result = await withAdmissionMutation(c.env, [id], async (mutation) => {
          const guard = mutation.guard(id);
          return mutation.batch([
            c.env.DB.prepare(
              `INSERT INTO roles (database_id,name,owner,password_ciphertext,password_iv,password_kid,password_revision,created_at,updated_at,valid_until,connection_limit,member_of_json,bypass_rls,created_by_key_id)
          SELECT id,?,0,?,?,?,1,?,?,?,?,?,?,? FROM databases WHERE id=? AND project_id=? AND generation=? AND deleted_at IS NULL
          AND EXISTS(SELECT 1 FROM projects WHERE id=databases.project_id AND deleted_at IS NULL)
          AND NOT ${hasNonterminalPoolHolderSql("databases")} AND (SELECT COUNT(*) FROM roles WHERE database_id=databases.id)<${ROLE_LIMIT}
          AND ${MEMBER_TARGETS_SQL}
          AND NOT EXISTS(SELECT 1 FROM pool_role_mutations pr WHERE pr.database_id=? AND pr.status IN('pending','running')) AND ${guard.sql}`,
            ).bind(
              body.name,
              password.ciphertext,
              password.iv,
              password.kid,
              now,
              now,
              attributes.validUntil,
              attributes.connectionLimit,
              JSON.stringify(attributes.memberOf),
              Number(attributes.bypassRls),
              issuer,
              id,
              db.project_id,
              db.generation,
              id,
              JSON.stringify(attributes.memberOf),
              attributes.memberOf.length,
              id,
              ...guard.bindings,
            ),
            c.env.DB.prepare(
              `UPDATE databases SET generation=generation+1,updated_at=? WHERE changes()=1 AND id=? AND project_id=? AND generation=? AND deleted_at IS NULL AND ${guard.sql}`,
            ).bind(now, id, db.project_id, db.generation, ...guard.bindings),
            lease.completeStatement(body.name, 201, {
              sql: "EXISTS(SELECT 1 FROM databases d JOIN roles r ON r.database_id=d.id WHERE d.id=? AND d.project_id=? AND d.generation=? AND r.name=? AND r.password_revision=1)",
              bindings: [id, db.project_id, generation, body.name],
            }),
          ]);
        });
      } catch (error) {
        if (isConstraintError(error)) {
          const removing = await c.env.DB.prepare(
            "SELECT 1 FROM roles WHERE database_id=? AND name=? AND deleted_at IS NOT NULL",
          )
            .bind(id, body.name)
            .first();
          throw new ApiError(
            "conflict",
            removing
              ? "A role of this name is being deleted; create it again once the deletion has completed"
              : "Role already exists",
          );
        }
        throw error;
      }
      if (result[0]!.meta.changes !== 1 || result[1]!.meta.changes !== 1)
        throw new ApiError(
          "conflict",
          "Database changed or role limit reached",
        );
      hint(c, db.region_id, [id]);
      return roleResponse(c, id, body.name, 201);
    },
  });
}
export async function resetPassword(
  c: ApiContext,
  id: string,
  name: string,
): Promise<Response> {
  const db = await databaseForRequest(c, id),
    row = await roleForRequest(c, id, name);
  requireIdempotencyKey(c, "Password reset");
  return withIdempotency(c, {
    replay: async (role, status) =>
      status === 202
        ? databaseOperationResponse(c, role)
        : roleResponse(c, id, role),
    execute: async (lease) => {
      const deferred = await deferPoolRoleChange(
        c,
        db,
        name,
        "reset",
        row.password_revision,
        lease,
      );
      if (deferred) return deferred;
      const now = new Date().toISOString(),
        password = await keyring(c.env.CREDENTIAL_KEYS).encrypt(
          id,
          name,
          newRolePassword(),
        );
      const result = await withAdmissionMutation(
        c.env,
        [id],
        async (mutation) => {
          const guard = mutation.guard(id);
          return mutation.batch([
            c.env.DB.prepare(
              `UPDATE roles SET password_ciphertext=?,password_iv=?,password_kid=?,password_revision=password_revision+1,updated_at=?
        WHERE database_id=? AND name=? AND password_revision=? AND deleted_at IS NULL
        AND EXISTS(SELECT 1 FROM databases d JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL WHERE d.id=roles.database_id AND d.project_id=? AND d.generation=? AND d.deleted_at IS NULL AND NOT ${hasNonterminalPoolHolderSql("d")})
        AND NOT EXISTS(SELECT 1 FROM pool_role_mutations pr WHERE pr.database_id=? AND pr.status IN('pending','running')) AND ${guard.sql}`,
            ).bind(
              password.ciphertext,
              password.iv,
              password.kid,
              now,
              id,
              name,
              row.password_revision,
              db.project_id,
              db.generation,
              id,
              ...guard.bindings,
            ),
            c.env.DB.prepare(
              `UPDATE databases SET generation=generation+1,updated_at=? WHERE changes()=1 AND id=? AND project_id=? AND generation=? AND deleted_at IS NULL AND ${guard.sql}`,
            ).bind(now, id, db.project_id, db.generation, ...guard.bindings),
            lease.completeStatement(name, 200, {
              sql: "EXISTS(SELECT 1 FROM databases d JOIN roles r ON r.database_id=d.id WHERE d.id=? AND d.project_id=? AND d.generation=? AND r.name=? AND r.password_revision=?)",
              bindings: [
                id,
                db.project_id,
                db.generation + 1,
                name,
                row.password_revision + 1,
              ],
            }),
          ]);
        },
      );
      if (result[0]!.meta.changes !== 1 || result[1]!.meta.changes !== 1)
        throw new ApiError(
          "conflict",
          "Database or role changed; retry the request",
        );
      hint(c, db.region_id, [id]);
      return roleResponse(c, id, name);
    },
  });
}
/**
 * Deletes a role: it is unroutable the moment this commits, and the region then sets it to
 * NOLOGIN, ends its sessions and drops it. The row stays as a tombstone, with its credential, until
 * PostgreSQL confirms the removal; only a confirmed removal frees the name.
 */
export async function deleteRole(
  c: ApiContext,
  id: string,
  name: string,
): Promise<Response> {
  const db = await databaseForRequest(c, id);
  requireIdempotencyKey(c, "Role deletion");
  if (name === OWNER_ROLE_NAME)
    throw new ApiError("invalid_request", "The owner role cannot be deleted");
  if (name === MAINTENANCE_ROLE)
    throw new ApiError(
      "invalid_request",
      "Role name is reserved for internal maintenance",
    );
  return withIdempotency(c, {
    replay: (operation, status) =>
      databaseOperationResponse(c, operation, status),
    execute: async (lease) => {
      const row = await c.env.DB.prepare(
        "SELECT * FROM roles WHERE database_id=? AND name=?",
      )
        .bind(id, name)
        .first<RoleRow>();
      if (!row) throw new ApiError("not_found", "Role not found");
      // A database that is not running applies the removal at its next wake; the role is
      // unroutable already, which is all an operation completed in that state promises.
      const dormant = db.desired_state === "suspended" || db.node_id === null;
      // A removal that is not over answers with its own operation, and so does one that completed
      // for a database that was not running while the database still is not. A failed removal, or
      // one completed in the dormant state that a running database has not yet confirmed, starts
      // again: its operation then reports what PostgreSQL did.
      const tombstone = row.deleted_at !== null;
      if (tombstone) {
        const latest = row.delete_operation_id
          ? await c.env.DB.prepare(
              "SELECT id,status FROM role_deletions WHERE id=? AND database_id=?",
            )
              .bind(row.delete_operation_id, id)
              .first<{ id: string; status: string }>()
          : null;
        if (
          latest &&
          (latest.status === "pending" ||
            latest.status === "running" ||
            (latest.status === "succeeded" && dormant))
        ) {
          await lease.completeStatement(latest.id, 202).run();
          return databaseOperationResponse(c, latest.id);
        }
      } else {
        if (
          await c.env.DB.prepare(
            `SELECT 1 FROM roles m, json_each(m.member_of_json) j WHERE m.database_id=? AND m.deleted_at IS NULL AND m.name<>? AND j.value=?`,
          )
            .bind(id, name, name)
            .first()
        )
          throw new ApiError(
            "conflict",
            "Role is a member_of target of another role; delete the members first",
          );
      }
      if (
        await c.env.DB.prepare(
          `SELECT 1 FROM databases d WHERE d.id=? AND ${hasNonterminalPoolHolderSql("d")}`,
        )
          .bind(id)
          .first()
      )
        throw new ApiError(
          "conflict",
          "A role cannot be deleted while the database is bound to a shared pool; retry after it is released",
        );
      if (
        await c.env.DB.prepare(
          "SELECT 1 FROM pool_role_mutations WHERE database_id=? AND status IN('pending','running')",
        )
          .bind(id)
          .first()
      )
        throw new ApiError(
          "conflict",
          "A role change is already waiting for pool release",
        );
      const operation = newOperationId(),
        now = new Date().toISOString(),
        issuer = (await getAuth(c)).id,
        generation = db.generation + 1;
      const result = await withAdmissionMutation(
        c.env,
        [id],
        async (mutation) => {
          const guard = mutation.guard(id);
          const scope = `EXISTS(SELECT 1 FROM databases d JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL WHERE d.id=roles.database_id AND d.project_id=? AND d.generation=? AND d.deleted_at IS NULL AND NOT ${hasNonterminalPoolHolderSql("d")})`;
          return mutation.batch([
            c.env.DB.prepare(
              `UPDATE roles SET deleted_at=COALESCE(deleted_at,?),updated_at=?,deleted_by_key_id=?,delete_operation_id=?
            WHERE database_id=? AND name=? AND owner=0
            AND ${tombstone ? "deleted_at IS NOT NULL AND delete_operation_id IS ?" : "deleted_at IS NULL"}
            AND ${scope}
            AND NOT EXISTS(SELECT 1 FROM roles m, json_each(m.member_of_json) j WHERE m.database_id=roles.database_id AND m.deleted_at IS NULL AND m.name<>roles.name AND j.value=roles.name)
            AND NOT EXISTS(SELECT 1 FROM pool_role_mutations pr WHERE pr.database_id=roles.database_id AND pr.status IN('pending','running'))
            AND ${guard.sql}`,
            ).bind(
              now,
              now,
              issuer,
              operation,
              id,
              name,
              ...(tombstone ? [row.delete_operation_id] : []),
              db.project_id,
              db.generation,
              ...guard.bindings,
            ),
            c.env.DB.prepare(
              `UPDATE databases SET generation=generation+1,updated_at=? WHERE changes()=1 AND id=? AND project_id=? AND generation=? AND deleted_at IS NULL AND ${guard.sql}`,
            ).bind(now, id, db.project_id, db.generation, ...guard.bindings),
            c.env.DB.prepare(
              `INSERT INTO role_deletions(id,status,project_id,database_id,generation,role_name,created_at,updated_at,completed_at)
            SELECT ?,?,project_id,id,generation,?,?,?,? FROM databases WHERE changes()=1 AND id=? AND project_id=? AND generation=? AND ${guard.sql}`,
            ).bind(
              operation,
              dormant ? "succeeded" : "pending",
              name,
              now,
              now,
              dormant ? now : null,
              id,
              db.project_id,
              generation,
              ...guard.bindings,
            ),
            lease.completeStatement(operation, 202, {
              sql: "EXISTS(SELECT 1 FROM role_deletions WHERE id=? AND database_id=? AND project_id=?)",
              bindings: [operation, id, db.project_id],
            }),
          ]);
        },
      );
      if (result[0]!.meta.changes !== 1 || result[2]!.meta.changes !== 1)
        throw new ApiError(
          "conflict",
          "Database or role changed; retry the request",
        );
      hint(c, db.region_id, [id]);
      return databaseOperationResponse(c, operation);
    },
  });
}
export async function connectionUri(
  c: ApiContext,
  id: string,
  name: string,
): Promise<Response> {
  const role = await roleForRequest(c, id, name),
    auth = await getAuth(c);
  const host = c.env.DB_ENDPOINT_HOST;
  // An installation value must be a hostname, never authority syntax or a URL.
  if (
    !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host) ||
    host.includes("..")
  )
    throw new ApiError("internal", "Database endpoint is not configured");
  const includesPassword = auth.scope === "integrator";
  const password = includesPassword
    ? await keyring(c.env.CREDENTIAL_KEYS).decrypt(id, name, {
        ciphertext: role.password_ciphertext,
        iv: role.password_iv,
        kid: role.password_kid,
      })
    : null;
  const uri = `postgres://${encodeURIComponent(name)}${password === null ? "" : `:${encodeURIComponent(password)}`}@${host}/${id}`;
  return c.json(
    ConnectionUri.parse({
      database_id: id,
      role: name,
      host,
      database: id,
      uri,
      includes_password: includesPassword,
    }),
  );
}
