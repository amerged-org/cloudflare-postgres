-- SPDX-License-Identifier: Apache-2.0
-- Contract: the capacity surface that nothing reads or writes any more is deleted (plan W1-D).
--
-- * The regional RAM window: `node_memory_samples` has had no producer since the node link replaced
--   the Kubernetes agent, so the table, the `regional_ram_warning` alert kind, the region's
--   `ram_expansion_threshold_ppm` and `ram_warning_threshold_ppm`, and the node columns
--   `memory_window_observed_at`, `memory_window_valid`, `memory_utilization_ppm` and
--   `memory_expansion_triggered_at` go. The alert payload keeps `regional_ram_utilization_ppm`, now
--   always null, so a receiver that reads it keeps working.
-- * `placement_mode` and `postgres_memory_request_mib` of the region policy, and the size class's
--   `cpu_request_millicores`: stored and returned, read by no placement or admission code.
-- * The three `reserved_*` usage metrics and the resource snapshot fields that fed them.
--
-- `usage_hourly` rows are never deleted: the three keys are removed from each row's `metrics` and
-- `gaps`, one first letter of the database ID at a time (every ID starts with a letter, and the
-- primary key serves the range), and the rows that hold other metrics keep them. The resource
-- snapshots of `lifecycle_events` are rewritten the same way; their immutability trigger is dropped
-- for that and created again below, unchanged.
--
-- `standing_cost_profile_hash` bound `ram_expansion_threshold_ppm` into the hash unless the
-- threshold was 760000, or null with a profile that has no trigger. The hash of every other policy
-- is cleared: an order waits for approval until PUT /v1/regions/{id}/capacity-policy stores the
-- profile again. The other hashes are the hash of the profile alone and stay valid.
--
-- A rollback of the API Worker alone does not undo this migration; the older API reads columns it no
-- longer has.

UPDATE node_region_policies SET standing_cost_profile_hash=NULL
WHERE standing_cost_profile_hash IS NOT NULL
  AND NOT (ram_expansion_threshold_ppm IS 760000
    OR (ram_expansion_threshold_ppm IS NULL
      AND json_extract(standing_cost_profile,'$.trigger') IS NULL));
ALTER TABLE node_region_policies DROP COLUMN ram_expansion_threshold_ppm;
ALTER TABLE node_region_policies DROP COLUMN ram_warning_threshold_ppm;
ALTER TABLE node_region_policies DROP COLUMN placement_mode;
ALTER TABLE node_region_policies DROP COLUMN postgres_memory_request_mib;

DROP TABLE node_memory_samples;
ALTER TABLE nodes DROP COLUMN memory_window_observed_at;
ALTER TABLE nodes DROP COLUMN memory_window_valid;
ALTER TABLE nodes DROP COLUMN memory_utilization_ppm;
ALTER TABLE nodes DROP COLUMN memory_expansion_triggered_at;

-- Alert episodes lose `regional_ram_warning`. SQLite cannot narrow a CHECK in place, so the table is
-- rebuilt as 0073 did and every other episode is copied unchanged, except that a payload which
-- still holds a RAM utilization number says null.
DELETE FROM infrastructure_alerts WHERE kind='regional_ram_warning';
UPDATE infrastructure_alerts
SET payload=json_set(payload,'$.regional_ram_utilization_ppm',json('null'))
WHERE json_type(payload,'$.regional_ram_utilization_ppm') IN('integer','real');
ALTER TABLE infrastructure_alerts RENAME TO infrastructure_alerts_previous;
CREATE TABLE infrastructure_alerts (
  region_id TEXT NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN('regional_node_cap_reached','regional_node_stale','infrastructure_backup_failed','infrastructure_backup_stale','regional_node_ram_warning','regional_node_cpu_warning','regional_node_storage_warning','database_archive_failing','database_base_backup_stale','thin_storage_blocked','regional_node_capacity_refusals','regional_node_pool_closed','database_volume_warning','database_volume_critical','control_cron_stalled','control_cron_step_failing','node_enrollment_refused','node_unexpected_reboot')),
  active INTEGER NOT NULL CHECK(active IN(0,1)),
  event_id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(payload)<=4096),
  delivered_at TEXT,
  last_attempt_at TEXT,
  PRIMARY KEY(region_id,kind)
) STRICT;
INSERT INTO infrastructure_alerts SELECT * FROM infrastructure_alerts_previous;
DROP TABLE infrastructure_alerts_previous;

