// SPDX-License-Identifier: Apache-2.0
import type { Env } from "../env.ts";
import { allOf } from "./sql-conjunction.ts";
import {
  NodeThinStorageAuthority as AuthoritySchema,
  DatabaseStorageVolumeReceipt,
  DesiredDatabaseStorage,
  thinStorageAuthorityMatches,
  type NodeThinStorageAuthority,
} from "@pgcf/contracts";
// The current Native receipt owns physical capacity. Logical quotas never reserve thin extents.
const identifier = (value: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(value))
    throw new Error("invalid_storage_sql_alias");
  return value;
};
const field = (name: string) => `json_extract(t.profile_json,'$.${name}')`;
/** When the identity proof behind an authority started its read, and until when it may be used.
 * Facts that need a read after an event use these. An authority recorded before composition
 * carries neither and was itself one complete read. */
function inventoryObservedSql(authorityAlias = "t") {
  const authority = identifier(authorityAlias);
  return `COALESCE(json_extract(${authority}.authority_json,'$.inventory_observed_at'),json_extract(${authority}.authority_json,'$.observed_at'))`;
}
function inventoryExpiresSql(authorityAlias = "t") {
  const authority = identifier(authorityAlias);
  return `COALESCE(json_extract(${authority}.authority_json,'$.inventory_expires_at'),json_extract(${authority}.authority_json,'$.expires_at'))`;
}

const receiptFields = [
  "storage_generation",
  "storage_uid",
  "namespace_uid",
  "cluster_uid",
  "node_uid",
  "volume_group_uuid",
  "pool_uuid",
  "volume_handle",
  "lv_uuid",
  "pvc_uid",
  "pv_uid",
] as const;
function holdReceiptMatchesCurrentSql(hold: string, database: string) {
  const same = receiptFields.map(
    (key) =>
      `json_extract(${hold}.storage_volume_json,'$.${key}')=json_extract(${database}.storage_volume_json,'$.${key}')`,
  );
  return `(${hold}.storage_volume_json IS NOT NULL AND ${database}.storage_volume_json IS NOT NULL AND json_extract(${hold}.storage_volume_json,'$.storage_generation')=${database}.storage_generation AND (${same.slice(0, 4).join(" AND ")}) AND (${same.slice(4, 8).join(" AND ")}) AND (${same.slice(8).join(" AND ")}))`;
}
/** A stop remains owned after a timeout, but a superseded/foreign intent grants no drain. */
export function currentStorageStopSql(
  databaseAlias = "d",
  operationAlias = "stop",
) {
  const d = identifier(databaseAlias),
    o = identifier(operationAlias);
  return `(${o}.database_id=${d}.id AND ${o}.project_id=${d}.project_id AND ${o}.generation=${d}.generation AND (${o}.status IN('pending','running') OR (${o}.status='failed' AND ${o}.error_code='operation_timeout')) AND ((${d}.desired_state='suspended' AND ${o}.id=${d}.power_operation AND ((${o}.kind='database.suspend' AND ${d}.suspension_reason='manual') OR (${o}.kind='database.hibernate' AND ${d}.suspension_reason='idle'))) OR (${d}.desired_state='deleted' AND ${o}.kind='database.delete' AND ${d}.observed_state<>'deleted'))) `;
}
/** Physical exposure may be shared only by separately captured holds for one currently proved LV. */
export function knownStorageHoldVolume(input: {
  binding: string | null;
  current: string | null;
  profile: string | null;
  storageGeneration: number;
  databaseId: string;
  authority: NodeThinStorageAuthority | null | undefined;
  now?: number;
}): string | null {
  const authority = input.authority,
    now = input.now ?? Date.now();
  if (!authority?.data_accounting_complete) return null;
  try {
    const binding = DatabaseStorageVolumeReceipt.parse(
        JSON.parse(input.binding ?? "null"),
      ),
      current = DatabaseStorageVolumeReceipt.parse(
        JSON.parse(input.current ?? "null"),
      ),
      profile = DesiredDatabaseStorage.parse(
        JSON.parse(input.profile ?? "null"),
      );
    if (
      !thinStorageAuthorityMatches(profile, authority, undefined, now, false) ||
      current.storage_generation !== input.storageGeneration ||
      receiptFields.some((key) => binding[key] !== current[key]) ||
      !authority.physical_lvs.some(
        (lv) =>
          lv.lv_uuid === binding.lv_uuid &&
          lv.name === binding.volume_handle &&
          lv.segtype === "thin",
      )
    )
      return null;
    const volume = authority.volumes.find(
      (v) =>
        v.database_id === input.databaseId &&
        v.storage_generation === binding.storage_generation,
    );
    if (
      !volume ||
      volume.storage_class !== profile.storage_class ||
      volume.volume_attributes_class !== profile.volume_attributes_class ||
      receiptFields.some((key) =>
        key === "node_uid"
          ? binding[key] !== authority.node_uid
          : key === "volume_group_uuid"
            ? binding[key] !== authority.volume_group_uuid
            : key === "pool_uuid"
              ? binding[key] !== authority.pool_uuid
              : binding[key] !== volume[key as keyof typeof volume],
      )
    )
      return null;
    return JSON.stringify(receiptFields.map((key) => binding[key]));
  } catch {
    return null;
  }
}

