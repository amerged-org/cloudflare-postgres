// SPDX-License-Identifier: Apache-2.0
// The regional RAM window and the expansion predicate over `node_memory_samples`.

function regionSqlExpression(value: string): string {
  if (value !== "?" && !/^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?$/.test(value))
    throw new Error("invalid_regional_memory_sql_expression");
  return value;
}

/** Exact physical-byte regional window. An incomplete/new/replaced member makes the window unknown. */
export function regionalRamWindowSql(regionExpression: string): string {
  const region = regionSqlExpression(regionExpression);
  return `WITH members AS (
    SELECT id,node_uid,last_observed_at FROM nodes WHERE region_id=${region} AND ready=1 AND schedulable=1
      AND database_placement_enabled=1 AND lost_at IS NULL
  ), latest AS (
    SELECT n.id,n.node_uid,n.last_observed_at,MAX(m.minute) minute,MAX(m.observed_at) observed_at
    FROM members n LEFT JOIN node_memory_samples m ON m.node_id=n.id AND m.node_uid=n.node_uid
    GROUP BY n.id,n.node_uid,n.last_observed_at
  ), aligned AS (
    SELECT MIN(minute) minute,COUNT(*) members FROM latest
    HAVING COUNT(*)>0 AND COUNT(minute)=COUNT(*) AND MIN(minute)=MAX(minute)
      AND SUM(CASE WHEN node_uid IS NOT NULL
        AND julianday(last_observed_at)>=julianday('now','-180 seconds')
        AND julianday(last_observed_at)<=julianday('now','+5 seconds')
        AND julianday(observed_at)>=julianday('now','-90 seconds')
        AND julianday(observed_at)<=julianday('now','+5 seconds') THEN 1 ELSE 0 END)=COUNT(*)
  ), windows AS (
    SELECT n.id,n.node_uid,a.minute,COUNT(m.minute) sample_count,
      MIN(m.minute) first_minute,MAX(m.minute) last_minute,
      MIN(m.capacity_memory_bytes) capacity_min,MAX(m.capacity_memory_bytes) capacity_max,
      SUM(m.working_set_bytes) working_bytes,
      SUM(CASE WHEN typeof(m.working_set_bytes)='integer' AND typeof(m.capacity_memory_bytes)='integer'
        AND m.capacity_memory_bytes BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
        AND m.working_set_bytes BETWEEN 0 AND m.capacity_memory_bytes
        AND CAST(strftime('%s',m.observed_at) AS INTEGER)/60=m.minute THEN 1 ELSE 0 END) valid_samples
    FROM latest n JOIN aligned a LEFT JOIN node_memory_samples m
      ON m.node_id=n.id AND m.node_uid=n.node_uid AND m.minute BETWEEN a.minute-9 AND a.minute
    GROUP BY n.id,n.node_uid,a.minute
  ) SELECT a.minute,SUM(w.working_bytes) working_set_bytes,SUM(w.capacity_min*10) capacity_memory_bytes
    FROM aligned a JOIN windows w ON w.minute=a.minute GROUP BY a.minute,a.members
    HAVING COUNT(*)=a.members AND SUM(CASE WHEN w.sample_count=10 AND w.valid_samples=10
      AND w.first_minute=a.minute-9 AND w.last_minute=a.minute AND w.capacity_min=w.capacity_max
      THEN 1 ELSE 0 END)=a.members
      AND typeof(SUM(w.working_bytes))='integer' AND typeof(SUM(w.capacity_min*10))='integer'
      AND SUM(w.working_bytes) BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
      AND SUM(w.capacity_min*10) BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}`;
}

/** Shared current-policy approval predicate. Quotient/remainder arithmetic stays in SQLite int64. */
export function regionalRamExpansionSql(
  regionExpression: string,
  requestKeyExpression?: string,
): string {
  const key =
    requestKeyExpression === undefined
      ? undefined
      : regionSqlExpression(requestKeyExpression);
  return `EXISTS(SELECT 1 FROM (${regionalRamWindowSql(regionExpression)}) regional_ram
    JOIN node_region_policies ram_policy ON ram_policy.region_id=${regionSqlExpression(regionExpression)}
    WHERE ram_policy.ram_expansion_threshold_ppm IS NOT NULL
      AND regional_ram.working_set_bytes >=
        (regional_ram.capacity_memory_bytes/1000000)*ram_policy.ram_expansion_threshold_ppm
        + ((regional_ram.capacity_memory_bytes%1000000)*ram_policy.ram_expansion_threshold_ppm+999999)/1000000
      ${
        key === undefined
          ? ""
          : `AND EXISTS(SELECT 1 FROM (SELECT ${key} request_key) ram_key
        WHERE (ram_key.request_key='capacity-ram-'||CAST(CAST(substr(ram_key.request_key,14) AS INTEGER) AS TEXT)
          AND CAST(substr(ram_key.request_key,14) AS INTEGER) BETWEEN 1 AND regional_ram.minute)
          OR ram_key.request_key LIKE 'capacity-order-%')`
      })`;
}
