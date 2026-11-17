// SPDX-License-Identifier: Apache-2.0
import {
  CredentialDisclosure,
  CredentialDisclosureListQuery,
} from "@pgcf/contracts";
import type { ApiContext } from "../env.ts";
import { auditCutoff, writeRequiredAuditRow } from "../middleware/audit.ts";
import { requireAdminRead } from "../middleware/auth.ts";
import { page } from "../platform/pagination.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function recordCredentialDisclosure(
  c: ApiContext,
  disclosure: Omit<CredentialDisclosure, "id" | "created_at">,
): Promise<void> {
  // A lost D1 response must not add a duplicate. A new request always gets its own ID.
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await writeRequiredAuditRow(
    () =>
      c.env.DB.prepare(
        `INSERT INTO credential_disclosures
           (id,key_id,project_id,database_id,role,role_created_at,password_revision,created_at)
         VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
      )
        .bind(
          id,
          disclosure.key_id,
          disclosure.project_id,
          disclosure.database_id,
          disclosure.role,
          disclosure.role_created_at,
          disclosure.password_revision,
          createdAt,
        )
        .run(),
    "credential_disclosure",
    "The credential disclosure could not be recorded",
  );
  try {
    await c.env.DB.prepare(
      "DELETE FROM credential_disclosures WHERE created_at < ?",
    )
      .bind(auditCutoff())
      .run();
  } catch {
    console.error(
      JSON.stringify({
        event: "audit_write_failed",
        phase: "credential_disclosure_retention",
        error_code: "d1_error",
      }),
    );
  }
}

export async function listCredentialDisclosures(
  c: ApiContext,
): Promise<Response> {
  await requireAdminRead(c);
  const { key_id: keyId, ...list } = CredentialDisclosureListQuery.parse(
    c.req.query(),
  );
  const pagination = page(c, list, (id) => UUID.test(id));
  const cursor = pagination.where();
  const rows = await c.env.DB.prepare(
    `SELECT id,key_id,project_id,database_id,role,role_created_at,password_revision,created_at
       FROM credential_disclosures
      WHERE created_at >= ? ${keyId === undefined ? "" : "AND key_id=?"}
        AND ${cursor.sql}
      ORDER BY created_at DESC,id DESC LIMIT ?`,
  )
    .bind(
      auditCutoff(),
      ...(keyId === undefined ? [] : [keyId]),
      ...cursor.bindings,
      pagination.limit + 1,
    )
    .all();
  return c.json(
    pagination.envelope(
      rows.results.map((row) => CredentialDisclosure.parse(row)),
    ),
  );
}