/** Insert this SELECT in the same admitted INSERT/placement UPDATE, never after it. */
export function selectedStorageProfileSql(nodeAlias = "n"): string {
  const node = identifier(nodeAlias);
  return `(SELECT json_object('backend','lvm-thin-v1',
    'storage_class','pgcf-lvm-thin-v1-'||substr(t.profile_sha256,1,16),
    'volume_attributes_class','pgcf-lvm-thin-v1-'||substr(t.profile_sha256,1,16),
    'profile_revision',t.profile_revision,'profile_sha256',t.profile_sha256,
    'node_uid',t.node_uid,'volume_group_uuid',t.volume_group_uuid,
    'pool_uuid',json_extract(t.authority_json,'$.pool_uuid'),
    'startup_reserve_bytes',${field("startup_reserve_bytes")},
    'write_bytes_per_second',${field("write_bytes_per_second")},
    'write_iops_per_second',${field("write_iops_per_second")},
    'guard_seconds',${field("guard_seconds")},'drain_seconds',${field("drain_seconds")})
    FROM node_thin_storage t WHERE t.node_id=${node}.id AND t.node_uid=${node}.node_uid)`;
}

/** Existing thick filesystems keep their allocation. Only a selected thin volume may grow logically. */
export function storageResizeAllowedSql(
  databaseAlias = "databases",
  sizeAlias = "s",
): string {
  const database = identifier(databaseAlias),
    size = identifier(sizeAlias);
  return `(${size}.storage_gib=(SELECT old.storage_gib FROM size_classes old WHERE old.id=${database}.size_class_id)
    OR (${database}.storage_profile_json IS NOT NULL
      AND ${size}.storage_gib>(SELECT old.storage_gib FROM size_classes old WHERE old.id=${database}.size_class_id)
      AND EXISTS(SELECT 1 FROM node_thin_storage t WHERE t.node_id=${database}.node_id
        AND t.node_uid=json_extract(${database}.storage_profile_json,'$.node_uid')
        AND ${size}.storage_gib<=${field("maximum_quota_gib")})))`;
}

/** Physical fields of the node's latest sample `o` (node_storage_observations). */
const sampled = (path: string) => `json_extract(o.physical_json,'$.${path}')`;
const sampledDataFree = `(${sampled("thin_pool.data_total_bytes")}-${sampled("thin_pool.data_used_bytes_upper_bound")})`,
  sampledMetadataFree = `(${sampled("thin_pool.metadata_total_bytes")}-${sampled("thin_pool.metadata_used_bytes_upper_bound")})`;
/** The node's latest physical sample, read at most two minutes ago. */
const freshSampleSql = `julianday(o.observed_at)>=julianday('now','-120 seconds') AND julianday(o.observed_at)<=julianday('now','+5 seconds')`;

/**
 * The thin pool reserve rule, Cloudflare's one storage decision at every start and attach: the
 * node's thin storage has no error and its latest physical sample, at most 120 s old, leaves the
 * profile's data and metadata reserve free in the pool. `databaseAlias` judges that database's own
 * pool; without it the rule is for a new volume: the node takes new databases and has a volume to
 * spare. No logical size is accounted: thin volumes overprovision the pool, which grows before it
 * runs out (`thinPoolGrowthNeededSql`), and dm-thin fails a write into a full pool, so PostgreSQL
 * acknowledges no commit it could not write. Running writers are never stopped by this rule.
 */
