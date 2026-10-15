// SPDX-License-Identifier: Apache-2.0
import { ARCHIVE_SERVER_NAME, DesiredDatabaseStorage } from "@pgcf/contracts";
import { reclaimConfigurationFingerprint } from "@pgcf/contracts/reclaim";
import { postgresPoolClassFromDesired } from "@pgcf/contracts/postgres-pool";
import { ApiError } from "../app.ts";
import type { Env } from "../env.ts";
const conflict = (message: string) => new ApiError("conflict", message);
interface InputRow {
  id: string;
  region_id: string;
  node_id: string | null;
  node_uid: string | null;
  boot_id: string | null;
  generation: number;
  storage_generation: number | null;
  desired_state: string;
  observed_generation: number;
  observed_state: string;
  observed_power: string | null;
  deleted_at: string | null;
  project_deleted_at: string | null;
  lost_at: string | null;
  ready: number | null;
  ever_ready: number;
  image: string | null;
  schema_revision: number | null;
  pg_major: 18;
  memory_mib: number;
  memory_request_mib: number | null;
  cpu_millicores: number;
  cpu_request_millicores: number | null;
  storage_gib: number;
  max_connections: number;
  archive_timeout_seconds: number;
  backup_retention_days: number;
  storage_profile_json: string | null;
  storage_volume_json: string | null;
  runtime_attestation_json: string | null;
  /** A parked Pod still holds the volume: no pool Pod may claim it. */
  parked_json: string | null;
  archive_path: string;
  roles_json: string;
  maintenance_revision: number | null;
  admission_revision: number;
  route_revision: number;
  mutation_id: string | null;
}
export async function readPostgresPoolDatabaseContext(env: Env, id: string) {
  const row = await env.DB.prepare(
    `SELECT d.id,d.region_id,d.node_id,n.node_uid,json_extract(o.facts_json,'$.boot_id') boot_id,
    d.generation,d.storage_generation,d.desired_state,d.observed_generation,d.observed_state,d.observed_power,d.deleted_at,p.deleted_at project_deleted_at,n.lost_at,n.ready,
    EXISTS(SELECT 1 FROM lifecycle_events l WHERE l.database_id=d.id AND l.kind='ready') ever_ready,
    d.desired_postgres_image image,d.desired_postgres_schema_revision schema_revision,d.pg_major,s.memory_mib,
    CASE WHEN rp.placement_mode='actual_ram' THEN rp.postgres_memory_request_mib ELSE NULL END memory_request_mib,
    s.cpu_millicores,s.cpu_request_millicores,s.storage_gib,s.max_connections,s.archive_timeout_seconds,s.backup_retention_days,
    d.storage_profile_json,d.storage_volume_json,d.runtime_attestation_json,d.parked_json,d.archive_path,ae.admission_revision,ae.route_revision,ae.mutation_id,
    (SELECT json_group_array(json_object('name',r.name,'owner',r.owner,'revision',r.password_revision)) FROM roles r WHERE r.database_id=d.id AND r.deleted_at IS NULL) roles_json,
    m.password_revision maintenance_revision FROM databases d JOIN projects p ON p.id=d.project_id JOIN size_classes s ON s.id=d.size_class_id
    JOIN database_admission_epochs ae ON ae.database_id=d.id LEFT JOIN nodes n ON n.id=d.node_id
    LEFT JOIN fleet_node_releases a ON a.node_id=n.id AND a.node_uid=n.node_uid
    LEFT JOIN fleet_node_release_observations o ON o.node_id=n.id AND o.node_uid=n.node_uid AND o.assignment_revision=a.revision
    LEFT JOIN node_region_policies rp ON rp.region_id=d.region_id LEFT JOIN maintenance_credentials m ON m.database_id=d.id WHERE d.id=?`,
  )
    .bind(id)
    .first<InputRow>();
  if (!row) throw new ApiError("not_found", "Database not found");
  if (!row.image) throw conflict("PostgreSQL image pin is unavailable");
  const roles = (
    JSON.parse(row.roles_json) as {
      name: string;
      owner: number;
      revision: number;
    }[]
  ).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const desired = {
    pg_major: row.pg_major,
    postgres: {
      image: row.image,
      configuration_schema_revision: row.schema_revision ?? 1,
    },
    size: {
      memory_mib: row.memory_mib,
      ...(row.memory_request_mib === null
        ? {}
        : { memory_request_mib: row.memory_request_mib }),
      cpu_millicores: row.cpu_millicores,
      ...(row.cpu_request_millicores === null
        ? {}
        : { cpu_request_millicores: row.cpu_request_millicores }),
      storage_gib: row.storage_gib,
      max_connections: row.max_connections,
      archive_timeout_seconds: row.archive_timeout_seconds,
      backup_retention_days: row.backup_retention_days,
    },
    roles: roles.map((role) => ({ ...role, owner: role.owner === 1 })),
    ...(row.maintenance_revision === null
      ? {}
      : { maintenance: { revision: row.maintenance_revision } }),
    storage_generation: row.storage_generation ?? 1,
    ...(row.storage_profile_json
      ? {
          storage: DesiredDatabaseStorage.parse(
            JSON.parse(row.storage_profile_json),
          ),
        }
      : {}),
    archive: {
      destination_path: row.archive_path,
      server_name: ARCHIVE_SERVER_NAME,
    },
  };
  return {
    row,
    roles,
    desired,
    class: await postgresPoolClassFromDesired(desired),
    fingerprint: await reclaimConfigurationFingerprint(desired, row.image),
  };
}