-- The size class no longer has a CPU request. A resource profile revision keeps its digest, which
-- names the revision as it was created; only the stored resources lose the key.
ALTER TABLE size_classes DROP COLUMN cpu_request_millicores;
UPDATE resource_profile_revisions
SET resources_json=json_remove(resources_json,'$.cpu_request_millicores')
WHERE json_type(resources_json,'$.cpu_request_millicores') IS NOT NULL;

-- Hourly usage: remove the three metrics from `metrics` and `gaps`, a first letter at a time.
UPDATE usage_hourly SET metrics=json_remove(metrics,'$.reserved_memory_mib_seconds','$.reserved_cpu_millicore_seconds','$.reserved_storage_byte_seconds'),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps) WHERE value NOT IN('reserved_memory_mib_seconds','reserved_cpu_millicore_seconds','reserved_storage_byte_seconds') ORDER BY key))
WHERE database_id>='a' AND database_id<'b' AND (instr(metrics,'reserved_')>0 OR instr(gaps,'reserved_')>0);
UPDATE usage_hourly SET metrics=json_remove(metrics,'$.reserved_memory_mib_seconds','$.reserved_cpu_millicore_seconds','$.reserved_storage_byte_seconds'),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps) WHERE value NOT IN('reserved_memory_mib_seconds','reserved_cpu_millicore_seconds','reserved_storage_byte_seconds') ORDER BY key))
WHERE database_id>='b' AND database_id<'c' AND (instr(metrics,'reserved_')>0 OR instr(gaps,'reserved_')>0);
UPDATE usage_hourly SET metrics=json_remove(metrics,'$.reserved_memory_mib_seconds','$.reserved_cpu_millicore_seconds','$.reserved_storage_byte_seconds'),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps) WHERE value NOT IN('reserved_memory_mib_seconds','reserved_cpu_millicore_seconds','reserved_storage_byte_seconds') ORDER BY key))
WHERE database_id>='c' AND database_id<'d' AND (instr(metrics,'reserved_')>0 OR instr(gaps,'reserved_')>0);
UPDATE usage_hourly SET metrics=json_remove(metrics,'$.reserved_memory_mib_seconds','$.reserved_cpu_millicore_seconds','$.reserved_storage_byte_seconds'),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps) WHERE value NOT IN('reserved_memory_mib_seconds','reserved_cpu_millicore_seconds','reserved_storage_byte_seconds') ORDER BY key))
WHERE database_id>='d' AND database_id<'e' AND (instr(metrics,'reserved_')>0 OR instr(gaps,'reserved_')>0);
UPDATE usage_hourly SET metrics=json_remove(metrics,'$.reserved_memory_mib_seconds','$.reserved_cpu_millicore_seconds','$.reserved_storage_byte_seconds'),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps) WHERE value NOT IN('reserved_memory_mib_seconds','reserved_cpu_millicore_seconds','reserved_storage_byte_seconds') ORDER BY key))
WHERE database_id>='e' AND database_id<'f' AND (instr(metrics,'reserved_')>0 OR instr(gaps,'reserved_')>0);
UPDATE usage_hourly SET metrics=json_remove(metrics,'$.reserved_memory_mib_seconds','$.reserved_cpu_millicore_seconds','$.reserved_storage_byte_seconds'),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps) WHERE value NOT IN('reserved_memory_mib_seconds','reserved_cpu_millicore_seconds','reserved_storage_byte_seconds') ORDER BY key))
WHERE database_id>='f' AND database_id<'g' AND (instr(metrics,'reserved_')>0 OR instr(gaps,'reserved_')>0);
UPDATE usage_hourly SET metrics=json_remove(metrics,'$.reserved_memory_mib_seconds','$.reserved_cpu_millicore_seconds','$.reserved_storage_byte_seconds'),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps) WHERE value NOT IN('reserved_memory_mib_seconds','reserved_cpu_millicore_seconds','reserved_storage_byte_seconds') ORDER BY key))
WHERE database_id>='g' AND database_id<'h' AND (instr(metrics,'reserved_')>0 OR instr(gaps,'reserved_')>0);
UPDATE usage_hourly SET metrics=json_remove(metrics,'$.reserved_memory_mib_seconds','$.reserved_cpu_millicore_seconds','$.reserved_storage_byte_seconds'),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps) WHERE value NOT IN('reserved_memory_mib_seconds','reserved_cpu_millicore_seconds','reserved_storage_byte_seconds') ORDER BY key))
WHERE database_id>='h' AND database_id<'i' AND (instr(metrics,'reserved_')>0 OR instr(gaps,'reserved_')>0);
UPDATE usage_hourly SET metrics=json_remove(metrics,'$.reserved_memory_mib_seconds','$.reserved_cpu_millicore_seconds','$.reserved_storage_byte_seconds'),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps) WHERE value NOT IN('reserved_memory_mib_seconds','reserved_cpu_millicore_seconds','reserved_storage_byte_seconds') ORDER BY key))
WHERE database_id>='i' AND database_id<'j' AND (instr(metrics,'reserved_')>0 OR instr(gaps,'reserved_')>0);
UPDATE usage_hourly SET metrics=json_remove(metrics,'$.reserved_memory_mib_seconds','$.reserved_cpu_millicore_seconds','$.reserved_storage_byte_seconds'),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps) WHERE value NOT IN('reserved_memory_mib_seconds','reserved_cpu_millicore_seconds','reserved_storage_byte_seconds') ORDER BY key))
WHERE database_id>='j' AND database_id<'k' AND (instr(metrics,'reserved_')>0 OR instr(gaps,'reserved_')>0);
UPDATE usage_hourly SET metrics=json_remove(metrics,'$.reserved_memory_mib_seconds','$.reserved_cpu_millicore_seconds','$.reserved_storage_byte_seconds'),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps) WHERE value NOT IN('reserved_memory_mib_seconds','reserved_cpu_millicore_seconds','reserved_storage_byte_seconds') ORDER BY key))
WHERE database_id>='k' AND database_id<'l' AND (instr(metrics,'reserved_')>0 OR instr(gaps,'reserved_')>0);
UPDATE usage_hourly SET metrics=json_remove(metrics,'$.reserved_memory_mib_seconds','$.reserved_cpu_millicore_seconds','$.reserved_storage_byte_seconds'),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps) WHERE value NOT IN('reserved_memory_mib_seconds','reserved_cpu_millicore_seconds','reserved_storage_byte_seconds') ORDER BY key))
WHERE database_id>='l' AND database_id<'m' AND (instr(metrics,'reserved_')>0 OR instr(gaps,'reserved_')>0);
UPDATE usage_hourly SET metrics=json_remove(metrics,'$.reserved_memory_mib_seconds','$.reserved_cpu_millicore_seconds','$.reserved_storage_byte_seconds'),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps) WHERE value NOT IN('reserved_memory_mib_seconds','reserved_cpu_millicore_seconds','reserved_storage_byte_seconds') ORDER BY key))
WHERE database_id>='m' AND database_id<'n' AND (instr(metrics,'reserved_')>0 OR instr(gaps,'reserved_')>0);
UPDATE usage_hourly SET metrics=json_remove(metrics,'$.reserved_memory_mib_seconds','$.reserved_cpu_millicore_seconds','$.reserved_storage_byte_seconds'),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps) WHERE value NOT IN('reserved_memory_mib_seconds','reserved_cpu_millicore_seconds','reserved_storage_byte_seconds') ORDER BY key))
WHERE database_id>='n' AND database_id<'o' AND (instr(metrics,'reserved_')>0 OR instr(gaps,'reserved_')>0);
UPDATE usage_hourly SET metrics=json_remove(metrics,'$.reserved_memory_mib_seconds','$.reserved_cpu_millicore_seconds','$.reserved_storage_byte_seconds'),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps) WHERE value NOT IN('reserved_memory_mib_seconds','reserved_cpu_millicore_seconds','reserved_storage_byte_seconds') ORDER BY key))
WHERE database_id>='o' AND database_id<'p' AND (instr(metrics,'reserved_')>0 OR instr(gaps,'reserved_')>0);
UPDATE usage_hourly SET metrics=json_remove(metrics,'$.reserved_memory_mib_seconds','$.reserved_cpu_millicore_seconds','$.reserved_storage_byte_seconds'),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps) WHERE value NOT IN('reserved_memory_mib_seconds','reserved_cpu_millicore_seconds','reserved_storage_byte_seconds') ORDER BY key))
WHERE database_id>='p' AND database_id<'q' AND (instr(metrics,'reserved_')>0 OR instr(gaps,'reserved_')>0);
UPDATE usage_hourly SET metrics=json_remove(metrics,'$.reserved_memory_mib_seconds','$.reserved_cpu_millicore_seconds','$.reserved_storage_byte_seconds'),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps) WHERE value NOT IN('reserved_memory_mib_seconds','reserved_cpu_millicore_seconds','reserved_storage_byte_seconds') ORDER BY key))
WHERE database_id>='q' AND database_id<'r' AND (instr(metrics,'reserved_')>0 OR instr(gaps,'reserved_')>0);
UPDATE usage_hourly SET metrics=json_remove(metrics,'$.reserved_memory_mib_seconds','$.reserved_cpu_millicore_seconds','$.reserved_storage_byte_seconds'),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps) WHERE value NOT IN('reserved_memory_mib_seconds','reserved_cpu_millicore_seconds','reserved_storage_byte_seconds') ORDER BY key))
WHERE database_id>='r' AND database_id<'s' AND (instr(metrics,'reserved_')>0 OR instr(gaps,'reserved_')>0);
UPDATE usage_hourly SET metrics=json_remove(metrics,'$.reserved_memory_mib_seconds','$.reserved_cpu_millicore_seconds','$.reserved_storage_byte_seconds'),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps) WHERE value NOT IN('reserved_memory_mib_seconds','reserved_cpu_millicore_seconds','reserved_storage_byte_seconds') ORDER BY key))
WHERE database_id>='s' AND database_id<'t' AND (instr(metrics,'reserved_')>0 OR instr(gaps,'reserved_')>0);
UPDATE usage_hourly SET metrics=json_remove(metrics,'$.reserved_memory_mib_seconds','$.reserved_cpu_millicore_seconds','$.reserved_storage_byte_seconds'),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps) WHERE value NOT IN('reserved_memory_mib_seconds','reserved_cpu_millicore_seconds','reserved_storage_byte_seconds') ORDER BY key))
WHERE database_id>='t' AND database_id<'u' AND (instr(metrics,'reserved_')>0 OR instr(gaps,'reserved_')>0);
UPDATE usage_hourly SET metrics=json_remove(metrics,'$.reserved_memory_mib_seconds','$.reserved_cpu_millicore_seconds','$.reserved_storage_byte_seconds'),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps) WHERE value NOT IN('reserved_memory_mib_seconds','reserved_cpu_millicore_seconds','reserved_storage_byte_seconds') ORDER BY key))
WHERE database_id>='u' AND database_id<'v' AND (instr(metrics,'reserved_')>0 OR instr(gaps,'reserved_')>0);
UPDATE usage_hourly SET metrics=json_remove(metrics,'$.reserved_memory_mib_seconds','$.reserved_cpu_millicore_seconds','$.reserved_storage_byte_seconds'),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps) WHERE value NOT IN('reserved_memory_mib_seconds','reserved_cpu_millicore_seconds','reserved_storage_byte_seconds') ORDER BY key))
WHERE database_id>='v' AND database_id<'w' AND (instr(metrics,'reserved_')>0 OR instr(gaps,'reserved_')>0);
UPDATE usage_hourly SET metrics=json_remove(metrics,'$.reserved_memory_mib_seconds','$.reserved_cpu_millicore_seconds','$.reserved_storage_byte_seconds'),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps) WHERE value NOT IN('reserved_memory_mib_seconds','reserved_cpu_millicore_seconds','reserved_storage_byte_seconds') ORDER BY key))
WHERE database_id>='w' AND database_id<'x' AND (instr(metrics,'reserved_')>0 OR instr(gaps,'reserved_')>0);
UPDATE usage_hourly SET metrics=json_remove(metrics,'$.reserved_memory_mib_seconds','$.reserved_cpu_millicore_seconds','$.reserved_storage_byte_seconds'),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps) WHERE value NOT IN('reserved_memory_mib_seconds','reserved_cpu_millicore_seconds','reserved_storage_byte_seconds') ORDER BY key))
WHERE database_id>='x' AND database_id<'y' AND (instr(metrics,'reserved_')>0 OR instr(gaps,'reserved_')>0);
UPDATE usage_hourly SET metrics=json_remove(metrics,'$.reserved_memory_mib_seconds','$.reserved_cpu_millicore_seconds','$.reserved_storage_byte_seconds'),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps) WHERE value NOT IN('reserved_memory_mib_seconds','reserved_cpu_millicore_seconds','reserved_storage_byte_seconds') ORDER BY key))
WHERE database_id>='y' AND database_id<'z' AND (instr(metrics,'reserved_')>0 OR instr(gaps,'reserved_')>0);
UPDATE usage_hourly SET metrics=json_remove(metrics,'$.reserved_memory_mib_seconds','$.reserved_cpu_millicore_seconds','$.reserved_storage_byte_seconds'),
  gaps=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(usage_hourly.gaps) WHERE value NOT IN('reserved_memory_mib_seconds','reserved_cpu_millicore_seconds','reserved_storage_byte_seconds') ORDER BY key))
