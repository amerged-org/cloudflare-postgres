// SPDX-License-Identifier: Apache-2.0

/** Lost nodes retain their known provider allocation until supported reconciliation removes it. */
export function regionalNodeCountSql(
  regionExpression: string,
  allocatedOnly = false,
): string {
  if (
    regionExpression !== "?" &&
    !/^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?$/.test(regionExpression)
  )
    throw new Error("invalid_node_count_sql_expression");
  return `(WITH registered AS (
    SELECT n.id,COALESCE(n.provider_instance_id,(SELECT a.provider_instance_id FROM node_additions a
      WHERE a.node_id=n.id AND a.region_id=n.region_id AND a.status<>'cancelled')) provider_instance_id
    FROM nodes n WHERE n.region_id=${regionExpression}
  ) SELECT count(*) FROM (
    SELECT CASE WHEN provider_instance_id IS NOT NULL THEN 'provider:'||provider_instance_id ELSE 'node:'||id END allocation
      FROM registered ${allocatedOnly ? "WHERE provider_instance_id IS NOT NULL" : ""}
    UNION SELECT CASE WHEN ${allocatedOnly ? "a.provider_instance_id" : "COALESCE(a.provider_instance_id,a.requested_instance_id)"} IS NOT NULL
      THEN 'provider:'||${allocatedOnly ? "a.provider_instance_id" : "COALESCE(a.provider_instance_id,a.requested_instance_id)"} ELSE 'node:'||a.node_id END allocation
      FROM node_additions a WHERE a.region_id=${regionExpression} AND a.slot_held=1 AND a.status<>'cancelled'
      ${allocatedOnly ? "AND a.provider_instance_id IS NOT NULL" : ""}
  ))`;
}
