// SPDX-License-Identifier: Apache-2.0
import {
  bearer,
  error,
  sha256,
  uuid,
  type AccountingDb,
  type JsonObject,
} from "./accounting";
import { newPassword } from "./role-credentials";

export interface Actor {
  kind: "organization" | "region";
  id: string;
  ownerId: string;
  hash: string;
  scope: string;
}
export function integer(
  value: unknown,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}
export function rv(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}
export function uid(value: unknown): value is string {
  return typeof value === "string" && uuid.test(value);
}
export function lease(
  input: JsonObject,
): input is JsonObject & { leaseToken: string; leaseEpoch: number } {
  return (
    typeof input.leaseToken === "string" &&
    /^cplease_[A-Za-z0-9_-]{43}$/.test(input.leaseToken) &&
    integer(input.leaseEpoch)
  );
}
export function leaseToken(): string {
  return "cplease_" + newPassword();
}
export function actorPredicate(actor: Actor): string {
  return `EXISTS (SELECT 1 FROM ${actor.kind === "organization" ? "api_tokens" : "region_tokens"} t WHERE t.id = ? AND t.token_hash = ? AND t.${actor.kind === "organization" ? "organization_id" : "region_id"} = ? AND t.revoked_at IS NULL AND instr(' ' || t.scopes || ' ', ' ' || ? || ' ') > 0)`;
}
export function actorBindings(actor: Actor): string[] {
  return [actor.id, actor.hash, actor.ownerId, actor.scope];
}
export async function authorize(
  request: Request,
  db: AccountingDb,
  kind: Actor["kind"],
  ownerId: string,
  scope: string,
): Promise<Actor | Response> {
  const supplied = bearer(request);
  if (!supplied?.startsWith(kind === "organization" ? "cporg_" : "cprgn_"))
    return error(401, "unauthorized");
  const hash = await sha256(supplied);
  const row = await db
    .prepare(
      `SELECT id, ${kind === "organization" ? "organization_id" : "region_id"} AS owner_id, scopes FROM ${kind === "organization" ? "api_tokens" : "region_tokens"} WHERE token_hash = ? AND revoked_at IS NULL`,
    )
    .bind(hash)
    .first<{ id: string; owner_id: string; scopes: string }>();
  if (!row) return error(401, "unauthorized");
  if (row.owner_id !== ownerId) return error(404, "not_found");
  if (!row.scopes.split(" ").includes(scope)) return error(403, "forbidden");
  if (kind === "region") {
    const region = await db
      .prepare("SELECT status FROM regions WHERE id = ?")
      .bind(ownerId)
      .first<{ status: string }>();
    if (!region || region.status === "disabled")
      return error(409, "region_disabled");
  }
  return { kind, id: row.id, ownerId, hash, scope };
}
export function idempotencyKey(request: Request): string | null {
  const key = request.headers.get("idempotency-key");
  return key && /^[A-Za-z0-9._~-]{1,128}$/.test(key) ? key : null;
}
