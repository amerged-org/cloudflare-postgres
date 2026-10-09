// SPDX-License-Identifier: Apache-2.0
import {
  archiveDestinationPath,
  DatabaseCreate,
  type DatabaseResize,
  databaseMemoryReservationMib,
  databaseCpuReservationMillicores,
  postgresCpuRequestMillicores,
  newDatabaseId,
  newOperationId,
  newRolePassword,
  OWNER_ROLE_NAME,
  SIDECAR,
  type DesiredPostgres,
} from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { assertProjectAccess, getAuth } from "../middleware/auth.ts";
import {
  withIdempotency,
  type IdempotencyLease,
} from "../middleware/idempotency.ts";
import { page } from "../platform/pagination.ts";
import { keyring } from "../crypto/keyring.ts";
import {
  choosePlacement,
  placementNodes,
  nodePlacementGuard,
  nodePlacementBindings,
  nodeDatabasePlacementGuard,
  nodeDatabaseCapacityGuard,
  nodeMemoryReservationGuard,
  databaseMemoryPolicyAllows,
} from "./placement.ts";
import { syncDatabaseActor } from "./database-actor-sync.ts";
import { runNodeCapacity, startupPlacementNodes } from "./node-capacity.ts";
import {
  startupHeadroomSql,
  computePoolOverheadSql,
  startupReservationStatement,
  nodeCpuHeadroomSql,
  databaseCpuChargeSql,
} from "./startup-admission.ts";
import {
  generateMaintenanceCredential,
  maintenanceCreationStatement,
} from "./maintenance.ts";
import {
  databaseForRequest,
  databaseView,
  isConstraintError,
  operationForRequest,
  operationView,
  type DatabaseRow,
  type RegionRow,
  type SizeRow,
} from "./rows.ts";

