// SPDX-License-Identifier: Apache-2.0
import {
  hashApiKey,
  isAdminScope,
  parseApiKey,
  timingSafeEqual,
  type ApiKeyScope,
} from "@pgcf/contracts";
import { ApiError } from "../api-error.ts";
import type { ApiContext, AuthPrincipal } from "../env.ts";
import { auditBeforeChange, auditRefusedKey, isRead } from "./audit.ts";

interface AuthRow extends AuthPrincipal {
  key_hash: string;
  revoked_at: string | null;
  expires_at: string | null;
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
    SELECT k.id, k.scope, k.project_id, k.key_hash, k.revoked_at, k.expires_at,
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
  const now = new Date().toISOString();
  if (
    !row ||
    !matches ||
    row.revoked_at ||
    (row.expires_at !== null && row.expires_at <= now) ||
    row.project_deleted_at
  ) {
    // Only an administrator key presented with its real secret is recorded: a revoked or expired
    // one. The lookup identifier is not secret (it is inside every key string and listed to every
    // admin_read holder), so a request that only knows it must not be able to write a row.
    if (row && matches && isAdminScope(row.scope))
      await auditRefusedKey(c, { id: row.id, scope: row.scope });
    throw new ApiError("unauthorized", "Invalid API key");
  }
  const principal: AuthPrincipal = {
    id: row.id,
    scope: row.scope,
    project_id: row.project_id,
  };
  // Before anything runs, and before a read-only key is refused the write: an administrator key's
  // changes are in the log first, and so is the attempt of a key that may not make them.
  if (isAdminScope(principal.scope) && !isRead(c))
    await auditBeforeChange(c, { id: principal.id, scope: principal.scope });
  if (principal.scope === "admin_read" && !isRead(c))
    throw new ApiError(
      "forbidden",
      "A read-only administrator key cannot change anything",
    );
  c.set("auth", principal);
  await c.env.DB.prepare(
    "UPDATE api_keys SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL",
  )
    .bind(now, row.id)
    .run();
  return principal;
}

/** Exactly this scope: `admin` is the one that changes things, so a read-only key never passes it. */
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

/** An administrator key of either scope: for the routes that only read what an administrator reads. */
export async function requireAdminRead(c: ApiContext): Promise<AuthPrincipal> {
  const auth = await getAuth(c);
  if (!isAdminScope(auth.scope))
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
