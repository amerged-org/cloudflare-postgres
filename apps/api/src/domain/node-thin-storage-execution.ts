// SPDX-License-Identifier: Apache-2.0
import {
  bytesToBase64url,
  newOperationId,
  timingSafeEqual,
  DatabaseStorageVolumeReceipt,
  THIN_INVENTORY_MAX_SECONDS,
  thinStorageClass,
  thinStorageInventory,
  NodeThinStorageAuthority,
  type NodePhysicalStorage,
  type ThinStorageProfile,
} from "@pgcf/contracts";
import {
  NodeThinStorageInput,
  NodeThinStorageLease,
  NodeThinStorageReport,
  NodeThinPoolAction,
} from "@pgcf/contracts/node-thin-storage";
import {
  BOOTSTRAP_PORTS,
  BOOTSTRAP_RELAY_IDENTITY_PATH,
  BOOTSTRAP_RELAY_PATH,
  signBootstrapRelay,
} from "@pgcf/contracts/bootstrap-relay";
import {
  RelayGrantCount,
  NodeBootstrapTransport,
  NodeBootstrapTransportBatch,
} from "@pgcf/contracts/node-bootstrap";
import {
  FleetReleaseSpec,
  thinStorageReleaseGuardPinned,
} from "@pgcf/contracts/releases";
import { storageAuthorityPublicKeys } from "./storage-authority.ts";
import { loadNodeHostConfiguration } from "./node-host-configuration.ts";
import { installationHash } from "./node-installation.ts";
import sources from "../../../../infra/storage/sources.lock.json" with { type: "json" };
import { ApiError } from "../app.ts";
import type { Env, ApiContext } from "../env.ts";
import { bearer } from "../middleware/auth.ts";
import {
  readCurrentNodeThinStorage,
  poolHostCustodyForDatabase,
  type NodeThinStorageRow,
} from "./node-thin-storage.ts";
import {
  storageProtectionStatements,
  storageHoldVolumeStatements,
  knownStorageHoldVolume,
  thinLogicalVolumeExposures,
  currentStorageStopSql,
} from "./storage-capacity.ts";
import {
  loadCurrentRegionMaterialReference,
  loadRegionJoinBundle,
} from "../crypto/bootstrap-credentials.ts";
import { bootstrapTransportSigningKey } from "./bootstrap-relay.ts";
import { readBootstrapRelayIdentity } from "./node-inspection.ts";
import type { DatabaseRow } from "./rows.ts";
import {
  withAdmissionMutation,
  type AdmissionMutation,
} from "./admission-mutations.ts";
import {
  postgresPoolCapable,
  postgresPoolQualificationCapable,
} from "./fleet-releases.ts";
const closed = (): never => {
  throw new ApiError(
    "conflict",
    "Current physical storage lease or identity changed",
  );
};
/** An identity turn lease covers the executor's 90 s budget and its report, not the write guard. */
export const THIN_STORAGE_LEASE_SECONDS = 95;
const iso = (ms: number) => new Date(ms).toISOString();
export const thinStorageAuthoritySql = `EXISTS(SELECT 1 FROM nodes n JOIN regions r ON r.id=n.region_id JOIN fleet_node_releases a ON a.node_id=n.id JOIN fleet_region_releases f ON f.region_id=n.region_id JOIN fleet_releases s ON s.id=a.release_id WHERE n.id=node_thin_storage.node_id AND n.node_uid=node_thin_storage.node_uid AND n.ready=1 AND n.lost_at IS NULL AND a.node_uid=n.node_uid AND a.release_id=f.release_id AND r.bootstrap_material_revision=node_thin_storage.material_revision AND NOT EXISTS(SELECT 1 FROM node_bootstrap_jobs j WHERE j.node_id=n.id AND j.admitted=0 AND (j.authorized<>1 OR j.cancelled<>0 OR j.admission_authorized<>1)) AND NOT EXISTS(SELECT 1 FROM node_additions original WHERE original.node_id=n.id AND original.status IN('failed','cancelled')) AND EXISTS(SELECT 1 FROM json_each(s.spec_json,'$.components') component WHERE json_extract(component.value,'$.name')='openebs-lvm' AND json_extract(component.value,'$.kind')='image' AND json_extract(component.value,'$.reference')=node_thin_storage.qualified_driver_image))`;
export async function readThinStorageLeaseRow(env: Env, nodeId: string) {
  const row = await env.DB.prepare(
    `SELECT t.*,n.region_id,n.k8s_node_name,n.provider_instance_id,a.release_id,a.revision assignment_revision,f.revision region_revision,s.spec_json,s.spec_sha256,h.revision host_revision,h.sha256 host_sha256,
    json_extract(p.observed_json,'$.boot_id') boot_id,json_extract(p.observed_json,'$.kubernetes_configuration_boot_id') configuration_boot_id
    FROM node_thin_storage t JOIN nodes n ON n.id=t.node_id JOIN fleet_node_releases a ON a.node_id=n.id JOIN fleet_region_releases f ON f.region_id=n.region_id JOIN fleet_releases s ON s.id=a.release_id LEFT JOIN node_host_configurations h ON h.node_id=n.id AND h.node_uid=n.node_uid AND h.release_id=a.release_id AND h.material_revision=t.material_revision
    LEFT JOIN fleet_patch_operations p ON p.operation_id=(SELECT q.operation_id FROM fleet_patch_operations q WHERE q.node_id=n.id AND q.node_uid=n.node_uid AND q.release_id=a.release_id AND q.assignment_revision=a.revision AND q.region_revision=f.revision AND q.material_revision=t.material_revision AND q.stage='complete' AND q.state='confirmed' AND q.error_code IS NULL AND q.host_configuration_revision=h.revision AND q.host_configuration_sha256=h.sha256 ORDER BY q.updated_at DESC LIMIT 1)
    WHERE t.node_id=? AND ${thinStorageAuthoritySql.replaceAll("node_thin_storage.", "t.")}`,
  )
    .bind(nodeId)
    .first<
      NodeThinStorageRow & {
        region_id: string;
        k8s_node_name: string;
        provider_instance_id: string;
        release_id: string;
        assignment_revision: number;
        region_revision: number;
        spec_json: string;
        spec_sha256: string;
        host_revision: number | null;
        host_sha256: string | null;
        boot_id: string | null;
        configuration_boot_id: string | null;
      }
    >();
  if (!row) return closed();
  const spec = FleetReleaseSpec.safeParse(JSON.parse(row.spec_json));
  if (
    !spec.success ||
    !thinStorageReleaseGuardPinned(spec.data) ||
    spec.data.storage_authority_keys_sha256 !==
      (await storageAuthorityPublicKeys(env)).sha256
  )
    return closed();
  return row;
}
export async function thinStorageCallbackBearer(
  env: Env,
  row: Awaited<ReturnType<typeof readThinStorageLeaseRow>>,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.API_KEY_PEPPER),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToBase64url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(
          `pgcf-thin-storage/v1\n${row.node_id}\n${row.node_uid}\n${row.lease_id}\n${row.lease_revision}\n${row.profile_revision}\n${row.material_revision}\n${row.release_id}\n${row.spec_sha256}\n${row.assignment_revision}\n${row.region_revision}`,
        ),
      ),
    ),
  );
}
export async function authenticateThinStorage(c: ApiContext, nodeId: string) {
  const row = await readThinStorageLeaseRow(c.env, nodeId);
  if (
    !row.lease_id ||
    !row.lease_expires_at ||
    Date.parse(row.lease_expires_at) <= Date.now()
  )
    return closed();
  if (!timingSafeEqual(bearer(c), await thinStorageCallbackBearer(c.env, row)))
    throw new ApiError(
      "unauthorized",
      "Native physical storage lease required",
    );
  return row;
}

