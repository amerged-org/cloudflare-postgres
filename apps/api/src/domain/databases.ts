// SPDX-License-Identifier: Apache-2.0
import {
  archiveDestinationPath,
  DatabaseCreate,
  DatabaseListQuery,
  type DatabaseIdleTime,
  type DatabaseResize,
  newDatabaseId,
  newOperationId,
  newRolePassword,
  OWNER_ROLE_NAME,
} from "@pgcf/contracts";
import { ApiError } from "../api-error.ts";
import { admissionScopesOpenSql } from "./admission-state.ts";
import type { ApiContext, Env } from "../env.ts";
import {
  publishForAnswer,
  withAdmissionMutation,
  type AdmissionSqlGuard,
} from "./admission-mutations.ts";
import { assertProjectAccess, getAuth } from "../middleware/auth.ts";
import {
  withIdempotency,
  type IdempotencyLease,
} from "../middleware/idempotency.ts";
import { page } from "../platform/pagination.ts";
import { latestAgentSampleSql } from "./operational-health.ts";
import { keyring } from "../crypto/keyring.ts";
import {
  choosePlacement,
  growthFits,
  nodeLoadGuard,
  placementGuard,
  placementNodes,
} from "./placement.ts";
import { archiveBucket } from "./archive-bucket.ts";
import { runNodeCapacity } from "./node-capacity.ts";
import { stoppedSleeperSql } from "./startup-admission.ts";
import {
  assertResourcesAllowed,
  effectiveResources,
  effectiveResourcesColumnsSql,
  NO_OVERRIDES,
  overridesOfCreate,
  ownResources,
  regionBounds,
  sameOverrides,
  sameResources,
  usageSnapshot,
  type ResourceOverrides,
} from "./resources.ts";
import {
  databaseForRequest,
  databaseView,
  effectiveSleepAfterSql,
  isConstraintError,
  operationForRequest,
  operationsForDatabase,
  operationView,
  type DatabaseRow,
  type RegionRow,
  type SizeRow,
} from "./rows.ts";