export function thinPoolRoomSql(
  nodeAlias = "n",
  sizeAlias = "s",
  databaseAlias?: string,
): string {
  const node = identifier(nodeAlias),
    size = identifier(sizeAlias),
    database = databaseAlias === undefined ? null : identifier(databaseAlias);
  const owner =
    database === null
      ? `t.allow_new_databases=1 AND t.status='ready'
        AND (SELECT COUNT(*) FROM databases v WHERE v.node_id=t.node_id AND v.storage_profile_json IS NOT NULL
          AND NOT(v.desired_state='deleted' AND v.observed_state='deleted'))<${field("maximum_volumes")}`
      : allOf(
          `json_extract(${database}.storage_profile_json,'$.backend')='lvm-thin-v1'`,
          `json_extract(${database}.storage_profile_json,'$.node_uid')=t.node_uid`,
          `json_extract(${database}.storage_profile_json,'$.volume_group_uuid')=t.volume_group_uuid`,
          `json_extract(${database}.storage_profile_json,'$.pool_uuid')=json_extract(t.authority_json,'$.pool_uuid')`,
        );
  return `EXISTS(SELECT 1 FROM node_thin_storage t JOIN node_storage_observations o ON o.node_id=t.node_id AND o.node_uid=t.node_uid
    WHERE ${allOf(
      `t.node_id=${node}.id`,
      `t.node_uid=${node}.node_uid`,
      thinPoolNodeRoomSql(),
      `typeof(${size}.storage_gib)='integer'`,
      `${size}.storage_gib BETWEEN 1 AND ${field("maximum_quota_gib")}`,
      owner,
    )})`;
}
/** The node part of the room rule over its thin storage `t` and its latest sample `o`: what the
 * desired page serves as storage_nodes[].write_allowed for the databases the node holds. */
export function thinPoolNodeRoomSql(): string {
  return allOf(
    "t.error_code IS NULL",
    "json_extract(t.authority_json,'$.pool_uuid') IS NOT NULL",
    `${sampled("volume_group_uuid")}=t.volume_group_uuid`,
    freshSampleSql,
    `${sampledDataFree}>=${field("data_reserve_bytes")}`,
    `${sampledMetadataFree}>=${field("metadata_reserve_bytes")}`,
  );
}

/**
 * Whether the node's thin pool should grow now: its latest fresh sample leaves less than the data
 * reserve and one start free, and the pool is below its maximum with the volume group's reserve
 * still free after the growth step. The capacity cron then asks for the node's pool action turn.
 */
export function thinPoolGrowthNeededSql(): string {
  return allOf(
    freshSampleSql,
    `${sampled("volume_group_uuid")}=t.volume_group_uuid`,
    `${sampledDataFree}<${field("data_reserve_bytes")}+${field("startup_reserve_bytes")}`,
    `${sampled("thin_pool.data_total_bytes")}<${field("maximum_data_bytes")}`,
    `${sampled("free_bytes")}>=${field("vg_reserve_bytes")}+MIN(${field("growth_bytes")},${field("maximum_data_bytes")}-${sampled("thin_pool.data_total_bytes")})`,
  );
}

/**
 * Why a node's fresh sample says its pool cannot take more, for the thin storage alert: no room
 * now, or below the growth point with no growth left (the maximum reached or the volume group too
 * full). Metadata does not grow past the profile's size and a full metadata device needs repair,
 * so its alert comes at twice its reserve. NULL while the pool is fine.
 */
export function thinPoolExhaustionSql(): string {
  return `CASE WHEN json_type(o.physical_json,'$.thin_pool') IS NOT 'object' OR NOT(${freshSampleSql}) THEN NULL
    WHEN ${sampledDataFree}<${field("data_reserve_bytes")} OR ${sampledMetadataFree}<${field("metadata_reserve_bytes")} THEN 'thin_pool_no_room'
    WHEN ${sampledMetadataFree}<2*${field("metadata_reserve_bytes")}
      OR (${sampledDataFree}<${field("data_reserve_bytes")}+${field("startup_reserve_bytes")} AND NOT(${thinPoolGrowthNeededSql()})) THEN 'thin_pool_growth_exhausted'
    ELSE NULL END`;
}

/** New placements retain the old thick behavior only on nodes with no selected thin policy. */
export function nodeStoragePlacementSql(
  nodeAlias = "n",
  sizeAlias = "s",
  databaseAlias?: string,
): string {
  const node = identifier(nodeAlias),
    size = identifier(sizeAlias),
    database = databaseAlias === undefined ? null : identifier(databaseAlias);
  const exclusion = database === null ? "" : `AND d.id<>${database}.id`;
  const thick = `${node}.storage_gib_total IS NOT NULL AND ${node}.storage_gib_total-COALESCE((SELECT SUM(sc.storage_gib) FROM databases d JOIN size_classes sc ON sc.id=d.size_class_id WHERE d.node_id=${node}.id AND d.observed_state<>'deleted' ${exclusion}),0)>=${size}.storage_gib`;
  const retained =
    database === null
      ? "0=1"
      : `${database}.storage_profile_json IS NULL AND ${size}.storage_gib=(SELECT old.storage_gib FROM size_classes old WHERE old.id=${database}.size_class_id)`;
  return `((NOT EXISTS(SELECT 1 FROM node_thin_storage t WHERE t.node_id=${node}.id) AND (${thick}))
    OR (EXISTS(SELECT 1 FROM node_thin_storage t WHERE t.node_id=${node}.id) AND ((${retained}) OR ${thinPoolRoomSql(node, size, database ?? undefined)})))`;
}

