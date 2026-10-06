// SPDX-License-Identifier: Apache-2.0
import {
  ARCHIVE_SERVER_NAME,
  DesiredDatabase,
  DesiredResponse,
  type DesiredCreation,
  type DesiredRecovery,
  type DesiredQuery,
  type DesiredSize,
} from "@pgcf/contracts";
import { keyring } from "../crypto/keyring.ts";
import {
  MAINTENANCE_ROLE,
  type MaintenanceCredential,
} from "@pgcf/contracts/maintenance";
import type { ApiContext } from "../env.ts";
import { agentRegion } from "./agent-auth.ts";
import type { DatabaseRow, RoleRow } from "./rows.ts";

interface DesiredRow extends DatabaseRow, DesiredSize {
  k8s_node_name: string;
  roles_json: string;
  creation_operation_id: string | null;
  creation_generation: number | null;
  creation_status: DesiredCreation["status"] | null;
  ever_ready: number;
  maintenance_ciphertext: string | null;
  maintenance_iv: string | null;
  maintenance_kid: string | null;
  maintenance_revision: number | null;
  restore_operation_id: string | null;
  source_database_id: string | null;
  source_archive_path: string | null;
  source_storage_generation: number | null;
  backup_id: string | null;
  target_time: string | null;
  restore_status: DesiredRecovery["status"] | null;
  source_region_id: string | null;
  source_backup_bucket: string | null;
  source_backup_endpoint_url: string | null;
}
export async function desired(
  c: ApiContext,
  query: DesiredQuery,
): Promise<Response> {
  const region = await agentRegion(c);
  const result = await c.env.DB.prepare(
    `SELECT d.*,n.k8s_node_name,s.memory_mib,s.cpu_millicores,s.storage_gib,s.max_connections,s.archive_timeout_seconds,s.backup_retention_days,
    (SELECT json_group_array(json_object('database_id',r.database_id,'name',r.name,'owner',r.owner,'password_revision',r.password_revision,'password_ciphertext',r.password_ciphertext,'password_iv',r.password_iv,'password_kid',r.password_kid)) FROM roles r WHERE r.database_id=d.id AND r.deleted_at IS NULL) roles_json,
    o.id creation_operation_id,o.generation creation_generation,o.status creation_status,
    EXISTS(SELECT 1 FROM lifecycle_events e WHERE e.database_id=d.id AND e.kind='ready') ever_ready,
    m.password_ciphertext maintenance_ciphertext,m.password_iv maintenance_iv,m.password_kid maintenance_kid,m.password_revision maintenance_revision,
    x.operation_id restore_operation_id,x.source_database_id,x.source_archive_path,x.source_storage_generation,x.backup_id,x.target_time,ro.status restore_status,
    src.region_id source_region_id,sr.backup_bucket source_backup_bucket,sr.backup_endpoint_url source_backup_endpoint_url
    FROM databases d JOIN nodes n ON n.id=d.node_id AND n.region_id=d.region_id JOIN size_classes s ON s.id=d.size_class_id
    LEFT JOIN operations o ON o.id=substr(d.archive_path,-23) AND o.kind='database.create' AND o.database_id=d.id AND o.project_id=d.project_id AND o.generation<=d.generation
    LEFT JOIN maintenance_credentials m ON m.database_id=d.id
    LEFT JOIN database_restores x ON x.target_database_id=d.id
    LEFT JOIN operations ro ON ro.id=x.operation_id AND ro.database_id=d.id AND ro.kind='database.restore'
    LEFT JOIN databases src ON src.id=x.source_database_id AND src.project_id=d.project_id
    LEFT JOIN regions sr ON sr.id=src.region_id
    WHERE d.region_id=? AND d.node_id IS NOT NULL AND (d.desired_state='deleted' OR (n.schedulable=1 AND n.lost_at IS NULL)) AND d.desired_state IN('running','suspended','deleted') AND (d.desired_state<>'suspended' OR d.power_operation IS NOT NULL) AND NOT(d.desired_state='deleted' AND d.observed_state='deleted' AND d.observed_generation=d.generation)
    ${query.after ? "AND d.id>?" : ""} ORDER BY d.id LIMIT ?`,
  )
    .bind(region.id, ...(query.after ? [query.after] : []), query.limit + 1)
    .all<DesiredRow>();
  const rows = result.results.slice(0, query.limit),
    databases: DesiredDatabase[] = [];
  const credentials = keyring(c.env.CREDENTIAL_KEYS);
  for (const row of rows) {
    const roles: DesiredDatabase["roles"] = [];
    let maintenance: MaintenanceCredential | undefined;
    // Deletion can recover even if a credential key has been retired.
    if (row.desired_state !== "deleted") {
      if (row.maintenance_ciphertext !== null) {
        maintenance = {
          role: MAINTENANCE_ROLE,
          revision: row.maintenance_revision!,
          password: await credentials.decrypt(row.id, MAINTENANCE_ROLE, {
            ciphertext: row.maintenance_ciphertext,
            iv: row.maintenance_iv!,
            kid: row.maintenance_kid!,
          }),
        };
      }
      const stored = JSON.parse(row.roles_json) as RoleRow[];
      for (const role of stored.sort((a, b) => a.name.localeCompare(b.name)))
        roles.push({
          name: role.name,
          owner: Boolean(role.owner),
          revision: role.password_revision,
          password: await credentials.decrypt(row.id, role.name, {
            ciphertext: role.password_ciphertext,
            iv: role.password_iv,
            kid: role.password_kid,
          }),
        });
    }
    databases.push(
      DesiredDatabase.parse({
        id: row.id,
        generation: row.generation,
        // Preserve the deployed generation-one wire shape during consumer-first upgrades.
        ...((row.storage_generation ?? 1) === 1
          ? {}
          : { storage_generation: row.storage_generation }),
        ...(row.restore_operation_id && row.desired_state !== "deleted"
          ? {
              recovery: {
                operation_id: row.restore_operation_id,
                source_database_id: row.source_database_id,
                source_archive_path: row.source_archive_path,
                source_storage_generation: row.source_storage_generation,
                ...(row.source_region_id !== row.region_id
                  ? {
                      source_archive: {
                        region_id: row.source_region_id,
                        bucket: row.source_backup_bucket,
                        endpoint_url: row.source_backup_endpoint_url,
                        region: "auto",
                      },
                    }
                  : {}),
                backup_id: row.backup_id,
                ...(row.target_time ? { target_time: row.target_time } : {}),
                status: row.restore_status,
                ever_ready: Boolean(row.ever_ready),
              },
            }
          : {}),
        desired_state: row.desired_state,
        ...(row.power_operation && row.desired_state !== "deleted"
          ? {
              power: {
                operation: row.power_operation,
                revision: row.generation,
                mode: row.desired_state === "suspended" ? "quiesce" : "running",
                reason:
                  row.desired_state === "suspended"
                    ? row.suspension_reason
                    : null,
              },
            }
          : {}),
        node: row.k8s_node_name,
        pg_major: row.pg_major,
        size: {
          memory_mib: row.memory_mib,
          cpu_millicores: row.cpu_millicores,
          storage_gib: row.storage_gib,
          max_connections: row.max_connections,
          archive_timeout_seconds: row.archive_timeout_seconds,
          backup_retention_days: row.backup_retention_days,
        },
        roles,
        ...(maintenance === undefined ? {} : { maintenance }),
        creation:
          row.creation_operation_id === null
            ? null
            : {
                operation_id: row.creation_operation_id,
                generation: row.creation_generation,
                status: row.creation_status,
                ever_ready: Boolean(row.ever_ready),
              },
        archive: {
          destination_path: row.archive_path,
          server_name: ARCHIVE_SERVER_NAME,
        },
      }),
    );
  }
  return c.json(
    DesiredResponse.parse({
      region: {
        id: region.id,
        backup: {
          bucket: region.backup_bucket,
          endpoint_url: region.backup_endpoint_url,
          region: "auto",
        },
      },
      databases,
      next: result.results.length > query.limit ? rows.at(-1)!.id : null,
    }),
  );
}
