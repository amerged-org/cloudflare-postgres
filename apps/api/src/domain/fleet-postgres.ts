// SPDX-License-Identifier: Apache-2.0
import { DesiredPostgres } from "@pgcf/contracts";
import { FleetReleaseSpec } from "@pgcf/contracts/releases";
import { ApiError } from "../app.ts";
import type { Env } from "../env.ts";
import { scheduleDatabaseResize } from "./databases.ts";
import {
  assertFleetPatchAuthority,
  fleetPatchAuthoritySql,
  readFleetPatch,
} from "./fleet-patches.ts";
import { databaseCpuChargeSql } from "./startup-admission.ts";
import type { DatabaseRow } from "./rows.ts";

export interface FleetPostgresProgress {
  total: number;
  applied: number;
  pending: number;
  deferred_cold: number;
  queued_unassigned: number;
  queued_pending: number;
  errors: { database_id: string; code: string }[];
}

/** One bounded turn; replay keeps the persisted generation and existing resize operation. */
export async function reconcileFleetPostgresRelease(
  env: Env,
  regionId: string,
  releaseId: string,
  patchId: string,
): Promise<FleetPostgresProgress> {
  const patch = await readFleetPatch(env, patchId);
  await assertFleetPatchAuthority(env, patch);
  if (
    patch.region_id !== regionId ||
    patch.release_id !== releaseId ||
    patch.stage !== "postgres" ||
    !["pending", "dispatched"].includes(patch.state)
  )
    throw new ApiError("conflict", "PostgreSQL patch authority changed");
  const release = await env.DB.prepare(
    "SELECT spec_json FROM fleet_releases WHERE id=?",
  )
    .bind(releaseId)
    .first<{ spec_json: string }>();
  if (!release) throw new ApiError("not_found", "Fleet release not found");
  const spec = FleetReleaseSpec.parse(JSON.parse(release.spec_json));
  const component = spec.components.find((c) => c.name === "postgres");
  const pin = DesiredPostgres.safeParse({
    release_id: releaseId,
    image: component?.reference,
    version: component?.version,
    configuration_schema_revision: spec.configuration_schema_revision,
  });
  if (!pin.success || component?.kind !== "image")
    throw new ApiError(
      "invalid_request",
      "PostgreSQL patch requires an immutable PostgreSQL18 image and supported configuration schema",
    );
  const authority = {
    sql: `EXISTS(SELECT 1 FROM fleet_patch_operations p WHERE p.operation_id=? AND p.revision=?
      AND p.region_id=databases.region_id AND p.release_id=? AND p.stage='postgres' AND p.state IN('pending','dispatched')
      AND julianday(p.deadline_at)>julianday('now') AND ${fleetPatchAuthoritySql.replaceAll("fleet_patch_operations.", "p.")}
      AND (databases.node_id IS NULL OR databases.node_id=p.node_id))`,
    bindings: [patchId, patch.revision, releaseId],
  };
  const rows = await env.DB.prepare(
    `SELECT * FROM databases WHERE region_id=? AND deleted_at IS NULL AND desired_state IN('running','suspended')
    AND (node_id IS NULL OR node_id=?)
    AND (desired_postgres_release_id IS NOT ? OR desired_postgres_image IS NOT ? OR desired_postgres_version IS NOT ? OR desired_postgres_schema_revision IS NOT ?)
    ORDER BY id LIMIT 20`,
  )
    .bind(
      regionId,
      patch.node_id,
      releaseId,
      pin.data.image,
      pin.data.version,
      pin.data.configuration_schema_revision,
    )
    .all<DatabaseRow>();
  const errors: FleetPostgresProgress["errors"] = [];
  for (const row of rows.results) {
    if (
      row.pg_major !== 18 ||
      (row.desired_postgres_schema_revision ?? 1) !==
        pin.data.configuration_schema_revision
    ) {
      errors.push({
        database_id: row.id,
        code: "unsupported_postgres_upgrade",
      });
      continue;
    }
    try {
      if (row.node_id === null) {
        const result = await env.DB.prepare(
          `UPDATE databases SET desired_postgres_release_id=?,desired_postgres_image=?,desired_postgres_version=?,desired_postgres_schema_revision=?,generation=generation+1,updated_at=?
          WHERE id=? AND project_id=? AND region_id=? AND node_id IS NULL AND generation=? AND updated_at=?
            AND desired_state='running' AND observed_state='pending' AND observed_generation=0 AND deleted_at IS NULL
            AND EXISTS(SELECT 1 FROM operations o WHERE o.database_id=databases.id AND o.project_id=databases.project_id AND o.generation<=databases.generation AND o.kind IN('database.create','database.restore') AND o.status='pending')
            AND EXISTS(SELECT 1 FROM projects WHERE id=databases.project_id AND deleted_at IS NULL) AND (${authority.sql})`,
        )
          .bind(
            releaseId,
            pin.data.image,
            pin.data.version,
            pin.data.configuration_schema_revision,
            new Date().toISOString(),
            row.id,
            row.project_id,
            regionId,
            row.generation,
            row.updated_at,
            ...authority.bindings,
          )
          .run();
        if (result.meta.changes !== 1)
          throw new ApiError(
            "conflict",
            "Queued database changed; retry the patch turn",
          );
        continue;
      }
      await scheduleDatabaseResize(
        env.DB,
        row,
        row.size_class_id,
        new Date().toISOString(),
        undefined,
        authority,
        pin.data,
      );
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      errors.push({ database_id: row.id, code: error.code });
    }
  }
  await assertFleetPatchAuthority(env, patch);
  const counts = await env.DB.prepare(
    `SELECT count(*) total,
    COALESCE(sum(CASE WHEN d.desired_postgres_release_id=? AND d.desired_postgres_image=?
      AND d.observed_generation=d.generation AND d.desired_state='running' AND d.observed_state='ready'
      AND d.observed_postgres_image=d.desired_postgres_image AND substr(d.observed_postgres_image_id,-71)=? THEN 1 ELSE 0 END),0) applied,
    COALESCE(sum(CASE WHEN d.desired_postgres_release_id=? AND d.desired_postgres_image=? AND ${databaseCpuChargeSql("d", "s")}=0 THEN 1 ELSE 0 END),0) deferred_cold
    FROM databases d JOIN size_classes s ON s.id=d.size_class_id WHERE d.region_id=? AND d.node_id=? AND d.deleted_at IS NULL AND d.desired_state IN('running','suspended')`,
  )
    .bind(
      releaseId,
      pin.data.image,
      pin.data.image.slice(-71),
      releaseId,
      pin.data.image,
      regionId,
      patch.node_id,
    )
    .first<{ total: number; applied: number; deferred_cold: number }>();
  if (!counts) throw new Error("PostgreSQL patch progress unavailable");
  const queued = await env.DB.prepare(
    `SELECT count(*) n,COALESCE(sum(CASE WHEN desired_postgres_release_id IS NOT ? OR desired_postgres_image IS NOT ? OR desired_postgres_version IS NOT ? OR desired_postgres_schema_revision IS NOT ? THEN 1 ELSE 0 END),0) pending FROM databases WHERE region_id=? AND node_id IS NULL AND deleted_at IS NULL AND desired_state='running'`,
  )
    .bind(
      releaseId,
      pin.data.image,
      pin.data.version,
      pin.data.configuration_schema_revision,
      regionId,
    )
    .first<{ n: number; pending: number }>();
  return {
    ...counts,
    pending:
      counts.total -
      counts.applied -
      counts.deferred_cold +
      (queued?.pending ?? 0),
    errors,
    queued_unassigned: queued?.n ?? 0,
    queued_pending: queued?.pending ?? 0,
  };
}
