// SPDX-License-Identifier: Apache-2.0
import { SIDECAR } from "@pgcf/contracts";

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