/** Wake allocates no new extents for a retained thick filesystem; a thin start needs room. */
export function databaseStorageStartupSql(
  databaseAlias = "databases",
  nodeAlias = "n",
  sizeAlias = "s",
): string {
  const database = identifier(databaseAlias);
  return `(${database}.storage_profile_json IS NULL OR ${thinPoolRoomSql(nodeAlias, sizeAlias, database)})`;
}

/** Metadata only; Native independently proves the retained thick volume before granting an exemption. */
export async function retainedThickStorageAssignments(
  env: Env,
  regionId: string,
) {
  const result = await env.DB.prepare(
    `SELECT d.id database_id,d.node_id,n.node_uid,n.k8s_node_name,
    COALESCE(d.storage_generation,1) storage_generation,d.archive_path
    FROM databases d JOIN nodes n ON n.id=d.node_id AND n.region_id=d.region_id
    WHERE d.region_id=? AND d.storage_profile_json IS NULL AND d.deleted_at IS NULL
      AND d.desired_state<>'deleted' AND n.node_uid IS NOT NULL AND n.lost_at IS NULL
    ORDER BY d.id`,
  )
    .bind(regionId)
    .all<{
      database_id: string;
      node_id: string;
      node_uid: string;
      k8s_node_name: string;
      storage_generation: number;
      archive_path: string;
    }>();
  return result.results;
}

