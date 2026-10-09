// SPDX-License-Identifier: Apache-2.0
import {
  bytesToBase64url,
  newOperationId,
  timingSafeEqual,
  DatabaseStorageVolumeReceipt,
  thinStorageClass,
  thinWriteExposure,
  NodeThinStorageAuthority,
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
import { FleetReleaseSpec } from "@pgcf/contracts/releases";
import { loadNodeHostConfiguration } from "./node-host-configuration.ts";
import { installationHash } from "./node-installation.ts";
import sources from "../../../../infra/storage/sources.lock.json" with { type: "json" };
import { ApiError } from "../app.ts";
import type { Env, ApiContext } from "../env.ts";
import { bearer } from "../middleware/auth.ts";
import {
  readCurrentNodeThinStorage,
  type NodeThinStorageRow,
} from "./node-thin-storage.ts";
import {
  storageProtectionStatements,
  storageHoldVolumeStatements,
  knownStorageHoldVolume,
  currentStorageStopSql,
} from "./storage-capacity.ts";
import {
  loadCurrentRegionMaterialReference,
  loadRegionJoinBundle,
} from "../crypto/bootstrap-credentials.ts";
import { bootstrapTransportSigningKey } from "./bootstrap-relay.ts";
import { readBootstrapRelayIdentity } from "./node-inspection.ts";
import type { DatabaseRow } from "./rows.ts";
const closed = (): never => {
  throw new ApiError(
    "conflict",
    "Current physical storage lease or identity changed",
  );
};
export const thinStorageAuthoritySql = `EXISTS(SELECT 1 FROM nodes n JOIN regions r ON r.id=n.region_id JOIN fleet_node_releases a ON a.node_id=n.id JOIN fleet_region_releases f ON f.region_id=n.region_id JOIN fleet_releases s ON s.id=a.release_id WHERE n.id=node_thin_storage.node_id AND n.node_uid=node_thin_storage.node_uid AND n.ready=1 AND n.lost_at IS NULL AND a.node_uid=n.node_uid AND a.release_id=f.release_id AND r.bootstrap_material_revision=node_thin_storage.material_revision AND NOT EXISTS(SELECT 1 FROM node_bootstrap_jobs j WHERE j.node_id=n.id AND j.admitted=0 AND (j.authorized<>1 OR j.cancelled<>0 OR j.admission_authorized<>1)) AND NOT EXISTS(SELECT 1 FROM node_additions original WHERE original.node_id=n.id AND original.status IN('failed','cancelled')) AND EXISTS(SELECT 1 FROM json_each(s.spec_json,'$.components') component WHERE json_extract(component.value,'$.name')='openebs-lvm' AND json_extract(component.value,'$.kind')='image' AND json_extract(component.value,'$.reference')=node_thin_storage.qualified_driver_image))`;
export async function readThinStorageLeaseRow(env: Env, nodeId: string) {
  const row = await env.DB.prepare(
    `SELECT t.*,n.region_id,n.k8s_node_name,n.provider_instance_id,a.release_id,a.revision assignment_revision,f.revision region_revision,s.spec_json,s.spec_sha256,h.revision host_revision,h.sha256 host_sha256,
    (SELECT json_extract(p.observed_json,'$.boot_id') FROM fleet_patch_operations p WHERE p.node_id=n.id AND p.node_uid=n.node_uid AND p.release_id=a.release_id AND p.assignment_revision=a.revision AND p.region_revision=f.revision AND p.material_revision=t.material_revision AND p.stage='complete' AND p.state='confirmed' AND p.error_code IS NULL AND p.host_configuration_revision=h.revision AND p.host_configuration_sha256=h.sha256 ORDER BY p.updated_at DESC LIMIT 1) boot_id
    FROM node_thin_storage t JOIN nodes n ON n.id=t.node_id JOIN fleet_node_releases a ON a.node_id=n.id JOIN fleet_region_releases f ON f.region_id=n.region_id JOIN fleet_releases s ON s.id=a.release_id LEFT JOIN node_host_configurations h ON h.node_id=n.id AND h.node_uid=n.node_uid AND h.release_id=a.release_id AND h.material_revision=t.material_revision WHERE t.node_id=? AND ${thinStorageAuthoritySql.replaceAll("node_thin_storage.", "t.")}`,
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
      }
    >();
  if (!row) return closed();
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

export const storageHoldSnapshotSql = `NOT EXISTS(SELECT 1 FROM database_start_admissions storage_hold WHERE (storage_hold.node_id=node_thin_storage.node_id AND storage_hold.node_uid=node_thin_storage.node_uid AND storage_hold.storage_budget_bytes>0) AND NOT EXISTS(SELECT 1 FROM json_each(?) captured_hold WHERE captured_hold.value=storage_hold.operation_id))`;
async function storageHolds(
  env: Env,
  nodeId: string,
  nodeUid: string,
  authority: NodeThinStorageAuthority | null | undefined,
) {
  const rows = await env.DB.prepare(
    "SELECT h.operation_id,h.database_id,h.storage_budget_bytes,h.storage_volume_json binding_json,d.storage_volume_json,d.storage_profile_json,d.storage_generation FROM database_start_admissions h JOIN databases d ON d.id=h.database_id WHERE h.node_id=? AND h.node_uid=? AND h.storage_budget_bytes>0 ORDER BY h.operation_id",
  )
    .bind(nodeId, nodeUid)
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
  };
}
function minimumHeadroom(
  profile: NodeThinStorageLease["profile"],
  authority: NodeThinStorageAuthority | null,
  holds: { bytes: number; newVolumes: number; ids: ReadonlySet<string> },
) {
  const window = profile.guard_seconds + profile.drain_seconds;
  const io =
    authority?.volumes.flatMap((v) =>
      v.storage_class === "pgcf-lvm" || holds.ids.has(v.database_id)
        ? []
        : v.io,
    ) ?? [];
  const bytes = io.reduce((n, v) => n + v.write_bytes_per_second * window, 0),
    iops = io.reduce((n, v) => n + v.write_iops_per_second * window, 0);
  const exposure = thinWriteExposure(bytes, iops),
    chunks = exposure.chunks + Math.ceil(holds.bytes / 65536);
  return {
    data: profile.data_reserve_bytes + holds.bytes + exposure.data_bytes,
    metadata:
      profile.metadata_reserve_bytes +
      4 * Math.ceil(chunks / 126) * 4096 +
      holds.newVolumes * 16384,
  };
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
  const profile = current.profile,
    now = new Date().toISOString(),
    operation = newOperationId();
  const holds = await storageHolds(
    env,
    nodeId,
    row.node_uid,
    current.row.current_qualified === 1 ? current.authority : null,
  );
  const required = minimumHeadroom(profile, current.authority, holds);
  // A queued first start cannot obtain its bounded hold until the measured pool fits it.
  // Grow the existing finite pool for one eligible request; this is not a physical quota debit
  // for established databases and never creates a VPS order below the regional RAM trigger.
  const nextStartup = allowPoolActions
    ? ((await env.DB.prepare(
        `SELECT MAX(MAX(s.storage_gib*1073741824,?)) bytes FROM databases d JOIN size_classes s ON s.id=d.size_class_id JOIN nodes n ON n.id=? WHERE (d.region_id=? AND (d.deleted_at IS NULL OR d.desired_state='deleted') AND s.storage_gib<=?) AND ((d.desired_state='running' AND d.node_id IS NULL AND ?=1 AND n.schedulable=1 AND n.database_placement_enabled=1 AND n.database_placement_closed_at IS NULL) OR (d.node_id=n.id AND ((d.desired_state='running' AND d.storage_protected_generation=d.generation AND d.storage_protected_at IS NOT NULL) OR (d.storage_volume_json IS NOT NULL AND EXISTS(SELECT 1 FROM operations stop WHERE ${currentStorageStopSql()}))))) AND NOT EXISTS(SELECT 1 FROM database_start_admissions h WHERE h.database_id=d.id AND h.storage_budget_bytes>0)`,
      )
        .bind(
          profile.startup_reserve_bytes,
          nodeId,
          row.region_id,
          profile.maximum_quota_gib,
          row.allow_new_databases,
        )
        .first<number>("bytes")) ?? profile.startup_reserve_bytes)
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
      if ((references ?? 0) > 0 || holds.count > 0) {
        await env.DB.prepare(
          "UPDATE node_thin_storage SET status='blocked',error_code='thin_storage_retained_pool_missing' WHERE node_id=? AND profile_revision=? AND lease_revision=?",
        )
          .bind(nodeId, row.profile_revision, row.lease_revision)
          .run();
        return null;
      }
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
      pool.data_total_bytes - pool.data_used_bytes_upper_bound <
        required.data + nextStartup &&
      pool.data_total_bytes < profile.maximum_data_bytes
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
    Date.parse(now) + profile.guard_seconds * 1000,
  ).toISOString();
  const result = await env.DB.prepare(
    `UPDATE node_thin_storage SET lease_id=?,lease_revision=lease_revision+1,lease_expires_at=?,action_json=?,updated_at=? WHERE node_id=? AND profile_revision=? AND lease_revision=? AND (lease_expires_at IS NULL OR julianday(lease_expires_at)<=julianday('now')) AND ${thinStorageAuthoritySql}`,
  )
    .bind(
      operation,
      expires,
      action ? JSON.stringify(action) : null,
      now,
      nodeId,
      row.profile_revision,
      row.lease_revision,
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
  const row = await readThinStorageLeaseRow(env, nodeId),
    current = await readCurrentNodeThinStorage(env, nodeId);
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
    `SELECT d.*,h.operation_id startup_operation,h.generation startup_generation,h.node_uid startup_uid,h.storage_budget_bytes,(SELECT json_object('operation_id',stop.id,'kind',stop.kind,'generation',stop.generation) FROM operations stop WHERE ${currentStorageStopSql()} ORDER BY stop.created_at DESC LIMIT 1) stop_operation FROM databases d LEFT JOIN database_start_admissions h ON h.database_id=d.id AND h.generation=d.generation AND h.storage_budget_bytes>0 AND h.budget_bytes>0 WHERE d.node_id=? AND d.region_id=? ORDER BY d.id`,
  )
    .bind(nodeId, row.region_id)
    .all<
      DatabaseRow & {
        startup_operation: string | null;
        stop_operation: string | null;
        startup_generation: number | null;
        startup_uid: string | null;
        storage_budget_bytes: number | null;
      }
    >();
  const requiredHeadroom =
    required ??
    minimumHeadroom(
      current.profile,
      current.authority,
      await storageHolds(
        env,
        nodeId,
        row.node_uid,
        current.row.current_qualified === 1 ? current.authority : null,
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
      authority_revision: row.authority_revision,
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
              generation: r.startup_generation,
              node_uid: r.startup_uid,
              budget_bytes: r.storage_budget_bytes,
              expires_at: row.lease_expires_at,
            }
          : null,
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

export async function recordThinStorageReport(
  env: Env,
  nodeId: string,
  raw: NodeThinStorageReport,
) {
  const report = NodeThinStorageReport.parse(raw),
    row = await readThinStorageLeaseRow(env, nodeId),
    input = await thinStorageInput(env, nodeId),
    lease = input.lease,
    now = Date.now(),
    a = report.authority;
  if (
    report.expected_revision !== row.lease_revision ||
    a.node_id !== nodeId ||
    a.node_uid !== row.node_uid ||
    a.cluster_uid !== row.cluster_uid ||
    a.name !== lease.name ||
    a.revision !== row.authority_revision + 1 ||
    a.profile_revision !== row.profile_revision ||
    a.profile_sha256 !== row.profile_sha256 ||
    a.storage_class !== thinStorageClass(row.profile_sha256) ||
    a.volume_group_uuid !== row.volume_group_uuid ||
    a.driver_image !== row.qualified_driver_image ||
    a.observed_at !== lease.issued_at ||
    a.expires_at !== lease.expires_at ||
    Date.parse(a.expires_at) <= now ||
    Date.parse(a.captured_at) > now + 5000 ||
    report.software.driver_sha256 !== sources.driver.binary_sha256 ||
    report.software.lvm_sha256 !== sources.driver.lvm_binary_sha256 ||
    report.software.tools_sha256 !== sources.thin_tools.binary_sha256 ||
    report.software.thin_tools_version !== sources.thin_tools.version ||
    !report.software.thin_module_live ||
    !report.software.cgroup_host_view
  )
    return closed();
  if (
    report.boot_id !== lease.boot_id ||
    report.software.host_extension_image !== input.host_extension.image ||
    report.software.host_configuration_sha256 !==
      input.host_configuration.status.sha256 ||
    (lease.kernel_version !== null &&
      report.software.kernel_version !== lease.kernel_version)
  )
    return closed();
  const prior = row.qualification_json
    ? (JSON.parse(row.qualification_json) as { system_uuid?: string })
    : null;
  if (prior?.system_uuid && prior.system_uuid !== report.system_uuid)
    return closed();
  if (lease.action) {
    const action = lease.action,
      pool = a.physical.thin_pool;
    if (
      !pool ||
      pool.data_total_bytes < action.target_data_bytes ||
      pool.metadata_total_bytes < action.target_metadata_bytes ||
      (action.kind === "grow" && a.pool_uuid !== action.expected_pool_uuid) ||
      (action.kind === "initialize" &&
        report.pool_tag !== `pgcf.node.${row.node_uid}`)
    )
      return closed();
    if (action.state === "pending" && report.action_applied) return closed();
  }
  const holds = await storageHolds(env, nodeId, row.node_uid, a),
    headroom = minimumHeadroom(lease.profile, a, holds),
    pool = a.physical.thin_pool;
  if (
    a.write_allowed &&
    (!a.data_accounting_complete ||
      !pool ||
      pool.data_total_bytes > lease.profile.maximum_data_bytes ||
      pool.metadata_total_bytes !== lease.profile.metadata_bytes ||
      pool.data_total_bytes - pool.data_used_bytes_upper_bound <
        headroom.data ||
      pool.metadata_total_bytes - pool.metadata_used_bytes_upper_bound <
        headroom.metadata)
  )
    return closed();
  for (const v of a.volumes) {
    const database = lease.databases.find(
      (d) =>
        d.id === v.database_id &&
        d.generation === v.generation &&
        d.storage_generation === v.storage_generation,
    );
    if (
      !database ||
      (database.storage &&
        (v.storage_class !== database.storage.storage_class ||
          v.volume_attributes_class !==
            database.storage.volume_attributes_class)) ||
      !a.physical_lvs.some(
        (lv) => lv.lv_uuid === v.lv_uuid && lv.name === v.volume_handle,
      )
    )
      return closed();
  }
  const serialized = JSON.stringify(a),
    received = new Date(now).toISOString();
  const accepted = `EXISTS(SELECT 1 FROM node_thin_storage t WHERE t.node_id=? AND t.authority_revision=? AND t.authority_json=?)`;
  const bindings = [nodeId, a.revision, serialized];
  const statements = [
    env.DB.prepare(
      `UPDATE node_thin_storage SET authority_revision=?,authority_json=?,authority_received_at=?,qualification_json=?,status=?,error_code=NULL,lease_id=NULL,lease_expires_at=NULL,action_json=NULL WHERE node_id=? AND lease_revision=? AND authority_revision=? AND profile_revision=? AND julianday(lease_expires_at)>julianday('now') AND ${thinStorageAuthoritySql} AND ${storageHoldSnapshotSql}`,
    ).bind(
      a.revision,
      serialized,
      received,
      JSON.stringify({
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
      a.write_allowed ? "ready" : "blocked",
      nodeId,
      row.lease_revision,
      row.authority_revision,
      row.profile_revision,
      JSON.stringify(holds.operations),
    ),
  ];
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
      return closed();
    statements.push(
      env.DB.prepare(
        `UPDATE databases SET storage_volume_json=? WHERE id=? AND node_id=? AND generation=? AND storage_generation=? AND json_extract(storage_profile_json,'$.node_uid')=? AND json_extract(storage_profile_json,'$.pool_uuid')=? AND (storage_volume_json IS NULL OR storage_volume_json=?) AND ${accepted}`,
      ).bind(
        value,
        database.id,
        nodeId,
        database.generation,
        database.storage_generation,
        database.storage.node_uid,
        database.storage.pool_uuid,
        value,
        ...bindings,
      ),
    );
  }
  statements.push(
    ...storageHoldVolumeStatements(env.DB, a),
    ...storageProtectionStatements(env.DB, a),
  );
  const results = await env.DB.batch(statements);
  if (results[0]!.meta.changes !== 1) return closed();
  return {
    accepted: true,
    revision: a.revision,
    write_allowed: a.write_allowed,
  };
}

export async function issueThinStorageTransport(
  env: Env,
  nodeId: string,
  capability: "talos_api" | "kubernetes_api",
) {
  const input = await thinStorageInput(env, nodeId),
    row = await readThinStorageLeaseRow(env, nodeId),
    service = env.BOOTSTRAP_RELAY_SERVICE;
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
    !identity.allowed_target_regions.includes(row.region_id) ||
    !identity.capabilities.includes(capability)
  )
    return closed();
  const address =
    capability === "talos_api"
      ? row.address
      : new URL(input.cluster_endpoint).hostname;
  const key = await bootstrapTransportSigningKey(
    env.BOOTSTRAP_RELAY_SIGNING_KEYS,
  );
  const token = await signBootstrapRelay({
    ...key,
    operation: input.lease.operation_id,
    node: nodeId,
    region: row.region_id,
    issuer_region: identity.region,
    relay_epoch: identity.relay_epoch,
    revision: row.lease_revision,
    capability,
    address,
  });
  await thinStorageInput(env, nodeId);
  return {
    websocket_url: input.callback.url.replace(/^https:/, "wss:") + "/relay",
    token,
    expectedTarget: { ip: address, port: BOOTSTRAP_PORTS[capability] },
  };
}

export async function processNodeThinStorage(env: Env, nodeId: string) {
  const input = await prepareThinStorageLease(env, nodeId);
  if (!input) return;
  const stub = env.NODE_BOOTSTRAP.get(
    env.NODE_BOOTSTRAP.idFromName(`thin-storage:${nodeId}`),
  );
  return stub.thinStorage(nodeId);
}
