// SPDX-License-Identifier: Apache-2.0
import {
  DatabaseStorageVolumeReceipt,
  thinStorageAuthorityMatches,
  thinStorageInventory,
} from "@pgcf/contracts";
import { FleetReleaseSpec } from "@pgcf/contracts/releases";
import {
  poolBindingScopeHash,
  type PoolBinding,
} from "@pgcf/contracts/postgres-pool";
import { PostgresPoolQualificationScope } from "../../../../packages/contracts/src/postgres-pool-qualification.ts";
import type { Env } from "../env.ts";
import { installationHash } from "./node-installation.ts";
import { readCurrentNodeThinStorage } from "./node-thin-storage.ts";
import { readPostgresPoolFleetFence } from "./postgres-pool-fleet-fence.ts";
import { currentStorageStopSql } from "./storage-capacity.ts";
import { readPostgresPoolHostController } from "./postgres-pool-host.ts";
import type { AdmissionSqlGuard } from "./admission-mutations.ts";
const cleanupBrand: unique symbol = Symbol(
  "validated-postgres-pool-qualification-cleanup",
);
export interface PostgresPoolQualificationCleanupAuthority {
  readonly [cleanupBrand]: true;
  readonly run_id: string;
  readonly scope_sha256: string;
  readonly scope: PostgresPoolQualificationScope;
  readonly operation_id: string;
  readonly database_generation: number;
  readonly fence: AdmissionSqlGuard;
}
/** A current CF stop for the one owned holder; this never upgrades cleanup into startup authority. */
export async function readPostgresPoolQualificationCleanupAuthority(
  env: Env,
  binding: PoolBinding,
  now = Date.now(),
): Promise<PostgresPoolQualificationCleanupAuthority | undefined> {
  const b = binding.scope;
  if (
    b.storage.backend !== "lvm-thin-v1" ||
    (await poolBindingScopeHash(b)) !== binding.scope_sha256
  )
    return undefined;
  const fleet = await readPostgresPoolFleetFence(env.DB, b.region_id, true);
  if (!fleet) return undefined;
  const row = await env.DB.prepare(
    `SELECT q.*,s.spec_json,s.spec_sha256,d.generation current_generation,d.storage_profile_json,d.storage_volume_json,
    json_extract(o.facts_json,'$.boot_id') current_boot FROM postgres_pool_qualification_runs q
    JOIN pool_pods p ON p.qualification_run_id=q.id AND p.qualification_scope_sha256=q.scope_sha256
    JOIN pool_bindings pb ON pb.pool_pod_uid=p.pod_uid JOIN database_runtime_holders h ON h.binding_id=pb.id AND h.revision=pb.holder_revision
    JOIN databases d ON d.id=h.database_id JOIN nodes n ON n.id=d.node_id
    JOIN fleet_node_releases a ON a.node_id=n.id AND a.node_uid=n.node_uid AND a.release_id=q.candidate_release_id
    JOIN fleet_region_releases f ON f.region_id=d.region_id AND f.release_id=a.release_id
    JOIN fleet_releases s ON s.id=a.release_id JOIN fleet_node_release_observations o ON o.node_id=n.id AND o.node_uid=n.node_uid AND o.assignment_revision=a.revision
    WHERE pb.id=? AND pb.scope_sha256=? AND h.state IN('detaching','failed','lost') AND q.status IN('running','cleanup')
    AND (q.status='cleanup' OR q.expires_at>?) AND n.node_uid=? AND n.ready=1 AND n.lost_at IS NULL`,
  )
    .bind(b.binding_id, binding.scope_sha256, now, b.node_uid)
    .first<Record<string, unknown>>();
  if (!row) return undefined;
  const parsed = PostgresPoolQualificationScope.safeParse(
      JSON.parse(row.scope_json as string),
    ),
    candidate = FleetReleaseSpec.safeParse(JSON.parse(row.spec_json as string));
  if (!parsed.success || !candidate.success) return undefined;
  const scope = parsed.data,
    spec = candidate.data;
  if (
    row.id !== scope.run_id ||
    row.region_id !== scope.region_id ||
    row.node_id !== scope.node_id ||
    row.node_uid !== scope.node_uid ||
    row.boot_id !== scope.boot_id ||
    row.database_id !== scope.database_id ||
    row.database_generation !== scope.database_generation ||
    row.candidate_release_id !== scope.candidate_release_id ||
    row.candidate_spec_sha256 !== scope.candidate_spec_sha256 ||
    row.spec_sha256 !== scope.candidate_spec_sha256 ||
    (await installationHash(scope)) !== row.scope_sha256 ||
    (await installationHash(spec)) !== row.spec_sha256 ||
    scope.database_id !== b.database_id ||
    scope.database_generation !== b.generation ||
    scope.node_id !== b.node_id ||
    scope.node_uid !== b.node_uid ||
    scope.boot_id !== b.boot_id ||
    row.current_boot !== b.boot_id ||
    Number(row.current_generation) < b.generation ||
    scope.thin_id !== b.storage.thin_id ||
    JSON.stringify(scope.storage) !== JSON.stringify(b.storage.profile) ||
    JSON.stringify(scope.storage) !== row.storage_profile_json ||
    spec.postgres_pool_candidate?.driver_sha256 !== b.driver_sha256 ||
    spec.postgres_pool_candidate.supervisor_sha256 !== b.supervisor_sha256 ||
    scope.software.driver_image !== b.driver_image ||
    scope.software.driver_sha256 !== b.driver_sha256 ||
    scope.software.supervisor_sha256 !== b.supervisor_sha256 ||
    !scope.software.postgres_image.endsWith(
      "@sha256:" + b.class.postgres_image_sha256,
    )
  )
    return undefined;
  const volume = DatabaseStorageVolumeReceipt.safeParse(
    JSON.parse(row.storage_volume_json as string),
  );
  if (
    !volume.success ||
    JSON.stringify(volume.data) !== JSON.stringify(scope.volume) ||
    scope.volume.storage_uid !== b.storage.storage_uid ||
    scope.volume.storage_generation !== b.storage.storage_generation ||
    scope.volume.namespace_uid !== b.storage.namespace_uid ||
    scope.volume.cluster_uid !== b.storage.cnpg_cluster_uid ||
    scope.volume.pvc_uid !== b.storage.pvc_uid ||
    scope.volume.pv_uid !== b.storage.pv_uid ||
    scope.volume.lv_uuid !== b.storage.lv_uuid ||
    scope.volume.volume_group_uuid !== b.storage.volume_group_uuid ||
    scope.volume.volume_handle !== b.storage.volume_handle
  )
    return undefined;
  const pins: { [name: string]: string } = {
    "openebs-lvm": scope.software.driver_image,
    "pool-supervisor": scope.software.supervisor_image,
    postgres: scope.software.postgres_image,
    barman: scope.software.archiver_image,
    "pgcf-sandbox-controller": scope.software.host_extension_image,
  };
  if (
    !Object.entries(pins).every(([name, reference]) =>
      spec.components.some(
        (c) =>
          c.name === name && c.kind === "image" && c.reference === reference,
      ),
    )
  )
    return undefined;
  const current = await readCurrentNodeThinStorage(env, b.node_id, now);
  const host = await readPostgresPoolHostController(env, b.node_id, b.node_uid);
  if (
    !host ||
    host.sha256 !== b.host_controller_sha256 ||
    scope.software.host_controller_sha256 !== b.host_controller_sha256 ||
    spec.postgres_pool_candidate?.host_controller_sha256 !==
      b.host_controller_sha256
  )
    return undefined;
  if (
    !current?.authority ||
    current.row.current_qualified !== 1 ||
    current.row.cluster_uid !== scope.cluster_uid ||
    (
      JSON.parse(current.row.qualification_json ?? "null") as {
        boot_id?: unknown;
      } | null
    )?.boot_id !== b.boot_id ||
    !current.authority.data_accounting_complete ||
    !thinStorageAuthorityMatches(
      scope.storage,
      current.authority,
      undefined,
      now,
      false,
    ) ||
    thinStorageInventory(current.authority).expires_at <= now
  )
    return undefined;
  const operation = await env.DB.prepare(
    `SELECT q.id FROM pool_role_mutations q WHERE q.database_id=? AND q.binding_id=? AND q.holder_revision=? AND q.expected_generation=? AND q.status IN('pending','failed')
    UNION ALL SELECT stop.id FROM databases d JOIN operations stop ON stop.database_id=d.id WHERE d.id=? AND ${currentStorageStopSql()} LIMIT 1`,
  )
    .bind(
      b.database_id,
      b.binding_id,
      binding.holder_revision,
      b.generation,
      b.database_id,
    )
    .first<string>("id");
  if (!operation) return undefined;
  const fence: AdmissionSqlGuard = {
    sql: `EXISTS(SELECT 1 FROM postgres_pool_qualification_runs q JOIN databases d ON d.id=q.database_id JOIN database_runtime_holders h ON h.database_id=d.id
    JOIN nodes n ON n.id=d.node_id JOIN fleet_node_release_observations o ON o.node_id=n.id AND o.node_uid=n.node_uid
    WHERE q.id=? AND q.scope_sha256=? AND q.scope_json=? AND q.status=? AND q.expires_at=? AND d.generation=? AND d.storage_profile_json=? AND d.storage_volume_json=?
    AND h.binding_id=? AND h.revision=? AND h.state IN('detaching','failed','lost') AND n.node_uid=? AND n.lost_at IS NULL AND json_extract(o.facts_json,'$.boot_id')=?
    AND (EXISTS(SELECT 1 FROM pool_role_mutations r WHERE r.id=? AND r.database_id=d.id AND r.binding_id=h.binding_id AND r.holder_revision=h.revision AND r.expected_generation=? AND r.status IN('pending','failed'))
      OR EXISTS(SELECT 1 FROM operations stop WHERE stop.id=? AND ${currentStorageStopSql()}))) AND (${fleet.sql})`,
    bindings: [
      row.id,
      row.scope_sha256,
      row.scope_json,
      row.status,
      row.expires_at,
      row.current_generation,
      row.storage_profile_json,
      row.storage_volume_json,
      b.binding_id,
      binding.holder_revision,
      b.node_uid,
      b.boot_id,
      operation,
      b.generation,
      operation,
      ...fleet.bindings,
    ] as AdmissionSqlGuard["bindings"],
  };
  return {
    [cleanupBrand]: true,
    run_id: scope.run_id,
    scope_sha256: row.scope_sha256 as string,
    scope,
    operation_id: operation,
    database_generation: row.current_generation as number,
    fence,
  };
}
