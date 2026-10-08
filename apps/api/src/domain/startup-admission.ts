// SPDX-License-Identifier: Apache-2.0
import {
  DatabaseId,
  NodeId,
  OperationId,
  SIDECAR,
  Timestamp,
} from "@pgcf/contracts";

const maximumInteger = Number.MAX_SAFE_INTEGER;
const mib = 1024 * 1024;
const identifier = (value: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(value))
    throw new Error("invalid_startup_sql_alias");
  return value;
};
const policyMode = (region: string) =>
  `COALESCE((SELECT placement_mode FROM node_region_policies WHERE region_id=${region}),'reserved')`;

/** A configured scheduling share consumes CPU until the owned runtime is confirmed stopped. */
export function databaseCpuChargeSql(
  databaseAlias = "d",
  sizeAlias = "s",
  acceptingStopInCurrentBatch = false,
): string {
  const database = identifier(databaseAlias),
    size = identifier(sizeAlias);
  // The observation batch records its lifecycle fact before completing this exact owned stop.
  // Both commit together; ordinary admission always requires the completed operation.
  const completed =
    "cold_operation.status='succeeded' AND cold_operation.completed_at IS NOT NULL";
  const stopStatus = acceptingStopInCurrentBatch
    ? `(cold_operation.status IN('pending','running') OR (${completed}))`
    : `(${completed})`;
  return `(CASE WHEN ${database}.desired_state='suspended'
    AND ${database}.observed_state='provisioning' AND ${database}.observed_power='hibernated'
    AND ${database}.observed_generation=${database}.generation AND ${database}.deleted_at IS NULL
    AND EXISTS(SELECT 1 FROM operations cold_operation WHERE cold_operation.id=${database}.power_operation
      AND cold_operation.database_id=${database}.id AND cold_operation.project_id=${database}.project_id
      AND cold_operation.generation<=${database}.generation AND ${stopStatus}
      AND ((${database}.suspension_reason='manual' AND cold_operation.kind='database.suspend')
        OR (${database}.suspension_reason='idle' AND cold_operation.kind='database.hibernate')))
    THEN 0 ELSE COALESCE(${size}.cpu_request_millicores,${size}.cpu_millicores)+${SIDECAR.requestCpuMillicores} END)`;
}

/** Every start competes in the same atomic SQL budget, including waking an existing database. */
export function nodeCpuHeadroomSql(
  nodeAlias = "n",
  sizeAlias = "s",
  excludeDatabaseAlias?: string,
): string {
  const node = identifier(nodeAlias),
    size = identifier(sizeAlias),
    excluded =
      excludeDatabaseAlias === undefined
        ? ""
        : `AND cpu_database.id<>${identifier(excludeDatabaseAlias)}.id`,
    target = `COALESCE(${size}.cpu_request_millicores,${size}.cpu_millicores)`;
  return `(${node}.ready=1 AND ${node}.schedulable=1 AND ${node}.lost_at IS NULL AND ${node}.node_uid IS NOT NULL
    AND julianday(${node}.last_observed_at)>=julianday('now','-180 seconds')
    AND julianday(${node}.last_observed_at)<=julianday('now','+5 seconds')
    AND typeof(${node}.allocatable_cpu_millicores)='integer' AND ${node}.allocatable_cpu_millicores BETWEEN 1 AND ${maximumInteger}
    AND typeof(${node}.platform_reserved_cpu_millicores)='integer'
    AND ${node}.platform_reserved_cpu_millicores BETWEEN 0 AND ${node}.allocatable_cpu_millicores
    AND typeof(${target})='integer' AND ${target} BETWEEN 1 AND ${size}.cpu_millicores
    AND ${node}.allocatable_cpu_millicores-${node}.platform_reserved_cpu_millicores
      -COALESCE((SELECT SUM(${databaseCpuChargeSql("cpu_database", "cpu_size")})
        FROM databases cpu_database JOIN size_classes cpu_size ON cpu_size.id=cpu_database.size_class_id
        WHERE cpu_database.node_id=${node}.id AND cpu_database.observed_state<>'deleted' ${excluded}),0)
      >=${target}+${SIDECAR.requestCpuMillicores})`;
}

/** A single startup must fit the permanent physical/allocatable budget even with no concurrent holds. */
export function startupPhysicalFitSql(
  nodeAlias = "n",
  sizeAlias = "s",
): string {
  const node = identifier(nodeAlias),
    size = identifier(sizeAlias),
    maximumMib = Math.floor(maximumInteger / mib),
    peak = `(${size}.memory_mib+${SIDECAR.limitMemoryMib})*${mib}`;
  return `(${policyMode(`${node}.region_id`)}='reserved' OR (
    ${node}.node_uid IS NOT NULL
    AND typeof(${node}.allocatable_memory_mib)='integer'
    AND ${node}.allocatable_memory_mib BETWEEN 1 AND ${maximumMib}
    AND typeof(${node}.platform_reserved_memory_mib)='integer'
    AND ${node}.platform_reserved_memory_mib BETWEEN 0 AND ${node}.allocatable_memory_mib
    AND typeof(${size}.memory_mib)='integer'
    AND ${size}.memory_mib BETWEEN 1 AND ${maximumMib - SIDECAR.limitMemoryMib}
    AND EXISTS(SELECT 1 FROM node_memory_samples physical WHERE physical.node_id=${node}.id AND physical.node_uid=${node}.node_uid
      AND physical.observed_at=(SELECT MAX(latest.observed_at) FROM node_memory_samples latest WHERE latest.node_id=${node}.id AND latest.node_uid=${node}.node_uid)
      AND typeof(physical.capacity_memory_bytes)='integer' AND physical.capacity_memory_bytes BETWEEN 1 AND ${maximumInteger}
      AND MIN(physical.capacity_memory_bytes,${node}.allocatable_memory_mib*${mib})-${node}.platform_reserved_memory_mib*${mib}>=${peak})
  ))`;
}

