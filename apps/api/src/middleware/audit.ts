// SPDX-License-Identifier: Apache-2.0
import { AUDIT_RETENTION_DAYS, type AdminScope } from "@pgcf/contracts";
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { ApiError } from "../api-error.ts";
import { cronErrorCode, cronErrorMessage } from "../domain/cron-health.ts";
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
     VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
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
 * How often the row that precedes a change is written before the request is refused, and the
 * pauses between the attempts. D1 loses a request now and then ("Network connection lost" after
 * about 12 s, 2026-10-23 16:03:35, which refused a create that nothing else was wrong with). The
 * row has its identifier before the first attempt and the insert ignores a row of that identifier,
 * so an attempt whose answer was lost after D1 committed it is repeated without a second row.
 */
export const AUDIT_WRITE_ATTEMPTS = 3;
const AUDIT_RETRY_PAUSES_MS = [100, 300];

/** Writes an audit prerequisite. The caller keeps the row ID stable across retries. */
export async function writeRequiredAuditRow(
  write: () => Promise<unknown>,
  phase: "before_change" | "credential_disclosure",
  errorMessage: string,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await write();
      return;
    } catch (error) {
      const failure = {
        phase,
        ...(phase === "before_change"
          ? {
              error_code: cronErrorCode(error),
              message: cronErrorMessage(error),
            }
          : { error_code: "d1_error" }),
      };
      if (attempt < AUDIT_WRITE_ATTEMPTS) {
        console.error(
          JSON.stringify({ event: "audit_write_retried", attempt, ...failure }),
        );
        await new Promise((resolve) =>
          setTimeout(resolve, AUDIT_RETRY_PAUSES_MS[attempt - 1]),
        );
        continue;
      }
      console.error(
        JSON.stringify({
          event: "audit_write_failed",
          ...failure,
          attempts: attempt,
        }),
      );
      throw new ApiError("internal", errorMessage);
    }
  }
}

/**
 * Records an administrator change before the handler runs. The request can proceed once its
 * audit row is durable. `recordAuditOutcome` fills in the status after the handler finishes.
 */
export async function auditBeforeChange(
  c: ApiContext,
  key: { id: string; scope: AdminScope },
): Promise<void> {
  const id = crypto.randomUUID();
  await writeRequiredAuditRow(
    () => insert(c, id, key, null),
    "before_change",
    "The audit log could not be written, so the request was not run",
  );
  c.set("auditEventId", id);
  await deletePastRetention(c);
}

/**
 * Records the refusal of an administrator key that was presented with its real secret and was
 * revoked or has expired. The caller never gets here for a wrong secret, which anyone can send
 * with a lookup identifier. The request is refused whatever the log says, so a failed write is
 * logged and changes nothing.
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
