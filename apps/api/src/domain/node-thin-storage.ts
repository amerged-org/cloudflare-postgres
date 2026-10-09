// SPDX-License-Identifier: Apache-2.0
import {
  DatabaseStorageVolumeReceipt,
  DesiredDatabaseStorage,
  NodeThinStorageAuthority,
  ThinStorageProfile,
  signStorageWriteAuthority,
  thinStorageAuthorityMatches,
  thinStorageVolumeReclaimed,
  type StorageWriteClaims,
} from "@pgcf/contracts";
import type { Env } from "../env.ts";
import type { DatabaseRow } from "./rows.ts";
import { nodeProofSigningKey } from "./node-proof-session.ts";
import {
  currentStorageStopSql,
  storageDrainReservationStatement,
  nodeThinStorageHeadroomSql,
  knownStorageHoldVolume,
} from "./storage-capacity.ts";

export interface NodeThinStorageRow {
  node_id: string;
  node_uid: string;
  cluster_uid: string;
  address: string;
  volume_group_uuid: string;
  profile_revision: number;
  profile_sha256: string;
  profile_json: string;
  allow_new_databases: number;
  authority_revision: number;
  authority_json: string | null;
  authority_received_at: string | null;
  lease_id: string | null;
  lease_revision: number;
  lease_expires_at: string | null;
  material_revision: number;
  action_json: string | null;
  qualified_driver_image: string | null;
  qualification_json: string | null;
  status: "selected" | "qualifying" | "ready" | "blocked";
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

/** One current release/material/host/boot predicate shared by reads and atomic capacity admission. */
export function qualifiedThinStorageSql(alias = "t") {
  if (!/^[a-z][a-z0-9_]*$/.test(alias))
    throw new Error("invalid_thin_authority_alias");
  return `EXISTS(SELECT 1 FROM nodes qn JOIN regions qr ON qr.id=qn.region_id JOIN fleet_node_releases qa ON qa.node_id=qn.id JOIN fleet_region_releases qf ON qf.region_id=qn.region_id JOIN fleet_releases qs ON qs.id=qa.release_id JOIN node_host_configurations qh ON qh.node_id=qn.id AND qh.node_uid=qn.node_uid JOIN fleet_node_release_observations qo ON qo.node_id=qn.id AND qo.node_uid=qn.node_uid AND qo.assignment_revision=qa.revision AND qo.agent_key_hash=qr.agent_key_hash JOIN fleet_patch_operations qp ON qp.node_id=qn.id JOIN json_each(qs.spec_json,'$.components') qverifier ON json_extract(qverifier.value,'$.name')='native-gateway' AND json_extract(qverifier.value,'$.kind')='image' JOIN json_each(qs.spec_json,'$.roles.'||qa.role||'.components') qgatewayrole ON qgatewayrole.value='native-gateway'
    WHERE (
      (((qn.id=${alias}.node_id AND qn.node_uid=${alias}.node_uid) AND (qn.ready=1 AND qn.lost_at IS NULL))
        AND (qa.node_uid=qn.node_uid AND (qa.release_id=qf.release_id AND qr.bootstrap_material_revision=${alias}.material_revision)))
      AND ((length(json_extract(qs.spec_json,'$.storage_authority_keys_sha256'))=64 AND json_extract(qs.spec_json,'$.storage_authority_keys_sha256') NOT GLOB '*[^0-9a-f]*')
        AND ((qh.release_id=qs.id AND qh.cluster_uid=${alias}.cluster_uid) AND (qh.material_revision=${alias}.material_revision AND json_extract(qo.facts_json,'$.boot_id')=json_extract(${alias}.qualification_json,'$.boot_id'))))
    ) AND (
      (((julianday(qo.observed_at)>=julianday('now','-180 seconds') AND julianday(qo.observed_at)<=julianday('now','+5 seconds')) AND (julianday(qo.received_at)>=julianday('now','-180 seconds') AND julianday(qo.received_at)<=julianday('now','+5 seconds')))
        AND ((json_extract(${alias}.qualification_json,'$.profile_revision')=${alias}.profile_revision AND json_extract(${alias}.qualification_json,'$.profile_sha256')=json_extract(qs.spec_json,'$.thin_storage_qualification.profile_sha256')) AND (json_extract(${alias}.qualification_json,'$.release_id')=qs.id AND json_extract(${alias}.qualification_json,'$.spec_sha256')=qs.spec_sha256)))
      AND ((json_extract(${alias}.qualification_json,'$.assignment_revision')=qa.revision AND (json_extract(${alias}.qualification_json,'$.region_revision')=qf.revision AND json_extract(qs.spec_json,'$.thin_storage_qualification.driver_image')=${alias}.qualified_driver_image))
        AND (json_extract(qs.spec_json,'$.thin_storage_qualification.host_extension_image')=json_extract(${alias}.qualification_json,'$.software.host_extension_image') AND (json_extract(qs.spec_json,'$.thin_storage_qualification.kernel_version')=json_extract(${alias}.qualification_json,'$.software.kernel_version') AND json_extract(${alias}.qualification_json,'$.software.host_configuration_sha256')=qh.sha256)))
    ) AND (
      (((qp.node_id=qn.id AND qp.node_uid=qn.node_uid) AND (qp.cluster_uid=${alias}.cluster_uid AND qp.release_id=qs.id))
        AND ((qp.spec_sha256=qs.spec_sha256 AND qp.assignment_revision=qa.revision) AND (qp.region_revision=qf.revision AND qp.material_revision=${alias}.material_revision)))
      AND (((qp.stage='complete' AND qp.state='confirmed') AND (qp.error_code IS NULL AND (qp.host_configuration_revision=qh.revision AND qp.host_configuration_sha256=qh.sha256)))
        AND ((json_extract(qp.observed_json,'$.host_configuration_sha256')=qh.sha256 AND json_extract(qp.observed_json,'$.runtime_admission_sha256')=qh.profile_sha256) AND (json_extract(qp.observed_json,'$.node_ready')=1 AND json_extract(qp.observed_json,'$.boot_id')=json_extract(${alias}.qualification_json,'$.boot_id'))))
    ))`;
}

export async function readCurrentNodeThinStorage(
  env: Pick<Env, "DB">,
  nodeId: string,
  now = Date.now(),
) {
  const row = await env.DB.prepare(
    `SELECT t.*,n.region_id,n.k8s_node_name,n.node_uid current_node_uid,n.ready,n.lost_at,CASE WHEN ${qualifiedThinStorageSql()} THEN 1 ELSE 0 END current_qualified FROM node_thin_storage t JOIN nodes n ON n.id=t.node_id WHERE t.node_id=?`,
  )
    .bind(nodeId)
    .first<
      NodeThinStorageRow & {
        region_id: string;
        k8s_node_name: string;
        current_node_uid: string | null;
        ready: number;
        lost_at: string | null;
        current_qualified: number;
      }
    >();
  if (!row) return null;
  const profile = ThinStorageProfile.parse(JSON.parse(row.profile_json));
  const parsed = NodeThinStorageAuthority.safeParse(
    row.authority_json ? JSON.parse(row.authority_json) : null,
  );
  let authority: NodeThinStorageAuthority | null = null;
  if (parsed.success) {
    const value = parsed.data;
    if (
      row.ready === 1 &&
      row.lost_at === null &&
      row.current_node_uid === row.node_uid &&
      value.node_id === row.node_id &&
      value.name === row.k8s_node_name &&
      value.node_uid === row.node_uid &&
      value.cluster_uid === row.cluster_uid &&
      value.volume_group_uuid === row.volume_group_uuid &&
      value.profile_revision === row.profile_revision &&
      value.profile_sha256 === row.profile_sha256 &&
      value.revision === row.authority_revision &&
      value.driver_image === row.qualified_driver_image &&
      value.driver_image === profile.driver_image &&
      row.authority_received_at !== null &&
      Date.parse(row.authority_received_at) >= now - 120000 &&
      Date.parse(row.authority_received_at) <= now + 5000 &&
      Date.parse(value.observed_at) >= now - 120000 &&
      Date.parse(value.observed_at) <= now + 5000 &&
      Date.parse(value.expires_at) > now &&
      Date.parse(value.expires_at) <=
        Date.parse(value.observed_at) + profile.guard_seconds * 1000
    )
      authority = {
        ...value,
        write_allowed:
          value.write_allowed &&
          row.status === "ready" &&
          row.current_qualified === 1,
      };
  }
  return { row, profile, authority };
}

/** No native proof means no authority; ordinary regional physical metrics cannot fill this gap. */
export async function desiredRegionStorageNodes(
  env: Pick<Env, "DB">,
  regionId: string,
  now = Date.now(),
): Promise<NodeThinStorageAuthority[]> {
  const rows = await env.DB.prepare(
    "SELECT t.node_id FROM node_thin_storage t JOIN nodes n ON n.id=t.node_id WHERE n.region_id=? ORDER BY n.id",
  )
    .bind(regionId)
    .all<{ node_id: string }>();
  const result: NodeThinStorageAuthority[] = [];
  for (const row of rows.results) {
    const current = await readCurrentNodeThinStorage(env, row.node_id, now);
    if (current?.authority) result.push(current.authority);
  }
  return result;
}

export async function storageWriteAuthorityForDatabase(
  env: Env,
  database: DatabaseRow,
  now = Date.now(),
): Promise<string | undefined> {
  if (
    !database.node_id ||
    !database.storage_profile_json ||
    !database.storage_volume_json ||
    database.desired_state !== "running" ||
    database.deleted_at
  )
    return undefined;
  const storage = DesiredDatabaseStorage.parse(
    JSON.parse(database.storage_profile_json),
  );
  const receipt = DatabaseStorageVolumeReceipt.parse(
    JSON.parse(database.storage_volume_json),
  );
  const current = await readCurrentNodeThinStorage(env, database.node_id, now);
  const authority = current?.authority;
  if (
    !thinStorageAuthorityMatches(storage, authority, undefined, now) ||
    !authority ||
    receipt.storage_generation !== (database.storage_generation ?? 1) ||
    receipt.node_uid !== storage.node_uid ||
    receipt.volume_group_uuid !== storage.volume_group_uuid ||
    receipt.pool_uuid !== storage.pool_uuid ||
    !authority.physical_lvs.some(
      (lv) => lv.lv_uuid === receipt.lv_uuid && lv.segtype === "thin",
    )
  )
    return undefined;
  const volume = authority.volumes.find(
    (volume) =>
      volume.database_id === database.id &&
      volume.generation === database.generation &&
      volume.storage_generation === receipt.storage_generation,
  );
  if (
    !volume ||
    volume.storage_uid !== receipt.storage_uid ||
    volume.namespace_uid !== receipt.namespace_uid ||
    volume.cluster_uid !== receipt.cluster_uid ||
    volume.lv_uuid !== receipt.lv_uuid ||
    volume.volume_handle !== receipt.volume_handle ||
    volume.pvc_uid !== receipt.pvc_uid ||
    volume.pv_uid !== receipt.pv_uid ||
    volume.storage_class !== storage.storage_class ||
    volume.volume_attributes_class !== storage.volume_attributes_class ||
    volume.io.length !== 1
  )
    return undefined;
  const io = volume.io[0]!;
  if (
    io.write_bytes_per_second > storage.write_bytes_per_second ||
    io.write_iops_per_second > storage.write_iops_per_second
  )
    return undefined;
  const key = await nodeProofSigningKey(env);
  // Stable within one accepted physical revision: polling never extends a stale read's deadline.
  const claims: StorageWriteClaims = {
    v: 1,
    kid: key.kid,
    database_id: database.id,
    generation: database.generation,
    authority_revision: authority.revision,
    storage_uid: receipt.storage_uid,
    node_uid: storage.node_uid,
    volume_group_uuid: storage.volume_group_uuid,
    pool_uuid: storage.pool_uuid,
    profile_sha256: storage.profile_sha256,
    volume_handle: receipt.volume_handle,
    lv_uuid: receipt.lv_uuid,
    pvc_uid: receipt.pvc_uid,
    pv_uid: receipt.pv_uid,
    pod_uid: io.pod_uid,
    observed_at: Date.parse(authority.observed_at),
    iat: Date.parse(authority.observed_at),
    exp: Date.parse(authority.expires_at),
    guard_seconds: storage.guard_seconds,
    drain_seconds: storage.drain_seconds,
    write_allowed: true,
  };
  return signStorageWriteAuthority(claims, key.privateKey, now);
}

/** The protected host reads this over strict CF HTTPS; regional inputs never issue startup grants. */
export async function hostStorageLease(
  c: import("../env.ts").ApiContext,
  id: string,
) {
  const { agentRegion } = await import("./agent-auth.ts");
  const { HostStorageLease } =
    await import("@pgcf/contracts/node-thin-storage");
  const { ApiError } = await import("../app.ts");
  const region = await agentRegion(c),
    now = Date.now();
  const node = await c.env.DB.prepare(
    `SELECT n.node_uid,r.bootstrap_material_revision FROM nodes n JOIN regions r ON r.id=n.region_id WHERE n.id=? AND n.region_id=? AND n.node_uid IS NOT NULL AND n.ready=1 AND n.lost_at IS NULL`,
  )
    .bind(id, region.id)
    .first<{ node_uid: string; bootstrap_material_revision: number }>();
  if (!node)
    throw new ApiError(
      "not_found",
      "Current physical storage host unavailable",
    );
  const current = await readCurrentNodeThinStorage(c.env, id, now);
  const rows = await c.env.DB.prepare(
    `SELECT d.*,COUNT(*) OVER() host_snapshot_count,s.storage_gib,a.node_uid startup_node_uid,a.storage_budget_bytes,a.operation_id startup_operation,
 (SELECT json_object('operation_id',stop.id,'kind',stop.kind,'generation',stop.generation) FROM operations stop WHERE ${currentStorageStopSql()} ORDER BY stop.created_at DESC LIMIT 1) stop_operation
 FROM databases d JOIN size_classes s ON s.id=d.size_class_id LEFT JOIN database_start_admissions a ON a.database_id=d.id AND a.generation=d.generation AND a.node_uid=? AND a.storage_budget_bytes>0 AND a.budget_bytes>0 AND a.ready_at IS NULL AND (d.storage_protected_at IS NULL OR d.storage_protected_generation<d.generation) WHERE d.node_id=? AND d.region_id=? AND (d.deleted_at IS NULL OR d.storage_profile_json IS NOT NULL) ORDER BY d.id`,
  )
    .bind(node.node_uid, id, region.id)
    .all<
      DatabaseRow & {
        storage_gib: number;
        stop_operation: string | null;
        host_snapshot_count: number;
        startup_node_uid: string | null;
        storage_budget_bytes: number | null;
        startup_operation: string | null;
      }
    >();
  if (
    rows.results.some((row) => row.host_snapshot_count !== rows.results.length)
  )
    throw new ApiError(
      "conflict",
      "Physical host database snapshot is incomplete",
    );
  const boot = current?.row.qualification_json
    ? (JSON.parse(current.row.qualification_json) as { boot_id?: string })
        .boot_id
    : undefined;
  const bootId =
    boot ??
    (await c.env.DB.prepare(
      "SELECT json_extract(p.observed_json,'$.boot_id') boot FROM fleet_patch_operations p WHERE p.node_id=? AND p.node_uid=? AND p.stage='complete' AND p.state='confirmed' AND p.error_code IS NULL ORDER BY p.updated_at DESC LIMIT 1",
    )
      .bind(id, node.node_uid)
      .first<string>("boot"));
  if (!bootId && rows.results.some((row) => row.storage_profile_json))
    throw new ApiError(
      "conflict",
      "Current qualified physical boot unavailable",
    );
  const databases = [];
  const legacy = [];
  for (const row of rows.results) {
    if (!row.storage_profile_json) {
      legacy.push({
        database_id: row.id,
        generation: row.generation,
        namespace: `pgcf-db-${row.id}`,
      });
      continue;
    }
    const storage = DesiredDatabaseStorage.parse(
      JSON.parse(row.storage_profile_json),
    );
    const authority = current?.authority;
    const receipt = row.storage_volume_json
      ? DatabaseStorageVolumeReceipt.parse(JSON.parse(row.storage_volume_json))
      : null;
    // Tombstones are explicit: only completed deletion and a later complete Native absence
    // read can declare no volume. Missing/paginated rows never authorize protective-scope GC.
    const reclaimed = Boolean(
      row.deleted_at &&
      row.desired_state === "deleted" &&
      row.observed_state === "deleted" &&
      row.observed_generation === row.generation &&
      receipt &&
      thinStorageVolumeReclaimed(
        storage,
        authority,
        receipt.lv_uuid,
        Date.parse(row.deleted_at),
        now,
      ),
    );
    const admitted =
      row.desired_state === "running" &&
      row.startup_operation !== null &&
      row.startup_node_uid === storage.node_uid &&
      row.storage_budget_bytes !== null &&
      row.storage_budget_bytes >=
        Math.max(storage.startup_reserve_bytes, row.storage_gib * 1024 ** 3) &&
      thinStorageAuthorityMatches(storage, authority, undefined, now);
    let drain:
      import("@pgcf/contracts/node-thin-storage").HostStorageDrain | null =
      null;
    if (
      row.stop_operation &&
      receipt &&
      current?.row.current_qualified === 1 &&
      authority
    ) {
      const stop = JSON.parse(row.stop_operation) as {
        operation_id: string;
        kind: "database.suspend" | "database.hibernate" | "database.delete";
        generation: number;
      };
      await storageDrainReservationStatement(c.env.DB, {
        databaseId: row.id,
        operationId: stop.operation_id,
        generation: row.generation,
        nodeId: id,
        now: new Date(now).toISOString(),
      }).run();
      const hold = await c.env.DB.prepare(
        `SELECT h.storage_budget_bytes,h.storage_volume_json FROM database_start_admissions h JOIN databases d ON d.id=h.database_id JOIN nodes n ON n.id=d.node_id JOIN size_classes s ON s.id=d.size_class_id JOIN operations stop ON stop.id=h.operation_id WHERE h.operation_id=? AND h.budget_bytes=0 AND h.generation=d.generation AND h.node_id=n.id AND h.node_uid=n.node_uid AND ${currentStorageStopSql()} AND ${nodeThinStorageHeadroomSql("n", "s", "d")}`,
      )
        .bind(stop.operation_id)
        .first<{
          storage_budget_bytes: number;
          storage_volume_json: string | null;
        }>();
      if (
        hold &&
        knownStorageHoldVolume({
          binding: hold.storage_volume_json,
          current: row.storage_volume_json ?? null,
          profile: row.storage_profile_json,
          storageGeneration: row.storage_generation ?? 1,
          databaseId: row.id,
          authority,
          now,
        }) !== null
      ) {
        drain = {
          ...stop,
          authority_revision: authority.revision,
          expires_at: Math.min(
            Date.parse(authority.expires_at),
            now + current.profile.drain_seconds * 1000,
          ),
          budget_bytes: hold.storage_budget_bytes,
        };
      }
    }
    databases.push({
      database_id: row.id,
      generation: row.generation,
      authority_revision: current?.row.authority_revision ?? 0,
      write_blocked:
        drain !== null
          ? true
          : row.desired_state === "deleted"
            ? !reclaimed
            : !current ||
              current.row.error_code !== null ||
              current.row.status === "blocked",
      desired_state: row.desired_state,
      node_uid: storage.node_uid,
      volume_group_uuid: storage.volume_group_uuid,
      pool_uuid: storage.pool_uuid,
      profile_sha256: storage.profile_sha256,
      startup_expires_at:
        admitted && authority ? Date.parse(authority.expires_at) : null,
      startup_operation_id: admitted ? row.startup_operation : null,
      volume: reclaimed ? null : receipt,
      runtime_authority:
        (await storageWriteAuthorityForDatabase(c.env, row, now)) ?? null,
      drain,
    });
  }
  return c.json(
    HostStorageLease.parse({
      purpose: "pgcf-storage-host/v1",
      node_uid: node.node_uid,
      boot_id: bootId ?? null,
      material_revision: node.bootstrap_material_revision,
      issued_at: now,
      expires_at: now + 120000,
      legacy,
      databases,
    }),
    200,
  );
}
