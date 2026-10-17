// SPDX-License-Identifier: Apache-2.0
import { allOf } from "./sql-conjunction.ts";
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
/** Physical fields of the node's latest sample `o` (node_storage_observations). */
const sampled = (path: string) => `json_extract(o.physical_json,'$.${path}')`;
const sampledDataFree = `(${sampled("thin_pool.data_total_bytes")}-${sampled("thin_pool.data_used_bytes_upper_bound")})`,
  sampledMetadataFree = `(${sampled("thin_pool.metadata_total_bytes")}-${sampled("thin_pool.metadata_used_bytes_upper_bound")})`;
/** The node's latest physical sample, read at most two minutes ago. */
const freshSampleSql = `julianday(o.observed_at)>=julianday('now','-120 seconds') AND julianday(o.observed_at)<=julianday('now','+5 seconds')`;

/** The node part of the room rule over its thin storage `t` and its latest sample `o`: what the
 * desired page serves as storage_nodes[].write_allowed for the databases the node holds. */
export function thinPoolNodeRoomSql(): string {
  // Room is space in the pool: an audit turn's error is alerted, never a reason to refuse every
  // start on the node.
  return allOf(
    "json_extract(t.authority_json,'$.pool_uuid') IS NOT NULL",
    `${sampled("volume_group_uuid")}=t.volume_group_uuid`,
    freshSampleSql,
    `${sampledDataFree}>=${field("data_reserve_bytes")}`,
    `${sampledMetadataFree}>=${field("metadata_reserve_bytes")}`,
  );
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
      AND json_extract(t.authority_json,'$.node_uid')=t.node_uid
      AND json_extract(t.authority_json,'$.volume_group_uuid')=t.volume_group_uuid
      AND json_extract(t.authority_json,'$.physical.volume_group_uuid')=t.volume_group_uuid
      AND json_extract(t.authority_json,'$.profile_sha256')=t.profile_sha256
      AND json_extract(t.authority_json,'$.profile_revision')=t.profile_revision
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
      AND json_extract(t.authority_json,'$.node_uid')=t.node_uid)
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
