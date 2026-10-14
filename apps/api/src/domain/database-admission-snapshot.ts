// SPDX-License-Identifier: Apache-2.0
import {
  ARCHIVE_SERVER_NAME,
  DatabaseId,
  DesiredDatabaseStorage,
  DatabaseStorageVolumeReceipt,
} from "@pgcf/contracts";
import {
  DatabaseRuntimeAttestationV2,
  DatabasePoolRuntimeAttestationV2,
  reclaimConfigurationFingerprint,
} from "@pgcf/contracts/reclaim";
import type { Env } from "../env.ts";
import { DatabaseAdmissionSnapshot } from "./admission-state.ts";
import { admissionSnapshotSql } from "./fleet-releases.ts";
import { DatabasePresence } from "../database-actor.ts";
import type { DatabaseRow } from "./rows.ts";
import { notifyAdmissionRevisions } from "./admission-mutations.ts";
import {
  hasNonterminalPoolHolderSql,
  readPostgresPoolAdmissionBinding,
} from "./postgres-pool.ts";

interface SnapshotRow extends DatabaseRow {
  epoch_database_id: string | null;
  presence_updated_at: string;
  project_deleted_at: string | null;
  node_uid: string | null;
  node_ready: number | null;
  lost_at: string | null;
  gateway_url: string;
  gateway_binding: string | null;
  admission_revision: number;
  route_revision: number;
  mutation_id: string | null;
  pool_holder: number;
  completed_mutation_id: string | null;
  cache_capable: number;
  roles_json: string;
  memory_mib: number;
  memory_request_mib: number | null;
  cpu_millicores: number;
  cpu_request_millicores: number | null;
  storage_gib: number;
  max_connections: number;
  archive_timeout_seconds: number;
  backup_retention_days: number;
  maintenance_revision: number | null;
}
/** Trusted publication reads all authoritative nonsecret admission/configuration inputs together. */
export async function readDatabaseAdmissionSnapshot(
  env: Env,
  id: string,
  now = Date.now(),
) {
  DatabaseId.parse(id);
  const readRow = () =>
    env.DB.prepare(
      `SELECT d.*,p.deleted_at project_deleted_at,n.node_uid,n.ready node_ready,n.lost_at,r.gateway_url,r.gateway_binding,
    ae.database_id epoch_database_id,CASE WHEN p.updated_at>d.updated_at THEN p.updated_at ELSE d.updated_at END presence_updated_at,
    ae.admission_revision,ae.route_revision,ae.mutation_id,ae.completed_mutation_id,
    CASE WHEN ${admissionSnapshotSql("r")} THEN 1 ELSE 0 END cache_capable,
    CASE WHEN ${hasNonterminalPoolHolderSql("d")} THEN 1 ELSE 0 END pool_holder,
    s.memory_mib,CASE WHEN policy.placement_mode='actual_ram' AND d.desired_state='running' THEN policy.postgres_memory_request_mib ELSE NULL END memory_request_mib,
    s.cpu_millicores,s.cpu_request_millicores,s.storage_gib,s.max_connections,s.archive_timeout_seconds,s.backup_retention_days,
    (SELECT json_group_array(json_object('name',rr.name,'owner',rr.owner,'revision',rr.password_revision)) FROM roles rr WHERE rr.database_id=d.id AND rr.deleted_at IS NULL) roles_json,
    m.password_revision maintenance_revision
    FROM databases d JOIN projects p ON p.id=d.project_id JOIN regions r ON r.id=d.region_id JOIN size_classes s ON s.id=d.size_class_id
    LEFT JOIN database_admission_epochs ae ON ae.database_id=d.id LEFT JOIN nodes n ON n.id=d.node_id AND n.region_id=d.region_id
    LEFT JOIN node_region_policies policy ON policy.region_id=d.region_id LEFT JOIN maintenance_credentials m ON m.database_id=d.id WHERE d.id=?`,
    )
      .bind(id)
      .first<SnapshotRow>();
  let row = await readRow();
  if (row && row.epoch_database_id === null) {
    await env.DB.prepare(
      "INSERT INTO database_admission_epochs(database_id) SELECT id FROM databases WHERE id=? ON CONFLICT(database_id) DO NOTHING",
    )
      .bind(id)
      .run();
    // One positive current readback, including a concurrent first publisher; never synthesize an epoch.
    row = await readRow();
    if (row?.epoch_database_id == null) return null;
  }
  if (!row) return null;
  const roleOrder = (a: { name: string }, b: { name: string }) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  const roles = (
    JSON.parse(row.roles_json) as {
      name: string;
      owner: number;
      revision: number;
    }[]
  ).sort(roleOrder);
  const deleted =
    row.deleted_at !== null ||
    row.desired_state === "deleted" ||
    row.project_deleted_at !== null;
  let runtime: DatabaseAdmissionSnapshot["runtime"] = null;
  try {
    const raw = row.runtime_attestation_json
      ? JSON.parse(row.runtime_attestation_json)
      : null;
    const parsed =
      raw?.kind === "pool"
        ? DatabasePoolRuntimeAttestationV2.safeParse(raw)
        : DatabaseRuntimeAttestationV2.safeParse(raw);
    if (parsed.success) runtime = parsed.data;
  } catch {
    /* A malformed/stale proof closes admission; it cannot repair desired state. */
  }
  const expectedImage = row.desired_postgres_image;
  if (runtime && expectedImage) {
    const fingerprint = await reclaimConfigurationFingerprint(
      {
        pg_major: row.pg_major,
        postgres: { image: expectedImage },
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
      },
      expectedImage,
    );
    if (
      runtime.database_id !== id ||
      runtime.region_id !== row.region_id ||
      runtime.generation !== row.generation ||
      runtime.storage_generation !== (row.storage_generation ?? 1) ||
      runtime.node_uid !== row.node_uid ||
      runtime.configuration_fingerprint !== fingerprint ||
      runtime.postgres_image_sha256 !== expectedImage.split("@sha256:")[1] ||
      runtime.memory_limit_bytes !== row.memory_mib * 1024 ** 2 ||
      runtime.memory_request_bytes !==
        (row.memory_request_mib ?? row.memory_mib) * 1024 ** 2 ||
      runtime.tls_server_name !== `database-rw.pgcf-db-${id}.svc` ||
      runtime.route_revision !== row.route_revision ||
      runtime.admission_epoch !== row.admission_revision ||
      JSON.stringify([...runtime.applied_role_revisions].sort(roleOrder)) !==
        JSON.stringify(
          roles.map(({ name, revision }) => ({ name, revision })),
        ) ||
      runtime.observation.expires_at <= now ||
      runtime.observed_at > now + 1000
    )
      runtime = null;
  } else runtime = null;
  const poolProof = DatabasePoolRuntimeAttestationV2.safeParse(runtime),
    pool = poolProof.success;
  if (
    poolProof.success &&
    !(await readPostgresPoolAdmissionBinding(env, id, poolProof.data, now))
  )
    runtime = null;
  if (!pool && row.pool_holder === 1) runtime = null;
  if (runtime && (row.storage_profile_json || row.storage_volume_json)) {
    try {
      const volume = DatabaseStorageVolumeReceipt.parse(
        row.storage_volume_json ? JSON.parse(row.storage_volume_json) : null,
      );
      if (
        volume.storage_generation !== runtime.storage_generation ||
        volume.node_uid !== runtime.node_uid ||
        volume.cluster_uid !== runtime.cnpg_cluster_uid ||
        volume.namespace_uid !== runtime.namespace_uid ||
        volume.storage_uid !== runtime.storage_uid ||
        volume.pvc_uid !== runtime.pvc_uid ||
        volume.pv_uid !== runtime.pv_uid
      )
        runtime = null;
    } catch {
      runtime = null;
    }
  }
  const admissible =
    !deleted &&
    row.mutation_id === null &&
    row.node_id !== null &&
    row.lost_at === null &&
    row.node_ready === 1 &&
    row.desired_state === "running" &&
    row.observed_state === "ready" &&
    row.observed_power === "awake" &&
    row.observed_generation === row.generation &&
    (row.storage_protected_at == null ||
      (row.storage_protected_generation ?? 0) < row.generation) &&
    (row.pool_holder === 0 || (pool && runtime !== null)) &&
    (row.cache_capable === 0 || runtime !== null);
  return {
    presence: DatabasePresence.parse({
      database_id: id,
      revision: row.generation,
      updated_at: row.presence_updated_at,
      deleted,
      roles: deleted ? [] : roles.map((role) => role.name),
    }),
    snapshot: DatabaseAdmissionSnapshot.parse({
      v: 1,
      database_id: id,
      admission_revision: row.admission_revision,
      route_revision: row.route_revision,
      generation: row.generation,
      updated_at: row.updated_at,
      roles: deleted
        ? []
        : roles.map(({ name, revision }) => ({ name, revision })),
      deleted,
      cache_capable: row.cache_capable === 1,
      admissible,
      region: {
        id: row.region_id,
        gateway_url: row.gateway_url,
        gateway_binding: row.gateway_binding,
      },
      runtime,
    }),
    mutation_id: row.mutation_id,
    completed_mutation_id: row.completed_mutation_id,
  };
}
export async function publishDatabaseAdmission(
  env: Env,
  id: string,
  completedMutation?: string,
) {
  const actor = env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id));
  if (await actor.repairAdmissionMutation())
    await notifyAdmissionRevisions(env, [id]);
  const state = await readDatabaseAdmissionSnapshot(env, id);
  if (!state) return false;
  await actor.seed(state.presence);
  return actor.publishAdmissionSnapshot(
    state.snapshot,
    completedMutation ?? state.completed_mutation_id,
  );
}