import {
  nodeStoragePlacementSql,
  selectedStorageProfileSql,
  storageResizeAllowedSql,
} from "./storage-capacity.ts";
export function hint(c: ApiContext, regionId: string, ids: string[]): void {
  const stub = c.env.REGION_LINK.get(c.env.REGION_LINK.idFromName(regionId));
  // Hints are best effort; the periodic full desired-state pull remains authoritative.
  c.executionCtx.waitUntil(stub.notify(ids).catch(() => undefined));
}
export async function databaseOperationResponse(
  c: ApiContext,
  operationId: string,
  status = 202,
): Promise<Response> {
  const operation = await operationForRequest(c, operationId);
  const database = await databaseForRequest(c, operation.database_id, true);
  await syncDatabaseActor(c, database.id);
  c.header("Location", `/v1/operations/${operation.id}`);
  return Response.json(
    { database: databaseView(database), operation: operationView(operation) },
    { status, headers: c.res.headers },
  );
}
export interface DatabaseInsertSnapshot {
  body: DatabaseCreate;
  size: SizeRow;
  region: RegionRow;
  nodeId: string | null;
  id: string;
  archivePath: string;
  now: string;
  authority?: { sql: string; bindings: (string | number | null)[] };
}
export function databaseInsertStatement(
  db: D1Database,
  snapshot: DatabaseInsertSnapshot,
): D1PreparedStatement {
  const postgresColumns =
    "desired_postgres_release_id,desired_postgres_image,desired_postgres_version,desired_postgres_schema_revision";
  const postgresSelection = [
    "f.release_id",
    "json_extract(c.value,'$.reference')",
    "json_extract(c.value,'$.version')",
    "json_extract(release.spec_json,'$.configuration_schema_revision')",
  ]
    .map(
      (column) =>
        `(SELECT ${column} FROM fleet_region_releases f JOIN fleet_releases release ON release.id=f.release_id,json_each(release.spec_json,'$.components') c WHERE f.region_id=r.id AND json_extract(c.value,'$.name')='postgres')`,
    )
    .join(",");
  if (snapshot.nodeId === null) {
    return db
      .prepare(
        `INSERT INTO databases(id,project_id,region_id,node_id,name,size_class_id,desired_state,generation,archive_path,status_message,created_at,updated_at,${postgresColumns})
      SELECT ?,p.id,r.id,NULL,?,s.id,'running',1,?,'Waiting for verified regional capacity',?,?,${postgresSelection}
      FROM projects p JOIN regions r ON r.id=? AND r.backup_bucket=? JOIN size_classes s ON s.id=? AND s.enabled=1
      WHERE p.id=? AND p.deleted_at IS NULL AND s.memory_mib=? AND s.storage_gib=? AND s.cpu_millicores=?
      AND s.max_connections=? AND s.sleep_after_seconds IS ? AND s.archive_timeout_seconds=? AND s.backup_retention_days=?
      AND (COALESCE((SELECT placement_mode FROM node_region_policies WHERE region_id=r.id),'reserved')='reserved' OR (s.memory_mib%256=0 AND (SELECT maximum_database_memory_mib FROM node_region_policies WHERE region_id=r.id)>=s.memory_mib AND (SELECT postgres_memory_request_mib FROM node_region_policies WHERE region_id=r.id)<=s.memory_mib))
      AND (${snapshot.authority?.sql ?? "1=1"})`,
      )
      .bind(
        snapshot.id,
        snapshot.body.name,
        snapshot.archivePath,
        snapshot.now,
        snapshot.now,
        snapshot.body.region_id,
        snapshot.region.backup_bucket,
        snapshot.body.size_class_id,
        snapshot.body.project_id,
        snapshot.size.memory_mib,
        snapshot.size.storage_gib,
        snapshot.size.cpu_millicores,
        snapshot.size.max_connections,
        snapshot.size.sleep_after_seconds,
        snapshot.size.archive_timeout_seconds,
        snapshot.size.backup_retention_days,
        ...(snapshot.authority?.bindings ?? []),
      );
  }
  return db
    .prepare(
      `INSERT INTO databases (id,project_id,region_id,node_id,name,size_class_id,desired_state,generation,archive_path,created_at,updated_at,storage_profile_json,${postgresColumns})
            SELECT ?,p.id,n.region_id,n.id,?,s.id,'running',1,?,?,?,${selectedStorageProfileSql()},${postgresSelection} FROM nodes n JOIN projects p ON p.id=? AND p.deleted_at IS NULL
            JOIN size_classes s ON s.id=? AND s.enabled=1 JOIN regions r ON r.id=n.region_id AND r.backup_bucket=?
            WHERE n.id=? AND n.region_id=? AND n.ready=1 AND n.schedulable=1 AND ${nodePlacementGuard("n")} AND ${nodeDatabasePlacementGuard("n")}
            AND ${startupHeadroomSql()}
            AND ${nodeMemoryReservationGuard(`n.allocatable_memory_mib-n.platform_reserved_memory_mib-COALESCE((SELECT SUM(sc.memory_mib+?+${computePoolOverheadSql("d", "memory_mib")}) FROM databases d JOIN size_classes sc ON sc.id=d.size_class_id WHERE d.node_id=n.id AND d.observed_state<>'deleted'),0)>=s.memory_mib+?+${computePoolOverheadSql("n", "memory_mib")}`)}
            AND n.platform_reserved_cpu_millicores IS NOT NULL
            AND ${nodeCpuHeadroomSql()}
            AND ${nodeStoragePlacementSql()}
            AND s.memory_mib=? AND s.storage_gib=? AND s.cpu_millicores=? AND COALESCE(s.cpu_request_millicores,s.cpu_millicores)=? AND s.max_connections=?
            AND s.sleep_after_seconds IS ? AND s.archive_timeout_seconds=? AND s.backup_retention_days=? AND (${snapshot.authority?.sql ?? "1=1"})`,
    )
    .bind(
      snapshot.id,
      snapshot.body.name,
      snapshot.archivePath,
      snapshot.now,
      snapshot.now,
      snapshot.body.project_id,
      snapshot.body.size_class_id,
      snapshot.region.backup_bucket,
      snapshot.nodeId,
      snapshot.body.region_id,
      ...nodePlacementBindings(Date.parse(snapshot.now)),
      SIDECAR.requestMemoryMib,
      SIDECAR.requestMemoryMib,
      snapshot.size.memory_mib,
      snapshot.size.storage_gib,
      snapshot.size.cpu_millicores,
      postgresCpuRequestMillicores(snapshot.size),
      snapshot.size.max_connections,
      snapshot.size.sleep_after_seconds,
      snapshot.size.archive_timeout_seconds,
      snapshot.size.backup_retention_days,
      ...(snapshot.authority?.bindings ?? []),
    );
}
export async function createDatabase(
  c: ApiContext,
  body: DatabaseCreate,
): Promise<Response> {
  await assertProjectAccess(c, body.project_id);
  return withIdempotency(c, {
    replay: (id, status) => databaseOperationResponse(c, id, status),
    execute: async (lease) => {
      const project = await c.env.DB.prepare(
        "SELECT id FROM projects WHERE id=? AND deleted_at IS NULL",
      )
        .bind(body.project_id)
        .first();
      const size = await c.env.DB.prepare(
        "SELECT * FROM size_classes WHERE id=? AND enabled=1",
      )
        .bind(body.size_class_id)
        .first<SizeRow>();
      const region = await c.env.DB.prepare(
        "SELECT id,backup_bucket,backup_endpoint_url,agent_key_hash FROM regions WHERE id=?",
      )
        .bind(body.region_id)
        .first<RegionRow>();
      if (!project) throw new ApiError("not_found", "Project not found");
      if (!size || !region)
        throw new ApiError(
          "invalid_request",
          "Size class or region unavailable",
        );
      if (
        !(await databaseMemoryPolicyAllows(
          c.env.DB,
          region.id,
          size.memory_mib,
        ))
      )
        throw new ApiError(
          "invalid_request",
          "Size class exceeds the configured per-database memory maximum",
        );
      const id = newDatabaseId(),
        op = newOperationId(),
        now = new Date().toISOString();
      const encrypted = await keyring(c.env.CREDENTIAL_KEYS).encrypt(
        id,
        OWNER_ROLE_NAME,
        newRolePassword(),
      );
      const maintenance = await generateMaintenanceCredential(
        c.env.CREDENTIAL_KEYS,
        id,
      );
      for (let attempt = 0; attempt < 3; attempt++) {
        const node =
          attempt === 2
            ? null
            : choosePlacement(
                await startupPlacementNodes(c.env.DB, body.region_id, size.id),
                body.region_id,
                size,
              );
        const archive = archiveDestinationPath(
          region.backup_bucket,
          region.id,
          id,
          1,
          op,
        );
        const guard = {
          sql: "EXISTS (SELECT 1 FROM databases WHERE id=? AND project_id=?)",
          bindings: [id, body.project_id],
        };
        let result: D1Result[];
        try {
          result = await c.env.DB.batch([
            databaseInsertStatement(c.env.DB, {
              body,
              size,
              region,
              nodeId: node?.id ?? null,
              id,
              archivePath: archive,
              now,
            }),
            maintenanceCreationStatement(
              c.env.DB,
              {
                databaseId: id,
                projectId: body.project_id,
                createdAt: now,
                creationGeneration: 1,
              },
              maintenance,
            ),
            c.env.DB.prepare(
              `INSERT INTO roles (database_id,name,owner,password_ciphertext,password_iv,password_kid,password_revision,created_at,updated_at)
            SELECT id,?,1,?,?,?,1,?,? FROM databases WHERE id=? AND project_id=?`,
            ).bind(
              OWNER_ROLE_NAME,
              encrypted.ciphertext,
              encrypted.iv,
              encrypted.kid,
              now,
              now,
              id,
              body.project_id,
            ),
            c.env.DB.prepare(
              `INSERT INTO operations (id,kind,status,project_id,database_id,generation,created_at,updated_at)
            SELECT ?,'database.create','pending',project_id,id,generation,?,? FROM databases WHERE id=? AND project_id=?`,
            ).bind(op, now, now, id, body.project_id),
            ...(node
              ? [
                  startupReservationStatement(c.env.DB, {
                    databaseId: id,
                    operationId: op,
                    generation: 1,
                    nodeId: node.id,
                    now,
                  }),
                ]
              : []),
            c.env.DB.prepare(
              `INSERT INTO lifecycle_events (database_id,kind,node_id,size_class_id,generation,occurred_at,resource_snapshot)
            SELECT id,'created',node_id,size_class_id,generation,?,json_set(?,'$.storage_allocated_bytes',CASE WHEN storage_profile_json IS NULL THEN ? ELSE NULL END,'$.reserved_cpu_millicores',?+${computePoolOverheadSql("databases", "cpu_millicores")},'$.reserved_memory_mib',?+${computePoolOverheadSql("databases", "memory_mib")}) FROM databases WHERE id=? AND project_id=? AND node_id IS NOT NULL`,
            ).bind(
              now,
              node === null
                ? null
                : JSON.stringify({
                    memory_mib: size.memory_mib,
                    cpu_millicores: size.cpu_millicores,
                    reserved_memory_mib:
                      size.memory_mib + SIDECAR.requestMemoryMib,
                    reserved_cpu_millicores:
                      databaseCpuReservationMillicores(size),
                    storage_allocated_bytes: size.storage_gib * 2 ** 30,
                  }),
              size.storage_gib * 2 ** 30,
              databaseCpuReservationMillicores(size),
              size.memory_mib + SIDECAR.requestMemoryMib,
              id,
              body.project_id,
            ),
            lease.completeStatement(op, 202, guard),
          ]);
        } catch (error) {
          if (isConstraintError(error))
            throw new ApiError(
              "conflict",
              "A database with this name already exists",
            );
          throw error;
        }
        if (result[0]!.meta.changes === 1) {
          if (node !== null) hint(c, region.id, [id]);
          else c.executionCtx.waitUntil(runNodeCapacity(c.env, region.id));
          return databaseOperationResponse(c, op);
        }
      }
      throw new ApiError(
        "conflict",
        "Project, region or size class changed; retry the request",
      );
    },
  });
}
export async function listDatabases(c: ApiContext): Promise<Response> {
  const auth = await getAuth(c),
    pagination = page(c, {
      limit: c.req.query("limit"),
      cursor: c.req.query("cursor"),
    });
  const project = c.req.query("project_id");
  if (project) await assertProjectAccess(c, project);
  const boundProject = auth.scope === "integrator" ? auth.project_id : project;
  const cursor = pagination.where("d.created_at", "d.id");
  const result = await c.env.DB.prepare(
    `SELECT d.* FROM databases d JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL WHERE d.deleted_at IS NULL ${boundProject ? "AND d.project_id=?" : ""} AND ${cursor.sql} ORDER BY d.created_at DESC,d.id DESC LIMIT ?`,
  )
    .bind(
      ...(boundProject ? [boundProject] : []),
      ...cursor.bindings,
      pagination.limit + 1,
    )
    .all<DatabaseRow>();
  return c.json(pagination.envelope(result.results.map(databaseView)));
}

