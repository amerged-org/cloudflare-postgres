// SPDX-License-Identifier: Apache-2.0
import {
  ConnectionUri,
  newRolePassword,
  type RoleCreate,
} from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import { keyring } from "../crypto/keyring.ts";
import type { ApiContext } from "../env.ts";
import { getAuth } from "../middleware/auth.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import { hint } from "./databases.ts";
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
export async function listRoles(c: ApiContext, id: string): Promise<Response> {
  await databaseForRequest(c, id);
  const result = await c.env.DB.prepare(
    "SELECT * FROM roles WHERE database_id=? AND deleted_at IS NULL ORDER BY name",
  )
    .bind(id)
    .all<RoleRow>();
  return c.json({ data: result.results.map(roleView), next_cursor: null });
}
export async function createRole(
  c: ApiContext,
  id: string,
  body: RoleCreate,
): Promise<Response> {
  const db = await databaseForRequest(c, id);
  return withIdempotency(c, {
    replay: async (name) =>
      c.json(roleView(await roleForRequest(c, id, name)), 201),
    execute: async (lease) => {
      const now = new Date().toISOString(),
        generation = db.generation + 1;
      const password = await keyring(c.env.CREDENTIAL_KEYS).encrypt(
        id,
        body.name,
        newRolePassword(),
      );
      let result: D1Result[];
      try {
        result = await c.env.DB.batch([
          c.env.DB.prepare(
            `INSERT INTO roles (database_id,name,owner,password_ciphertext,password_iv,password_kid,password_revision,created_at,updated_at)
          SELECT id,?,0,?,?,?,1,?,? FROM databases WHERE id=? AND project_id=? AND generation=? AND deleted_at IS NULL
          AND EXISTS(SELECT 1 FROM projects WHERE id=databases.project_id AND deleted_at IS NULL)
          AND (SELECT COUNT(*) FROM roles WHERE database_id=databases.id AND deleted_at IS NULL)<100`,
          ).bind(
            body.name,
            password.ciphertext,
            password.iv,
            password.kid,
            now,
            now,
            id,
            db.project_id,
            db.generation,
          ),
          c.env.DB.prepare(
            "UPDATE databases SET generation=generation+1,updated_at=? WHERE changes()=1 AND id=? AND project_id=? AND generation=? AND deleted_at IS NULL",
          ).bind(now, id, db.project_id, db.generation),
          lease.completeStatement(body.name, 201, {
            sql: "EXISTS(SELECT 1 FROM databases d JOIN roles r ON r.database_id=d.id WHERE d.id=? AND d.project_id=? AND d.generation=? AND r.name=? AND r.password_revision=1)",
            bindings: [id, db.project_id, generation, body.name],
          }),
        ]);
      } catch (error) {
        if (isConstraintError(error))
          throw new ApiError("conflict", "Role already exists");
        throw error;
      }
      if (result[0]!.meta.changes !== 1 || result[1]!.meta.changes !== 1)
        throw new ApiError(
          "conflict",
          "Database changed or role limit reached",
        );
      hint(c, db.region_id, [id]);
      return c.json(roleView(await roleForRequest(c, id, body.name)), 201);
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
    replay: async (role) => c.json(roleView(await roleForRequest(c, id, role))),
    execute: async (lease) => {
      const now = new Date().toISOString(),
        password = await keyring(c.env.CREDENTIAL_KEYS).encrypt(
          id,
          name,
          newRolePassword(),
        );
      const result = await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE roles SET password_ciphertext=?,password_iv=?,password_kid=?,password_revision=password_revision+1,updated_at=?
        WHERE database_id=? AND name=? AND password_revision=? AND deleted_at IS NULL
        AND EXISTS(SELECT 1 FROM databases d JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL WHERE d.id=roles.database_id AND d.project_id=? AND d.generation=? AND d.deleted_at IS NULL)`,
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
        ),
        c.env.DB.prepare(
          "UPDATE databases SET generation=generation+1,updated_at=? WHERE changes()=1 AND id=? AND project_id=? AND generation=? AND deleted_at IS NULL",
        ).bind(now, id, db.project_id, db.generation),
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
      if (result[0]!.meta.changes !== 1 || result[1]!.meta.changes !== 1)
        throw new ApiError(
          "conflict",
          "Database or role changed; retry the request",
        );
      hint(c, db.region_id, [id]);
      return c.json(roleView(await roleForRequest(c, id, name)));
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
