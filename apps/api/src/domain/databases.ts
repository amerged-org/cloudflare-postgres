// SPDX-License-Identifier: Apache-2.0
import {
  archiveDestinationPath,
  DatabaseCreate,
  type DatabaseResize,
  databaseMemoryReservationMib,
  databaseCpuReservationMillicores,
  newDatabaseId,
  newOperationId,
  newRolePassword,
  OWNER_ROLE_NAME,
  SIDECAR,
} from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { assertProjectAccess, getAuth } from "../middleware/auth.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import { page } from "../platform/pagination.ts";
import { keyring } from "../crypto/keyring.ts";
import { choosePlacement, placementNodes } from "./placement.ts";
import { syncDatabaseActor } from "./database-actor-sync.ts";
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
  nodeId: string;
  id: string;
  archivePath: string;
  now: string;
}
export function databaseInsertStatement(
  db: D1Database,
  snapshot: DatabaseInsertSnapshot,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO databases (id,project_id,region_id,node_id,name,size_class_id,desired_state,generation,archive_path,created_at,updated_at)
            SELECT ?,p.id,n.region_id,n.id,?,s.id,'running',1,?,?,? FROM nodes n JOIN projects p ON p.id=? AND p.deleted_at IS NULL
            JOIN size_classes s ON s.id=? AND s.enabled=1 JOIN regions r ON r.id=n.region_id AND r.backup_bucket=?
            WHERE n.id=? AND n.region_id=? AND n.ready=1 AND n.schedulable=1 AND n.storage_gib_total IS NOT NULL
            AND n.allocatable_memory_mib-n.platform_reserved_memory_mib-COALESCE((SELECT SUM(sc.memory_mib+?) FROM databases d JOIN size_classes sc ON sc.id=d.size_class_id WHERE d.node_id=n.id AND d.observed_state<>'deleted'),0)>=s.memory_mib+?
            AND n.platform_reserved_cpu_millicores IS NOT NULL
            AND n.allocatable_cpu_millicores-n.platform_reserved_cpu_millicores-COALESCE((SELECT SUM(sc.cpu_millicores+?) FROM databases d JOIN size_classes sc ON sc.id=d.size_class_id WHERE d.node_id=n.id AND d.observed_state<>'deleted'),0)>=s.cpu_millicores+?
            AND n.storage_gib_total-COALESCE((SELECT SUM(sc.storage_gib) FROM databases d JOIN size_classes sc ON sc.id=d.size_class_id WHERE d.node_id=n.id AND d.observed_state<>'deleted'),0)>=s.storage_gib
            AND s.memory_mib=? AND s.storage_gib=? AND s.cpu_millicores=? AND s.max_connections=?
            AND s.sleep_after_seconds IS ? AND s.archive_timeout_seconds=? AND s.backup_retention_days=?`,
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
      SIDECAR.requestMemoryMib,
      SIDECAR.requestMemoryMib,
      SIDECAR.requestCpuMillicores,
      SIDECAR.requestCpuMillicores,
      snapshot.size.memory_mib,
      snapshot.size.storage_gib,
      snapshot.size.cpu_millicores,
      snapshot.size.max_connections,
      snapshot.size.sleep_after_seconds,
      snapshot.size.archive_timeout_seconds,
      snapshot.size.backup_retention_days,
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
      for (let attempt = 0; attempt < 2; attempt++) {
        const node = choosePlacement(
          await placementNodes(c.env.DB, body.region_id),
          body.region_id,
          size,
        );
        if (!node)
          throw new ApiError(
            "capacity_exhausted",
            "No node has sufficient memory, CPU and storage",
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
              nodeId: node.id,
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
            c.env.DB.prepare(
              `INSERT INTO lifecycle_events (database_id,kind,node_id,size_class_id,generation,occurred_at,resource_snapshot)
            SELECT id,'created',node_id,size_class_id,generation,?,? FROM databases WHERE id=? AND project_id=?`,
            ).bind(
              now,
              JSON.stringify({
                memory_mib: size.memory_mib,
                cpu_millicores: size.cpu_millicores,
                reserved_memory_mib: size.memory_mib + SIDECAR.requestMemoryMib,
                reserved_cpu_millicores:
                  size.cpu_millicores + SIDECAR.requestCpuMillicores,
                storage_allocated_bytes: size.storage_gib * 2 ** 30,
              }),
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
          hint(c, region.id, [id]);
          return databaseOperationResponse(c, op);
        }
      }
      throw new ApiError(
        "capacity_exhausted",
        "No node has sufficient memory, CPU and storage",
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
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE databases SET size_class_id=?,generation=generation+1,observed_state='provisioning',status_message=NULL,updated_at=?
    WHERE id=? AND project_id=? AND node_id IS ? AND generation=? AND size_class_id=? AND updated_at=?
      AND desired_state='running' AND observed_state='ready' AND observed_generation=generation AND deleted_at IS NULL
      AND EXISTS(SELECT 1 FROM projects p WHERE p.id=databases.project_id AND p.deleted_at IS NULL)
      AND EXISTS(SELECT 1 FROM nodes n JOIN size_classes s ON s.id=? AND s.enabled=1
        WHERE n.id=databases.node_id AND n.region_id=databases.region_id AND n.ready=1 AND n.schedulable=1
          AND n.storage_gib_total IS NOT NULL AND n.platform_reserved_cpu_millicores IS NOT NULL
          AND s.storage_gib=(SELECT old.storage_gib FROM size_classes old WHERE old.id=databases.size_class_id)
          AND n.allocatable_memory_mib-n.platform_reserved_memory_mib-COALESCE((SELECT SUM(sc.memory_mib+?) FROM databases d JOIN size_classes sc ON sc.id=d.size_class_id WHERE d.node_id=n.id AND d.id<>databases.id AND d.observed_state<>'deleted'),0)>=s.memory_mib+?
          AND n.allocatable_cpu_millicores-n.platform_reserved_cpu_millicores-COALESCE((SELECT SUM(sc.cpu_millicores+?) FROM databases d JOIN size_classes sc ON sc.id=d.size_class_id WHERE d.node_id=n.id AND d.id<>databases.id AND d.observed_state<>'deleted'),0)>=s.cpu_millicores+?
          AND n.storage_gib_total-COALESCE((SELECT SUM(sc.storage_gib) FROM databases d JOIN size_classes sc ON sc.id=d.size_class_id WHERE d.node_id=n.id AND d.id<>databases.id AND d.observed_state<>'deleted'),0)>=s.storage_gib
          AND s.memory_mib=? AND s.cpu_millicores=? AND s.storage_gib=? AND s.max_connections=?
          AND s.sleep_after_seconds IS ? AND s.archive_timeout_seconds=? AND s.backup_retention_days=?)`,
    )
    .bind(
      size.id,
      now,
      row.id,
      row.project_id,
      row.node_id,
      row.generation,
      row.size_class_id,
      row.updated_at,
      size.id,
      SIDECAR.requestMemoryMib,
      SIDECAR.requestMemoryMib,
      SIDECAR.requestCpuMillicores,
      SIDECAR.requestCpuMillicores,
      size.memory_mib,
      size.cpu_millicores,
      size.storage_gib,
      size.max_connections,
      size.sleep_after_seconds,
      size.archive_timeout_seconds,
      size.backup_retention_days,
    );
}

