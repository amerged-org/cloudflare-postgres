// SPDX-License-Identifier: Apache-2.0
import { DatabaseId, NodeId, SIDECAR, Timestamp } from "@pgcf/contracts";

import { coveredStorageHoldSql } from "./storage-capacity.ts";
const maximumInteger = Number.MAX_SAFE_INTEGER;
const identifier = (value: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(value))
    throw new Error("invalid_startup_sql_alias");
  return value;
};

/** A database whose owned runtime stop is confirmed: the one predicate behind every "cold" decision. */
export function stoppedSleeperSql(
  database: string,
  acceptingStopInCurrentBatch: boolean,
): string {
  // The observation batch records its lifecycle fact before completing this exact owned stop.
  // Both commit together; ordinary admission always requires the completed operation.
  const completed =
    "cold_operation.status='succeeded' AND cold_operation.completed_at IS NOT NULL";
  const stopStatus = acceptingStopInCurrentBatch
    ? `(cold_operation.status IN('pending','running') OR (${completed}))`
    : `(${completed})`;
  return `${database}.desired_state='suspended'
    AND ${database}.observed_state='provisioning' AND ${database}.observed_power='hibernated'
    AND ${database}.observed_generation=${database}.generation AND ${database}.deleted_at IS NULL
    AND EXISTS(SELECT 1 FROM operations cold_operation WHERE cold_operation.id=${database}.power_operation
      AND cold_operation.database_id=${database}.id AND cold_operation.project_id=${database}.project_id
      AND cold_operation.generation<=${database}.generation AND ${stopStatus}
      AND ((${database}.suspension_reason='manual' AND cold_operation.kind='database.suspend')
        OR (${database}.suspension_reason='idle' AND cold_operation.kind='database.hibernate')))
`;
}

/** A configured scheduling share consumes CPU until the owned runtime is confirmed stopped. */
export function databaseCpuChargeSql(
  databaseAlias = "d",
  sizeAlias = "s",
  acceptingStopInCurrentBatch = false,
): string {
  const database = identifier(databaseAlias),
    size = identifier(sizeAlias);
  const sleeping = stoppedSleeperSql(database, acceptingStopInCurrentBatch);
  return `(CASE WHEN (${sleeping}) THEN 0
    ELSE COALESCE(${size}.cpu_request_millicores,${size}.cpu_millicores)+${SIDECAR.requestCpuMillicores} END)`;
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

/**
 * The attestation of an accepted ready report stays with the newest thin start of the database:
 * the writer that hold backs keeps its token (`heldWriterPod`) when a later ready report of the
 * controller carries no attestation and so clears `databases.runtime_attestation_json`. Run after
 * the report's own update in the same batch; a report without an attestation changes nothing.
 */
export function rememberStartAttestationStatement(
  db: D1Database,
  input: { databaseId: string; generation: number; observedAt: string },
): D1PreparedStatement {
  DatabaseId.parse(input.databaseId);
  Timestamp.parse(input.observedAt);
  if (!Number.isSafeInteger(input.generation) || input.generation < 1)
    throw new Error("invalid_startup_generation");
  return db
    .prepare(
      `UPDATE database_start_admissions AS a SET attested_json=(SELECT d.runtime_attestation_json FROM databases d WHERE d.id=a.database_id)
     WHERE a.database_id=? AND a.budget_bytes>0 AND a.storage_budget_bytes>0
       AND a.generation=(SELECT MAX(h.generation) FROM database_start_admissions h WHERE h.database_id=a.database_id AND h.budget_bytes>0 AND h.storage_budget_bytes>0)
       AND EXISTS(SELECT 1 FROM databases d WHERE d.id=a.database_id AND d.runtime_attestation_json IS NOT NULL
         AND d.desired_state='running' AND d.observed_state='ready' AND d.observed_generation=? AND d.updated_at=? AND d.generation>=a.generation)`,
    )
    .bind(input.databaseId, input.generation, input.observedAt);
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
       AND ${coveredStorageHoldSql()}
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