/** The current identity proof's revision; the next slow report claims its successor. */
function identityRevision(row: NodeThinStorageRow) {
  const authority = retainedPoolAuthority(row);
  return authority
    ? thinStorageInventory(authority).revision
    : row.authority_revision;
}
function retainedPoolAuthority(
  row: NodeThinStorageRow,
): NodeThinStorageAuthority | null {
  const parsed = NodeThinStorageAuthority.safeParse(
    row.authority_json ? JSON.parse(row.authority_json) : null,
  );
  if (!parsed.success) return null;
  const value = parsed.data;
  return value.node_id === row.node_id &&
    value.node_uid === row.node_uid &&
    value.cluster_uid === row.cluster_uid &&
    value.volume_group_uuid === row.volume_group_uuid &&
    value.profile_revision <= row.profile_revision &&
    value.revision === row.authority_revision
    ? value
    : null;
}

export const storageHoldSnapshotSql = `NOT EXISTS(SELECT 1 FROM (
  SELECT h.operation_id FROM database_start_admissions h WHERE h.node_id=node_thin_storage.node_id AND h.node_uid=node_thin_storage.node_uid AND h.storage_budget_bytes>0
  UNION ALL SELECT cleanup.operation_id FROM pool_cleanup_grants cleanup JOIN pool_bindings b ON b.id=cleanup.binding_id WHERE b.node_id=node_thin_storage.node_id AND b.node_uid=node_thin_storage.node_uid AND cleanup.state<>'completed'
) storage_hold WHERE NOT EXISTS(SELECT 1 FROM json_each(?) captured_hold WHERE captured_hold.value=storage_hold.operation_id))`;
export async function storageHolds(
  env: Env,
  nodeId: string,
  nodeUid: string,
  authority: NodeThinStorageAuthority | null | undefined,
  now = Date.now(),
) {
  const { poolCleanupExposureSql, poolCleanupReceiptSql } =
    await import("./storage-capacity.ts");
  const rows = await env.DB.prepare(
    `SELECT h.operation_id,h.database_id,h.storage_budget_bytes,h.storage_volume_json binding_json,d.storage_volume_json,d.storage_profile_json,d.storage_generation FROM database_start_admissions h JOIN databases d ON d.id=h.database_id WHERE h.node_id=? AND h.node_uid=? AND h.storage_budget_bytes>0
    UNION ALL SELECT cleanup.operation_id,b.database_id,${poolCleanupExposureSql()},${poolCleanupReceiptSql()},d.storage_volume_json,d.storage_profile_json,d.storage_generation
    FROM pool_cleanup_grants cleanup JOIN pool_bindings b ON b.id=cleanup.binding_id JOIN databases d ON d.id=b.database_id WHERE b.node_id=? AND b.node_uid=? AND cleanup.state<>'completed' ORDER BY operation_id`,
  )
    .bind(nodeId, nodeUid, nodeId, nodeUid)
    .all<{
      operation_id: string;
      database_id: string;
      storage_budget_bytes: number;
      storage_volume_json: string | null;
      binding_json: string | null;
      storage_profile_json: string | null;
      storage_generation: number;
    }>();
  const exposures = new Map<string, number>();
  let unknownVolumes = 0;
  for (const row of rows.results) {
    const known = knownStorageHoldVolume({
      binding: row.binding_json,
      current: row.storage_volume_json,
      profile: row.storage_profile_json,
      storageGeneration: row.storage_generation,
      databaseId: row.database_id,
      authority,
      now,
    });
    if (known === null) unknownVolumes++;
    const key = known ?? `unknown:${row.operation_id}`;
    exposures.set(
      key,
      Math.max(exposures.get(key) ?? 0, row.storage_budget_bytes),
    );
  }
  const bytes = [...exposures.values()].reduce((n, value) => n + value, 0);
  if (!Number.isSafeInteger(bytes)) return closed();
  return {
    bytes,
    count: rows.results.length,
    newVolumes: unknownVolumes,
    ids: new Set(rows.results.map((r) => r.database_id)),
    operations: rows.results.map((r) => r.operation_id),
    exposures,
  };
}
export function minimumHeadroom(
  profile: NodeThinStorageLease["profile"],
  authority: NodeThinStorageAuthority | null,
  holds: {
    bytes: number;
    newVolumes: number;
    ids: ReadonlySet<string>;
    exposures?: ReadonlyMap<string, number>;
  },
) {
  const retained = authority
    ? thinLogicalVolumeExposures(authority)
    : new Map();
  const unknown = {
    data: Number.MAX_SAFE_INTEGER,
    metadata: Number.MAX_SAFE_INTEGER,
  };
  if (!retained) return unknown;
  for (const [key, bytes] of holds.exposures ?? [])
    retained.set(key, Math.max(retained.get(key) ?? 0, bytes));
  const bytes =
      [...retained.values()].reduce((sum, value) => sum + value, 0) +
      (holds.exposures ? 0 : holds.bytes),
    chunks = Math.ceil(bytes / 65536);
  if (!Number.isSafeInteger(bytes)) return unknown;
  const required = {
    data: profile.data_reserve_bytes + bytes,
    metadata:
      profile.metadata_reserve_bytes +
      4 * Math.ceil(chunks / 126) * 4096 +
      holds.newVolumes * 16384,
  };
  return Number.isSafeInteger(required.data) &&
    Number.isSafeInteger(required.metadata)
    ? required
    : unknown;
}
/** Cloudflare's write decision for one reading under one identity proof; the rule the slow report
 * has always been held to: complete data accounting, the profile's geometry and free data and
 * metadata of at least the minimum headroom. */
export function thinStorageWriteAllowed(
  profile: ThinStorageProfile,
  identity: NodeThinStorageAuthority,
  physical: NodePhysicalStorage,
  headroom: { data: number; metadata: number },
) {
  const pool = physical.thin_pool;
  return Boolean(
    identity.data_accounting_complete &&
    identity.pool_uuid !== null &&
    pool &&
    pool.data_total_bytes <= profile.maximum_data_bytes &&
    pool.metadata_total_bytes === profile.metadata_bytes &&
    pool.data_total_bytes - pool.data_used_bytes_upper_bound >= headroom.data &&
    pool.metadata_total_bytes - pool.metadata_used_bytes_upper_bound >=
      headroom.metadata,
  );
}
/** The authority Cloudflare signs: the identity proof's facts and the fresher reading's physical
 * state, valid one guard from that reading and never past the identity proof. */