export function databaseResizeStatement(
  db: D1Database,
  row: DatabaseRow,
  size: SizeRow,
  now: string,
  authority?: DatabaseInsertSnapshot["authority"],
  postgres?: DesiredPostgres,
): D1PreparedStatement {
  const imageUpdate = postgres
    ? "desired_postgres_release_id=?,desired_postgres_image=?,desired_postgres_version=?,desired_postgres_schema_revision=?,"
    : "";
  const imageBindings = postgres
    ? [
        postgres.release_id,
        postgres.image,
        postgres.version,
        postgres.configuration_schema_revision,
      ]
    : [];
  const sameClassImagePatch =
    postgres !== undefined && size.id === row.size_class_id;
  if (row.desired_state === "suspended")
    return db
      .prepare(
        `UPDATE databases SET ${imageUpdate}size_class_id=?,generation=generation+1,observed_generation=generation+1,observed_state='provisioning',status_message=NULL,updated_at=?
       WHERE (id=? AND project_id=? AND generation=? AND size_class_id=? AND updated_at=? AND node_id IS ?
         AND desired_state='suspended' AND observed_state='provisioning' AND observed_generation=generation
         AND observed_power='hibernated' AND power_operation IS ? AND suspension_reason IS ? AND deleted_at IS NULL)
         AND EXISTS(SELECT 1 FROM projects WHERE id=databases.project_id AND deleted_at IS NULL)
         AND EXISTS(SELECT 1 FROM size_classes old WHERE old.id=databases.size_class_id
           AND ${databaseCpuChargeSql("databases", "old")}=0)
         AND EXISTS(SELECT 1 FROM size_classes target WHERE target.id=? AND ${sameClassImagePatch ? "1=1" : "target.enabled=1"}
           AND ${storageResizeAllowedSql("databases", "target")}
           AND target.memory_mib=? AND target.cpu_millicores=? AND COALESCE(target.cpu_request_millicores,target.cpu_millicores)=?
           AND target.storage_gib=? AND target.max_connections=? AND target.sleep_after_seconds IS ?
           AND target.archive_timeout_seconds=? AND target.backup_retention_days=?
           AND (COALESCE((SELECT placement_mode FROM node_region_policies WHERE region_id=databases.region_id),'reserved')='reserved'
             OR EXISTS(SELECT 1 FROM node_region_policies p WHERE p.region_id=databases.region_id
               AND target.memory_mib BETWEEN 256 AND p.maximum_database_memory_mib AND target.memory_mib%256=0
               AND p.postgres_memory_request_mib BETWEEN 1 AND target.memory_mib)))
         AND (${authority?.sql ?? "1=1"})`,
      )
      .bind(
        ...imageBindings,
        size.id,
        now,
        row.id,
        row.project_id,
        row.generation,
        row.size_class_id,
        row.updated_at,
        row.node_id,
        row.power_operation ?? null,
        row.suspension_reason ?? null,
        size.id,
        size.memory_mib,
        size.cpu_millicores,
        postgresCpuRequestMillicores(size),
        size.storage_gib,
        size.max_connections,
        size.sleep_after_seconds,
        size.archive_timeout_seconds,
        size.backup_retention_days,
        ...(authority?.bindings ?? []),
      );
  return db
    .prepare(
      `UPDATE databases SET ${imageUpdate}size_class_id=?,generation=generation+1,observed_state='provisioning',status_message=NULL,updated_at=?
    WHERE ((id=? AND project_id=? AND node_id IS ? AND generation=? AND size_class_id=? AND updated_at=?)
      AND (desired_state='running' AND observed_state='ready' AND observed_generation=generation AND deleted_at IS NULL))
      AND EXISTS(SELECT 1 FROM projects p WHERE p.id=databases.project_id AND p.deleted_at IS NULL)
      AND EXISTS(SELECT 1 FROM nodes n JOIN size_classes s ON s.id=? AND ${sameClassImagePatch ? "1=1" : "s.enabled=1"}
        WHERE (n.id=databases.node_id AND n.region_id=databases.region_id AND n.ready=1 AND n.schedulable=1)
          AND ((${nodePlacementGuard("n")}) AND ${nodeDatabaseCapacityGuard("n")}
          AND ${startupHeadroomSql()}
          AND n.platform_reserved_cpu_millicores IS NOT NULL)
          AND (${storageResizeAllowedSql()}
          AND ${nodeMemoryReservationGuard(`n.allocatable_memory_mib-n.platform_reserved_memory_mib-COALESCE((SELECT SUM(sc.memory_mib+?+${computePoolOverheadSql("d", "memory_mib")}) FROM databases d JOIN size_classes sc ON sc.id=d.size_class_id WHERE d.node_id=n.id AND d.id<>databases.id AND d.observed_state<>'deleted'),0)>=s.memory_mib+?+${computePoolOverheadSql("n", "memory_mib")}`)}
          AND ${nodeCpuHeadroomSql("n", "s", "databases")})
          AND ${nodeStoragePlacementSql("n", "s", "databases")}
          AND ((s.memory_mib=? AND s.cpu_millicores=? AND COALESCE(s.cpu_request_millicores,s.cpu_millicores)=? AND s.storage_gib=? AND s.max_connections=?)
          AND (s.sleep_after_seconds IS ? AND s.archive_timeout_seconds=? AND s.backup_retention_days=?)))
      AND (${authority?.sql ?? "1=1"})`,
    )
    .bind(
      ...imageBindings,
      size.id,
      now,
      row.id,
      row.project_id,
      row.node_id,
      row.generation,
      row.size_class_id,
      row.updated_at,
      size.id,
      ...nodePlacementBindings(Date.parse(now)),
      SIDECAR.requestMemoryMib,
      SIDECAR.requestMemoryMib,
      size.memory_mib,
      size.cpu_millicores,
      postgresCpuRequestMillicores(size),
      size.storage_gib,
      size.max_connections,
      size.sleep_after_seconds,
      size.archive_timeout_seconds,
      size.backup_retention_days,
      ...(authority?.bindings ?? []),
    );
}

