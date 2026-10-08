// SPDX-License-Identifier: Apache-2.0
import {
  bytesToHex,
  DatabaseResourceProfile,
  ResourceProfileRevision,
  type ResourceProfileUpdate,
  type ResourceProfileAssignment,
  ResourceProfileRollout,
  type ResourceProfileRolloutUpdate,
} from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { Env, ApiContext } from "../env.ts";
import { getAuth, requireScope } from "../middleware/auth.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import { databaseForRequest, type DatabaseRow } from "./rows.ts";
import { databaseCpuChargeSql } from "./startup-admission.ts";
import { resizeDatabase, scheduleDatabaseResize } from "./databases.ts";

interface ProfileRow {
  profile_id: string;
  revision: number;
  size_class_id: string;
  resources_json: string;
  sha256: string;
  created_at: string;
}
async function revision(db: D1Database, id: string, number?: number) {
  const row = await db
    .prepare(
      `SELECT r.* FROM resource_profile_revisions r JOIN resource_profiles p ON p.id=r.profile_id
     WHERE r.profile_id=? AND r.revision=${number === undefined ? "p.revision" : "?"}`,
    )
    .bind(id, ...(number === undefined ? [] : [number]))
    .first<ProfileRow>();
  if (!row)
    throw new ApiError("not_found", "Resource profile revision not found");
  return ResourceProfileRevision.parse({
    profile_id: row.profile_id,
    revision: row.revision,
    size_class_id: row.size_class_id,
    resources: JSON.parse(row.resources_json),
    sha256: row.sha256,
    created_at: row.created_at,
  });
}
export async function getResourceProfile(
  c: ApiContext,
  id: string,
  number?: number,
) {
  await getAuth(c);
  return c.json(await revision(c.env.DB, id, number));
}
export async function updateResourceProfile(
  c: ApiContext,
  id: string,
  body: ResourceProfileUpdate,
) {
  await requireScope(c, "admin");
  return withIdempotency(c, {
    replay: () => getResourceProfile(c, id, body.expected_revision + 1),
    execute: async (lease) => {
      const now = new Date().toISOString(),
        next = body.expected_revision + 1;
      const resources = JSON.stringify(body.resources);
      const sha256 = bytesToHex(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(`${id}\n${next}\n${resources}`),
          ),
        ),
      );
      const size = `rp-${sha256.slice(0, 28)}`,
        value = body.resources;
      const result = await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO resource_profiles(id,revision,created_at,updated_at)
          SELECT ?,0,?,? WHERE ?=0 ON CONFLICT(id) DO NOTHING`,
        ).bind(id, now, now, body.expected_revision),
        c.env.DB.prepare(
          `INSERT INTO size_classes(id,memory_mib,cpu_millicores,cpu_request_millicores,
          storage_gib,max_connections,sleep_after_seconds,archive_timeout_seconds,backup_retention_days,
          enabled,created_at,updated_at)
          SELECT ?,?,?,?,?,?,?,?,?,?,?,? FROM resource_profiles WHERE id=? AND revision=?`,
        ).bind(
          size,
          value.memory_mib,
          value.cpu_millicores,
          value.cpu_request_millicores ?? null,
          value.storage_gib,
          value.max_connections,
          value.sleep_after_seconds,
          value.archive_timeout_seconds,
          value.backup_retention_days,
          Number(value.enabled),
          now,
          now,
          id,
          body.expected_revision,
        ),
        c.env.DB.prepare(
          `INSERT INTO resource_profile_revisions
          (profile_id,revision,size_class_id,resources_json,sha256,created_at)
          SELECT ?,?,?,?,?,? WHERE changes()=1`,
        ).bind(id, next, size, resources, sha256, now),
        c.env.DB.prepare(
          `UPDATE resource_profiles SET revision=?,updated_at=? WHERE id=? AND revision=?
          AND EXISTS(SELECT 1 FROM resource_profile_revisions WHERE profile_id=? AND revision=? AND sha256=?)`,
        ).bind(next, now, id, body.expected_revision, id, next, sha256),
        lease.completeStatement(id, 200, { sql: "changes()=1", bindings: [] }),
      ]);
      if (result[3]!.meta.changes !== 1)
        throw new ApiError("conflict", "Resource profile revision changed");
      return getResourceProfile(c, id, next);
    },
  });
}
export async function getDatabaseResourceProfile(c: ApiContext, id: string) {
  const authorized = await databaseForRequest(c, id);
  const database = await c.env.DB.prepare(
    `SELECT d.*, r.profile_id,r.revision profile_revision,p.rollout_revision,
      (${databaseCpuChargeSql("d", "s")}=0) confirmed_cold
     FROM databases d JOIN size_classes s ON s.id=d.size_class_id
     LEFT JOIN resource_profile_revisions r ON r.size_class_id=d.size_class_id
     LEFT JOIN resource_profiles p ON p.id=r.profile_id
     WHERE d.id=? AND d.project_id=? AND d.deleted_at IS NULL`,
  )
    .bind(id, authorized.project_id)
    .first<
      DatabaseRow & {
        profile_id: string | null;
        profile_revision: number | null;
        rollout_revision: number | null;
        confirmed_cold: number;
      }
    >();
  if (!database) throw new ApiError("not_found", "Database not found");
  const assigned = database.profile_id !== null;
  const applied =
    database.observed_generation === database.generation &&
    database.observed_state === "ready" &&
    database.desired_state === "running";
  const target = database.rollout_revision || database.profile_revision;
  const selected = assigned && target === database.profile_revision;
  const deferred = database.confirmed_cold === 1;
  return c.json(
    DatabaseResourceProfile.parse({
      database_id: database.id,
      profile_id: database.profile_id,
      profile_revision: database.profile_revision,
      target_profile_revision: target,
      size_class_id: database.size_class_id,
      desired_generation: database.generation,
      observed_generation: database.observed_generation,
      observed_state: database.observed_state,
      applied: Boolean(assigned && selected && applied),
      application_state: !assigned
        ? "unassigned"
        : !selected
          ? "pending"
          : applied
            ? "applied"
            : deferred
              ? "deferred_until_wake"
              : "pending",
    }),
  );
}
export async function assignDatabaseResourceProfile(
  c: ApiContext,
  id: string,
  body: ResourceProfileAssignment,
) {
  await databaseForRequest(c, id, true);
  const selected = await revision(
    c.env.DB,
    body.profile_id,
    body.profile_revision,
  );
  return resizeDatabase(
    c,
    id,
    { size_class_id: selected.size_class_id },
    body.expected_generation,
  );
}

/** Rollout status is derived from assignments and actual current-generation observations. */
export async function getResourceProfileRollout(c: ApiContext, id: string) {
  await requireScope(c, "admin");
  const profile = await c.env.DB.prepare(
    "SELECT revision,rollout_revision FROM resource_profiles WHERE id=?",
  )
    .bind(id)
    .first<{ revision: number; rollout_revision: number }>();
  if (!profile) throw new ApiError("not_found", "Resource profile not found");
  const row = await c.env.DB.prepare(
    `SELECT count(*) assignments,
      COALESCE(SUM(CASE WHEN r.revision=p.rollout_revision AND d.observed_generation=d.generation AND d.observed_state='ready' THEN 1 ELSE 0 END),0) applied,
      COALESCE(SUM(CASE WHEN r.revision=p.rollout_revision AND d.observed_generation=d.generation AND ${databaseCpuChargeSql("d", "s")}=0 THEN 1 ELSE 0 END),0) deferred
     FROM databases d JOIN projects project ON project.id=d.project_id AND project.deleted_at IS NULL
     JOIN size_classes s ON s.id=d.size_class_id
     JOIN resource_profile_revisions r ON r.size_class_id=d.size_class_id JOIN resource_profiles p ON p.id=r.profile_id
     WHERE p.id=? AND d.deleted_at IS NULL AND d.desired_state<>'deleted'`,
  )
    .bind(id)
    .first<{ assignments: number; applied: number; deferred: number }>();
  if (!row) throw new Error("resource_profile_rollout_count_missing");
  return c.json(
    ResourceProfileRollout.parse({
      profile_id: id,
      profile_revision: profile.rollout_revision || null,
      latest_revision: profile.revision,
      ...row,
      pending: row.assignments - row.applied - row.deferred,
    }),
  );
}
export async function updateResourceProfileRollout(
  c: ApiContext,
  id: string,
  body: ResourceProfileRolloutUpdate,
) {
  await requireScope(c, "admin");
  await revision(c.env.DB, id, body.profile_revision);
  return withIdempotency(c, {
    replay: () => getResourceProfileRollout(c, id),
    execute: async (lease) => {
      const result = await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE resource_profiles SET rollout_revision=?,updated_at=? WHERE id=? AND rollout_revision=?
          AND EXISTS(SELECT 1 FROM resource_profile_revisions r JOIN size_classes s ON s.id=r.size_class_id
            WHERE r.profile_id=resource_profiles.id AND r.revision=? AND s.enabled=1)`,
        ).bind(
          body.profile_revision,
          new Date().toISOString(),
          id,
          body.expected_revision,
          body.profile_revision,
        ),
        lease.completeStatement(id, 200, { sql: "changes()=1", bindings: [] }),
      ]);
      if (result[0]!.meta.changes !== 1)
        throw new ApiError(
          "conflict",
          "Resource profile rollout changed or is unavailable",
        );
      return getResourceProfileRollout(c, id);
    },
  });
}
/** Bounded work in the existing cron; generations and operations coalesce concurrent executors. */
export async function runResourceProfileRollouts(
  env: Env,
  now = Date.now(),
): Promise<number> {
  const name = "resource_profiles";
  await env.DB.prepare(
    "INSERT INTO reconciliation_cursors(name,cursor) VALUES(?,NULL) ON CONFLICT(name) DO NOTHING",
  )
    .bind(name)
    .run();
  const cursor = await env.DB.prepare(
    "SELECT cursor FROM reconciliation_cursors WHERE name=?",
  )
    .bind(name)
    .first<{ cursor: string | null }>();
  if (!cursor) throw new Error("resource_profile_cursor_missing");
  const rows = await env.DB.prepare(
    `SELECT d.*, target.size_class_id target_size,p.id profile_id,p.rollout_revision selected_revision FROM databases d
     JOIN projects project ON project.id=d.project_id AND project.deleted_at IS NULL
     JOIN resource_profile_revisions current ON current.size_class_id=d.size_class_id
     JOIN resource_profiles p ON p.id=current.profile_id AND p.rollout_revision>0 AND p.rollout_revision<>current.revision
     JOIN resource_profile_revisions target ON target.profile_id=p.id AND target.revision=p.rollout_revision
     WHERE d.id>? AND d.deleted_at IS NULL AND d.desired_state<>'deleted' ORDER BY d.id LIMIT 9`,
  )
    .bind(cursor.cursor ?? "")
    .all<
      DatabaseRow & {
        target_size: string;
        profile_id: string;
        selected_revision: number;
      }
    >();
  let changed = 0;
  for (const row of rows.results.slice(0, 8)) {
    try {
      await scheduleDatabaseResize(
        env.DB,
        row,
        row.target_size,
        new Date(now).toISOString(),
        undefined,
        {
          sql: "EXISTS(SELECT 1 FROM resource_profiles WHERE id=? AND rollout_revision=?)",
          bindings: [row.profile_id, row.selected_revision],
        },
      );
      await env.REGION_LINK.get(
        env.REGION_LINK.idFromName(row.region_id),
      ).notify([row.id]);
      changed++;
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        !["conflict", "capacity_exhausted", "invalid_request"].includes(
          error.code,
        )
      )
        throw error;
      // Existing generation/observation/capacity state remains authoritative and queryable; retry on the next page.
    }
  }
  await env.DB.prepare(
    "UPDATE reconciliation_cursors SET cursor=? WHERE name=? AND cursor IS ?",
  )
    .bind(
      rows.results.length > 8 ? rows.results[7]!.id : null,
      name,
      cursor.cursor,
    )
    .run();
  return changed;
}