export function composeThinStorageAuthority(input: {
  identity: NodeThinStorageAuthority;
  inventory: { observed_at: number; expires_at: number; revision: number };
  reading: {
    observed_at: number;
    captured_at: string;
    physical: NodePhysicalStorage;
  };
  revision: number;
  guardSeconds: number;
  writeAllowed: boolean;
}) {
  return NodeThinStorageAuthority.parse({
    ...input.identity,
    revision: input.revision,
    observed_at: iso(input.reading.observed_at),
    captured_at: input.reading.captured_at,
    expires_at: iso(
      Math.min(
        input.reading.observed_at + input.guardSeconds * 1000,
        input.inventory.expires_at,
      ),
    ),
    write_allowed: input.writeAllowed,
    physical: input.reading.physical,
    inventory_observed_at: iso(input.inventory.observed_at),
    inventory_expires_at: iso(input.inventory.expires_at),
    inventory_revision: input.inventory.revision,
  });
}
/** The largest next first start or retained recovery a growth must leave room for. */
export async function nextThinStartupBytes(
  env: Env,
  nodeId: string,
  regionId: string,
  profile: ThinStorageProfile,
  allowNewDatabases: number,
) {
  return (
    (await env.DB.prepare(
      `SELECT MAX(MAX(s.storage_gib*1073741824,?)) bytes FROM databases d JOIN size_classes s ON s.id=d.size_class_id JOIN nodes n ON n.id=? WHERE (d.region_id=? AND (d.deleted_at IS NULL OR d.desired_state='deleted') AND s.storage_gib<=?) AND ((d.desired_state='running' AND d.node_id IS NULL AND ?=1 AND n.schedulable=1 AND n.database_placement_enabled=1 AND n.database_placement_closed_at IS NULL) OR (d.node_id=n.id AND ((d.desired_state='running' AND d.storage_protected_generation=d.generation AND d.storage_protected_at IS NOT NULL) OR (d.storage_volume_json IS NOT NULL AND EXISTS(SELECT 1 FROM operations stop WHERE ${currentStorageStopSql()}))))) AND NOT EXISTS(SELECT 1 FROM database_start_admissions h WHERE h.database_id=d.id AND h.storage_budget_bytes>0)`,
    )
      .bind(
        profile.startup_reserve_bytes,
        nodeId,
        regionId,
        profile.maximum_quota_gib,
        allowNewDatabases,
      )
      .first<number>("bytes")) ?? profile.startup_reserve_bytes
  );
}
/** The existing growth rule: the pool cannot cover the minimum headroom and the next start. */
export function thinPoolDataGrowthNeeded(
  profile: ThinStorageProfile,
  pool: NonNullable<NodePhysicalStorage["thin_pool"]>,
  required: { data: number },
  nextStartup: number,
) {
  return (
    pool.data_total_bytes - pool.data_used_bytes_upper_bound <
      required.data + nextStartup &&
    pool.data_total_bytes < profile.maximum_data_bytes
  );
}
export async function reserveThinStorageLease(
  env: Env,
  nodeId: string,
  allowPoolActions = true,
) {
  const current = await readCurrentNodeThinStorage(env, nodeId);
  if (!current) return closed();
  const row = await readThinStorageLeaseRow(env, nodeId);
  if (row.error_code) return null;
  if (row.lease_expires_at && Date.parse(row.lease_expires_at) > Date.now())
    return null;
  // Never reserve a lease or pool action that current sealed host custody cannot serve.
  if (!row.host_revision || !row.host_sha256 || !row.boot_id) return closed();
  const profile = current.profile,
    now = new Date().toISOString(),
    operation = newOperationId();
  // Expiry ends permission, not a retained LV's physical exposure. This is advisory input only.
  const advisory =
    current.authority ??
    current.reclamation ??
    retainedPoolAuthority(current.row);
  const holds = await storageHolds(
    env,
    nodeId,
    row.node_uid,
    advisory,
    current.authority ? Date.now() : Date.parse(advisory?.observed_at ?? now),
  );
  const required = minimumHeadroom(profile, advisory, holds);
  // A queued first start cannot obtain its bounded hold until the measured pool fits it.
  // Grow the existing finite pool for one eligible request; this is not a physical quota debit
  // for established databases and never creates a VPS order below the regional RAM trigger.
  const nextStartup = allowPoolActions
    ? await nextThinStartupBytes(
        env,
        nodeId,
        row.region_id,
        profile,
        row.allow_new_databases,
      )
    : profile.startup_reserve_bytes;

  let action = row.action_json
    ? NodeThinPoolAction.parse(JSON.parse(row.action_json))
    : null;
  const retained = retainedPoolAuthority(row);
  const pool = retained?.physical.thin_pool;
  if (!action && allowPoolActions) {
    if (!pool) {
      const references = await env.DB.prepare(
        "SELECT COUNT(*) count FROM databases WHERE node_id=? AND deleted_at IS NULL AND desired_state<>'deleted' AND storage_profile_json IS NOT NULL",
      )
        .bind(nodeId)
        .first<number>("count");
      if ((references ?? 0) > 0) {
        await env.DB.prepare(
          "UPDATE node_thin_storage SET status='blocked',error_code='thin_storage_retained_pool_missing' WHERE node_id=? AND profile_revision=? AND lease_revision=?",
        )
          .bind(nodeId, row.profile_revision, row.lease_revision)
          .run();
        return null;
      }
      const unresolved = await env.DB.prepare(
        `SELECT EXISTS(SELECT 1 FROM pool_bindings b WHERE b.node_id=? AND b.state NOT IN('released','refused') AND json_extract(b.scope_json,'$.storage.backend')='lvm-thin-v1')
        OR EXISTS(SELECT 1 FROM database_runtime_holders h JOIN databases d ON d.id=h.database_id WHERE d.node_id=? AND d.storage_profile_json IS NOT NULL AND h.kind='pool' AND h.state NOT IN('released','refused')) held`,
      )
        .bind(nodeId, nodeId)
        .first<number>("held");
      // Deleted obligations need a new absence proof, never replacement-pool permission.
      if (
        holds.count === 0 &&
        !unresolved &&
        required.data <= profile.maximum_data_bytes
      )
        action = NodeThinPoolAction.parse({
          kind: "initialize",
          state: "pending",
          nonce: operation,
          target_data_bytes: profile.initial_data_bytes,
          target_metadata_bytes: profile.metadata_bytes,
          expected_pool_uuid: null,
          driver_pod_uid: null,
          boot_id: null,
          dispatched_at: null,
          deadline_at: null,
        });
    } else if (
      current.authority &&
      required.data <= profile.maximum_data_bytes &&
      pool.metadata_total_bytes < profile.metadata_bytes
    ) {
      action = NodeThinPoolAction.parse({
        kind: "grow",
        state: "pending",
        nonce: operation,
        target_data_bytes: pool.data_total_bytes,
        target_metadata_bytes: profile.metadata_bytes,
        expected_pool_uuid: current.authority.pool_uuid,
        driver_pod_uid: null,
        boot_id: null,
        dispatched_at: null,
        deadline_at: null,
      });
    } else if (
      current.authority &&
      required.data <= profile.maximum_data_bytes &&
      thinPoolDataGrowthNeeded(profile, pool, required, nextStartup)
    ) {
      const target = Math.min(
        profile.maximum_data_bytes,
        Math.max(
          pool.data_total_bytes + profile.growth_bytes,
          pool.data_used_bytes_upper_bound + required.data + nextStartup,
        ),
      );
      const extent = 4 * 1024 * 1024;
      action = NodeThinPoolAction.parse({
        kind: "grow",
        state: "pending",
        nonce: operation,
        target_data_bytes: Math.ceil(target / extent) * extent,
        target_metadata_bytes: profile.metadata_bytes,
        expected_pool_uuid: current.authority.pool_uuid,
        driver_pod_uid: null,
        boot_id: null,
        dispatched_at: null,
        deadline_at: null,
      });
    }
  }
  const expires = new Date(
    Date.parse(now) + THIN_STORAGE_LEASE_SECONDS * 1000,
  ).toISOString();
  // The newest sample accepted before this lease bounds what its own LVM reading may show.
  const result = await env.DB.prepare(
    `UPDATE node_thin_storage SET lease_id=?,lease_revision=lease_revision+1,lease_expires_at=?,action_json=?,updated_at=?,lease_sample_observed_at=sample_observed_at,lease_sample_data_used_bytes=sample_data_used_bytes WHERE node_id=? AND profile_revision=? AND lease_revision=? AND (lease_expires_at IS NULL OR julianday(lease_expires_at)<=julianday('now')) AND ${thinStorageAuthoritySql}
      AND (?=0 OR ((NOT EXISTS(SELECT 1 FROM database_start_admissions a WHERE a.node_id=node_thin_storage.node_id AND a.storage_budget_bytes>0)
        AND NOT EXISTS(SELECT 1 FROM pool_bindings b WHERE b.node_id=node_thin_storage.node_id AND b.state NOT IN('released','refused') AND json_extract(b.scope_json,'$.storage.backend')='lvm-thin-v1'))
        AND (NOT EXISTS(SELECT 1 FROM database_runtime_holders h JOIN databases d ON d.id=h.database_id WHERE d.node_id=node_thin_storage.node_id AND d.storage_profile_json IS NOT NULL AND h.kind='pool' AND h.state NOT IN('released','refused'))
        AND NOT EXISTS(SELECT 1 FROM databases d WHERE d.node_id=node_thin_storage.node_id AND d.deleted_at IS NULL AND d.desired_state<>'deleted' AND d.storage_profile_json IS NOT NULL))))`,
  )
    .bind(
      operation,
      expires,
      action ? JSON.stringify(action) : null,
      now,
      nodeId,
      row.profile_revision,
      row.lease_revision,
      Number(action?.kind === "initialize"),
    )
    .run();
  if (result.meta.changes !== 1) return null;
  return await readThinStorageLeaseRow(env, nodeId);
}
export async function prepareThinStorageLease(
  env: Env,
  nodeId: string,
  allowPoolActions = true,
) {
  return (await reserveThinStorageLease(env, nodeId, allowPoolActions))
    ? await thinStorageInput(env, nodeId)
    : null;
}
export async function thinStorageStatus(env: Env, nodeId: string) {
  const row = await readThinStorageLeaseRow(env, nodeId);
  if (
    !row.lease_id ||
    !row.lease_expires_at ||
    Date.parse(row.lease_expires_at) <= Date.now()
  )
    return closed();
  return {
    operation_id: row.lease_id,
    revision: row.lease_revision,
    node_uid: row.node_uid,
    release_id: row.release_id,
    spec_sha256: row.spec_sha256,
    assignment_revision: row.assignment_revision,
    region_revision: row.region_revision,
  };
}
export async function thinStorageInput(
  env: Env,
  nodeId: string,
  required?: { data: number; metadata: number },
): Promise<NodeThinStorageInput> {
  return buildThinStorageInput(
    env,
    nodeId,
    await readThinStorageLeaseRow(env, nodeId),
    required,
  );
}
async function buildThinStorageInput(
  env: Env,
  nodeId: string,
  row: Awaited<ReturnType<typeof readThinStorageLeaseRow>>,
  required?: { data: number; metadata: number },
): Promise<NodeThinStorageInput> {
  const current = await readCurrentNodeThinStorage(env, nodeId);
  if (
    !current ||
    !row.lease_id ||
    !row.lease_expires_at ||
    Date.parse(row.lease_expires_at) <= Date.now()
  )
    return closed();
  const ref = await loadCurrentRegionMaterialReference(
    env.DB,
    row.region_id,
    "join_bundle",
  );
  if (ref.revision !== row.material_revision) return closed();
  const bundle = await loadRegionJoinBundle(env.DB, env.CREDENTIAL_KEYS, ref);
  if (bundle.kube_system_uid !== row.cluster_uid) return closed();
  const spec = FleetReleaseSpec.parse(JSON.parse(row.spec_json));
  const hostExtension = spec.components.find(
    (component) => component.name === "pgcf-sandbox-controller",
  );
  if (
    !hostExtension ||
    hostExtension.kind !== "image" ||
    !row.host_revision ||
    !row.host_sha256 ||
    !row.boot_id
  )
    return closed();
  const host = await loadNodeHostConfiguration(env, {
    node_id: nodeId,
    node_uid: row.node_uid,
    cluster_uid: row.cluster_uid,
    material_revision: row.material_revision,
    revision: row.host_revision,
    sha256: row.host_sha256,
  });
  const records = await env.DB.prepare(
    `SELECT d.*,h.operation_id startup_operation,h.node_uid startup_uid,h.storage_budget_bytes,(SELECT json_object('operation_id',stop.id,'kind',stop.kind,'generation',stop.generation) FROM operations stop WHERE ${currentStorageStopSql()} ORDER BY stop.created_at DESC LIMIT 1) stop_operation FROM databases d LEFT JOIN database_start_admissions h ON h.database_id=d.id AND h.generation=(SELECT MAX(x.generation) FROM database_start_admissions x WHERE x.database_id=d.id AND x.generation<=d.generation AND x.storage_budget_bytes>0 AND x.budget_bytes>0) AND h.storage_budget_bytes>0 AND h.budget_bytes>0 WHERE d.node_id=? AND d.region_id=? ORDER BY d.id`,
  )
    .bind(nodeId, row.region_id)
    .all<
      DatabaseRow & {
        startup_operation: string | null;
        stop_operation: string | null;
        startup_uid: string | null;
        storage_budget_bytes: number | null;
      }
    >();
  const advisory =
    current.authority ??
    current.reclamation ??
    retainedPoolAuthority(current.row);
  const poolCapable =
    (await postgresPoolCapable(env.DB, row.region_id)) ||
    (await postgresPoolQualificationCapable(env.DB, row.region_id));
  const poolCustody = new Map(
    await Promise.all(
      records.results.map(
        async (record) =>
          [
            record.id,
            await poolHostCustodyForDatabase(env, record.id, poolCapable),
          ] as const,
      ),
    ),
  );
  const requiredHeadroom =
    required ??
    minimumHeadroom(
      current.profile,
      advisory,
      await storageHolds(
        env,
        nodeId,
        row.node_uid,
        advisory,
        current.authority
          ? Date.now()
          : Date.parse(advisory?.observed_at ?? row.updated_at),
      ),
    );
  const callback = new URL(
    `/internal/v1/node-thin-storage/${nodeId}`,
    env.NODE_BOOTSTRAP_CALLBACK_URL,
  );
  if (callback.protocol !== "https:") return closed();
  return NodeThinStorageInput.parse({
    class_creation_allowed:
      !row.authority_json ||
      NodeThinStorageAuthority.parse(JSON.parse(row.authority_json))
        .storage_class !== thinStorageClass(row.profile_sha256),
    lease: {
      operation_id: row.lease_id,
      release_id: row.release_id,
      spec_sha256: row.spec_sha256,
      assignment_revision: row.assignment_revision,
      region_revision: row.region_revision,
      revision: row.lease_revision,
      authority_revision: identityRevision(row),
      node_id: nodeId,
      region_id: row.region_id,
      node_uid: row.node_uid,
      cluster_uid: row.cluster_uid,
      name: row.k8s_node_name,
      provider_instance_id: row.provider_instance_id,
      address: row.address,
      volume_group_uuid: row.volume_group_uuid,
      pool_uuid: retainedPoolAuthority(row)?.pool_uuid ?? null,
      profile_revision: row.profile_revision,
      profile_sha256: row.profile_sha256,
      profile: current.profile,
      material_revision: row.material_revision,
      kernel_version: spec.thin_storage_qualification?.kernel_version ?? null,
      boot_id: row.boot_id,
      configuration_boot_id: row.configuration_boot_id,
      issued_at: row.updated_at,
      expires_at: row.lease_expires_at,
      required_data_free_bytes: requiredHeadroom.data,
      required_metadata_free_bytes: requiredHeadroom.metadata,
      action: row.action_json ? JSON.parse(row.action_json) : null,
      databases: records.results.map((r) => ({
        id: r.id,
        generation: r.generation,
        storage_generation: r.storage_generation ?? 1,
        desired_state: r.desired_state,
        archive_path: r.archive_path,
        power_operation: r.power_operation ?? null,
        stop_operation: r.stop_operation ? JSON.parse(r.stop_operation) : null,
        storage: r.storage_profile_json
          ? JSON.parse(r.storage_profile_json)
          : null,
        volume: r.storage_volume_json
          ? JSON.parse(r.storage_volume_json)
          : null,
        startup: r.startup_operation
          ? {
              operation_id: r.startup_operation,
              // The hold of the start under way, which role changes since have not ended.
              generation: r.generation,
              node_uid: r.startup_uid,
              budget_bytes: r.storage_budget_bytes,
              expires_at: row.lease_expires_at,
            }
          : null,
        ...(poolCustody.get(r.id) ? { pool: poolCustody.get(r.id) } : {}),
      })),
    },
    host_extension: {
      image: hostExtension.reference,
      version: hostExtension.version,
      sha256: hostExtension.sha256,
    },
    host_configuration: host,
    cluster_endpoint: bundle.cluster_endpoint,
    talos_admin_config: bundle.talos_admin_config,
    kubeconfig: bundle.kubeconfig,
    callback: {
      url: callback.href,
      bearer: await thinStorageCallbackBearer(env, row),
    },
  });
}
export async function dispatchThinPoolAction(
  env: Env,
  nodeId: string,
  nonce: string,
  driverUid: string,
  bootId: string,
) {
  const row = await readThinStorageLeaseRow(env, nodeId);
  if (!row.action_json || !row.lease_expires_at) return closed();
  const action = NodeThinPoolAction.parse(JSON.parse(row.action_json));
  if (action.state !== "pending" || action.nonce !== nonce) return closed();
  const dispatched = NodeThinPoolAction.parse({
    ...action,
    state: "dispatched",
    driver_pod_uid: driverUid,
    boot_id: bootId,
    dispatched_at: new Date().toISOString(),
    deadline_at: row.lease_expires_at,
  });
  const result = await env.DB.prepare(
    `UPDATE node_thin_storage SET action_json=? WHERE node_id=? AND lease_revision=? AND action_json=? AND julianday(lease_expires_at)>julianday('now') AND ${thinStorageAuthoritySql}`,
  )
    .bind(
      JSON.stringify(dispatched),
      nodeId,
      row.lease_revision,
      row.action_json,
    )
    .run();
  if (result.meta.changes !== 1) return closed();
  return { dispatched: true };
}

