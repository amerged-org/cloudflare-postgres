// SPDX-License-Identifier: Apache-2.0
import type { SizeClassUpsert } from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { getAuth, requireScope } from "../middleware/auth.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import { page } from "./pagination.ts";
import { sizeRow, type Row } from "./rows.ts";

export async function listSizeClasses(c: ApiContext): Promise<Response> {
  await getAuth(c);
  const pagination = page(c);
  const cursor = pagination.where();
  const rows = await c.env.DB.prepare(
    `SELECT * FROM size_classes WHERE ${cursor.sql} ORDER BY created_at DESC, id DESC LIMIT ?`,
  )
    .bind(...cursor.bindings, pagination.limit + 1)
    .all<Row>();
  return c.json(pagination.envelope(rows.results.map(sizeRow)), 200);
}
export async function upsertSizeClass(
  c: ApiContext,
  id: string,
  body: SizeClassUpsert,
): Promise<Response> {
  await requireScope(c, "admin");
  const read = async () => {
    const row = await c.env.DB.prepare(
      "SELECT * FROM size_classes WHERE id = ?",
    )
      .bind(id)
      .first<Row>();
    if (!row) throw new ApiError("not_found", "Size class not found");
    return c.json(sizeRow(row), 200);
  };
  return withIdempotency(c, {
    replay: read,
    execute: async (lease) => {
      const now = new Date().toISOString();
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO size_classes
          (id, memory_mib, cpu_millicores, storage_gib, max_connections, sleep_after_seconds,
           archive_timeout_seconds, backup_retention_days, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET memory_mib = excluded.memory_mib, cpu_millicores = excluded.cpu_millicores,
            storage_gib = excluded.storage_gib, max_connections = excluded.max_connections,
            sleep_after_seconds = excluded.sleep_after_seconds, archive_timeout_seconds = excluded.archive_timeout_seconds,
            backup_retention_days = excluded.backup_retention_days, enabled = excluded.enabled, updated_at = excluded.updated_at`,
        ).bind(
          id,
          body.memory_mib,
          body.cpu_millicores,
          body.storage_gib,
          body.max_connections,
          body.sleep_after_seconds,
          body.archive_timeout_seconds,
          body.backup_retention_days,
          body.enabled ? 1 : 0,
          now,
          now,
        ),
        lease.completeStatement(id, 200),
      ]);
      return read();
    },
  });
}
