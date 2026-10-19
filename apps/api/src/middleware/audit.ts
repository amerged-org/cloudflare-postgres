// SPDX-License-Identifier: Apache-2.0
import { AUDIT_RETENTION_DAYS, type AdminScope } from "@pgcf/contracts";
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { ApiError } from "../api-error.ts";
import { cronErrorCode } from "../domain/cron-health.ts";
import type { ApiContext, ApiEnv } from "../env.ts";

/** The methods that only read; every other request of an administrator key is audited. */
const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);
export const isRead = (c: ApiContext): boolean =>
  READ_METHODS.has(c.req.method);

/** Events from before this instant are past their retention: never listed, deleted by the next row written. */
export const auditCutoff = (now = Date.now()): string =>
  new Date(now - AUDIT_RETENTION_DAYS * 86_400_000).toISOString();

/** The route as the OpenAPI document spells it: `/v1/api-keys/{id}`, never the path that was asked for. */
const routeTemplate = (c: ApiContext): string =>
  routePath(c, -1).replace(/:([A-Za-z0-9_]+)/g, "{$1}");

function insert(
  c: ApiContext,
  id: string,
  key: { id: string; scope: AdminScope },
  status: number | null,
) {
  return c.env.DB.prepare(
    `INSERT INTO audit_events(id,key_id,scope,method,route,status,request_id,created_at)
     VALUES(?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id,
      key.id,
      key.scope,
      c.req.method,
      routeTemplate(c),
      status,
      c.get("requestId"),
      new Date().toISOString(),
    )
    .run();
}

/**
 * Deletes the events past their retention, after a row went in. The minute cron cannot take the
 * statement: `usage-cron.test.ts` and `admission-cron-bounds.test.ts` hold the whole cron to 850
 * statements and it is at 850 (as for the probe requests of SEC-09). The deletion is not part of
 * any guarantee, so a failure of it is logged and the request goes on.
 */
async function deletePastRetention(c: ApiContext): Promise<void> {
  try {
    await c.env.DB.prepare("DELETE FROM audit_events WHERE created_at < ?")
      .bind(auditCutoff())
      .run();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "audit_write_failed",
        phase: "retention",
        error_code: cronErrorCode(error),
      }),
    );
  }
}

/**
 * Records, before the handler runs, that an administrator key is about to make a request that is
 * not a read. The change cannot be undone once it has happened, so a row that cannot be written
 * refuses the request instead (it fails closed): nothing runs that the log does not know of. The
 * outcome is completed by `recordAuditOutcome` once the answer is known.
 */
export async function auditBeforeChange(
  c: ApiContext,
  key: { id: string; scope: AdminScope },
): Promise<void> {
  const id = crypto.randomUUID();
  try {
    await insert(c, id, key, null);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "audit_write_failed",
        phase: "before_change",
        error_code: cronErrorCode(error),
      }),
    );
    throw new ApiError(
      "internal",
      "The audit log could not be written, so the request was not run",
    );
  }
  c.set("auditEventId", id);
  await deletePastRetention(c);
}

/**
 * Records the refusal of a key that matches an administrator key's lookup identifier: its secret is
 * wrong, or it was revoked or has expired. The request is refused whatever the log says, so a
 * failed write is logged and changes nothing.
 */
export async function auditRefusedKey(
  c: ApiContext,
  key: { id: string; scope: AdminScope },
): Promise<void> {
  try {
    await insert(c, crypto.randomUUID(), key, 401);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "audit_write_failed",
        phase: "refused_key",
        error_code: cronErrorCode(error),
      }),
    );
    return;
  }
  // A stale key that is presented over and over adds rows while no change is made to delete any.
  await deletePastRetention(c);
}

/**
 * Completes the row `auditBeforeChange` wrote with the status of the answer. The change has
 * happened by now, so a status that cannot be written is logged and the answer stands: the row keeps
 * a null status, which says that the outcome is unknown, never that the request succeeded.
 */
export const recordAuditOutcome: MiddlewareHandler<ApiEnv> = async (
  c,
  next,
) => {
  await next();
  const id = c.get("auditEventId");
  if (id === undefined) return;
  try {
    await c.env.DB.prepare("UPDATE audit_events SET status=? WHERE id=?")
      .bind(c.res.status, id)
      .run();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "audit_write_failed",
        phase: "outcome",
        error_code: cronErrorCode(error),
      }),
    );
  }
};