/** Temporary full-volume exposure across both identity reads and exact captured holds.
 * io.max's metadata/swap bypass cannot justify a rate-only physical growth bound. */
function thinWriteAllowance(
  writers: readonly (NodeThinStorageAuthority | null)[],
  holds: { bytes: number; exposures?: ReadonlyMap<string, number> },
) {
  const exposure = new Map(holds.exposures);
  for (const authority of writers) {
    if (!authority) continue;
    const retained = thinLogicalVolumeExposures(authority);
    if (!retained) return Number.MAX_SAFE_INTEGER;
    for (const [key, bytes] of retained)
      exposure.set(key, Math.max(exposure.get(key) ?? 0, bytes));
  }
  const total =
    [...exposure.values()].reduce((sum, value) => sum + value, 0) +
    (holds.exposures ? 0 : holds.bytes);
  return Number.isSafeInteger(total) ? total : Number.MAX_SAFE_INTEGER;
}

/** The slow report is an identity proof: its read started at the lease's issue, it stays usable
 * THIN_INVENTORY_MAX_SECONDS and it carries its own revision. Cloudflare composes the authority from
 * it and the fresher of its reading and the current one, even when that authority already expired. */
export async function recordThinStorageReport(
  env: Env,
  nodeId: string,
  raw: NodeThinStorageReport,
) {
  return acceptIdentityProof(env, nodeId, NodeThinStorageReport.parse(raw));
}
async function acceptIdentityProof(
  env: Env,
  nodeId: string,
  report: NodeThinStorageReport,
) {
  let row = await readThinStorageLeaseRow(env, nodeId);
  const input = await thinStorageInput(env, nodeId),
    lease = input.lease,
    now = Date.now(),
    a = report.authority,
    issued = Date.parse(lease.issued_at),
    inventory = {
      observed_at: issued,
      expires_at: issued + THIN_INVENTORY_MAX_SECONDS * 1000,
      revision: lease.authority_revision + 1,
    };
  // A report for another lease, or one past its lease, ends nothing: the executor retries.
  if (
    report.expected_revision !== row.lease_revision ||
    a.revision !== inventory.revision ||
    (a.inventory_observed_at !== undefined &&
      (a.inventory_observed_at !== iso(inventory.observed_at) ||
        a.inventory_expires_at !== iso(inventory.expires_at) ||
        a.inventory_revision !== inventory.revision)) ||
    a.observed_at !== lease.issued_at ||
    a.expires_at !== lease.expires_at ||
    Date.parse(a.expires_at) <= now ||
    Date.parse(a.captured_at) > now + 5000
  )
    return closed();
  // Identity, qualification and uncertain pool-action refusals block the node, as they did before
  // the executor's refused callback became a transient failure.
  const block = async (code: string): Promise<never> => {
    await env.DB.prepare(
      "UPDATE node_thin_storage SET status='blocked',error_code=?,lease_id=NULL,lease_expires_at=NULL,sample_nonce=NULL,sample_nonce_issued_at=NULL,sample_observed_at=NULL,sample_data_used_bytes=NULL,lease_sample_observed_at=NULL,lease_sample_data_used_bytes=NULL WHERE node_id=? AND lease_id=? AND lease_revision=?",
    )
      .bind(code, nodeId, row.lease_id, row.lease_revision)
      .run();
    return closed();
  };
  const prior = row.qualification_json
    ? (JSON.parse(row.qualification_json) as { system_uuid?: string })
    : null;
  if (
    a.node_id !== nodeId ||
    a.node_uid !== row.node_uid ||
    a.cluster_uid !== row.cluster_uid ||
    a.name !== lease.name ||
    a.profile_revision !== row.profile_revision ||
    a.profile_sha256 !== row.profile_sha256 ||
    a.storage_class !== thinStorageClass(row.profile_sha256) ||
    a.volume_group_uuid !== row.volume_group_uuid ||
    a.driver_image !== row.qualified_driver_image ||
    report.boot_id !== lease.boot_id ||
    (prior?.system_uuid && prior.system_uuid !== report.system_uuid)
  )
    return block("thin_storage_report_identity_changed");
  if (
    report.software.driver_sha256 !== sources.driver.binary_sha256 ||
    report.software.lvm_sha256 !== sources.driver.lvm_binary_sha256 ||
    report.software.tools_sha256 !== sources.thin_tools.binary_sha256 ||
    report.software.thin_tools_version !== sources.thin_tools.version ||
    !report.software.thin_module_live ||
    !report.software.cgroup_host_view ||
    report.software.host_extension_image !== input.host_extension.image ||
    report.software.host_configuration_sha256 !==
      input.host_configuration.status.sha256 ||
    (lease.kernel_version !== null &&
      report.software.kernel_version !== lease.kernel_version)
  )
    return block("thin_storage_report_unqualified");
  if (lease.action) {
    const action = lease.action,
      pool = a.physical.thin_pool;
    if (
      !pool ||
      pool.data_total_bytes < action.target_data_bytes ||
      pool.metadata_total_bytes < action.target_metadata_bytes ||
      (action.kind === "grow" && a.pool_uuid !== action.expected_pool_uuid) ||
      (action.kind === "initialize" &&
        report.pool_tag !== `pgcf.node.${row.node_uid}`) ||
      (action.state === "pending" && report.action_applied)
    )
      return block("thin_storage_action_unconfirmed");
  }
  // Receipt identity is judged at the proof's lease issue with a guard-length view. The 95 s
  // executor lease is not runtime write authority and must not turn known receipts into new LVs.
  const proofAuthority = composeThinStorageAuthority({
      identity: a,
      inventory,
      reading: {
        observed_at: issued,
        captured_at: a.captured_at,
        physical: a.physical,
      },
      revision: a.revision,
      guardSeconds: lease.profile.guard_seconds,
      writeAllowed: a.write_allowed,
    }),
    holds = await storageHolds(
      env,
      nodeId,
      row.node_uid,
      proofAuthority,
      issued,
    ),
    headroom = minimumHeadroom(lease.profile, a, holds),
    pool = a.physical.thin_pool,
    proofWriteAllowed = thinStorageWriteAllowed(
      lease.profile,
      a,
      a.physical,
      headroom,
    );
  // The read's database list is the one its lease was issued with, and its turn lasts most of a
  // minute. A database placed meanwhile, or one whose PersistentVolume the read could not see yet,
  // leaves a thin LV the read cannot attribute, and installing it would deny writes on the whole
  // node until the next proof. When every unattributed thin LV is new to the stored identity and
  // they fit the unbound startup holds (the rule a sample applies to new LVs), the read is stale:
  // refuse it for a retry with the current list while samples keep renewing the stored identity.
  if (!a.data_accounting_complete) {
    const attributed = new Set(a.volumes.map((volume) => volume.lv_uuid)),
      known = retainedPoolAuthority(row)?.physical_lvs ?? [],
      unattributed = a.physical_lvs.filter(
        (lv) => lv.segtype === "thin" && !attributed.has(lv.lv_uuid),
      ),
      bytes = unattributed.reduce((sum, lv) => sum + lv.size_bytes, 0),
      unbound = [...holds.exposures]
        .filter(([key]) => key.startsWith("unknown:"))
        .reduce((sum, [, value]) => sum + value, 0);
    if (
      unattributed.length > 0 &&
      a.physical_lvs.every((lv) =>
        ["thin", "thin-pool", "linear"].includes(lv.segtype),
      ) &&
      unattributed.every(
        (lv) =>
          !known.some(
            (read) => read.lv_uuid === lv.lv_uuid || read.name === lv.name,
          ),
      ) &&
      unattributed.length <= holds.newVolumes &&
      Number.isSafeInteger(bytes) &&
      bytes <= unbound
    )
      return closed();
  }
  // A first identity still sees its newly measured LV and an unbound startup hold separately.
  // Preserve that conservative denial while installing verified receipts under the existing CAS.
  // Only a later fresh sample can use the installed exact bindings to remove double exposure;
  // the executor's earlier hold-only decision never grants writes on Cloudflare's behalf.
  for (const v of a.volumes) {
    const database = lease.databases.find((d) => d.id === v.database_id);
    // A power, role, resize or restore request may supersede a valid executor input during its
    // read. Refuse that stale turn for a retry; it proves no node-wide identity failure.
    if (
      database &&
      (database.generation > v.generation ||
        database.storage_generation > v.storage_generation)
    )
      return closed();
    if (
      !database ||
      database.generation !== v.generation ||
      database.storage_generation !== v.storage_generation ||
      (database.storage &&
        (v.storage_class !== database.storage.storage_class ||
          v.volume_attributes_class !==
            database.storage.volume_attributes_class)) ||
      !a.physical_lvs.some(
        (lv) => lv.lv_uuid === v.lv_uuid && lv.name === v.volume_handle,
      )
    )
      return block("thin_storage_report_identity_changed");
  }
  const stored = retainedPoolAuthority(row);
  // The proof's own reading must not exceed the newest sample before its lease plus what Cloudflare
  // allowed since: the sampler or a writer's limit was wrong, so the node stops being renewed.
  if (
    pool &&
    row.lease_sample_observed_at !== null &&
    row.lease_sample_data_used_bytes !== null
  ) {
    const allowed =
      row.lease_sample_data_used_bytes + thinWriteAllowance([stored, a], holds);
    // Both LVM readers round percentages to hundredths and charge another hundredth. The
    // conservative upper bound can rise after growth without a write; compare its lower bound.
    const proofUsedLowerBound = Math.max(
      0,
      pool.data_used_bytes_upper_bound -
        Math.ceil(pool.data_total_bytes / 5000),
    );
    if (proofUsedLowerBound > allowed) {
      console.error(
        JSON.stringify({
          event: "thin_storage_headroom_inconsistent",
          node_id: nodeId,
          sample_observed_at: row.lease_sample_observed_at,
          sample_data_used_bytes: row.lease_sample_data_used_bytes,
          proof_data_used_bytes: pool.data_used_bytes_upper_bound,
          allowed_bytes: allowed,
        }),
      );
      return block("thin_storage_headroom_inconsistent");
    }
  }
  const receipts: {
    database: (typeof lease.databases)[number];
    storage: NonNullable<(typeof lease.databases)[number]["storage"]>;
    value: string;
  }[] = [];
  for (const volume of a.volumes) {
    const database = lease.databases.find((d) => d.id === volume.database_id)!;
    if (!database.storage) continue;
    const receipt = DatabaseStorageVolumeReceipt.parse({
      storage_generation: volume.storage_generation,
      storage_uid: volume.storage_uid,
      namespace_uid: volume.namespace_uid,
      cluster_uid: volume.cluster_uid,
      node_uid: a.node_uid,
      volume_group_uuid: a.volume_group_uuid,
      pool_uuid: a.pool_uuid,
      volume_handle: volume.volume_handle,
      lv_uuid: volume.lv_uuid,
      pvc_uid: volume.pvc_uid,
      pv_uid: volume.pv_uid,
    });
    const value = JSON.stringify(receipt);
    if (database.volume && JSON.stringify(database.volume) !== value)
      return block("thin_storage_report_identity_changed");
    receipts.push({ database, storage: database.storage, value });
  }
  const validated = row,
    qualification = JSON.stringify({
      system_uuid: report.system_uuid,
      boot_id: report.boot_id,
      profile_revision: row.profile_revision,
      profile_sha256: await installationHash(lease.profile),
      release_id: row.release_id,
      spec_sha256: row.spec_sha256,
      assignment_revision: row.assignment_revision,
      region_revision: row.region_revision,
      software: report.software,
    }),
    reportedVolumes = JSON.stringify(a.volumes),
    heldOperations = JSON.stringify(holds.operations);
  // Validate custody, inventory and receipts once. A fast renewal changes only the reading and
  // revision; after a conflict the one row read below is enough to compose with that fresh sample.
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = retainedPoolAuthority(row),
      freshPool = current?.physical.thin_pool,
      fresher =
        current &&
        pool &&
        freshPool &&
        current.pool_uuid === a.pool_uuid &&
        current.profile_revision === a.profile_revision &&
        freshPool.metadata_total_bytes === pool.metadata_total_bytes &&
        freshPool.data_total_bytes >= pool.data_total_bytes &&
        Date.parse(current.observed_at) > issued
          ? current
          : null;
    // The executor reads the final post-action geometry. A larger later sample cannot describe the
    // same non-shrinking pool, even with a dispatched growth; never use its inflated free space.
    if (fresher && freshPool!.data_total_bytes > pool!.data_total_bytes)
      return block("thin_storage_headroom_inconsistent");
    const reading = fresher
        ? {
            observed_at: Date.parse(fresher.observed_at),
            captured_at: fresher.captured_at,
            physical: fresher.physical,
          }
        : {
            observed_at: issued,
            captured_at: a.captured_at,
            physical: a.physical,
          },
      writeAllowed =
        proofWriteAllowed &&
        thinStorageWriteAllowed(lease.profile, a, reading.physical, headroom),
      composed = composeThinStorageAuthority({
        identity: a,
        inventory,
        reading,
        revision: row.authority_revision + 1,
        guardSeconds: lease.profile.guard_seconds,
        writeAllowed,
      }),
      serialized = JSON.stringify(composed),
      received = new Date(Date.now()).toISOString(),
      accepted = `EXISTS(SELECT 1 FROM node_thin_storage t WHERE t.node_id=? AND t.authority_revision=? AND t.authority_json=?)`,
      bindings = [nodeId, composed.revision, serialized];
    const protectionSubjects = [
      ...new Set([
        ...composed.protections.map((proof) => proof.database_id),
        ...composed.volumes
          .filter((volume) => volume.quiesced === true)
          .map((volume) => volume.database_id),
      ]),
    ];
    const protectedAdmissions = protectionSubjects.length
      ? (
          await env.DB.prepare(
            `SELECT id FROM databases WHERE node_id=? AND id IN(SELECT value FROM json_each(?))
      AND desired_state='running' AND deleted_at IS NULL
      AND (storage_protected_at IS NULL OR storage_protected_generation IS NOT generation OR storage_protected_operation IS NULL
        OR observed_state<>'provisioning'
        OR EXISTS(SELECT 1 FROM json_each(?) changed_proof WHERE json_extract(changed_proof.value,'$.database_id')=databases.id
          AND json_extract(changed_proof.value,'$.operation_id') IS NOT NULL
          AND (json_extract(changed_proof.value,'$.operation_id') IS NOT storage_protected_operation
            OR observed_power<>'hibernated' OR observed_generation<>generation)))`,
          )
            .bind(
              nodeId,
              JSON.stringify(protectionSubjects),
              JSON.stringify(composed.protections),
            )
            .all<{ id: string }>()
        ).results.map((record) => record.id)
      : [];
    const execute = async (mutation?: AdmissionMutation) => {
      const guards = new Map(
        protectedAdmissions.map((id) => [id, mutation!.guard(id)]),
      );
      const allGuards = [...guards.values()],
        allGuardSql = allGuards.length
          ? allGuards.map((guard) => `(${guard.sql})`).join(" AND ")
          : "1=1",
        statements = [
          env.DB.prepare(
            `UPDATE node_thin_storage SET authority_revision=?,authority_json=?,authority_received_at=?,inventory_physical_json=?,qualification_json=?,status=?,error_code=NULL,lease_id=NULL,lease_expires_at=NULL,action_json=NULL WHERE node_id=? AND lease_revision=? AND authority_revision=? AND profile_revision=? AND julianday(lease_expires_at)>julianday('now') AND ${thinStorageAuthoritySql} AND ${storageHoldSnapshotSql} AND NOT EXISTS(SELECT 1 FROM json_each(?) volume WHERE NOT EXISTS(SELECT 1 FROM databases d WHERE d.id=json_extract(volume.value,'$.database_id') AND d.node_id=node_thin_storage.node_id AND d.generation=json_extract(volume.value,'$.generation') AND d.storage_generation=json_extract(volume.value,'$.storage_generation'))) AND (${allGuardSql})`,
          ).bind(
            composed.revision,
            serialized,
            received,
            JSON.stringify(a.physical),
            qualification,
            writeAllowed ? "ready" : "blocked",
            nodeId,
            row.lease_revision,
            row.authority_revision,
            row.profile_revision,
            heldOperations,
            reportedVolumes,
            ...allGuards.flatMap((guard) => guard.bindings),
          ),
        ];
      for (const { database, storage, value } of receipts)
        statements.push(
          env.DB.prepare(
            `UPDATE databases SET storage_volume_json=? WHERE id=? AND node_id=? AND generation=? AND storage_generation=? AND json_extract(storage_profile_json,'$.node_uid')=? AND json_extract(storage_profile_json,'$.pool_uuid')=? AND (storage_volume_json IS NULL OR storage_volume_json=?) AND ${accepted}`,
          ).bind(
            value,
            database.id,
            nodeId,
            database.generation,
            database.storage_generation,
            storage.node_uid,
            storage.pool_uuid,
            value,
            ...bindings,
          ),
        );
      statements.push(
        ...storageHoldVolumeStatements(env.DB, composed),
        ...storageProtectionStatements(env.DB, composed, guards),
      );
      return mutation ? mutation.batch(statements) : env.DB.batch(statements);
    };
    const results = protectedAdmissions.length
      ? await withAdmissionMutation(env, protectedAdmissions, execute)
      : await execute();
    if (results[0]!.meta.changes === 1)
      return {
        accepted: true,
        revision: composed.revision,
        write_allowed: composed.write_allowed,
      };
    const after = await readThinStorageLeaseRow(env, nodeId);
    if (
      after.authority_revision === row.authority_revision ||
      identityRevision(after) !== identityRevision(validated) ||
      (
        [
          "lease_id",
          "lease_revision",
          "lease_expires_at",
          "updated_at",
          "profile_revision",
          "profile_sha256",
          "profile_json",
          "material_revision",
          "action_json",
          "qualification_json",
          "node_uid",
          "cluster_uid",
          "volume_group_uuid",
          "release_id",
          "spec_sha256",
          "assignment_revision",
          "region_revision",
          "host_revision",
          "host_sha256",
          "boot_id",
          "configuration_boot_id",
          "error_code",
          "lease_sample_observed_at",
          "lease_sample_data_used_bytes",
        ] as const
      ).some((field) => after[field] !== validated[field])
    )
      return closed();
    row = after;
  }
  return closed();
}