/** Full bounded startup peak; permanent placement reservations do not substitute for fresh RAM. */
export function startupHeadroomSql(nodeAlias = "n", sizeAlias = "s"): string {
  const node = identifier(nodeAlias),
    size = identifier(sizeAlias);
  const peak = `(${size}.memory_mib+${SIDECAR.limitMemoryMib})*${mib}`;
  return `(${policyMode(`${node}.region_id`)}='reserved' OR (
    ${node}.ready=1 AND ${node}.schedulable=1 AND ${node}.lost_at IS NULL AND ${node}.node_uid IS NOT NULL
    AND ${startupPhysicalFitSql(node, size)}
    AND EXISTS(SELECT 1 FROM node_region_policies p WHERE p.region_id=${node}.region_id AND p.placement_mode='actual_ram'
      AND ${size}.memory_mib BETWEEN 256 AND p.maximum_database_memory_mib AND ${size}.memory_mib%256=0
      AND p.postgres_memory_request_mib>0 AND p.postgres_memory_request_mib<=${size}.memory_mib)
    AND EXISTS(SELECT 1 FROM node_memory_samples m WHERE m.node_id=${node}.id AND m.node_uid=${node}.node_uid
      AND m.observed_at=(SELECT MAX(latest.observed_at) FROM node_memory_samples latest WHERE latest.node_id=${node}.id AND latest.node_uid=${node}.node_uid)
      AND julianday(m.observed_at)>=julianday('now','-90 seconds') AND julianday(m.observed_at)<=julianday('now','+5 seconds')
      AND m.memory_pressure=0 AND m.capacity_memory_bytes BETWEEN 1 AND ${maximumInteger}
      AND m.available_bytes BETWEEN 0 AND m.capacity_memory_bytes
      AND m.available_bytes>=${peak}+COALESCE((SELECT SUM(a.budget_bytes) FROM database_start_admissions a WHERE a.node_id=${node}.id AND a.node_uid=${node}.node_uid),0))
  ))`;
}

export function databaseStartupHeadroomSql(
  databaseAlias = "databases",
): string {
  const database = identifier(databaseAlias);
  return `EXISTS(
    SELECT 1 FROM nodes n JOIN size_classes s ON s.id=${database}.size_class_id
    WHERE n.id=${database}.node_id AND n.region_id=${database}.region_id
      AND ${nodeCpuHeadroomSql("n", "s", database)} AND ${startupHeadroomSql()})`;
}

/** Append after the admitted database mutation and its operation INSERT in the same D1 batch.
 * The first mutation checked headroom. Rechecking a clock-sensitive guard here could lose the
 * hold at a freshness boundary after admitting the intent, so this captures that atomic grant. */
export function startupReservationStatement(
  db: D1Database,
  input: {
    databaseId: string;
    operationId: string;
    generation: number;
    nodeId: string;
    now: string;
  },
): D1PreparedStatement {
  DatabaseId.parse(input.databaseId);
  OperationId.parse(input.operationId);
  NodeId.parse(input.nodeId);
  Timestamp.parse(input.now);
  if (!Number.isSafeInteger(input.generation) || input.generation < 1)
    throw new Error("invalid_startup_generation");
  return db
    .prepare(
      `INSERT INTO database_start_admissions(operation_id,database_id,generation,node_id,node_uid,budget_bytes,granted_at,grant_sample_observed_at)
     SELECT o.id,d.id,d.generation,n.id,n.node_uid,(s.memory_mib+?)*${mib},?,
       (SELECT MAX(m.observed_at) FROM node_memory_samples m WHERE m.node_id=n.id AND m.node_uid=n.node_uid)
     FROM databases d JOIN operations o ON o.database_id=d.id AND o.project_id=d.project_id
       AND o.kind IN('database.create','database.restore','database.wake','database.resume','database.resize') AND o.generation<=d.generation
     JOIN nodes n ON n.id=d.node_id AND n.region_id=d.region_id JOIN size_classes s ON s.id=d.size_class_id
     JOIN node_region_policies p ON p.region_id=d.region_id AND p.placement_mode='actual_ram'
     WHERE d.id=? AND o.id=? AND d.generation=? AND n.id=? AND d.updated_at=? AND d.desired_state='running' AND d.deleted_at IS NULL
       AND n.node_uid IS NOT NULL
       AND (o.kind IN('database.create','database.restore') OR d.power_operation=o.id OR (o.kind='database.resize' AND o.generation=d.generation))
     ON CONFLICT(operation_id) DO NOTHING`,
    )
    .bind(
      SIDECAR.limitMemoryMib,
      input.now,
      input.databaseId,
      input.operationId,
      input.generation,
      input.nodeId,
      input.now,
    );
}

