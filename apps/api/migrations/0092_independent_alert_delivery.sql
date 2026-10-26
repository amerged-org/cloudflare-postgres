-- SPDX-License-Identifier: Apache-2.0
-- Independent notification destinations and opt-in current-pressure alerts. No purchases or moves.
-- Migration first; earlier Workers keep using the original singleton recipient and episode fields.
ALTER TABLE infrastructure_backup_config ADD COLUMN notification_recipients TEXT NOT NULL DEFAULT '[]'
  CHECK(json_valid(notification_recipients) AND json_type(notification_recipients)='array');
ALTER TABLE node_region_policies ADD COLUMN capacity_alert_policy TEXT
  CHECK(capacity_alert_policy IS NULL OR json_valid(capacity_alert_policy));
ALTER TABLE infrastructure_alerts RENAME TO infrastructure_alerts_previous;
CREATE TABLE infrastructure_alerts (
  region_id TEXT NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN('regional_node_cap_reached','regional_node_stale','infrastructure_backup_failed','infrastructure_backup_stale','regional_node_capacity_warning','regional_node_capacity_action','regional_node_ram_warning','regional_node_cpu_warning','regional_node_storage_warning','database_archive_failing','database_base_backup_stale','thin_storage_blocked','database_delete_incomplete','regional_node_capacity_refusals','regional_node_pool_closed','database_volume_warning','database_volume_critical','control_cron_stalled','control_cron_step_failing','node_enrollment_refused','node_unexpected_reboot')),
  active INTEGER NOT NULL CHECK(active IN(0,1)),
  event_id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(payload)<=4096),
  delivered_at TEXT,
  last_attempt_at TEXT,
  PRIMARY KEY(region_id,kind)
) STRICT;
INSERT INTO infrastructure_alerts SELECT * FROM infrastructure_alerts_previous;
DROP TABLE infrastructure_alerts_previous;

ALTER TABLE infrastructure_alerts ADD COLUMN fanout_initialized INTEGER NOT NULL DEFAULT 0 CHECK(fanout_initialized IN(0,1));
CREATE TABLE infrastructure_alert_deliveries (
  region_id TEXT NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  event_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN('webhook','email')),
  recipient TEXT,
  delivered_at TEXT,
  last_attempt_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,
  last_error TEXT,
  PRIMARY KEY(region_id,kind,event_id,occurred_at,destination_id)
) STRICT;
