// SPDX-License-Identifier: Apache-2.0
import {
  archiveDestinationPath,
  type DatabaseRestore,
  newDatabaseId,
  newOperationId,
} from "@pgcf/contracts";
import { ApiError } from "../api-error.ts";
import type { ApiContext } from "../env.ts";
import { getAuth } from "../middleware/auth.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import { keyring } from "../crypto/keyring.ts";
import { databaseInsertStatement, hint } from "./databases.ts";
import { choosePlacement, placementNodes } from "./placement.ts";
import {
  assertResourcesAllowed,
  effectiveResources,
  ownResources,
  regionBounds,
} from "./resources.ts";
import {
  databaseForRequest,
  databaseView,
  isConstraintError,
  operationForRequest,
  operationView,
  type RoleRow,
  type RegionRow,
  type SizeRow,
} from "./rows.ts";
import { publishForAnswer } from "./admission-mutations.ts";
import { validatedArchivePrefix } from "./archive.ts";
import { archiveBucket } from "./archive-bucket.ts";
import { restoreBackup } from "./restore-catalog.ts";
import { retainedArchiveRestorable } from "./retained-archives.ts";
interface Retained {
  roles_json: string;
  expires_at: string;
  cleanup_claim: string | null;
  archive_path: string;
  storage_generation: number;
}
/**
 * A role of the source: a live row, or an entry of a retained archive. Archives retained before
 * roles had attributes lack them, and a role without them is a plain role.
 */
type SourceRole = Omit<
  RoleRow,
  | "valid_until"
  | "connection_limit"
  | "member_of_json"
  | "bypass_rls"
  | "created_by_key_id"
  | "deleted_by_key_id"
  | "delete_operation_id"
> &
  Partial<
    Pick<
      RoleRow,
      "valid_until" | "connection_limit" | "member_of_json" | "bypass_rls"
    >
  > & { member_of?: string[] };
