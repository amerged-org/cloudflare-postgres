-- SPDX-License-Identifier: Apache-2.0
-- Alert episodes gain the database, Thin storage and cron kinds. SQLite cannot widen a CHECK in
-- place, so the table is rebuilt as 0041 did and every episode is copied unchanged.
ALTER TABLE infrastructure_alerts RENAME TO infrastructure_alerts_previous;
CREATE TABLE infrastructure_alerts (
  region_id TEXT NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN('regional_ram_warning','regional_node_cap_reached','regional_node_stale','infrastructure_backup_failed','infrastructure_backup_stale','regional_node_ram_warning','regional_node_cpu_warning','regional_node_storage_warning','database_archive_failing','database_base_backup_stale','thin_storage_blocked','database_storage_protected','control_cron_stalled','control_cron_step_failing')),
  active INTEGER NOT NULL CHECK(active IN(0,1)),
  event_id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(payload)<=4096),
  delivered_at TEXT,
  last_attempt_at TEXT,
  PRIMARY KEY(region_id,kind)
) STRICT;
INSERT INTO infrastructure_alerts SELECT * FROM infrastructure_alerts_previous;
DROP TABLE infrastructure_alerts_previous;

-- The minute cron's heartbeat, one row. started_at is the latest run's start and completed_at the
-- latest run that attempted every step; failing_steps_json maps each step that failed in that run to
-- its consecutive failed runs and last error code. watchdog_checked_at is the CronWatchdog alarm's
-- last evaluation, written by the alarm and never by the cron.
CREATE TABLE cron_heartbeat (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  watchdog_checked_at TEXT,
  failing_steps_json TEXT NOT NULL DEFAULT '{}'
    CHECK(json_valid(failing_steps_json) AND length(failing_steps_json)<=4096)
) STRICT;
