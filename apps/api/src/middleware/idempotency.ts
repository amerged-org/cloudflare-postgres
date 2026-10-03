// SPDX-License-Identifier: Apache-2.0
import {
  bytesToHex,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_PATTERN,
} from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { getAuth } from "./auth.ts";

interface IdempotencyRow {
  request_hash: string;
  state: "in_progress" | "completed";
  resource_id: string | null;
  response_status: number | null;
}
export interface IdempotencyLease {
  completeStatement(
    resourceId: string,
    status: number,
    guard?: { sql: string; bindings: (string | number | null)[] },
  ): D1PreparedStatement;
}
export interface IdempotencyHandlers {
  replay(resourceId: string, status: number): Promise<Response>;
  execute(lease: IdempotencyLease): Promise<Response>;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}
export async function requestHash(c: ApiContext): Promise<string> {
  const text = c.req.raw.body === null ? "" : await c.req.text();
  const body: unknown = text === "" ? null : JSON.parse(text);
  const bytes = new TextEncoder().encode(
    `${c.req.method}\n${new URL(c.req.url).pathname}\n${canonical(body)}`,
  );
  return bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  );
}

export async function withIdempotency(
  c: ApiContext,
  handlers: IdempotencyHandlers,
): Promise<Response> {
  const auth = await getAuth(c);
  const key = c.req.header(IDEMPOTENCY_KEY_HEADER);
  if (key === undefined)
    return handlers.execute({
      completeStatement: () => c.env.DB.prepare("SELECT 1"),
    });
  if (!IDEMPOTENCY_KEY_PATTERN.test(key))
    throw new ApiError("invalid_request", "Invalid Idempotency-Key");
  const hash = await requestHash(c);
  const inserted = await c.env.DB.prepare(
    `
    INSERT INTO idempotency_keys (api_key_id, key, request_hash, state, created_at)
    VALUES (?, ?, ?, 'in_progress', ?) ON CONFLICT(api_key_id, key) DO NOTHING
  `,
  )
    .bind(auth.id, key, hash, new Date().toISOString())
    .run();
  const read = () =>
    c.env.DB.prepare(
      `
    SELECT request_hash, state, resource_id, response_status FROM idempotency_keys
    WHERE api_key_id = ? AND key = ?
  `,
    )
      .bind(auth.id, key)
      .first<IdempotencyRow>();
  if (inserted.meta.changes === 0) {
    const previous = await read();
    if (!previous)
      throw new ApiError(
        "idempotency_in_progress",
        "Retry after the concurrent request completes",
      );
    if (previous.request_hash !== hash)
      throw new ApiError(
        "idempotency_conflict",
        "Idempotency-Key was used for a different request",
      );
    if (previous.state === "in_progress")
      throw new ApiError(
        "idempotency_in_progress",
        "Request is already in progress",
      );
    if (!previous.resource_id || previous.response_status === null)
      throw new Error("Invalid stored idempotency result");
    return handlers.replay(previous.resource_id, previous.response_status);
  }
  const lease: IdempotencyLease = {
    completeStatement(resourceId, status, guard) {
      return c.env.DB.prepare(
        `
        UPDATE idempotency_keys SET state = 'completed', resource_id = ?, response_status = ?
        WHERE api_key_id = ? AND key = ? AND request_hash = ? AND state = 'in_progress'
        ${guard ? `AND (${guard.sql})` : ""}
      `,
      ).bind(
        resourceId,
        status,
        auth.id,
        key,
        hash,
        ...(guard?.bindings ?? []),
      );
    },
  };
  try {
    const response = await handlers.execute(lease);
    const result = await read();
    if (result?.state !== "completed")
      throw new Error("Mutation did not complete its idempotency reservation");
    return response;
  } catch (error) {
    // Completed mutations remain reserved even if producing the response fails.
    await c.env.DB.prepare(
      `DELETE FROM idempotency_keys
      WHERE api_key_id = ? AND key = ? AND request_hash = ? AND state = 'in_progress'`,
    )
      .bind(auth.id, key, hash)
      .run();
    throw error;
  }
}

export function refuseCredentialReplay(): never {
  throw new ApiError(
    "idempotency_conflict",
    "Creation completed; one-time credentials cannot be replayed. Revoke and create new credentials if the original response was lost.",
  );
}
export async function purgeIdempotency(
  db: D1Database,
  now = Date.now(),
): Promise<number> {
  const result = await db
    .prepare("DELETE FROM idempotency_keys WHERE created_at < ?")
    .bind(new Date(now - 24 * 60 * 60 * 1000).toISOString())
    .run();
  return result.meta.changes;
}