/** Bind each current-operation hold individually; an older unknown hold never inherits a DB-ID guess. */
export function storageHoldVolumeStatements(
  db: D1Database,
  raw: NodeThinStorageAuthority,
): D1PreparedStatement[] {
  const authority = AuthoritySchema.parse(raw),
    serialized = JSON.stringify(authority),
    statements: D1PreparedStatement[] = [];
  for (const volume of authority.volumes) {
    if (
      volume.storage_class !== authority.storage_class ||
      volume.volume_attributes_class !== authority.storage_class ||
      authority.pool_uuid === null
    )
      continue;
    // Select the declared fields only; volume carries additional measurement properties.
    const value = DatabaseStorageVolumeReceipt.parse({
      storage_generation: volume.storage_generation,
      storage_uid: volume.storage_uid,
      namespace_uid: volume.namespace_uid,
      cluster_uid: volume.cluster_uid,
      node_uid: authority.node_uid,
      volume_group_uuid: authority.volume_group_uuid,
      pool_uuid: authority.pool_uuid,
      volume_handle: volume.volume_handle,
      lv_uuid: volume.lv_uuid,
      pvc_uid: volume.pvc_uid,
      pv_uid: volume.pv_uid,
    });
    const same = receiptFields
      .map((key) => `json_extract(d.storage_volume_json,'$.${key}')=?`)
      .join(" AND ");
    statements.push(
      db
        .prepare(
          // The hold is the newest start at or below the reading's generation: a role change
          // advances the generation while a start is under way, and starts nothing.
          `UPDATE database_start_admissions AS h SET storage_volume_json=(SELECT d.storage_volume_json FROM databases d WHERE d.id=h.database_id) WHERE (h.database_id=? AND h.generation=(SELECT MAX(x.generation) FROM database_start_admissions x WHERE x.database_id=h.database_id AND x.generation<=?) AND h.node_id=? AND h.node_uid=? AND h.storage_budget_bytes>0 AND h.storage_volume_json IS NULL) AND EXISTS(SELECT 1 FROM databases d JOIN operations o ON o.id=h.operation_id AND o.database_id=d.id AND o.project_id=d.project_id WHERE d.id=h.database_id AND d.generation=? AND d.node_id=h.node_id AND d.storage_generation=? AND (${same}) AND (d.power_operation=h.operation_id OR substr(d.archive_path,-23)=h.operation_id OR (o.kind='database.resize' AND o.generation=h.generation))) AND EXISTS(SELECT 1 FROM node_thin_storage t WHERE t.node_id=? AND t.node_uid=? AND t.authority_revision=? AND t.authority_json=?)`,
        )
        .bind(
          volume.database_id,
          volume.generation,
          authority.node_id,
          authority.node_uid,
          volume.generation,
          volume.storage_generation,
          ...receiptFields.map((key) => value[key]),
          authority.node_id,
          authority.node_uid,
          authority.revision,
          serialized,
        ),
    );
    if (
      authority.write_allowed &&
      authority.data_accounting_complete &&
      volume.io.length === 1
    ) {
      // Current SQL-ready runtime identity comes from the existing host Create/Start handoff.
      // The fresh high-trust physical frame must independently name that exact capped Pod.
      statements.push(
        db
          .prepare(
            `UPDATE database_start_admissions AS h SET ready_at=(SELECT d.updated_at FROM databases d WHERE d.id=h.database_id),ready_sample_observed_at=COALESCE((SELECT MAX(m.observed_at) FROM node_memory_samples m WHERE m.node_id=h.node_id AND m.node_uid=h.node_uid),h.grant_sample_observed_at)
        WHERE (h.database_id=? AND h.generation<=? AND h.node_id=? AND h.node_uid=? AND h.storage_budget_bytes>0 AND h.ready_at IS NULL)
        AND EXISTS(SELECT 1 FROM databases d JOIN node_thin_storage t ON t.node_id=d.node_id WHERE (d.id=h.database_id AND d.generation=? AND d.storage_generation=? AND d.observed_generation=d.generation)
          AND (d.desired_state='running' AND d.observed_state='ready' AND d.observed_power='awake' AND d.deleted_at IS NULL)
          AND ${holdReceiptMatchesCurrentSql("h", "d")}
          AND (t.node_uid=h.node_uid AND t.authority_revision=? AND t.authority_json=? AND julianday(${inventoryObservedSql()})>=julianday(d.updated_at))
          AND (json_extract(d.runtime_attestation_json,'$.database_id')=d.id AND json_extract(d.runtime_attestation_json,'$.generation')=d.generation AND json_extract(d.runtime_attestation_json,'$.storage_generation')=d.storage_generation AND json_extract(d.runtime_attestation_json,'$.node_uid')=h.node_uid)
          AND (json_extract(d.runtime_attestation_json,'$.boot_id')=json_extract(t.qualification_json,'$.boot_id') AND json_extract(d.runtime_attestation_json,'$.cluster_uid')=t.cluster_uid AND json_extract(d.runtime_attestation_json,'$.namespace_uid')=? AND json_extract(d.runtime_attestation_json,'$.cnpg_cluster_uid')=?)
          AND (json_extract(d.runtime_attestation_json,'$.storage_uid')=? AND json_extract(d.runtime_attestation_json,'$.pvc_uid')=? AND json_extract(d.runtime_attestation_json,'$.pv_uid')=? AND json_extract(d.runtime_attestation_json,'$.pod_uid')=?)
          AND (?<=json_extract(d.storage_profile_json,'$.write_bytes_per_second') AND ?<=json_extract(d.storage_profile_json,'$.write_iops_per_second'))
          AND EXISTS(SELECT 1 FROM operations current_ready WHERE current_ready.database_id=d.id AND current_ready.project_id=d.project_id AND current_ready.generation=d.generation AND current_ready.status='succeeded' AND ((current_ready.id=d.power_operation AND current_ready.kind IN('database.resume','database.wake')) OR (current_ready.id=substr(d.archive_path,-23) AND current_ready.kind IN('database.create','database.restore')) OR current_ready.kind='database.resize')))
      `,
          )
          .bind(
            volume.database_id,
            volume.generation,
            authority.node_id,
            authority.node_uid,
            volume.generation,
            volume.storage_generation,
            authority.revision,
            serialized,
            volume.namespace_uid,
            volume.cluster_uid,
            volume.storage_uid,
            volume.pvc_uid,
            volume.pv_uid,
            volume.io[0]!.pod_uid,
            volume.io[0]!.write_bytes_per_second,
            volume.io[0]!.write_iops_per_second,
          ),
      );
    }
  }
  return statements;
}

/** No receipt can be inferred for an older grant. A deleted obligation can instead be
 * discharged by a later qualified closed-world read proving no Thin storage anywhere
 * in its immutable node/VG/profile scope. Known retained thick storage is preserved. */
