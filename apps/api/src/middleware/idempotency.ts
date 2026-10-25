// SPDX-License-Identifier: Apache-2.0
import {
  bytesToHex,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_PATTERN,
} from "@pgcf/contracts";
import { routePath } from "hono/route";
import { ApiError } from "../api-error.ts";
import type { ApiContext } from "../env.ts";
import { requiredIdempotentPublicRoutes } from "../openapi-public-errors.ts";
import { getAuth } from "./auth.ts";

interface IdempotencyRow {
  request_hash: string;
  state: "in_progress" | "completed";
  resource_id: string | null;
  response_status: number | null;
}
export interface IdempotencyLease {
  readonly guard: { sql: string; bindings: (string | number | null)[] };
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

/** The route as the OpenAPI registries spell it: the method and the path with `{name}` parameters. */
function routeKey(c: ApiContext): string {
  return `${c.req.method} ${routePath(c, -1).replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`;
}

/**
 * A mutation whose route is in `requiredIdempotentPublicRoutes` refuses a request without a key
 * before any durable work; the same registry documents the header as required.
 */
export async function withIdempotency(
  c: ApiContext,
  handlers: IdempotencyHandlers,
): Promise<Response> {
  const execute = async (lease: IdempotencyLease) => {
    const id = c.req.param("id");
    if (
      id &&
      c.req.path.startsWith("/v1/databases/") &&
      (await c.env.DB.prepare(
        "SELECT 1 FROM database_replacements WHERE database_id=? AND phase IN('proving','restoring','rolling_back')",
      )
        .bind(id)
        .first())
    )
      throw new ApiError(
        "conflict",
        "An in-place restore holds this database",
        { reason: "mutation_in_progress" },
      );
    return handlers.execute(lease);
  };
  const auth = await getAuth(c);
  const key = c.req.header(IDEMPOTENCY_KEY_HEADER);
  if (key === undefined) {
    if (requiredIdempotentPublicRoutes.has(routeKey(c)))
      throw new ApiError("invalid_request", "Idempotency-Key is required");
    return execute({
      guard: { sql: "1=1", bindings: [] },
      completeStatement: () => c.env.DB.prepare("SELECT 1"),
    });
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(key))
    throw new ApiError("invalid_request", "Invalid Idempotency-Key");
  const hash = await requestHash(c);
  // An unfinished row holds this attempt's owner; completion replaces it with the resource ID.
  const owner = `lease_${crypto.randomUUID()}`;
  const inserted = await c.env.DB.prepare(
    `
    INSERT INTO idempotency_keys (api_key_id, key, request_hash, state, resource_id, created_at)
    VALUES (?, ?, ?, 'in_progress', ?, ?) ON CONFLICT(api_key_id, key) DO NOTHING
  `,
  )
    .bind(auth.id, key, hash, owner, new Date().toISOString())
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
    guard: {
      sql: "EXISTS(SELECT 1 FROM idempotency_keys lease WHERE lease.api_key_id=? AND lease.key=? AND lease.request_hash=? AND lease.state='in_progress' AND lease.resource_id=?)",
      bindings: [auth.id, key, hash, owner],
    },
    completeStatement(resourceId, status, guard) {
      return c.env.DB.prepare(
        `
        UPDATE idempotency_keys SET state = 'completed', resource_id = ?, response_status = ?
        WHERE api_key_id = ? AND key = ? AND request_hash = ? AND state = 'in_progress' AND resource_id = ?
        ${guard ? `AND (${guard.sql})` : ""}
      `,
      ).bind(
        resourceId,
        status,
        auth.id,
        key,
        hash,
        owner,
        ...(guard?.bindings ?? []),
      );
    },
  };
  try {
    const response = await execute(lease);
    const result = await read();
    if (result?.state !== "completed")
      throw new Error("Mutation did not complete its idempotency reservation");
    return response;
  } catch (error) {
    // Completed mutations remain reserved even if producing the response fails.
    await c.env.DB.prepare(
      `DELETE FROM idempotency_keys
      WHERE api_key_id = ? AND key = ? AND request_hash = ? AND state = 'in_progress' AND resource_id = ?`,
    )
      .bind(auth.id, key, hash, owner)
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