/** One identity/key import; each grant keeps the default TTL and draws its own nonce. */
async function signNativeRelayCapabilities(
  env: Env,
  scope: {
    operation: string;
    node: string;
    region: string;
    revision: number;
    capability: "talos_api" | "kubernetes_api";
    address: string;
    callback: string;
  },
  count: number,
) {
  const service = env.BOOTSTRAP_RELAY_SERVICE;
  if (!service) return closed();
  const endpoint = new URL(env.BOOTSTRAP_RELAY_URL);
  if (
    !["https:", "http:"].includes(endpoint.protocol) ||
    endpoint.pathname !== BOOTSTRAP_RELAY_PATH ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    return closed();
  const signal = AbortSignal.timeout(10000);
  const response = await service.fetch(
    new Request(new URL(BOOTSTRAP_RELAY_IDENTITY_PATH, endpoint), {
      signal,
      redirect: "manual",
    }),
  );
  if (response.status !== 200) return closed();
  const identity = await readBootstrapRelayIdentity(response, signal);
  if (
    identity.region !== env.BOOTSTRAP_RELAY_ISSUER_REGION ||
    identity.issuer_region !== identity.region ||
    !identity.allowed_target_regions.includes(scope.region) ||
    !identity.capabilities.includes(scope.capability)
  )
    return closed();
  const key = await bootstrapTransportSigningKey(
    env.BOOTSTRAP_RELAY_SIGNING_KEYS,
  );
  const tokens = await Promise.all(
    Array.from({ length: count }, () =>
      signBootstrapRelay({
        ...key,
        operation: scope.operation,
        node: scope.node,
        region: scope.region,
        issuer_region: identity.region,
        relay_epoch: identity.relay_epoch,
        revision: scope.revision,
        capability: scope.capability,
        address: scope.address,
      }),
    ),
  );
  return NodeBootstrapTransportBatch.parse({
    websocket_url: scope.callback.replace(/^https:/, "wss:") + "/relay",
    tokens,
    expectedTarget: {
      ip: scope.address,
      port: BOOTSTRAP_PORTS[scope.capability],
    },
  });
}
/** Legacy singleton used by qualification; its caller fences the qualification run. */
export async function signNativeRelayCapability(
  env: Env,
  scope: Parameters<typeof signNativeRelayCapabilities>[1],
) {
  const { tokens, ...transport } = await signNativeRelayCapabilities(
    env,
    scope,
    1,
  );
  return NodeBootstrapTransport.parse({ ...transport, token: tokens[0] });
}
function thinTransportScope(
  row: Awaited<ReturnType<typeof readThinStorageLeaseRow>>,
) {
  // Actions and renewed authority may advance within this lease. They do not change its target.
  return JSON.stringify([
    row.node_id,
    row.node_uid,
    row.cluster_uid,
    row.region_id,
    row.k8s_node_name,
    row.provider_instance_id,
    row.address,
    row.volume_group_uuid,
    row.lease_id,
    row.lease_revision,
    row.lease_expires_at,
    row.profile_revision,
    row.profile_sha256,
    row.profile_json,
    row.qualified_driver_image,
    row.material_revision,
    row.release_id,
    row.spec_sha256,
    row.assignment_revision,
    row.region_revision,
    row.host_revision,
    row.host_sha256,
    row.boot_id,
    row.configuration_boot_id,
  ]);
}
export async function issueThinStorageTransport(
  env: Env,
  nodeId: string,
  capability: "talos_api" | "kubernetes_api",
  count = 1,
) {
  count = RelayGrantCount.parse(count);
  const row = await readThinStorageLeaseRow(env, nodeId),
    input = await buildThinStorageInput(env, nodeId, row);
  const transport = await signNativeRelayCapabilities(
    env,
    {
      operation: input.lease.operation_id,
      node: nodeId,
      region: row.region_id,
      revision: row.lease_revision,
      capability,
      address:
        capability === "talos_api"
          ? row.address
          : new URL(input.cluster_endpoint).hostname,
      callback: input.callback.url,
    },
    count,
  );
  const current = await readThinStorageLeaseRow(env, nodeId);
  if (
    thinTransportScope(current) !== thinTransportScope(row) ||
    !current.lease_expires_at ||
    Date.parse(current.lease_expires_at) <= Date.now()
  )
    return closed();
  if (count > 1) return transport;
  const { tokens, ...singleton } = transport;
  return NodeBootstrapTransport.parse({ ...singleton, token: tokens[0] });
}

/** Ask the node's NodeBootstrap for an identity turn now instead of at its cadence. */
export async function requestThinStorageTurn(env: Env, nodeId: string) {
  await env.NODE_BOOTSTRAP.get(
    env.NODE_BOOTSTRAP.idFromName(`thin-storage:${nodeId}`),
  ).thinStorageDue(nodeId);
}
/** A thin database just placed on a node, or starting there again, needs the node's next identity
 * proof: only a proof reads a new volume into its receipt or measures the Pod writing to it, and the
 * first write token waits for that. Ask for the turn now instead of at the next cadence. */
export async function requestThinStorageTurnsFor(
  env: Env,
  databaseIds: readonly string[],
) {
  if (databaseIds.length === 0) return;
  const nodes = await env.DB.prepare(
    "SELECT DISTINCT d.node_id FROM databases d JOIN node_thin_storage t ON t.node_id=d.node_id WHERE d.id IN(SELECT value FROM json_each(?)) AND d.storage_profile_json IS NOT NULL",
  )
    .bind(JSON.stringify(databaseIds))
    .all<{ node_id: string }>();
  for (const { node_id } of nodes.results)
    await requestThinStorageTurn(env, node_id).catch(() => undefined);
}
export async function processNodeThinStorage(env: Env, nodeId: string) {
  const input = await prepareThinStorageLease(env, nodeId);
  if (!input) return;
  const stub = env.NODE_BOOTSTRAP.get(
    env.NODE_BOOTSTRAP.idFromName(`thin-storage:${nodeId}`),
  );
  return stub.thinStorage(nodeId);
}