function globallyAbsentDeletedStorageHoldSql(admission: string): string {
  return `EXISTS(SELECT 1 FROM databases storage_db
    JOIN operations start_op ON start_op.id=${admission}.operation_id AND start_op.database_id=storage_db.id AND start_op.project_id=storage_db.project_id
    JOIN nodes n ON n.id=storage_db.node_id AND n.region_id=storage_db.region_id
    JOIN node_thin_storage t ON t.node_id=n.id AND t.node_uid=n.node_uid
    WHERE (${admission}.storage_volume_json IS NULL AND ${admission}.storage_budget_bytes>0
      AND storage_db.id=${admission}.database_id AND storage_db.node_id=${admission}.node_id AND n.node_uid=${admission}.node_uid
      AND start_op.generation=${admission}.generation AND ${admission}.generation<=storage_db.generation
      AND start_op.kind IN('database.create','database.restore','database.resume','database.wake','database.resize'))
      AND (storage_db.desired_state='deleted' AND storage_db.observed_state='deleted'
      AND storage_db.observed_generation=storage_db.generation AND storage_db.deleted_at IS NOT NULL
      AND julianday(${admission}.granted_at)<=julianday(storage_db.updated_at))
      AND (n.ready=1 AND n.lost_at IS NULL AND t.error_code IS NULL
      AND julianday(n.last_observed_at)>=julianday('now','-180 seconds') AND julianday(n.last_observed_at)<=julianday('now','+5 seconds'))
      AND (json_extract(storage_db.storage_profile_json,'$.backend')='lvm-thin-v1'
      AND json_extract(storage_db.storage_profile_json,'$.node_uid')=t.node_uid
      AND json_extract(storage_db.storage_profile_json,'$.volume_group_uuid')=t.volume_group_uuid
      AND json_extract(storage_db.storage_profile_json,'$.profile_sha256')=t.profile_sha256
      AND json_extract(storage_db.storage_profile_json,'$.profile_revision')<=t.profile_revision)
      AND (json_extract(t.authority_json,'$.revision')=t.authority_revision
      AND json_extract(t.authority_json,'$.node_id')=t.node_id AND json_extract(t.authority_json,'$.name')=n.k8s_node_name
      AND json_extract(t.authority_json,'$.node_uid')=t.node_uid AND json_extract(t.authority_json,'$.cluster_uid')=t.cluster_uid
      AND json_extract(t.authority_json,'$.volume_group_uuid')=t.volume_group_uuid
      AND json_extract(t.authority_json,'$.physical.volume_group_uuid')=t.volume_group_uuid
      AND json_extract(t.authority_json,'$.profile_sha256')=t.profile_sha256
      AND json_extract(t.authority_json,'$.profile_revision')=t.profile_revision
      AND json_extract(t.authority_json,'$.driver_image')=t.qualified_driver_image
      AND json_extract(t.authority_json,'$.data_accounting_complete')=1)
      AND (julianday(t.authority_received_at)>=julianday('now','-120 seconds') AND julianday(t.authority_received_at)<=julianday('now','+5 seconds')
      AND julianday(${inventoryObservedSql()})>=julianday('now','-120 seconds') AND julianday(${inventoryObservedSql()})<=julianday('now','+5 seconds')
      AND julianday(${inventoryExpiresSql()})>julianday('now')
      AND julianday(${inventoryObservedSql()})>julianday(${admission}.ready_at,'+5 seconds')
      AND julianday(${inventoryObservedSql()})>julianday(storage_db.updated_at,'+5 seconds'))
      AND EXISTS(SELECT 1 FROM node_memory_samples current_memory WHERE current_memory.node_id=n.id AND current_memory.node_uid=n.node_uid
        AND julianday(current_memory.observed_at)>julianday(storage_db.updated_at,'+5 seconds'))
      AND (json_type(t.authority_json,'$.pool_uuid')='null' AND json_type(t.authority_json,'$.physical.thin_pool')='null'
      AND json_type(t.authority_json,'$.physical_lvs')='array' AND json_type(t.authority_json,'$.volumes')='array' AND json_type(t.authority_json,'$.active_lv_uuids')='array')
      AND NOT EXISTS(SELECT 1 FROM json_each(t.authority_json,'$.physical_lvs') lv WHERE json_extract(lv.value,'$.segtype') IS NOT 'linear')
      AND NOT EXISTS(SELECT 1 FROM json_each(t.authority_json,'$.volumes') volume WHERE json_extract(volume.value,'$.storage_class') IS NOT 'pgcf-lvm')
      AND NOT EXISTS(SELECT 1 FROM json_each(t.authority_json,'$.active_lv_uuids') active WHERE NOT EXISTS(
        SELECT 1 FROM json_each(t.authority_json,'$.physical_lvs') lv WHERE json_extract(lv.value,'$.lv_uuid')=active.value AND json_extract(lv.value,'$.segtype')='linear'))
      AND NOT EXISTS(SELECT 1 FROM json_each(t.authority_json,'$.physical_lvs') lv WHERE NOT EXISTS(
        SELECT 1 FROM json_each(t.authority_json,'$.volumes') volume WHERE json_extract(volume.value,'$.lv_uuid')=json_extract(lv.value,'$.lv_uuid') AND json_extract(volume.value,'$.volume_handle')=json_extract(lv.value,'$.name')))
      AND NOT EXISTS(SELECT 1 FROM json_each(t.authority_json,'$.volumes') volume WHERE NOT EXISTS(
        SELECT 1 FROM json_each(t.authority_json,'$.physical_lvs') lv WHERE json_extract(lv.value,'$.lv_uuid')=json_extract(volume.value,'$.lv_uuid') AND json_extract(lv.value,'$.name')=json_extract(volume.value,'$.volume_handle')))
      AND (SELECT count(*) FROM json_each(t.authority_json,'$.physical_lvs'))=(SELECT count(DISTINCT json_extract(value,'$.lv_uuid')) FROM json_each(t.authority_json,'$.physical_lvs'))
      AND (SELECT count(*) FROM json_each(t.authority_json,'$.physical_lvs'))=(SELECT count(DISTINCT json_extract(value,'$.name')) FROM json_each(t.authority_json,'$.physical_lvs'))
      AND (SELECT count(*) FROM json_each(t.authority_json,'$.volumes'))=(SELECT count(DISTINCT json_extract(value,'$.lv_uuid')) FROM json_each(t.authority_json,'$.volumes'))
  )`;
}