import { hintDatabases } from "./node-hints.ts";
export function hint(c: ApiContext, ids: string[]): void {
  // Hints are best effort; the node's own pull of its desired page remains authoritative.
  c.executionCtx.waitUntil(hintDatabases(c.env, ids).catch(() => 0));
}
export async function databaseOperationResponse(
  c: ApiContext,
  operationId: string,
  status = 202,
): Promise<Response> {
  const operation = await operationForRequest(c, operationId);
  const database = await databaseForRequest(c, operation.database_id, true);
  await publishForAnswer(c, database.id);
  c.header("Location", `/v1/operations/${operation.id}`);
  return Response.json(
    { database: databaseView(database), operation: operationView(operation) },
    { status, headers: c.res.headers },
  );
}
export interface DatabaseInsertSnapshot {
  body: DatabaseCreate;
  size: SizeRow;
  /** The database's own resources; omitted takes the size class's. */
  resources?: ResourceOverrides;
  /** The node the database is placed on; null waits for verified regional capacity. */
  nodeId: string | null;
  /** The memory and storage pending on that node when `placementNodes` read it, and the instant of that read. */
  pendingMemoryMib?: number;
  pendingStorageGib?: number;
  decidedAt?: number;
  id: string;
  archivePath: string;
  now: string;
  authority?: { sql: string; bindings: (string | number | null)[] };
}
export function databaseInsertStatement(
  db: D1Database,
  snapshot: DatabaseInsertSnapshot,
): D1PreparedStatement {
  const own = snapshot.resources ?? NO_OVERRIDES,
    ownValues = [own.memory_mib, own.cpu_millicores, own.storage_gib],
    sizeValues = [
      snapshot.size.memory_mib,
      snapshot.size.storage_gib,
      snapshot.size.cpu_millicores,
      snapshot.size.max_connections,
      snapshot.size.sleep_after_seconds,
      snapshot.size.archive_timeout_seconds,
      snapshot.size.backup_retention_days,
    ];
  if (snapshot.nodeId === null) {
    return db
      .prepare(
        `INSERT INTO databases(id,project_id,region_id,node_id,name,size_class_id,sleep_after_seconds,desired_state,generation,archive_path,status_message,created_at,updated_at,own_memory_mib,own_cpu_millicores,own_storage_gib)
      SELECT ?,p.id,r.id,NULL,?,s.id,?,'running',1,?,'Waiting for verified regional capacity',?,?,?,?,?
      FROM projects p JOIN regions r ON r.id=? JOIN size_classes s ON s.id=? AND s.enabled=1
      WHERE p.id=? AND p.deleted_at IS NULL AND s.memory_mib=? AND s.storage_gib=? AND s.cpu_millicores=?
      AND ${admissionScopesOpenSql("p.id", "r.id", "NULL")}
      AND s.max_connections=? AND s.sleep_after_seconds IS ? AND s.archive_timeout_seconds=? AND s.backup_retention_days=?
      AND (${snapshot.authority?.sql ?? "1=1"})`,
      )
      .bind(
        snapshot.id,
        snapshot.body.name,
        snapshot.body.sleep_after_seconds ?? null,
        snapshot.archivePath,
        snapshot.now,
        snapshot.now,
        ...ownValues,
        snapshot.body.region_id,
        snapshot.body.size_class_id,
        snapshot.body.project_id,
        ...sizeValues,
        ...(snapshot.authority?.bindings ?? []),
      );
  }
  const guard = placementGuard("n", {
    nodeId: snapshot.nodeId,
    pendingMemoryMib: snapshot.pendingMemoryMib ?? 0,
    pendingStorageGib: snapshot.pendingStorageGib ?? 0,
    now: snapshot.decidedAt ?? Date.parse(snapshot.now),
  });
  return db
    .prepare(
      `INSERT INTO databases (id,project_id,region_id,node_id,name,size_class_id,sleep_after_seconds,desired_state,generation,archive_path,created_at,updated_at,placed_at,own_memory_mib,own_cpu_millicores,own_storage_gib)
            SELECT ?,p.id,n.region_id,n.id,?,s.id,?,'running',1,?,?,?,?,?,?,? FROM nodes n JOIN projects p ON p.id=? AND p.deleted_at IS NULL
            JOIN size_classes s ON s.id=? AND s.enabled=1 JOIN regions r ON r.id=n.region_id
            WHERE n.region_id=? AND ${guard.sql}
            AND ${admissionScopesOpenSql("p.id", "r.id", "n.id")}
            AND s.memory_mib=? AND s.storage_gib=? AND s.cpu_millicores=? AND s.max_connections=?
            AND s.sleep_after_seconds IS ? AND s.archive_timeout_seconds=? AND s.backup_retention_days=? AND (${snapshot.authority?.sql ?? "1=1"})`,
    )
    .bind(
      snapshot.id,
      snapshot.body.name,
      snapshot.body.sleep_after_seconds ?? null,
      snapshot.archivePath,
      snapshot.now,
      snapshot.now,
      snapshot.now,
      ...ownValues,
      snapshot.body.project_id,
      snapshot.body.size_class_id,
      snapshot.body.region_id,
      ...guard.bindings,
      ...sizeValues,
      ...(snapshot.authority?.bindings ?? []),
    );
}
export async function createDatabase(
  c: ApiContext,
  body: DatabaseCreate,
): Promise<Response> {
  const auth = await assertProjectAccess(c, body.project_id);
  if (body.resources !== undefined && auth.scope !== "admin")
    throw new ApiError(
      "forbidden",
      "Only an admin key sets a database's own resources",
    );
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
      const region = await c.env.DB.prepare("SELECT id FROM regions WHERE id=?")
        .bind(body.region_id)
        .first<RegionRow>();
      if (!project) throw new ApiError("not_found", "Project not found");
      if (!size || !region)
        throw new ApiError(
          "invalid_request",
          "Size class or region unavailable",
        );
      const { bucketName } = archiveBucket(c.env),
        own = overridesOfCreate(body.resources),
        effective = effectiveResources(size, own);
      assertResourcesAllowed(
        effective,
        own,
        await regionBounds(c.env.DB, region.id),
      );
      const id = newDatabaseId(),
        op = newOperationId(),
        now = new Date().toISOString();
      const encrypted = await keyring(c.env.CREDENTIAL_KEYS).encrypt(
        id,
        OWNER_ROLE_NAME,
        newRolePassword(),
      );
      for (let attempt = 0; attempt < 3; attempt++) {
        const decidedAt = Date.now(),
          node =
            attempt === 2
              ? null
              : choosePlacement(
                  await placementNodes(c.env.DB, body.region_id, decidedAt),
                  effective,
                  decidedAt,
                );
        const archive = archiveDestinationPath(
          bucketName,
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
              resources: own,
              nodeId: node?.id ?? null,
              pendingMemoryMib: node?.pending_memory_mib,
              pendingStorageGib: node?.pending_storage_gib,
              decidedAt,
              id,
              archivePath: archive,
              now,
            }),
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
            SELECT id,'created',node_id,size_class_id,generation,?,? FROM databases WHERE id=? AND project_id=? AND node_id IS NOT NULL`,
            ).bind(
              now,
              JSON.stringify(usageSnapshot(effective)),
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
              { reason: "name_in_use" },
            );
          throw error;
        }
        if (result[0]!.meta.changes === 1) {
          if (node !== null) hint(c, [id]);
          else c.executionCtx.waitUntil(runNodeCapacity(c.env, region.id));
          return databaseOperationResponse(c, op);
        }
      }
      throw new ApiError(
        "conflict",
        "Project, region or size class changed; retry the request",
        { reason: "generation_changed" },
      );
    },
  });
}
/** The operations of one database, newest first: the very rows `GET /v1/operations/{id}` reads. */
export async function listDatabaseOperations(
  c: ApiContext,
  id: string,
): Promise<Response> {
  const pagination = page(c);
  const rows = await operationsForDatabase(c, id, pagination);
  const { data, next_cursor } = pagination.envelope(rows);
  return c.json({ data: data.map(operationView), next_cursor });
}
export async function listDatabases(c: ApiContext): Promise<Response> {
  const auth = await getAuth(c),
    query = DatabaseListQuery.parse(c.req.query()),
    pagination = page(c, {
      limit: query.limit,
      cursor: query.cursor,
    });
  const project = query.project_id;
  if (project) await assertProjectAccess(c, project);
  const boundProject = auth.scope === "integrator" ? auth.project_id : project;
  const cursor = pagination.where("d.created_at", "d.id");
  const filters: string[] = [],
    bindings: string[] = [];
  for (const [column, value] of [
    ["d.project_id", boundProject],
    ["d.region_id", query.region_id],
    ["d.node_id", query.node_id],
    ["d.desired_state", query.desired_state],
    ["d.name", query.name],
  ] as const)
    if (value !== undefined && value !== null) {
      filters.push(`${column}=?`);
      bindings.push(value);
    }
  if (query.observed_state !== undefined) {
    // Match databaseView: a current suspended database with no awake Pod is publicly hibernated.
    filters.push(
      "CASE WHEN d.desired_state='suspended' AND d.observed_state='provisioning' AND d.observed_generation=d.generation AND d.observed_power='hibernated' THEN 'hibernated' ELSE d.observed_state END=?",
    );
    bindings.push(query.observed_state);
  }
  const result = await c.env.DB.prepare(
    `SELECT d.*,${latestAgentSampleSql("d")} agent_sample,${effectiveSleepAfterSql("d")} effective_sleep_after_seconds,${effectiveResourcesColumnsSql("d")} FROM databases d JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL WHERE d.deleted_at IS NULL ${filters.map((filter) => `AND ${filter}`).join(" ")} AND ${cursor.sql} ORDER BY d.created_at DESC,d.id DESC LIMIT ?`,
  )
    .bind(...bindings, ...cursor.bindings, pagination.limit + 1)
    .all<DatabaseRow>();
  const now = Date.now();
  return c.json(
    pagination.envelope(result.results.map((row) => databaseView(row, now))),
  );
}

/**
 * What the resize of a database asks of its node, decided from `placementNodes` at `decidedAt`:
 * the memory and storage pending there then, and whether the memory grows (a growing database
 * counts at its full memory until its average catches up).
 */
export interface ResizeCapacity {
  pendingMemoryMib: number;
  pendingStorageGib: number;
  decidedAt: number;
  grows: boolean;
}
export function databaseResizeStatement(
  db: D1Database,
  row: DatabaseRow,
  size: SizeRow,
  now: string,
  authority?: DatabaseInsertSnapshot["authority"],
  admission?: AdmissionSqlGuard,
  /** The database's own resources after the resize; omitted keeps its present ones. */
  resources: ResourceOverrides = ownResources(row),
  capacity?: ResizeCapacity,
): D1PreparedStatement {
  const current = ownResources(row),
    own = [
      resources.memory_mib,
      resources.cpu_millicores,
      resources.storage_gib,
    ],
    wasOwn = [current.memory_mib, current.cpu_millicores, current.storage_gib],
    ownSet =
      "size_class_id=?,own_memory_mib=?,own_cpu_millicores=?,own_storage_gib=?",
    ownRead =
      "own_memory_mib IS ? AND own_cpu_millicores IS ? AND own_storage_gib IS ?",
    classRead = `s.memory_mib=? AND s.cpu_millicores=? AND s.storage_gib=? AND s.max_connections=?
      AND s.sleep_after_seconds IS ? AND s.archive_timeout_seconds=? AND s.backup_retention_days=?`,
    classValues = [
      size.memory_mib,
      size.cpu_millicores,
      size.storage_gib,
      size.max_connections,
      size.sleep_after_seconds,
      size.archive_timeout_seconds,
      size.backup_retention_days,
    ];
  const guard =
    capacity === undefined
      ? null
      : nodeLoadGuard("n", {
          pendingMemoryMib: capacity.pendingMemoryMib,
          pendingStorageGib: capacity.pendingStorageGib,
          now: capacity.decidedAt,
        });
  if (row.desired_state === "suspended")
    return db
      .prepare(
        `UPDATE databases SET ${ownSet},generation=generation+1,observed_generation=generation+1,observed_state='provisioning',status_message=NULL,updated_at=?
       WHERE (id=? AND project_id=? AND generation=? AND size_class_id=? AND updated_at=? AND node_id IS ?
         AND ${ownRead}
         AND desired_state='suspended' AND observed_state='provisioning' AND observed_generation=generation
         AND observed_power='hibernated' AND power_operation IS ? AND suspension_reason IS ? AND deleted_at IS NULL)
         AND EXISTS(SELECT 1 FROM projects WHERE id=databases.project_id AND deleted_at IS NULL)
         AND ${stoppedSleeperSql("databases", false)}
         AND EXISTS(SELECT 1 FROM size_classes s WHERE s.id=? AND s.enabled=1
           AND ${classRead})
         ${guard === null ? "" : `AND EXISTS(SELECT 1 FROM nodes n WHERE n.id=databases.node_id AND n.region_id=databases.region_id AND ${guard.sql})`}
         AND (${authority?.sql ?? "1=1"}) AND (${admission?.sql ?? "1=1"})`,
      )
      .bind(
        size.id,
        ...own,
        now,
        row.id,
        row.project_id,
        row.generation,
        row.size_class_id,
        row.updated_at,
        row.node_id,
        ...wasOwn,
        row.power_operation ?? null,
        row.suspension_reason ?? null,
        size.id,
        ...classValues,
        ...(guard?.bindings ?? []),
        ...(authority?.bindings ?? []),
        ...(admission?.bindings ?? []),
      );
  return db
    .prepare(
      `UPDATE databases SET ${ownSet},placed_at=CASE WHEN ?=1 THEN ? ELSE placed_at END,generation=generation+1,observed_state='provisioning',status_message=NULL,updated_at=?
    WHERE ((id=? AND project_id=? AND node_id IS ? AND generation=? AND size_class_id=? AND updated_at=? AND ${ownRead})
      AND (desired_state='running' AND observed_state='ready' AND observed_generation=generation AND deleted_at IS NULL))
      AND EXISTS(SELECT 1 FROM projects p WHERE p.id=databases.project_id AND p.deleted_at IS NULL)
      AND EXISTS(SELECT 1 FROM nodes n JOIN size_classes s ON s.id=? AND s.enabled=1
        WHERE n.id=databases.node_id AND n.region_id=databases.region_id
          ${guard === null ? "" : `AND ${guard.sql}`}
          AND ${classRead})
      AND (${authority?.sql ?? "1=1"}) AND (${admission?.sql ?? "1=1"})`,
    )
    .bind(
      size.id,
      ...own,
      Number(capacity?.grows ?? false),
      now,
      now,
      row.id,
      row.project_id,
      row.node_id,
      row.generation,
      row.size_class_id,
      row.updated_at,
      ...wasOwn,
      size.id,
      ...(guard?.bindings ?? []),
      ...classValues,
      ...(authority?.bindings ?? []),
      ...(admission?.bindings ?? []),
    );
}

/**
 * The API and central profile rollout share the same atomic resize. `own` is the database's own
 * resources after it; omitted keeps its present ones. A change that leaves the effective resources
 * as they are only stores them.
 */
export async function scheduleDatabaseResize(
  env: Env,
  row: DatabaseRow,
  targetId: string,
  now: string,
  lease?: IdempotencyLease,
  authority?: DatabaseInsertSnapshot["authority"],
  own?: ResourceOverrides,
): Promise<string> {
  const db = env.DB;
  if (
    row.deleted_at !== null ||
    !["running", "suspended"].includes(row.desired_state)
  )
    throw new ApiError("conflict", "Database is deleted", {
      reason: "database_deleted",
    });
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
  const current = ownResources(row),
    resources = own ?? current,
    before = effectiveResources(previous, current),
    after = effectiveResources(target, resources);
  assertResourcesAllowed(
    after,
    resources,
    await regionBounds(db, row.region_id),
  );
  if (after.storage_gib < before.storage_gib)
    throw new ApiError("invalid_request", "Storage shrink is not supported");
  const sleeping = row.desired_state === "suspended";
  const op = newOperationId();
  if (target.id === previous.id && sameResources(before, after)) {
    // The database keeps what it runs with; its own values are only recorded.
    if (!sameOverrides(current, resources)) {
      const stored = await db
        .prepare(
          `UPDATE databases SET own_memory_mib=?,own_cpu_millicores=?,own_storage_gib=?
         WHERE id=? AND project_id=? AND generation=? AND size_class_id=? AND updated_at=? AND deleted_at IS NULL
           AND own_memory_mib IS ? AND own_cpu_millicores IS ? AND own_storage_gib IS ?`,
        )
        .bind(
          resources.memory_mib,
          resources.cpu_millicores,
          resources.storage_gib,
          row.id,
          row.project_id,
          row.generation,
          row.size_class_id,
          row.updated_at,
          current.memory_mib,
          current.cpu_millicores,
          current.storage_gib,
        )
        .run();
      if (stored.meta.changes !== 1)
        throw new ApiError("conflict", "Database changed; retry the request", {
          reason: "generation_changed",
        });
    }
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
      throw new ApiError("conflict", "Database changed; retry the request", {
        reason: "generation_changed",
      });
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
    throw new ApiError("conflict", "Database configuration is not ready", {
      reason: "not_ready",
    });
  let capacity: ResizeCapacity | undefined;
  // A sleeping database takes its memory and CPU at its next wake, where its node admits them;
  // its storage is sold from now on, so it counts against the logical cap like an awake one's.
  const growth = {
    memory_mib: sleeping
      ? 0
      : Math.max(0, after.memory_mib - before.memory_mib),
    storage_gib: Math.max(0, after.storage_gib - before.storage_gib),
    cpu_millicores: sleeping ? 0 : after.cpu_millicores,
  };
  if (!sleeping || growth.storage_gib > 0) {
    const decidedAt = Date.parse(now),
      node = (await placementNodes(db, row.region_id, decidedAt)).find(
        (value) => value.id === row.node_id,
      );
    if (!node || !growthFits(node, growth, decidedAt))
      throw new ApiError(
        "capacity_exhausted",
        "Current node has insufficient memory, CPU or storage",
        { reason: "node_capacity" },
      );
    // Growth is written only while the node still reports and nothing else was placed on it.
    if (growth.memory_mib > 0 || growth.storage_gib > 0)
      capacity = {
        pendingMemoryMib: node.pending_memory_mib,
        pendingStorageGib: node.pending_storage_gib,
        decidedAt,
        grows: growth.memory_mib > 0,
      };
  }
  return withAdmissionMutation(env, [row.id], async (mutation) => {
    const guard = mutation.guard(row.id),
      generation = row.generation + 1;
    const statements = [
      databaseResizeStatement(
        db,
        row,
        target,
        now,
        authority,
        guard,
        resources,
        capacity,
      ),
      db
        .prepare(
          `INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at)
       SELECT ?,'database.resize','pending',project_id,id,generation,?,? FROM databases
       WHERE changes()=1 AND id=? AND project_id=? AND generation=? AND size_class_id=? AND (${guard.sql})`,
        )
        .bind(
          op,
          now,
          now,
          row.id,
          row.project_id,
          generation,
          target.id,
          ...guard.bindings,
        ),
    ];
    statements.push(
      db
        .prepare(
          `UPDATE operations SET status='failed',error_code='superseded',error_message='Resource configuration superseded',updated_at=?,completed_at=?
     WHERE database_id=? AND project_id=? AND kind='database.resize' AND generation<? AND status IN('pending','running')
       AND EXISTS(SELECT 1 FROM databases d JOIN operations current ON current.database_id=d.id AND current.project_id=d.project_id
         WHERE d.id=operations.database_id AND d.generation=? AND d.size_class_id=? AND d.updated_at=?
           AND current.id=? AND current.generation=d.generation AND current.kind='database.resize') AND (${guard.sql})`,
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
          ...guard.bindings,
        ),
    );
    if (lease)
      statements.push(
        lease.completeStatement(op, 202, {
          sql: `EXISTS(SELECT 1 FROM operations WHERE id=? AND project_id=?) AND (${guard.sql})`,
          bindings: [op, row.project_id, ...guard.bindings],
        }),
      );
    const result = await mutation.batch(statements);
    if (result[0]!.meta.changes !== 1) {
      const changed = await db
        .prepare("SELECT * FROM databases WHERE id=?")
        .bind(row.id)
        .first<DatabaseRow>();
      if (
        !changed ||
        changed.generation !== row.generation ||
        changed.desired_state !== row.desired_state ||
        changed.size_class_id !== row.size_class_id ||
        changed.updated_at !== row.updated_at ||
        !sameOverrides(ownResources(changed), current) ||
        (sleeping && capacity === undefined)
      )
        throw new ApiError("conflict", "Database changed; retry the request", {
          reason: "generation_changed",
        });
      throw new ApiError(
        "capacity_exhausted",
        "Current node capacity changed; retry the request",
        { reason: "node_capacity" },
      );
    }
    return op;
  });
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
        throw new ApiError("conflict", "Database generation changed", {
          reason: "generation_changed",
        });
      const op = await scheduleDatabaseResize(
        c.env,
        row,
        body.size_class_id,
        new Date().toISOString(),
        lease,
      );
      hint(c, [id]);
      return databaseOperationResponse(c, op);
    },
  });
}

/**
 * Each idle check reads the idle time from the row, so setting it is a single write in any state
 * but deleted: no generation, no operation, and updated_at stays as the resize CAS read it. The
 * write and its Idempotency-Key completion commit in one batch, so a key never stands for a value
 * that was not stored.
 */
export async function setDatabaseIdleTime(
  c: ApiContext,
  id: string,
  body: DatabaseIdleTime,
): Promise<Response> {
  const row = await databaseForRequest(c, id, true);
  const view = async () =>
    c.json(databaseView(await databaseForRequest(c, id, true)), 200);
  return withIdempotency(c, {
    replay: view,
    execute: async (lease) => {
      const live = "deleted_at IS NULL AND desired_state<>'deleted'";
      const deleted = () =>
        new ApiError("conflict", "Database is deleted", {
          reason: "database_deleted",
        });
      if (row.desired_state === "deleted" || row.deleted_at !== null)
        throw deleted();
      const [write] = await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE databases SET sleep_after_seconds=? WHERE id=? AND project_id=? AND ${live}
           AND EXISTS(SELECT 1 FROM projects p WHERE p.id=databases.project_id AND p.deleted_at IS NULL)`,
        ).bind(body.sleep_after_seconds, id, row.project_id),
        lease.completeStatement(id, 200, {
          sql: `EXISTS(SELECT 1 FROM databases WHERE id=? AND sleep_after_seconds IS ? AND ${live})`,
          bindings: [id, body.sleep_after_seconds],
        }),
      ]);
      if (write!.meta.changes !== 1) throw deleted();
      return view();
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
          throw new ApiError("conflict", "Deletion operation is unavailable", {
            reason: "database_deleted",
          });
        await lease.completeStatement(existing.id, 202).run();
        return databaseOperationResponse(c, existing.id);
      }
      const op = newOperationId(),
        now = new Date().toISOString();
      let generation = row.generation + 1;
      const result = await withAdmissionMutation(
        c.env,
        [id],
        async (mutation) => {
          // Every writer of the generation holds this fence, so the generation read here is the
          // one the batch finds; a change that committed after the request's first read is not a
          // conflict.
          const current = await c.env.DB.prepare(
            "SELECT generation FROM databases WHERE id=? AND project_id=?",
          )
            .bind(id, row.project_id)
            .first<{ generation: number }>();
          generation = (current?.generation ?? row.generation) + 1;
          const guard = mutation.guard(id);
          return mutation.batch([
            c.env.DB.prepare(
              `UPDATE databases SET desired_state='deleted',generation=generation+1,deleted_at=?,updated_at=?
        WHERE id=? AND project_id=? AND generation=? AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM projects WHERE id=databases.project_id AND deleted_at IS NULL) AND (${guard.sql})`,
            ).bind(
              now,
              now,
              id,
              row.project_id,
              generation - 1,
              ...guard.bindings,
            ),
            c.env.DB.prepare(
              `INSERT INTO retained_archives(source_database_id,project_id,region_id,archive_path,storage_generation,roles_json,deleted_at,expires_at)
          SELECT d.id,d.project_id,d.region_id,d.archive_path,d.storage_generation,
          (SELECT json_group_array(json_object('database_id',r.database_id,'name',r.name,'owner',r.owner,'password_ciphertext',r.password_ciphertext,'password_iv',r.password_iv,'password_kid',r.password_kid,'password_revision',r.password_revision,'updated_at',r.updated_at,'valid_until',r.valid_until,'connection_limit',r.connection_limit,'member_of',json(r.member_of_json),'bypass_rls',r.bypass_rls)) FROM roles r WHERE r.database_id=d.id AND r.deleted_at IS NULL),
          d.deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ',d.deleted_at,'+'||s.backup_retention_days||' days')
          FROM databases d JOIN size_classes s ON s.id=d.size_class_id WHERE changes()=1 AND d.id=? AND d.project_id=? AND d.generation=? AND d.deleted_at=? AND (${guard.sql})`,
            ).bind(id, row.project_id, generation, now, ...guard.bindings),
            c.env.DB.prepare(
              `INSERT INTO operations (id,kind,status,project_id,database_id,generation,created_at,updated_at)
        SELECT ?,'database.delete','pending',project_id,id,generation,?,? FROM databases WHERE changes()=1 AND id=? AND project_id=? AND generation=? AND (${guard.sql})`,
            ).bind(
              op,
              now,
              now,
              id,
              row.project_id,
              generation,
              ...guard.bindings,
            ),
            c.env.DB.prepare(
              `UPDATE operations SET status='failed',error_code='superseded',error_message='Power intent superseded by deletion',updated_at=?,completed_at=? WHERE database_id=? AND generation<? AND kind IN('database.suspend','database.resume','database.hibernate','database.wake') AND status IN('pending','running') AND EXISTS(SELECT 1 FROM operations WHERE id=? AND database_id=? AND generation=? AND kind='database.delete') AND (${guard.sql})`,
            ).bind(
              now,
              now,
              id,
              generation,
              op,
              id,
              generation,
              ...guard.bindings,
            ),
            c.env.DB.prepare(
              `UPDATE role_deletions SET status='failed',error_code='superseded',error_message='Database deleted before the role removal completed',updated_at=?,completed_at=? WHERE database_id=? AND status IN('pending','running') AND EXISTS(SELECT 1 FROM operations WHERE id=? AND database_id=? AND generation=? AND kind='database.delete') AND (${guard.sql})`,
            ).bind(now, now, id, op, id, generation, ...guard.bindings),
            c.env.DB.prepare(
              `UPDATE databases SET observed_state='deleted',observed_generation=generation,status_message=NULL
          WHERE id=? AND project_id=? AND generation=? AND desired_state='deleted' AND node_id IS NULL
          AND EXISTS(SELECT 1 FROM operations WHERE id=? AND database_id=databases.id AND kind='database.delete') AND (${guard.sql})`,
            ).bind(id, row.project_id, generation, op, ...guard.bindings),
            c.env.DB.prepare(
              `UPDATE operations SET status='succeeded',completed_at=?,updated_at=? WHERE id=? AND kind='database.delete'
          AND EXISTS(SELECT 1 FROM databases d WHERE d.id=operations.database_id AND d.node_id IS NULL AND d.observed_state='deleted' AND d.observed_generation=operations.generation) AND (${guard.sql})`,
            ).bind(now, now, op, ...guard.bindings),
            c.env.DB.prepare(
              `UPDATE operations SET status='failed',completed_at=?,updated_at=?,error_code='superseded',error_message='Unplaced creation cancelled by deletion'
          WHERE database_id=? AND kind='database.create' AND status='pending' AND EXISTS(SELECT 1 FROM databases d WHERE d.id=operations.database_id AND d.node_id IS NULL AND d.observed_state='deleted') AND (${guard.sql})`,
            ).bind(now, now, id, ...guard.bindings),
            lease.completeStatement(op, 202, {
              sql: `EXISTS(SELECT 1 FROM operations WHERE id=? AND project_id=?) AND (${guard.sql})`,
              bindings: [op, row.project_id, ...guard.bindings],
            }),
          ]);
        },
      );
      if (result[0]!.meta.changes !== 1)
        throw new ApiError("conflict", "Database changed; retry the request", {
          reason: "generation_changed",
        });
      hint(c, [id]);
      return databaseOperationResponse(c, op);
    },
  });
}
