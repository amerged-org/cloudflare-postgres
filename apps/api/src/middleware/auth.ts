// SPDX-License-Identifier: Apache-2.0
import {
  hashApiKey,
  parseApiKey,
  timingSafeEqual,
  type ApiKeyScope,
} from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { ApiContext, AuthPrincipal } from "../env.ts";

interface AuthRow extends AuthPrincipal {
  key_hash: string;
  revoked_at: string | null;
  project_deleted_at: string | null;
}

export function bearer(c: ApiContext): string {
  const authorization = c.req.header("Authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/);
  if (!match)
    throw new ApiError("unauthorized", "A valid bearer key is required");
  return match[1]!;
}

export async function getAuth(c: ApiContext): Promise<AuthPrincipal> {
  const cached = c.get("auth");
  if (cached) return cached;
  const key = bearer(c);
  const parsed = parseApiKey(key);
  if (!parsed) throw new ApiError("unauthorized", "Invalid API key");
  const row = await c.env.DB.prepare(
    `
    SELECT k.id, k.scope, k.project_id, k.key_hash, k.revoked_at,
           p.deleted_at AS project_deleted_at
    FROM api_keys k LEFT JOIN projects p ON p.id = k.project_id
    WHERE k.lookup_id = ?
  `,
  )
    .bind(parsed.lookupId)
    .first<AuthRow>();
  const expected = await hashApiKey(c.env.API_KEY_PEPPER, key);
  // Compare even unknown keys, so missing lookup IDs do not skip verification.
  const matches = timingSafeEqual(row?.key_hash ?? "0".repeat(64), expected);
  if (!row || !matches || row.revoked_at || row.project_deleted_at)
    throw new ApiError("unauthorized", "Invalid API key");
  const principal: AuthPrincipal = {
    id: row.id,
    scope: row.scope,
    project_id: row.project_id,
  };
  c.set("auth", principal);
  await c.env.DB.prepare(
    "UPDATE api_keys SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL",
  )
    .bind(new Date().toISOString(), row.id)
    .run();
  return principal;
}

export async function requireScope(
  c: ApiContext,
  scope: ApiKeyScope,
): Promise<AuthPrincipal> {
  const auth = await getAuth(c);
  if (auth.scope !== scope)
    throw new ApiError(
      "forbidden",
      "API key scope does not allow this operation",
    );
  return auth;
}

export async function assertProjectAccess(
  c: ApiContext,
  projectId: string,
): Promise<AuthPrincipal> {
  const auth = await getAuth(c);
  if (auth.scope === "integrator" && auth.project_id !== projectId)
    throw new ApiError("not_found", "Project not found");
  return auth;
}