/** A later Native read must cover the actual bound volume (or prove its physical absence).
 * A RAM heartbeat by itself cannot settle a thin startup debit. */
export function coveredStorageHoldSql(admissionAlias = "a"): string {
  const admission = identifier(admissionAlias);
  return `(${admission}.storage_budget_bytes=0 OR ${globallyAbsentDeletedStorageHoldSql(admission)} OR EXISTS(
    SELECT 1 FROM databases storage_db JOIN node_thin_storage t ON t.node_id=storage_db.node_id
    WHERE (storage_db.id=${admission}.database_id AND t.node_uid=${admission}.node_uid) AND ${holdReceiptMatchesCurrentSql(admission, "storage_db")}
      AND (json_extract(storage_db.storage_profile_json,'$.node_uid')=t.node_uid
      AND json_extract(storage_db.storage_profile_json,'$.volume_group_uuid')=t.volume_group_uuid
      AND json_extract(storage_db.storage_profile_json,'$.profile_sha256')=t.profile_sha256
      AND json_extract(storage_db.storage_profile_json,'$.profile_revision')<=t.profile_revision
      AND json_extract(t.authority_json,'$.revision')=t.authority_revision)
      AND (julianday(t.authority_received_at)>=julianday('now','-120 seconds')
      AND julianday(t.authority_received_at)<=julianday('now','+5 seconds')
      AND json_extract(t.authority_json,'$.node_uid')=t.node_uid
      AND json_extract(t.authority_json,'$.cluster_uid')=t.cluster_uid)
      AND (json_extract(t.authority_json,'$.volume_group_uuid')=t.volume_group_uuid
      AND json_extract(t.authority_json,'$.profile_sha256')=t.profile_sha256
      AND json_extract(t.authority_json,'$.data_accounting_complete')=1
      AND julianday(${inventoryObservedSql()})>julianday(${admission}.ready_at,'+5 seconds'))
      AND (julianday(${inventoryObservedSql()})>=julianday('now','-120 seconds')
      AND julianday(${inventoryObservedSql()})<=julianday('now','+5 seconds')
      AND julianday(${inventoryExpiresSql()})>julianday('now')
      AND storage_db.storage_volume_json IS NOT NULL)
      AND (json_extract(storage_db.storage_volume_json,'$.node_uid')=t.node_uid
      AND json_extract(storage_db.storage_volume_json,'$.volume_group_uuid')=t.volume_group_uuid
      AND json_extract(storage_db.storage_volume_json,'$.storage_generation')=storage_db.storage_generation)
      AND ((storage_db.desired_state='deleted' AND storage_db.observed_state='deleted'
          AND NOT EXISTS(SELECT 1 FROM json_each(t.authority_json,'$.physical_lvs') lv WHERE json_extract(lv.value,'$.lv_uuid')=json_extract(storage_db.storage_volume_json,'$.lv_uuid'))
          AND NOT EXISTS(SELECT 1 FROM json_each(t.authority_json,'$.active_lv_uuids') lv WHERE lv.value=json_extract(storage_db.storage_volume_json,'$.lv_uuid')))
        OR EXISTS(SELECT 1 FROM json_each(t.authority_json,'$.volumes') v
          WHERE json_extract(v.value,'$.database_id')=storage_db.id
            AND json_extract(v.value,'$.generation')=storage_db.generation
            AND json_extract(v.value,'$.storage_generation')=storage_db.storage_generation
            AND json_extract(v.value,'$.storage_uid')=json_extract(storage_db.storage_volume_json,'$.storage_uid')
            AND json_extract(v.value,'$.namespace_uid')=json_extract(storage_db.storage_volume_json,'$.namespace_uid')
            AND json_extract(v.value,'$.cluster_uid')=json_extract(storage_db.storage_volume_json,'$.cluster_uid')
            AND json_extract(v.value,'$.volume_handle')=json_extract(storage_db.storage_volume_json,'$.volume_handle')
            AND json_extract(v.value,'$.lv_uuid')=json_extract(storage_db.storage_volume_json,'$.lv_uuid')
            AND json_extract(v.value,'$.pvc_uid')=json_extract(storage_db.storage_volume_json,'$.pvc_uid')
            AND json_extract(v.value,'$.pv_uid')=json_extract(storage_db.storage_volume_json,'$.pv_uid')
            AND ((storage_db.observed_power='hibernated' AND storage_db.observed_generation=storage_db.generation)
              OR (json_array_length(v.value,'$.io')=1
                AND json_extract(v.value,'$.io[0].write_bytes_per_second')<=json_extract(storage_db.storage_profile_json,'$.write_bytes_per_second')
                AND json_extract(v.value,'$.io[0].write_iops_per_second')<=json_extract(storage_db.storage_profile_json,'$.write_iops_per_second')))))
  ))`;
}

