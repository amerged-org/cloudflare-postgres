// SPDX-License-Identifier: Apache-2.0
import {
  ADMIN_KEY_DEFAULT_LIFETIME_DAYS,
  ADMIN_KEY_MAX_LIFETIME_DAYS,
  hashApiKey,
  isAdminScope,
  newApiKey,
  newApiKeyId,
  timingSafeEqual,
  type ApiKeyCreate,
} from "@pgcf/contracts";
import { ApiError } from "../api-error.ts";
import type { ApiContext } from "../env.ts";
import { bearer, requireAdminRead, requireScope } from "../middleware/auth.ts";
import {
  refuseCredentialReplay,
  withIdempotency,
} from "../middleware/idempotency.ts";
import { page } from "./pagination.ts";
import { keyRow, type Row } from "./rows.ts";

const DAY_MS = 86_400_000;

/**
 * When the new key stops working. A time asked for must lie ahead, and an administrator key's no
 * further than a year: otherwise the default would mean nothing. Without one, an administrator key
 * made by an administrator expires after 90 days, an integrator key never. The first key, made with
 * the bootstrap token, has no earlier key to make its successor, so it never expires unless it asks.
 */
function keyExpiry(
  body: ApiKeyCreate,
  now: Date,
  bootstrap: boolean,
): string | null {
  const admin = isAdminScope(body.scope);
  if (body.expires_at === undefined)
    return admin && !bootstrap
      ? new Date(
          now.getTime() + ADMIN_KEY_DEFAULT_LIFETIME_DAYS * DAY_MS,
        ).toISOString()
      : null;
  const at = Date.parse(body.expires_at);
  if (at <= now.getTime())
    throw new ApiError("invalid_request", "expires_at must be in the future");
  if (admin && at > now.getTime() + ADMIN_KEY_MAX_LIFETIME_DAYS * DAY_MS)
    throw new ApiError(
      "invalid_request",
      `expires_at of an administrator key is at most ${ADMIN_KEY_MAX_LIFETIME_DAYS} days ahead`,
    );
  return body.expires_at;
}

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
    const created = new Date();
    const now = created.toISOString();
    const expires_at = keyExpiry(body, created, true);
    const result = await c.env.DB.prepare(
      `INSERT INTO api_keys
      (id, lookup_id, key_hash, scope, project_id, name, created_at, expires_at)
      SELECT ?, ?, ?, 'admin', NULL, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM api_keys WHERE scope = 'admin')`,
    )
      .bind(
        id,
        generated.lookupId,
        await hashApiKey(c.env.API_KEY_PEPPER, generated.key),
        body.name,
        now,
        expires_at,
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
          expires_at,
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
      const created = new Date();
      const now = created.toISOString();
      const expires_at = keyExpiry(body, created, false);
      const result = await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO api_keys (id, lookup_id, key_hash, scope, project_id, name, created_at, expires_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ? IS NULL OR EXISTS (SELECT 1 FROM projects WHERE id = ? AND deleted_at IS NULL)`,
        ).bind(
          id,
          generated.lookupId,
          await hashApiKey(c.env.API_KEY_PEPPER, generated.key),
          body.scope,
          body.project_id ?? null,
          body.name,
          now,
          expires_at,
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
      return c.json(
        {
          api_key: {
            id,
            scope: body.scope,
            project_id: body.project_id ?? null,
            name: body.name,
            lookup_id: generated.lookupId,
            created_at: now,
            expires_at,
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
  await requireAdminRead(c);
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