/** Only an accepted actual-ready observation for the owned operation may mark its grant. */
export function recordStartupReadyStatement(
  db: D1Database,
  input: { databaseId: string; generation: number; readyAt: string },
): D1PreparedStatement {
  return recordStartupObservationStatement(db, {
    databaseId: input.databaseId,
    generation: input.generation,
    observedAt: input.readyAt,
    state: "ready",
  });
}

/** Record only an accepted ready or confirmed stopped runtime, never an operation timeout. */
export function recordStartupObservationStatement(
  db: D1Database,
  input: {
    databaseId: string;
    generation: number;
    observedAt: string;
    state: "ready" | "hibernated" | "deleted";
  },
): D1PreparedStatement {
  DatabaseId.parse(input.databaseId);
  Timestamp.parse(input.observedAt);
  if (!Number.isSafeInteger(input.generation) || input.generation < 1)
    throw new Error("invalid_startup_generation");
  return db
    .prepare(
      `UPDATE database_start_admissions AS a SET ready_at=?,ready_sample_observed_at=COALESCE(
       (SELECT MAX(m.observed_at) FROM node_memory_samples m WHERE m.node_id=a.node_id AND m.node_uid=a.node_uid),a.grant_sample_observed_at)
     WHERE a.database_id=? AND a.generation<=? AND a.ready_at IS NULL
       AND EXISTS(SELECT 1 FROM databases d JOIN nodes n ON n.id=d.node_id AND n.region_id=d.region_id
         JOIN operations o ON o.id=a.operation_id AND o.database_id=d.id AND o.project_id=d.project_id AND o.generation<=d.generation
         WHERE d.id=a.database_id AND d.node_id=a.node_id AND n.node_uid=a.node_uid AND n.lost_at IS NULL
           AND d.generation=? AND d.observed_generation=d.generation AND d.updated_at=?
           AND ((?='ready' AND d.desired_state='running' AND d.observed_state='ready' AND d.observed_power='awake' AND d.deleted_at IS NULL
             AND (d.power_operation=a.operation_id OR substr(d.archive_path,-23)=a.operation_id OR (o.kind='database.resize' AND o.generation=a.generation)))
             OR (?='hibernated' AND d.desired_state='suspended' AND d.observed_power='hibernated'
               AND EXISTS(SELECT 1 FROM operations stopped WHERE stopped.id=d.power_operation AND stopped.database_id=d.id AND stopped.kind IN('database.suspend','database.hibernate') AND stopped.generation<=d.generation))
             OR (?='deleted' AND d.desired_state='deleted' AND d.observed_state='deleted' AND d.deleted_at IS NOT NULL)))`,
    )
    .bind(
      input.observedAt,
      input.databaseId,
      input.generation,
      input.generation,
      input.observedAt,
      input.state,
      input.state,
      input.state,
    );
}

/** A later current-UID physical sample covers the acknowledged runtime before releasing peak RAM.
 * The five-second margin prevents an allowed future-skew sample from predating readiness. */
export function releaseCoveredStartupReservationsStatement(
  db: D1Database,
  input: { nodeId: string; nodeUid: string },
): D1PreparedStatement {
  NodeId.parse(input.nodeId);
  if (!input.nodeUid) throw new Error("invalid_startup_node_uid");
  return db
    .prepare(
      `DELETE FROM database_start_admissions AS a WHERE a.node_id=? AND a.node_uid=? AND a.ready_at IS NOT NULL
       AND EXISTS(SELECT 1 FROM nodes n JOIN node_memory_samples m ON m.node_id=n.id AND m.node_uid=n.node_uid
         WHERE n.id=a.node_id AND n.node_uid=a.node_uid AND n.lost_at IS NULL
           AND m.observed_at=(SELECT MAX(latest.observed_at) FROM node_memory_samples latest WHERE latest.node_id=n.id AND latest.node_uid=n.node_uid)
           AND julianday(m.observed_at)>julianday(a.ready_at,'+5 seconds')
           AND m.observed_at>a.ready_sample_observed_at AND m.observed_at>a.grant_sample_observed_at
           AND julianday(m.observed_at)>=julianday('now','-90 seconds') AND julianday(m.observed_at)<=julianday('now','+5 seconds')
           AND m.capacity_memory_bytes BETWEEN 1 AND ${maximumInteger} AND m.available_bytes BETWEEN 0 AND m.capacity_memory_bytes
           AND m.working_set_bytes BETWEEN 0 AND m.capacity_memory_bytes AND m.memory_pressure IN(0,1))`,
    )
    .bind(input.nodeId, input.nodeUid);
}
