// SPDX-License-Identifier: Apache-2.0
import {
  ARCHIVE_SERVER_NAME,
  DesiredDatabase,
  DesiredDatabaseStorage,
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
import type { ApiContext, Env } from "../env.ts";
import { agentRegion } from "./agent-auth.ts";
import type { DatabaseRow, RegionRow, RoleRow } from "./rows.ts";
import {
  readDesiredFleetRelease,
  admissionSnapshotCapable,
} from "./fleet-releases.ts";
import { desiredRegionArchiveSources } from "./region-archive-sources.ts";
import { desiredRegionStorageNodes } from "./node-thin-storage.ts";
interface DesiredRow extends DatabaseRow, DesiredSize {
  admission_revision: number;
  route_revision: number;
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
type PageRegion = Pick<
  RegionRow,
  "id" | "backup_bucket" | "backup_endpoint_url"
>;
export async function desired(
  c: ApiContext,
  query: DesiredQuery,
): Promise<Response> {
  const started = Date.now();
  const region = await agentRegion(c);
  const page = (await desiredPage(c.env, region, query))!;
  const response = c.json(page);
  // One line per page, so a wake's pull is measured where the controller reads it.
  console.log(
    JSON.stringify({
      event: "desired_page",
      region_id: region.id,
      ...(page.databases.length === 1
        ? { database_id: page.databases[0]!.id }
        : {}),
      databases: page.databases.length,
      at_ms: Date.now(),
      elapsedMs: Date.now() - started,
    }),
  );
  return response;
}
/**
 * The page a targeted pull of one database reads now, for the hint of its claimed wake: the same
 * builder, so the same row. It is carried only while that row is the claimed wake itself (its
 * revision and power operation, running); anything else is left to the region's pull.
 */
export async function wakeHintPage(
  env: Env,
  regionId: string,
  databaseId: string,
  claim: { operation: string; revision: number },
): Promise<DesiredResponse | undefined> {
  const page = await desiredPage(env, regionId, { limit: 1 }, databaseId);
  const row = page?.databases[0];
  return page?.databases.length === 1 &&
    row?.id === databaseId &&
    row.generation === claim.revision &&
    row.desired_state === "running" &&
    row.power?.operation === claim.operation
    ? page
    : undefined;
}
/** One page of a region's desired state, or with `only` that database's alone; none for an unknown region. */
async function desiredPage(
  env: Env,
  region: PageRegion | string,
  query: DesiredQuery,
  only?: string,
): Promise<DesiredResponse | undefined> {
  const regionId = typeof region === "string" ? region : region.id;
  // The controller pulls this page on every wake hint. What depends only on the region is read together.
  const [
    regionRow,
    admissionCapable,
    policy,
    storageNodes,
    fleetRelease,
    recoverySources,
  ] = await Promise.all([
    typeof region === "string"
      ? env.DB.prepare(
          "SELECT id,backup_bucket,backup_endpoint_url FROM regions WHERE id=?",
        )
          .bind(region)
          .first<PageRegion>()
      : region,
    admissionSnapshotCapable(env.DB, regionId),
    env.DB.prepare(
      "SELECT placement_mode,maximum_database_memory_mib,postgres_memory_request_mib FROM node_region_policies WHERE region_id=?",
    )
      .bind(regionId)
      .first<{
        placement_mode: string;
        maximum_database_memory_mib: number | null;
        postgres_memory_request_mib: number | null;
      }>(),
    desiredRegionStorageNodes(env, regionId),
    readDesiredFleetRelease(env.DB, regionId),
    desiredRegionArchiveSources(env, regionId),
  ]);
  if (!regionRow) return undefined;
  const scheduling =
    policy?.placement_mode === "actual_ram"
      ? {
          placement_mode: "actual_ram" as const,
          maximum_database_memory_mib: policy.maximum_database_memory_mib,
          postgres_memory_request_mib: policy.postgres_memory_request_mib,
        }
      : undefined;
  const result = await env.DB.prepare(
    `SELECT d.*,COALESCE(ae.admission_revision,1) admission_revision,COALESCE(ae.route_revision,1) route_revision,n.k8s_node_name,s.memory_mib,s.cpu_millicores,s.cpu_request_millicores,s.storage_gib,s.max_connections,s.archive_timeout_seconds,s.backup_retention_days,
    (SELECT json_group_array(json_object('database_id',r.database_id,'name',r.name,'owner',r.owner,'password_revision',r.password_revision,'password_ciphertext',r.password_ciphertext,'password_iv',r.password_iv,'password_kid',r.password_kid,'deleted_at',r.deleted_at,'valid_until',r.valid_until,'connection_limit',r.connection_limit,'member_of',json(r.member_of_json),'bypass_rls',r.bypass_rls)) FROM roles r WHERE r.database_id=d.id) roles_json,
    o.id creation_operation_id,o.generation creation_generation,o.status creation_status,
    EXISTS(SELECT 1 FROM lifecycle_events e WHERE e.database_id=d.id AND e.kind='ready') ever_ready,
    m.password_ciphertext maintenance_ciphertext,m.password_iv maintenance_iv,m.password_kid maintenance_kid,m.password_revision maintenance_revision,
    x.operation_id restore_operation_id,x.source_database_id,x.source_archive_path,x.source_storage_generation,x.backup_id,x.target_time,ro.status restore_status,
    src.region_id source_region_id,sr.backup_bucket source_backup_bucket,sr.backup_endpoint_url source_backup_endpoint_url
    FROM databases d JOIN nodes n ON n.id=d.node_id AND n.region_id=d.region_id JOIN size_classes s ON s.id=d.size_class_id
    LEFT JOIN database_admission_epochs ae ON ae.database_id=d.id
    LEFT JOIN operations o ON o.id=substr(d.archive_path,-23) AND o.kind='database.create' AND o.database_id=d.id AND o.project_id=d.project_id AND o.generation<=d.generation
    LEFT JOIN maintenance_credentials m ON m.database_id=d.id
    LEFT JOIN database_restores x ON x.target_database_id=d.id
    LEFT JOIN operations ro ON ro.id=x.operation_id AND ro.database_id=d.id AND ro.kind='database.restore'
    LEFT JOIN databases src ON src.id=x.source_database_id AND src.project_id=d.project_id
    LEFT JOIN regions sr ON sr.id=src.region_id
    WHERE d.region_id=? AND d.node_id IS NOT NULL AND (d.desired_state='deleted' OR (n.schedulable=1 AND n.lost_at IS NULL)) AND d.desired_state IN('running','suspended','deleted') AND (d.desired_state<>'suspended' OR d.power_operation IS NOT NULL) AND NOT(d.desired_state='deleted' AND d.observed_state='deleted' AND d.observed_generation=d.generation)
    ${query.after ? "AND d.id>?" : ""} ${only ? "AND d.id=?" : ""} ORDER BY d.id LIMIT ?`,
  )
    .bind(
      regionId,
      ...(query.after ? [query.after] : []),
      ...(only ? [only] : []),
      query.limit + 1,
    )
    .all<DesiredRow>();
  const rows = result.results.slice(0, query.limit),
    databases: DesiredDatabase[] = [];
  const credentials = keyring(env.CREDENTIAL_KEYS);
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
      const stored = JSON.parse(row.roles_json) as (Omit<
        RoleRow,
        "member_of_json"
      > & { member_of: string[] })[];
      for (const role of stored.sort((a, b) => a.name.localeCompare(b.name))) {
        // A deleted role is only named: the region removes it from PostgreSQL and reports back,
        // and its credential is never sent again.
        if (role.deleted_at !== null) {
          roles.push({ name: role.name, state: "absent" });
          continue;
        }
        roles.push({
          name: role.name,
          owner: Boolean(role.owner),
          revision: role.password_revision,
          password: await credentials.decrypt(row.id, role.name, {
            ciphertext: role.password_ciphertext,
            iv: role.password_iv,
            kid: role.password_kid,
          }),
          // Attributes appear only where they differ from a plain role, so a database without
          // them keeps the wire shape every deployed consumer accepts.
          ...(role.valid_until === null
            ? {}
            : { valid_until: role.valid_until }),
          ...(role.connection_limit === null
            ? {}
            : { connection_limit: role.connection_limit }),
          ...(role.member_of.length === 0 ? {} : { member_of: role.member_of }),
          ...(role.bypass_rls ? { bypass_rls: true as const } : {}),
        });
      }
    }
    const storage = row.storage_profile_json
      ? DesiredDatabaseStorage.parse(JSON.parse(row.storage_profile_json))
      : undefined;
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
        ...(storage ? { storage } : {}),
        ...(row.desired_postgres_release_id
          ? {
              postgres: {
                release_id: row.desired_postgres_release_id,
                image: row.desired_postgres_image,
                version: row.desired_postgres_version,
                configuration_schema_revision:
                  row.desired_postgres_schema_revision,
              },
            }
          : {}),
        size: {
          memory_mib: row.memory_mib,
          ...(scheduling && row.desired_state === "running"
            ? { memory_request_mib: scheduling.postgres_memory_request_mib }
            : {}),
          cpu_millicores: row.cpu_millicores,
          ...(row.cpu_request_millicores == null
            ? {}
            : { cpu_request_millicores: row.cpu_request_millicores }),
          storage_gib: row.storage_gib,
          max_connections: row.max_connections,
          archive_timeout_seconds: row.archive_timeout_seconds,
          backup_retention_days: row.backup_retention_days,
        },
        roles,
        ...(admissionCapable
          ? {
              admission: {
                v: 1,
                admission_epoch: row.admission_revision,
                route_revision: row.route_revision,
              },
            }
          : {}),
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
  return DesiredResponse.parse({
    ...(fleetRelease ? { fleet_release: fleetRelease } : {}),
    region: {
      id: regionRow.id,
      ...(storageNodes.length ? { storage_nodes: storageNodes } : {}),
      ...(recoverySources === undefined
        ? {}
        : { recovery_sources: recoverySources }),
      ...(scheduling ? { scheduling } : {}),
      backup: {
        bucket: regionRow.backup_bucket,
        endpoint_url: regionRow.backup_endpoint_url,
        region: "auto",
      },
    },
    databases,
    next: result.results.length > query.limit ? rows.at(-1)!.id : null,
  });
}
