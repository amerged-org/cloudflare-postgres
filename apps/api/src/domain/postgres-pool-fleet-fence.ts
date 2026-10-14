// SPDX-License-Identifier: Apache-2.0
import {
  postgresPoolCapable,
  postgresPoolQualificationCapable,
} from "./fleet-releases.ts";
import type { AdmissionSqlGuard } from "./admission-mutations.ts";
const witnessSql = `SELECT json_array(
  (SELECT json_array(r.agent_key_hash,f.release_id,f.revision,s.spec_sha256) FROM regions r
    LEFT JOIN fleet_region_releases f ON f.region_id=r.id LEFT JOIN fleet_releases s ON s.id=f.release_id WHERE r.id=?),
  (SELECT json_group_array(j) FROM (SELECT json_array(n.id,n.node_uid,n.lost_at,a.node_uid,a.release_id,a.revision,
    o.node_uid,o.assignment_revision,o.agent_key_hash,o.facts_json,o.observed_at,o.received_at,
    (SELECT json_group_array(json_array(p.operation_id,p.node_uid,p.release_id,p.spec_sha256,p.assignment_revision,p.region_revision,p.stage,p.state,p.error_code))
      FROM fleet_patch_operations p WHERE p.node_id=n.id)) j
    FROM nodes n LEFT JOIN fleet_node_releases a ON a.node_id=n.id LEFT JOIN fleet_node_release_observations o ON o.node_id=n.id
    WHERE n.region_id=? ORDER BY n.id))) witness`;
/** Bracket the full gate with the exact current fleet view, then CAS that view in shallow SQL. */
export async function readPostgresPoolFleetFence(
  db: D1Database,
  regionId: string,
  qualification = false,
): Promise<AdmissionSqlGuard | undefined> {
  const before = await db
    .prepare(witnessSql)
    .bind(regionId, regionId)
    .first<string>("witness");
  const capable = qualification
    ? await postgresPoolQualificationCapable(db, regionId)
    : await postgresPoolCapable(db, regionId);
  const after = await db
    .prepare(witnessSql)
    .bind(regionId, regionId)
    .first<string>("witness");
  if (!capable || before !== after) return undefined;
  const [release] = JSON.parse(after!) as [
    [string, string, number, string],
    unknown,
  ];
  if (!release) return undefined;
  return {
    sql: `EXISTS(SELECT 1 FROM regions r JOIN fleet_region_releases f ON f.region_id=r.id JOIN fleet_releases s ON s.id=f.release_id
    WHERE r.id=? AND r.agent_key_hash=? AND f.release_id=? AND f.revision=? AND s.spec_sha256=? AND json_extract(s.spec_json,'$.${qualification ? "postgres_pool_qualification_version" : "postgres_pool_version"}')=1)
    AND (${witnessSql}) IS ?`,
    bindings: [
      regionId,
      release[0],
      release[1],
      release[2],
      release[3],
      regionId,
      regionId,
      after,
    ],
  };
}
