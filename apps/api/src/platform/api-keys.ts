// SPDX-License-Identifier: Apache-2.0
import {
  hashApiKey,
  newApiKey,
  newApiKeyId,
  timingSafeEqual,
  type ApiKeyCreate,
} from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { bearer, requireScope } from "../middleware/auth.ts";
import {
  refuseCredentialReplay,
  withIdempotency,
} from "../middleware/idempotency.ts";
import { page } from "./pagination.ts";
import { keyRow, type Row } from "./rows.ts";

export async function createApiKey(
  c: ApiContext,
  body: ApiKeyCreate,
): Promise<Response> {
  const token = bearer(c);
  if (c.env.BOOTSTRAP_TOKEN && timingSafeEqual(token, c.env.BOOTSTRAP_TOKEN)) {
    if (body.scope !== "admin")
      throw new ApiError(
        "forbidden",
        "Bootstrap creates the first admin key only",
      );
    const id = newApiKeyId();
    const generated = newApiKey();
    const now = new Date().toISOString();
    const result = await c.env.DB.prepare(
      `INSERT INTO api_keys
      (id, lookup_id, key_hash, scope, project_id, name, created_at)
      SELECT ?, ?, ?, 'admin', NULL, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM api_keys WHERE scope = 'admin')`,
    )
      .bind(
        id,
        generated.lookupId,
        await hashApiKey(c.env.API_KEY_PEPPER, generated.key),
        body.name,
        now,
      )
      .run();
    if (result.meta.changes === 0)
      throw new ApiError("unauthorized", "Bootstrap has already completed");
    return c.json(
      {
        api_key: {
          id,
          scope: "admin",
          project_id: null,
          name: body.name,
          lookup_id: generated.lookupId,
          created_at: now,
          revoked_at: null,
        },
        key: generated.key,
      },
      201,
    );
  }
  await requireScope(c, "admin");
  return withIdempotency(c, {
    replay: async () => refuseCredentialReplay(),
    execute: async (lease) => {
      if (body.project_id) {
        const project = await c.env.DB.prepare(
          "SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL",
        )
          .bind(body.project_id)
          .first();
        if (!project) throw new ApiError("not_found", "Project not found");
      }
      const id = newApiKeyId();
      const generated = newApiKey();
      const now = new Date().toISOString();
      const result = await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO api_keys (id, lookup_id, key_hash, scope, project_id, name, created_at)
          SELECT ?, ?, ?, ?, ?, ?, ? WHERE ? IS NULL OR EXISTS (SELECT 1 FROM projects WHERE id = ? AND deleted_at IS NULL)`,
        ).bind(
          id,
          generated.lookupId,
          await hashApiKey(c.env.API_KEY_PEPPER, generated.key),
          body.scope,
          body.project_id ?? null,
          body.name,
          now,
          body.project_id ?? null,
          body.project_id ?? null,
        ),
        lease.completeStatement(id, 201, {
          sql: "EXISTS (SELECT 1 FROM api_keys WHERE id = ?)",
          bindings: [id],
        }),
      ]);
      if (result[0]!.meta.changes === 0)
        throw new ApiError("not_found", "Project not found");
      c.header("Location", `/v1/api-keys/${id}`);
      return c.json(
        {
          api_key: {
            id,
            scope: body.scope,
            project_id: body.project_id ?? null,
            name: body.name,
            lookup_id: generated.lookupId,
            created_at: now,
            revoked_at: null,
          },
          key: generated.key,
        },
        201,
      );
    },
  });
}

export async function listApiKeys(c: ApiContext): Promise<Response> {
  await requireScope(c, "admin");
  const pagination = page(c);
  const cursor = pagination.where();
  const rows = await c.env.DB.prepare(
    `SELECT * FROM api_keys WHERE ${cursor.sql} ORDER BY created_at DESC, id DESC LIMIT ?`,
  )
    .bind(...cursor.bindings, pagination.limit + 1)
    .all<Row>();
  return c.json(pagination.envelope(rows.results.map(keyRow)), 200);
}

export async function deleteApiKey(
  c: ApiContext,
  id: string,
): Promise<Response> {
  await requireScope(c, "admin");
  return withIdempotency(c, {
    replay: async () => c.body(null, 204),
    execute: async (lease) => {
      const row = await c.env.DB.prepare("SELECT id FROM api_keys WHERE id = ?")
        .bind(id)
        .first();
      if (!row) throw new ApiError("not_found", "API key not found");
      await c.env.DB.batch([
        c.env.DB.prepare(
          "UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?",
        ).bind(new Date().toISOString(), id),
        lease.completeStatement(id, 204),
      ]);
      return c.body(null, 204);
    },
  });
}
