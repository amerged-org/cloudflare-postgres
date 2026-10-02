// SPDX-License-Identifier: Apache-2.0
import { newProjectId, type ProjectCreate } from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { ApiContext } from "../env.ts";
import {
  assertProjectAccess,
  getAuth,
  requireScope,
} from "../middleware/auth.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import { page } from "./pagination.ts";
import { projectRow, type Row } from "./rows.ts";

export async function createProject(
  c: ApiContext,
  body: ProjectCreate,
): Promise<Response> {
  await requireScope(c, "admin");
  return withIdempotency(c, {
    replay: async (id) => {
      const row = await c.env.DB.prepare("SELECT * FROM projects WHERE id = ?")
        .bind(id)
        .first<Row>();
      if (!row) throw new ApiError("not_found", "Project not found");
      c.header("Location", `/v1/projects/${id}`);
      return c.json(projectRow(row), 201);
    },
    execute: async (lease) => {
      const id = newProjectId();
      const now = new Date().toISOString();
      try {
        await c.env.DB.batch([
          c.env.DB.prepare(
            "INSERT INTO projects (id, name, external_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          ).bind(id, body.name, body.external_id ?? null, now, now),
          lease.completeStatement(id, 201),
        ]);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes(
            "UNIQUE constraint failed: projects.external_id",
          )
        )
          throw new ApiError(
            "conflict",
            "A project with this external ID already exists",
          );
        throw error;
      }
      c.header("Location", `/v1/projects/${id}`);
      return c.json(
        {
          id,
          name: body.name,
          external_id: body.external_id ?? null,
          created_at: now,
          updated_at: now,
        },
        201,
      );
    },
  });
}

export async function listProjects(c: ApiContext): Promise<Response> {
  const auth = await getAuth(c);
  const pagination = page(c);
  const cursor = pagination.where();
  const scope = auth.scope === "integrator" ? "AND id = ?" : "";
  const result = await c.env.DB.prepare(
    `SELECT * FROM projects WHERE deleted_at IS NULL AND ${cursor.sql} ${scope} ORDER BY created_at DESC, id DESC LIMIT ?`,
  )
    .bind(
      ...cursor.bindings,
      ...(auth.scope === "integrator" ? [auth.project_id] : []),
      pagination.limit + 1,
    )
    .all<Row>();
  return c.json(pagination.envelope(result.results.map(projectRow)), 200);
}

export async function getProject(c: ApiContext, id: string): Promise<Response> {
  await assertProjectAccess(c, id);
  const row = await c.env.DB.prepare(
    "SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL",
  )
    .bind(id)
    .first<Row>();
  if (!row) throw new ApiError("not_found", "Project not found");
  return c.json(projectRow(row), 200);
}

export async function deleteProject(
  c: ApiContext,
  id: string,
): Promise<Response> {
  await assertProjectAccess(c, id);
  return withIdempotency(c, {
    replay: async () => c.body(null, 204),
    execute: async (lease) => {
      const row = await c.env.DB.prepare(
        "SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL",
      )
        .bind(id)
        .first();
      if (!row) throw new ApiError("not_found", "Project not found");
      const now = new Date().toISOString();
      const results = await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM databases WHERE project_id = projects.id AND observed_state <> 'deleted')`,
        ).bind(now, now, id),
        c.env.DB.prepare(
          `UPDATE api_keys SET revoked_at = ? WHERE project_id = ? AND revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND deleted_at = ?)`,
        ).bind(now, id, id, now),
        lease.completeStatement(id, 204, {
          sql: "EXISTS (SELECT 1 FROM projects WHERE id = ? AND deleted_at = ?)",
          bindings: [id, now],
        }),
      ]);
      if (results[0]!.meta.changes === 0)
        throw new ApiError(
          "conflict",
          "Project still has databases awaiting deletion",
        );
      return c.body(null, 204);
    },
  });
}
