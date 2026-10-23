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
import { ApiError } from "../api-error.ts";
import { keyring } from "../crypto/keyring.ts";
import type { ApiContext } from "../env.ts";
import { getAuth } from "../middleware/auth.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import { databaseOperationResponse, hint } from "./databases.ts";
import { syncDatabaseActor } from "./database-actor-sync.ts";
import { withAdmissionMutation } from "./admission-mutations.ts";
import {
  databaseForRequest,
  isConstraintError,
  roleView,
  type RoleRow,
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
export async function createRole(
  c: ApiContext,
  id: string,
  body: RoleCreate,
): Promise<Response> {
  const db = await databaseForRequest(c, id);
  return withIdempotency(c, {
    replay: async (name) => roleResponse(c, id, name, 201),
    execute: async (lease) => {
      const attributes = await roleAttributes(c, id, body);
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
          AND (SELECT COUNT(*) FROM roles WHERE database_id=databases.id)<${ROLE_LIMIT}
          AND ${MEMBER_TARGETS_SQL} AND ${guard.sql}`,
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
            { reason: removing ? "role_being_deleted" : "role_exists" },
          );
        }
        throw error;
      }
      if (result[0]!.meta.changes !== 1 || result[1]!.meta.changes !== 1) {
        // A full database (a role awaiting its removal counts) is not cured by repeating.
        const held = await c.env.DB.prepare(
          "SELECT COUNT(*) count FROM roles WHERE database_id=?",
        )
          .bind(id)
          .first<number>("count");
        if ((held ?? 0) >= ROLE_LIMIT)
          throw new ApiError(
            "conflict",
            `A database holds at most ${ROLE_LIMIT} roles`,
            { reason: "role_limit" },
          );
        throw new ApiError("conflict", "Database changed; retry the request", {
          reason: "generation_changed",
        });
      }
      hint(c, [id]);
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
  return withIdempotency(c, {
    replay: async (role) => roleResponse(c, id, role),
    execute: async (lease) => {
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
        AND EXISTS(SELECT 1 FROM databases d JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL WHERE d.id=roles.database_id AND d.project_id=? AND d.generation=? AND d.deleted_at IS NULL)
        AND ${guard.sql}`,
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
          { reason: "generation_changed" },
        );
      hint(c, [id]);
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
  if (name === OWNER_ROLE_NAME)
    throw new ApiError("invalid_request", "The owner role cannot be deleted");
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
            { reason: "role_has_members" },
          );
      }
      const operation = newOperationId(),
        now = new Date().toISOString(),
        issuer = (await getAuth(c)).id,
        generation = db.generation + 1;
      const result = await withAdmissionMutation(
        c.env,
        [id],
        async (mutation) => {
          const guard = mutation.guard(id);
          const scope = `EXISTS(SELECT 1 FROM databases d JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL WHERE d.id=roles.database_id AND d.project_id=? AND d.generation=? AND d.deleted_at IS NULL)`;
          return mutation.batch([
            c.env.DB.prepare(
              `UPDATE roles SET deleted_at=COALESCE(deleted_at,?),updated_at=?,deleted_by_key_id=?,delete_operation_id=?
            WHERE database_id=? AND name=? AND owner=0
            AND ${tombstone ? "deleted_at IS NOT NULL AND delete_operation_id IS ?" : "deleted_at IS NULL"}
            AND ${scope}
            AND NOT EXISTS(SELECT 1 FROM roles m, json_each(m.member_of_json) j WHERE m.database_id=roles.database_id AND m.deleted_at IS NULL AND m.name<>roles.name AND j.value=roles.name)
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
          { reason: "generation_changed" },
        );
      hint(c, [id]);
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