WHERE database_id>='z' AND (instr(metrics,'reserved_')>0 OR instr(gaps,'reserved_')>0);

-- The resource snapshot of a lifecycle event keeps the memory and CPU limits and nothing else.
DROP TRIGGER lifecycle_events_immutable;
UPDATE lifecycle_events SET resource_snapshot=json_remove(resource_snapshot,'$.reserved_memory_mib','$.reserved_cpu_millicores','$.storage_allocated_bytes')
WHERE database_id>='a' AND database_id<'b' AND (instr(resource_snapshot,'reserved_')>0 OR instr(resource_snapshot,'storage_allocated_bytes')>0);
UPDATE lifecycle_events SET resource_snapshot=json_remove(resource_snapshot,'$.reserved_memory_mib','$.reserved_cpu_millicores','$.storage_allocated_bytes')
WHERE database_id>='b' AND database_id<'c' AND (instr(resource_snapshot,'reserved_')>0 OR instr(resource_snapshot,'storage_allocated_bytes')>0);
UPDATE lifecycle_events SET resource_snapshot=json_remove(resource_snapshot,'$.reserved_memory_mib','$.reserved_cpu_millicores','$.storage_allocated_bytes')
WHERE database_id>='c' AND database_id<'d' AND (instr(resource_snapshot,'reserved_')>0 OR instr(resource_snapshot,'storage_allocated_bytes')>0);
UPDATE lifecycle_events SET resource_snapshot=json_remove(resource_snapshot,'$.reserved_memory_mib','$.reserved_cpu_millicores','$.storage_allocated_bytes')
WHERE database_id>='d' AND database_id<'e' AND (instr(resource_snapshot,'reserved_')>0 OR instr(resource_snapshot,'storage_allocated_bytes')>0);
UPDATE lifecycle_events SET resource_snapshot=json_remove(resource_snapshot,'$.reserved_memory_mib','$.reserved_cpu_millicores','$.storage_allocated_bytes')
WHERE database_id>='e' AND database_id<'f' AND (instr(resource_snapshot,'reserved_')>0 OR instr(resource_snapshot,'storage_allocated_bytes')>0);
UPDATE lifecycle_events SET resource_snapshot=json_remove(resource_snapshot,'$.reserved_memory_mib','$.reserved_cpu_millicores','$.storage_allocated_bytes')
WHERE database_id>='f' AND database_id<'g' AND (instr(resource_snapshot,'reserved_')>0 OR instr(resource_snapshot,'storage_allocated_bytes')>0);
UPDATE lifecycle_events SET resource_snapshot=json_remove(resource_snapshot,'$.reserved_memory_mib','$.reserved_cpu_millicores','$.storage_allocated_bytes')
WHERE database_id>='g' AND database_id<'h' AND (instr(resource_snapshot,'reserved_')>0 OR instr(resource_snapshot,'storage_allocated_bytes')>0);
UPDATE lifecycle_events SET resource_snapshot=json_remove(resource_snapshot,'$.reserved_memory_mib','$.reserved_cpu_millicores','$.storage_allocated_bytes')
WHERE database_id>='h' AND database_id<'i' AND (instr(resource_snapshot,'reserved_')>0 OR instr(resource_snapshot,'storage_allocated_bytes')>0);
UPDATE lifecycle_events SET resource_snapshot=json_remove(resource_snapshot,'$.reserved_memory_mib','$.reserved_cpu_millicores','$.storage_allocated_bytes')
WHERE database_id>='i' AND database_id<'j' AND (instr(resource_snapshot,'reserved_')>0 OR instr(resource_snapshot,'storage_allocated_bytes')>0);
UPDATE lifecycle_events SET resource_snapshot=json_remove(resource_snapshot,'$.reserved_memory_mib','$.reserved_cpu_millicores','$.storage_allocated_bytes')
WHERE database_id>='j' AND database_id<'k' AND (instr(resource_snapshot,'reserved_')>0 OR instr(resource_snapshot,'storage_allocated_bytes')>0);
UPDATE lifecycle_events SET resource_snapshot=json_remove(resource_snapshot,'$.reserved_memory_mib','$.reserved_cpu_millicores','$.storage_allocated_bytes')
WHERE database_id>='k' AND database_id<'l' AND (instr(resource_snapshot,'reserved_')>0 OR instr(resource_snapshot,'storage_allocated_bytes')>0);
UPDATE lifecycle_events SET resource_snapshot=json_remove(resource_snapshot,'$.reserved_memory_mib','$.reserved_cpu_millicores','$.storage_allocated_bytes')
WHERE database_id>='l' AND database_id<'m' AND (instr(resource_snapshot,'reserved_')>0 OR instr(resource_snapshot,'storage_allocated_bytes')>0);
UPDATE lifecycle_events SET resource_snapshot=json_remove(resource_snapshot,'$.reserved_memory_mib','$.reserved_cpu_millicores','$.storage_allocated_bytes')
WHERE database_id>='m' AND database_id<'n' AND (instr(resource_snapshot,'reserved_')>0 OR instr(resource_snapshot,'storage_allocated_bytes')>0);
UPDATE lifecycle_events SET resource_snapshot=json_remove(resource_snapshot,'$.reserved_memory_mib','$.reserved_cpu_millicores','$.storage_allocated_bytes')
WHERE database_id>='n' AND database_id<'o' AND (instr(resource_snapshot,'reserved_')>0 OR instr(resource_snapshot,'storage_allocated_bytes')>0);
UPDATE lifecycle_events SET resource_snapshot=json_remove(resource_snapshot,'$.reserved_memory_mib','$.reserved_cpu_millicores','$.storage_allocated_bytes')
WHERE database_id>='o' AND database_id<'p' AND (instr(resource_snapshot,'reserved_')>0 OR instr(resource_snapshot,'storage_allocated_bytes')>0);
UPDATE lifecycle_events SET resource_snapshot=json_remove(resource_snapshot,'$.reserved_memory_mib','$.reserved_cpu_millicores','$.storage_allocated_bytes')
WHERE database_id>='p' AND database_id<'q' AND (instr(resource_snapshot,'reserved_')>0 OR instr(resource_snapshot,'storage_allocated_bytes')>0);
UPDATE lifecycle_events SET resource_snapshot=json_remove(resource_snapshot,'$.reserved_memory_mib','$.reserved_cpu_millicores','$.storage_allocated_bytes')
WHERE database_id>='q' AND database_id<'r' AND (instr(resource_snapshot,'reserved_')>0 OR instr(resource_snapshot,'storage_allocated_bytes')>0);
UPDATE lifecycle_events SET resource_snapshot=json_remove(resource_snapshot,'$.reserved_memory_mib','$.reserved_cpu_millicores','$.storage_allocated_bytes')
WHERE database_id>='r' AND database_id<'s' AND (instr(resource_snapshot,'reserved_')>0 OR instr(resource_snapshot,'storage_allocated_bytes')>0);
UPDATE lifecycle_events SET resource_snapshot=json_remove(resource_snapshot,'$.reserved_memory_mib','$.reserved_cpu_millicores','$.storage_allocated_bytes')
WHERE database_id>='s' AND database_id<'t' AND (instr(resource_snapshot,'reserved_')>0 OR instr(resource_snapshot,'storage_allocated_bytes')>0);
UPDATE lifecycle_events SET resource_snapshot=json_remove(resource_snapshot,'$.reserved_memory_mib','$.reserved_cpu_millicores','$.storage_allocated_bytes')
WHERE database_id>='t' AND database_id<'u' AND (instr(resource_snapshot,'reserved_')>0 OR instr(resource_snapshot,'storage_allocated_bytes')>0);
UPDATE lifecycle_events SET resource_snapshot=json_remove(resource_snapshot,'$.reserved_memory_mib','$.reserved_cpu_millicores','$.storage_allocated_bytes')
WHERE database_id>='u' AND database_id<'v' AND (instr(resource_snapshot,'reserved_')>0 OR instr(resource_snapshot,'storage_allocated_bytes')>0);
UPDATE lifecycle_events SET resource_snapshot=json_remove(resource_snapshot,'$.reserved_memory_mib','$.reserved_cpu_millicores','$.storage_allocated_bytes')
WHERE database_id>='v' AND database_id<'w' AND (instr(resource_snapshot,'reserved_')>0 OR instr(resource_snapshot,'storage_allocated_bytes')>0);
UPDATE lifecycle_events SET resource_snapshot=json_remove(resource_snapshot,'$.reserved_memory_mib','$.reserved_cpu_millicores','$.storage_allocated_bytes')
WHERE database_id>='w' AND database_id<'x' AND (instr(resource_snapshot,'reserved_')>0 OR instr(resource_snapshot,'storage_allocated_bytes')>0);
UPDATE lifecycle_events SET resource_snapshot=json_remove(resource_snapshot,'$.reserved_memory_mib','$.reserved_cpu_millicores','$.storage_allocated_bytes')
WHERE database_id>='x' AND database_id<'y' AND (instr(resource_snapshot,'reserved_')>0 OR instr(resource_snapshot,'storage_allocated_bytes')>0);
UPDATE lifecycle_events SET resource_snapshot=json_remove(resource_snapshot,'$.reserved_memory_mib','$.reserved_cpu_millicores','$.storage_allocated_bytes')
WHERE database_id>='y' AND database_id<'z' AND (instr(resource_snapshot,'reserved_')>0 OR instr(resource_snapshot,'storage_allocated_bytes')>0);
UPDATE lifecycle_events SET resource_snapshot=json_remove(resource_snapshot,'$.reserved_memory_mib','$.reserved_cpu_millicores','$.storage_allocated_bytes')
WHERE database_id>='z' AND (instr(resource_snapshot,'reserved_')>0 OR instr(resource_snapshot,'storage_allocated_bytes')>0);
CREATE TRIGGER lifecycle_events_immutable BEFORE UPDATE ON lifecycle_events
BEGIN SELECT RAISE(ABORT, 'lifecycle events are immutable'); END;