export async function resizeDatabase(
  c: ApiContext,
  id: string,
  body: DatabaseResize,
): Promise<Response> {
  await databaseForRequest(c, id, true);
  return withIdempotency(c, {
    replay: (op, status) => databaseOperationResponse(c, op, status),
    execute: async (lease) => {
      const row = await databaseForRequest(c, id, true);
      if (row.deleted_at !== null || row.desired_state !== "running")
        throw new ApiError("conflict", "Database is not running");
      const [previous, target] = await Promise.all([
        c.env.DB.prepare("SELECT * FROM size_classes WHERE id=?")
          .bind(row.size_class_id)
          .first<SizeRow>(),
        c.env.DB.prepare("SELECT * FROM size_classes WHERE id=?")
          .bind(body.size_class_id)
          .first<SizeRow>(),
      ]);
      if (
        !previous ||
        !target ||
        (target.id !== previous.id && target.enabled !== 1)
      )
        throw new ApiError("invalid_request", "Size class unavailable");
      if (target.storage_gib < previous.storage_gib)
        throw new ApiError(
          "invalid_request",
          "Storage shrink is not supported",
        );
      if (target.storage_gib !== previous.storage_gib)
        throw new ApiError(
          "invalid_request",
          "Storage-changing resize is not supported",
        );
      const now = new Date().toISOString();
      if (target.id === previous.id) {
        const op = newOperationId();
        await c.env.DB.prepare(
          `INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at,completed_at)
          SELECT ?,'database.resize','succeeded',project_id,id,generation,?,?,? FROM databases
          WHERE id=? AND project_id=? AND generation=? AND size_class_id=? AND updated_at=? AND deleted_at IS NULL
            AND desired_state='running' AND observed_state='ready' AND observed_generation=generation
            AND EXISTS(SELECT 1 FROM projects p WHERE p.id=databases.project_id AND p.deleted_at IS NULL)
          ON CONFLICT DO NOTHING`,
        )
          .bind(
            op,
            now,
            now,
            now,
            id,
            row.project_id,
            row.generation,
            row.size_class_id,
            row.updated_at,
          )
          .run();
        const existing = await c.env.DB.prepare(
          `SELECT o.id FROM operations o JOIN databases d ON d.id=o.database_id AND d.project_id=o.project_id
          WHERE o.database_id=? AND o.project_id=? AND o.kind='database.resize' AND o.generation=?
            AND d.generation=? AND d.size_class_id=? AND d.desired_state='running' AND d.deleted_at IS NULL`,
        )
          .bind(
            id,
            row.project_id,
            row.generation,
            row.generation,
            row.size_class_id,
          )
          .first<{ id: string }>();
        if (!existing)
          throw new ApiError("conflict", "Database changed; retry the request");
        await lease
          .completeStatement(existing.id, 202, {
            sql: "EXISTS(SELECT 1 FROM operations WHERE id=? AND project_id=?)",
            bindings: [existing.id, row.project_id],
          })
          .run();
        return databaseOperationResponse(c, existing.id);
      }
      if (
        row.observed_state !== "ready" ||
        row.observed_generation !== row.generation ||
        row.node_id === null
      )
        throw new ApiError("conflict", "Database configuration is not ready");
      const node = (await placementNodes(c.env.DB, row.region_id)).find(
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
                databaseMemoryReservationMib(previous),
              reserved_cpu_millicores:
                node.reserved_cpu_millicores -
                databaseCpuReservationMillicores(previous),
              reserved_storage_gib:
                node.reserved_storage_gib - previous.storage_gib,
            },
          ],
          row.region_id,
          target,
        )
      )
        throw new ApiError(
          "capacity_exhausted",
          "Current node has insufficient memory, CPU or storage",
        );
      const op = newOperationId();
      const generation = row.generation + 1;
      const result = await c.env.DB.batch([
        databaseResizeStatement(c.env.DB, row, target, now),
        c.env.DB.prepare(
          `INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at)
          SELECT ?,'database.resize','pending',project_id,id,generation,?,? FROM databases
          WHERE changes()=1 AND id=? AND project_id=? AND generation=? AND size_class_id=?`,
        ).bind(op, now, now, id, row.project_id, generation, target.id),
        lease.completeStatement(op, 202, {
          sql: "EXISTS(SELECT 1 FROM operations WHERE id=? AND project_id=?)",
          bindings: [op, row.project_id],
        }),
      ]);
      if (result[0]!.meta.changes !== 1) {
        const current = await databaseForRequest(c, id, true);
        if (
          current.generation !== row.generation ||
          current.desired_state !== row.desired_state ||
          current.size_class_id !== row.size_class_id ||
          current.updated_at !== row.updated_at
        )
          throw new ApiError("conflict", "Database changed; retry the request");
        throw new ApiError(
          "capacity_exhausted",
          "Current node capacity changed; retry the request",
        );
      }
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
          `INSERT INTO operations (id,kind,status,project_id,database_id,generation,created_at,updated_at)
        SELECT ?,'database.delete','pending',project_id,id,generation,?,? FROM databases WHERE changes()=1 AND id=? AND project_id=? AND generation=?`,
        ).bind(op, now, now, id, row.project_id, generation),
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