/** The API and central profile rollout share the same atomic resize and startup admission. */
export async function scheduleDatabaseResize(
  db: D1Database,
  row: DatabaseRow,
  targetId: string,
  now: string,
  lease?: IdempotencyLease,
  authority?: DatabaseInsertSnapshot["authority"],
  postgres?: DesiredPostgres,
): Promise<string> {
  if (
    row.deleted_at !== null ||
    !["running", "suspended"].includes(row.desired_state)
  )
    throw new ApiError("conflict", "Database is deleted");
  const [previous, target] = await Promise.all([
    db
      .prepare("SELECT * FROM size_classes WHERE id=?")
      .bind(row.size_class_id)
      .first<SizeRow>(),
    db
      .prepare("SELECT * FROM size_classes WHERE id=?")
      .bind(targetId)
      .first<SizeRow>(),
  ]);
  if (
    !previous ||
    !target ||
    (target.id !== previous.id && target.enabled !== 1)
  )
    throw new ApiError("invalid_request", "Size class unavailable");
  if (!(await databaseMemoryPolicyAllows(db, row.region_id, target.memory_mib)))
    throw new ApiError(
      "invalid_request",
      "Size class exceeds the configured per-database memory maximum",
    );
  if (
    target.storage_gib < previous.storage_gib ||
    (target.storage_gib !== previous.storage_gib &&
      row.storage_profile_json == null)
  )
    throw new ApiError(
      "invalid_request",
      target.storage_gib < previous.storage_gib
        ? "Storage shrink is not supported"
        : "Storage-changing resize is not supported",
    );
  const sleeping = row.desired_state === "suspended";
  const op = newOperationId();
  if (target.id === previous.id && !postgres) {
    await db
      .prepare(
        `INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at,completed_at)
       SELECT ?,'database.resize','succeeded',project_id,id,generation,?,?,? FROM databases
       WHERE id=? AND project_id=? AND generation=? AND size_class_id=? AND updated_at=? AND deleted_at IS NULL
         AND desired_state=? AND observed_state=? AND observed_generation=generation
         AND EXISTS(SELECT 1 FROM projects WHERE id=databases.project_id AND deleted_at IS NULL)
       ON CONFLICT DO NOTHING`,
      )
      .bind(
        op,
        now,
        now,
        now,
        row.id,
        row.project_id,
        row.generation,
        row.size_class_id,
        row.updated_at,
        row.desired_state,
        row.observed_state,
      )
      .run();
    const existing = await db
      .prepare(
        `SELECT o.id FROM operations o JOIN databases d ON d.id=o.database_id AND d.project_id=o.project_id
       WHERE o.database_id=? AND o.project_id=? AND o.kind='database.resize' AND o.generation=?
         AND d.generation=? AND d.size_class_id=? AND d.desired_state=? AND d.deleted_at IS NULL`,
      )
      .bind(
        row.id,
        row.project_id,
        row.generation,
        row.generation,
        row.size_class_id,
        row.desired_state,
      )
      .first<{ id: string }>();
    if (!existing)
      throw new ApiError("conflict", "Database changed; retry the request");
    if (lease)
      await lease
        .completeStatement(existing.id, 202, {
          sql: "EXISTS(SELECT 1 FROM operations WHERE id=? AND project_id=?)",
          bindings: [existing.id, row.project_id],
        })
        .run();
    return existing.id;
  }
  if (
    row.observed_generation !== row.generation ||
    row.node_id === null ||
    (sleeping
      ? row.observed_state !== "provisioning" ||
        row.observed_power !== "hibernated"
      : row.observed_state !== "ready")
  )
    throw new ApiError("conflict", "Database configuration is not ready");
  if (!sleeping) {
    const node = (await placementNodes(db, row.region_id, row.id)).find(
      (value) => value.id === row.node_id,
    );
    if (
      !node ||
      !choosePlacement(
        [
          {
            ...node,
            reserved_memory_mib:
              node.reserved_memory_mib -
              databaseMemoryReservationMib(previous) -
              (node.compute_pool_memory_mib ?? 0),
            reserved_cpu_millicores:
              node.reserved_cpu_millicores -
              databaseCpuReservationMillicores(previous) -
              (node.compute_pool_cpu_millicores ?? 0),
            reserved_storage_gib:
              node.reserved_storage_gib - previous.storage_gib,
          },
        ],
        row.region_id,
        target,
        Date.parse(now),
        row.node_id,
      )
    )
      throw new ApiError(
        "capacity_exhausted",
        "Current node has insufficient memory, CPU or storage",
      );
  }
  const generation = row.generation + 1;
  const statements = [
    databaseResizeStatement(db, row, target, now, authority, postgres),
    db
      .prepare(
        `INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at)
       SELECT ?,'database.resize','pending',project_id,id,generation,?,? FROM databases
       WHERE changes()=1 AND id=? AND project_id=? AND generation=? AND size_class_id=?`,
      )
      .bind(op, now, now, row.id, row.project_id, generation, target.id),
  ];
  if (!sleeping)
    statements.push(
      startupReservationStatement(db, {
        databaseId: row.id,
        operationId: op,
        generation,
        nodeId: row.node_id,
        now,
      }),
    );
  statements.push(
    db
      .prepare(
        `UPDATE operations SET status='failed',error_code='superseded',error_message='Resource configuration superseded',updated_at=?,completed_at=?
     WHERE database_id=? AND project_id=? AND kind='database.resize' AND generation<? AND status IN('pending','running')
       AND EXISTS(SELECT 1 FROM databases d JOIN operations current ON current.database_id=d.id AND current.project_id=d.project_id
         WHERE d.id=operations.database_id AND d.generation=? AND d.size_class_id=? AND d.updated_at=?
           AND current.id=? AND current.generation=d.generation AND current.kind='database.resize')`,
      )
      .bind(
        now,
        now,
        row.id,
        row.project_id,
        generation,
        generation,
        target.id,
        now,
        op,
      ),
  );
  if (lease)
    statements.push(
      lease.completeStatement(op, 202, {
        sql: "EXISTS(SELECT 1 FROM operations WHERE id=? AND project_id=?)",
        bindings: [op, row.project_id],
      }),
    );
  const result = await db.batch(statements);
  if (result[0]!.meta.changes !== 1) {
    const current = await db
      .prepare("SELECT * FROM databases WHERE id=?")
      .bind(row.id)
      .first<DatabaseRow>();
    if (
      !current ||
      current.generation !== row.generation ||
      current.desired_state !== row.desired_state ||
      current.size_class_id !== row.size_class_id ||
      current.updated_at !== row.updated_at ||
      sleeping
    )
      throw new ApiError("conflict", "Database changed; retry the request");
    throw new ApiError(
      "capacity_exhausted",
      "Current node capacity changed; retry the request",
    );
  }
  return op;
}