/** Only a fresh Native negative physical read may complete deletion of a known thin volume. */
export function thinStorageDeletionConfirmedSql(
  databaseAlias = "databases",
): string {
  const database = identifier(databaseAlias),
    lv = `json_extract(${database}.storage_volume_json,'$.lv_uuid')`;
  return `(${database}.storage_profile_json IS NULL OR EXISTS(
    SELECT 1 FROM node_thin_storage t JOIN nodes n ON n.id=t.node_id AND n.node_uid=t.node_uid
    WHERE t.node_id=${database}.node_id AND n.region_id=${database}.region_id AND n.lost_at IS NULL
      AND ${database}.storage_volume_json IS NOT NULL
      AND typeof(${lv})='text' AND length(${lv})=38 AND length(replace(${lv},'-',''))=32
      AND replace(${lv},'-','') NOT GLOB '*[^A-Za-z0-9]*'
      AND substr(${lv},7,1)='-' AND substr(${lv},12,1)='-' AND substr(${lv},17,1)='-'
      AND substr(${lv},22,1)='-' AND substr(${lv},27,1)='-' AND substr(${lv},32,1)='-'
      AND json_extract(${database}.storage_volume_json,'$.storage_generation')=${database}.storage_generation
      AND json_extract(${database}.storage_profile_json,'$.node_uid')=t.node_uid
      AND json_extract(${database}.storage_volume_json,'$.node_uid')=t.node_uid
      AND json_extract(${database}.storage_volume_json,'$.volume_group_uuid')=t.volume_group_uuid
      AND json_extract(${database}.storage_profile_json,'$.profile_sha256')=t.profile_sha256
      AND json_extract(t.authority_json,'$.revision')=t.authority_revision
      AND julianday(t.authority_received_at)>=julianday('now','-120 seconds')
      AND julianday(t.authority_received_at)<=julianday('now','+5 seconds')
      AND json_extract(t.authority_json,'$.node_uid')=t.node_uid
      AND json_extract(t.authority_json,'$.cluster_uid')=t.cluster_uid
      AND json_extract(t.authority_json,'$.volume_group_uuid')=t.volume_group_uuid
      AND json_extract(t.authority_json,'$.profile_sha256')=t.profile_sha256
      AND json_extract(t.authority_json,'$.data_accounting_complete')=1
      AND julianday(${inventoryObservedSql()})>julianday(${database}.updated_at)
      AND julianday(${inventoryObservedSql()})>=julianday('now','-120 seconds')
      AND julianday(${inventoryObservedSql()})<=julianday('now','+5 seconds')
      AND julianday(${inventoryExpiresSql()})>julianday('now')
      AND NOT EXISTS(SELECT 1 FROM json_each(t.authority_json,'$.physical_lvs') physical_lv WHERE json_extract(physical_lv.value,'$.lv_uuid')=${lv})
      AND NOT EXISTS(SELECT 1 FROM json_each(t.authority_json,'$.active_lv_uuids') active_lv WHERE active_lv.value=${lv})))`;
}
