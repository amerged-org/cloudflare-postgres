// SPDX-License-Identifier: Apache-2.0
import { createRoute, type RouteConfig } from "@hono/zod-openapi";
import {
  AUDIT_RETENTION_DAYS,
  AuditEvent,
  ErrorBody,
  ListQuery,
  listEnvelope,
} from "@pgcf/contracts";
import type { ApiApp } from "../app.ts";
import { listAuditEvents } from "../domain/audit-events.ts";
import type { ApiContext } from "../env.ts";

const error = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorBody } },
});
function register(
  app: ApiApp,
  route: RouteConfig,
  handler: (c: ApiContext) => Promise<Response>,
): void {
  app.openapi(createRoute(route), handler);
}

export function registerAuditEvents(app: ApiApp): void {
  register(
    app,
    {
      method: "get",
      path: "/v1/audit-events",
      tags: ["API keys"],
      security: [{ bearerAuth: [] }],
      summary: "List the audit log of the administrator keys",
      description: [
        "Every request that an admin or admin_read key made with a method other than GET or HEAD, and every refusal (401) of an administrator key that was revoked or has expired and was presented with its real secret. Newest first, with the usual `limit` and `cursor`.",
        "A change is recorded before it runs, so a request whose row cannot be written is not run and answers 500. Its status is written when the answer is known; null means it could not be written (or the Worker stopped first) and the change may have happened. A key with a wrong secret, an unknown key, an integrator key and every successful read are not recorded: the identifier in a key string is not secret, so recording them would let anyone grow the log.",
        `Each event names the key, its scope, the method, the route template (/v1/api-keys/{id}, never the path asked for), the status and the X-Request-Id. No body, query, key material or address is kept. Events are kept ${AUDIT_RETENTION_DAYS} days: an older one is not listed, and the next change or refused administrator key deletes it. Administrator keys only (admin or admin_read); an integrator key is refused with 403.`,
      ].join("\n\n"),
      request: { query: ListQuery },
      responses: {
        200: {
          description: "Audit events, newest first",
          content: {
            "application/json": { schema: listEnvelope(AuditEvent) },
          },
        },
        400: error("Invalid list query"),
        401: error("Invalid credentials"),
        403: error("Administrator scope required"),
      },
    },
    listAuditEvents,
  );
}