export async function resizeDatabase(
  c: ApiContext,
  id: string,
  body: DatabaseResize,
  expectedGeneration?: number,
): Promise<Response> {
  await databaseForRequest(c, id, true);
  return withIdempotency(c, {
    replay: (op, status) => databaseOperationResponse(c, op, status),
    execute: async (lease) => {
      const row = await databaseForRequest(c, id, true);
      if (
        expectedGeneration !== undefined &&
        row.generation !== expectedGeneration
      )
        throw new ApiError("conflict", "Database generation changed");
      const op = await scheduleDatabaseResize(
        c.env.DB,
        row,
        body.size_class_id,
        new Date().toISOString(),
        lease,
      );
      hint(c, row.region_id, [id]);
      return databaseOperationResponse(c, op);
    },
  });
}

export async function deleteDatabase(
  c: ApiContext,
  id: string,
): Promise<Response> {
  const row = await databaseForRequest(c, id, true);
  return withIdempotency(c, {
    replay: (op, status) => databaseOperationResponse(c, op, status),
    execute: async (lease) => {
      if (row.desired_state === "deleted") {
        const existing = await c.env.DB.prepare(
          "SELECT id FROM operations WHERE database_id=? AND project_id=? AND kind='database.delete' ORDER BY created_at DESC,id DESC LIMIT 1",
        )
          .bind(id, row.project_id)
          .first<{ id: string }>();
        if (!existing)
          throw new ApiError("conflict", "Deletion operation is unavailable");
        await lease.completeStatement(existing.id, 202).run();
        return databaseOperationResponse(c, existing.id);
      }
      const op = newOperationId(),
        now = new Date().toISOString(),
        generation = row.generation + 1;
      const result = await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE databases SET desired_state='deleted',generation=generation+1,deleted_at=?,updated_at=?
        WHERE id=? AND project_id=? AND generation=? AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM projects WHERE id=databases.project_id AND deleted_at IS NULL)`,
        ).bind(now, now, id, row.project_id, row.generation),
        c.env.DB.prepare(
          `INSERT INTO retained_archives(source_database_id,project_id,region_id,archive_path,storage_generation,roles_json,deleted_at,expires_at)
          SELECT d.id,d.project_id,d.region_id,d.archive_path,d.storage_generation,
          (SELECT json_group_array(json_object('database_id',r.database_id,'name',r.name,'owner',r.owner,'password_ciphertext',r.password_ciphertext,'password_iv',r.password_iv,'password_kid',r.password_kid,'password_revision',r.password_revision,'updated_at',r.updated_at)) FROM roles r WHERE r.database_id=d.id AND r.deleted_at IS NULL),
          d.deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ',d.deleted_at,'+'||s.backup_retention_days||' days')
          FROM databases d JOIN size_classes s ON s.id=d.size_class_id WHERE changes()=1 AND d.id=? AND d.project_id=? AND d.generation=? AND d.deleted_at=?`,
        ).bind(id, row.project_id, generation, now),
        c.env.DB.prepare(
          `INSERT INTO operations (id,kind,status,project_id,database_id,generation,created_at,updated_at)
        SELECT ?,'database.delete','pending',project_id,id,generation,?,? FROM databases WHERE changes()=1 AND id=? AND project_id=? AND generation=?`,
        ).bind(op, now, now, id, row.project_id, generation),
        c.env.DB.prepare(
          `UPDATE operations SET status='failed',error_code='superseded',error_message='Power intent superseded by deletion',updated_at=?,completed_at=? WHERE database_id=? AND generation<? AND kind IN('database.suspend','database.resume','database.hibernate','database.wake') AND status IN('pending','running') AND EXISTS(SELECT 1 FROM operations WHERE id=? AND database_id=? AND generation=? AND kind='database.delete')`,
        ).bind(now, now, id, generation, op, id, generation),
        c.env.DB.prepare(
          `UPDATE databases SET observed_state='deleted',observed_generation=generation,status_message=NULL
          WHERE id=? AND project_id=? AND generation=? AND desired_state='deleted' AND node_id IS NULL
          AND EXISTS(SELECT 1 FROM operations WHERE id=? AND database_id=databases.id AND kind='database.delete')`,
        ).bind(id, row.project_id, generation, op),
        c.env.DB.prepare(
          `UPDATE operations SET status='succeeded',completed_at=?,updated_at=? WHERE id=? AND kind='database.delete'
          AND EXISTS(SELECT 1 FROM databases d WHERE d.id=operations.database_id AND d.node_id IS NULL AND d.observed_state='deleted' AND d.observed_generation=operations.generation)`,
        ).bind(now, now, op),
        c.env.DB.prepare(
          `UPDATE operations SET status='failed',completed_at=?,updated_at=?,error_code='superseded',error_message='Unplaced creation cancelled by deletion'
          WHERE database_id=? AND kind='database.create' AND status='pending' AND EXISTS(SELECT 1 FROM databases d WHERE d.id=operations.database_id AND d.node_id IS NULL AND d.observed_state='deleted')`,
        ).bind(now, now, id),
        lease.completeStatement(op, 202, {
          sql: "EXISTS(SELECT 1 FROM operations WHERE id=? AND project_id=?)",
          bindings: [op, row.project_id],
        }),
      ]);
      if (result[0]!.meta.changes !== 1)
        throw new ApiError("conflict", "Database changed; retry the request");
      hint(c, row.region_id, [id]);
      return databaseOperationResponse(c, op);
    },
  });
}
