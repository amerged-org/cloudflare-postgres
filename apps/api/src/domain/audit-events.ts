// SPDX-License-Identifier: Apache-2.0
import { AuditEvent } from "@pgcf/contracts";
import type { ApiContext } from "../env.ts";
import { auditCutoff } from "../middleware/audit.ts";
import { requireAdminRead } from "../middleware/auth.ts";
import { page } from "../platform/pagination.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `GET /v1/audit-events`: the requests of administrator keys, newest first. An event older than the
 * retention is not listed even while its row is still there, so the 90 days hold whenever the next
 * deletion comes.
 */
export async function listAuditEvents(c: ApiContext): Promise<Response> {
  await requireAdminRead(c);
  const pagination = page(c, c.req.query(), (id) => UUID.test(id));
  const cursor = pagination.where();
  const rows = await c.env.DB.prepare(
    `SELECT id,key_id,scope,method,route,status,request_id,created_at FROM audit_events
     WHERE created_at >= ? AND ${cursor.sql} ORDER BY created_at DESC, id DESC LIMIT ?`,
  )
    .bind(auditCutoff(), ...cursor.bindings, pagination.limit + 1)
    .all();
  return c.json(
    pagination.envelope(rows.results.map((row) => AuditEvent.parse(row))),
    200,
  );
}