function attributesOf(role: SourceRole) {
  return {
    validUntil: role.valid_until ?? null,
    connectionLimit: role.connection_limit ?? null,
    memberOf:
      role.member_of ??
      (role.member_of_json
        ? (JSON.parse(role.member_of_json) as string[])
        : []),
    bypassRls: role.bypass_rls ? 1 : 0,
  };
}
async function response(
  c: ApiContext,
  id: string,
  status = 202,
): Promise<Response> {
  const operation = await operationForRequest(c, id),
    database = await databaseForRequest(c, operation.database_id, true);
  await publishForAnswer(c, database.id);
  c.header("Location", `/v1/operations/${id}`);
  return Response.json(
    {
      target_database: databaseView(database),
      operation: operationView(operation),
    },
    { status, headers: c.res.headers },
  );
}
export async function restoreDatabase(
  c: ApiContext,
  sourceId: string,
  body: DatabaseRestore,
): Promise<Response> {
  await databaseForRequest(c, sourceId, true);
  return withIdempotency(c, {
    replay: (id, status) => response(c, id, status),
    execute: async (lease) => {
      const source = await databaseForRequest(c, sourceId, true),
        now = new Date().toISOString();
      const historical = body.source_operation_id
        ? await c.env.DB.prepare(
            `SELECT source_archive_path,source_storage_generation FROM database_replacements
           WHERE operation=? AND database_id=? AND project_id=? AND region_id=?
             AND phase IN('succeeded','failed') AND retained_until>? AND source_cleanup_claim IS NULL AND source_archive_deleted_at IS NULL`,
          )
            .bind(
              body.source_operation_id,
              sourceId,
              source.project_id,
              source.region_id,
              now,
            )
            .first<{
              source_archive_path: string;
              source_storage_generation: number;
            }>()
        : null;
      if (body.source_operation_id && !historical)
        throw new ApiError(
          "conflict",
          "The prior state is unavailable or outside recovery retention",
          { reason: "archive_expired" },
        );
      const archiveSource = historical
        ? {
            ...source,
            archive_path: historical.source_archive_path,
            storage_generation: historical.source_storage_generation,
          }
        : source;
      if (body.mode === "pitr" && body.target_time > now)
        throw new ApiError(
          "invalid_request",
          "Recovery time must not be in the future",
        );
      const retained =
        source.deleted_at === null
          ? null
          : await c.env.DB.prepare(
              "SELECT * FROM retained_archives WHERE source_database_id=? AND project_id=? AND region_id=?",
            )
              .bind(sourceId, source.project_id, source.region_id)
              .first<Retained>();
      if (
        source.deleted_at !== null &&
        !historical &&
        !retainedArchiveRestorable(retained, source, now)
      )
        throw new ApiError(
          "conflict",
          "The deleted source archive is outside recovery retention",
          { reason: "archive_expired" },
        );
      // A node reads archives of its own region only (ULTRA plan 7.3), so a restore into another
      // region could never build: the target is in the source's region.
      if ((body.region_id ?? source.region_id) !== source.region_id)
        throw new ApiError(
          "conflict",
          "A restore goes into the source's own region",
          { reason: "region_unavailable" },
        );
      const [region, size] = await Promise.all([
        c.env.DB.prepare("SELECT id FROM regions WHERE id=?")
          .bind(source.region_id)
          .first<RegionRow>(),
        c.env.DB.prepare("SELECT * FROM size_classes WHERE id=? AND enabled=1")
          .bind(source.size_class_id)
          .first<SizeRow>(),
      ]);
      if (!region || !size)
        throw new ApiError("conflict", "Source region or size is unavailable", {
          reason: "source_unavailable",
        });
      // The target keeps what the source runs with: its size class and its own resources.
      const own = ownResources(source),
        effective = effectiveResources(size, own);
      assertResourcesAllowed(
        effective,
        own,
        await regionBounds(c.env.DB, region.id),
      );
      const selected = archiveBucket(c.env),
        prefix = validatedArchivePrefix(archiveSource, selected.bucketName);
      const backup = await restoreBackup(
        selected.bucket,
        prefix,
        body.mode === "pitr" ? body.target_time : undefined,
      );
      const stored = retained
        ? (JSON.parse(retained.roles_json) as SourceRole[])
        : (
            await c.env.DB.prepare(
              "SELECT * FROM roles WHERE database_id=? AND deleted_at IS NULL ORDER BY name",
            )
              .bind(sourceId)
              .all<RoleRow>()
          ).results;
      const issuer = (await getAuth(c)).id;
      if (stored.filter((r) => r.owner === 1).length !== 1)
        throw new ApiError("conflict", "Source credentials are unavailable", {
          reason: "source_unavailable",
        });
      const targetId = newDatabaseId(),
        op = newOperationId(),
        storageGeneration = (archiveSource.storage_generation ?? 1) + 1,
        credentials = keyring(c.env.CREDENTIAL_KEYS);
      const roles = await Promise.all(
        stored.map(async (r) => ({
          row: r,
          encrypted: await credentials.encrypt(
            targetId,
            r.name,
            await credentials.decrypt(sourceId, r.name, {
              ciphertext: r.password_ciphertext,
              iv: r.password_iv,
              kid: r.password_kid,
            }),
          ),
        })),
      );
      const decidedAt = Date.now(),
        node = choosePlacement(
          await placementNodes(c.env.DB, region.id, decidedAt),
          effective,
          decidedAt,
        );
      const archive = archiveDestinationPath(
        selected.bucketName,
        region.id,
        targetId,
        storageGeneration,
        op,
      );
      const authority = {
        sql: `EXISTS(SELECT 1 FROM databases src WHERE src.id=? AND src.project_id=? AND src.region_id=? AND src.generation=? AND src.updated_at=? AND src.archive_path=? AND src.storage_generation=? AND src.deleted_at IS ?
   AND (src.deleted_at IS NULL OR EXISTS(SELECT 1 FROM retained_archives ra WHERE ra.source_database_id=src.id AND ra.archive_path=src.archive_path AND ra.storage_generation=src.storage_generation AND ra.expires_at>? AND ra.cleanup_claim IS NULL AND ra.roles_json=?)))
   AND (SELECT json_group_array(json_object('name',r.name,'revision',r.password_revision,'ciphertext',r.password_ciphertext)) FROM (SELECT * FROM roles WHERE database_id=? AND deleted_at IS NULL ORDER BY name) r)=? AND (${lease.guard.sql})`,
        bindings: [
          sourceId,
          source.project_id,
          source.region_id,
          source.generation,
          source.updated_at,
          source.archive_path,
          source.storage_generation ?? 1,
          source.deleted_at,
          now,
          retained?.roles_json ?? "",
          sourceId,
          JSON.stringify(
            stored
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((r) => ({
                name: r.name,
                revision: r.password_revision,
                ciphertext: r.password_ciphertext,
              })),
          ),
          ...lease.guard.bindings,
        ],
      };
      const guard = {
        sql: "EXISTS(SELECT 1 FROM database_restores WHERE target_database_id=? AND operation_id=?)",
        bindings: [targetId, op],
      };
      if (historical) {
        authority.sql +=
          " AND EXISTS(SELECT 1 FROM database_replacements rp WHERE rp.operation=? AND rp.database_id=? AND rp.source_archive_path=? AND rp.retained_until>? AND rp.source_cleanup_claim IS NULL AND rp.source_archive_deleted_at IS NULL)";
        authority.bindings.push(
          body.source_operation_id!,
          sourceId,
          archiveSource.archive_path,
          now,
        );
      }
      const statements = [
        databaseInsertStatement(c.env.DB, {
          body: {
            project_id: source.project_id,
            region_id: region.id,
            size_class_id: source.size_class_id,
            sleep_after_seconds: source.sleep_after_seconds ?? null,
            name: body.name,
          },
          size,
          resources: own,
          nodeId: node?.id ?? null,
          pendingMemoryMib: node?.pending_memory_mib,
          pendingStorageGib: node?.pending_storage_gib,
          decidedAt,
          id: targetId,
          archivePath: archive,
          now,
          authority,
        }),
        c.env.DB.prepare(
          "UPDATE databases SET storage_generation=? WHERE id=? AND project_id=? AND created_at=?",
        ).bind(storageGeneration, targetId, source.project_id, now),
        ...roles.map(({ row: r, encrypted: e }) => {
          const attributes = attributesOf(r);
          return c.env.DB.prepare(
            "INSERT INTO roles(database_id,name,owner,password_ciphertext,password_iv,password_kid,password_revision,created_at,updated_at,valid_until,connection_limit,member_of_json,bypass_rls,created_by_key_id) SELECT id,?,?,?,?,?,?,?,?,?,?,?,?,? FROM databases WHERE id=? AND project_id=? AND created_at=?",
          ).bind(
            r.name,
            r.owner,
            e.ciphertext,
            e.iv,
            e.kid,
            r.password_revision,
            now,
            now,
            attributes.validUntil,
            attributes.connectionLimit,
            JSON.stringify(attributes.memberOf),
            attributes.bypassRls,
            issuer,
            targetId,
            source.project_id,
            now,
          );
        }),
        c.env.DB.prepare(
          "INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at) SELECT ?,'database.restore','pending',project_id,id,generation,?,? FROM databases WHERE id=? AND project_id=? AND created_at=?",
        ).bind(op, now, now, targetId, source.project_id, now),
        c.env.DB.prepare(
          "INSERT INTO database_restores(target_database_id,operation_id,source_database_id,source_archive_path,source_storage_generation,backup_id,target_time,created_at) SELECT id,?,?,?,?,?,?,? FROM databases WHERE id=? AND project_id=? AND created_at=?",
        ).bind(
          op,
          sourceId,
          archiveSource.archive_path,
          archiveSource.storage_generation ?? 1,
          backup.id,
          body.mode === "pitr" ? body.target_time : null,
          now,
          targetId,
          source.project_id,
          now,
        ),
        lease.completeStatement(op, 202, guard),
      ];
      let result: D1Result[];
      try {
        result = await c.env.DB.batch(statements);
      } catch (error) {
        if (isConstraintError(error))
          throw new ApiError(
            "conflict",
            "A database with this target name already exists",
            { reason: "name_in_use" },
          );
        throw error;
      }
      if (result[0]!.meta.changes !== 1)
        throw new ApiError(
          "conflict",
          "Source credentials, retention or placement changed; retry the request",
          { reason: "generation_changed" },
        );
      if (node) hint(c, [targetId]);
      return response(c, op);
    },
  });
}
