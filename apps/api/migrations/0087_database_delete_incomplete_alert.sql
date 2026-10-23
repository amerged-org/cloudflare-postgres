-- SPDX-License-Identifier: Apache-2.0
-- Contract: the alert kind `database_delete_incomplete` (plan 4.3, F2 of the live run on US1).
--
-- A database is deleted in D1 at the request, and its node removes the unit, the volumes, the user
-- and the files after it. When the node cannot (a full filesystem that makes PostgreSQL's shutdown
-- checkpoint PANIC, a unit that no signal ends, a user the system cannot lock), the volume stays and
-- so does its space in the thin pool. The agent says every step that fails and tries again; this kind
-- tells the operator when a delete has not finished ten minutes after the request, ten minutes
-- being below the 20 minutes after which the integrator's delete operation ends `operation_timeout`.
--
-- SQLite cannot widen a CHECK in place, so the table is built again as 0082 did and every episode is
-- copied unchanged. Nothing references `infrastructure_alerts`.
--
-- Deploy order: this migration first, then the API Worker. The API Worker that runs meanwhile never
-- writes the new kind. A new API Worker before the migration fails the write of an episode of this
-- kind, which the alert step reports as that kind failing while the others are judged and sent as
-- before; no other kind is affected.

ALTER TABLE infrastructure_alerts RENAME TO infrastructure_alerts_previous;
CREATE TABLE infrastructure_alerts (
  region_id TEXT NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN('regional_node_cap_reached','regional_node_stale','infrastructure_backup_failed','infrastructure_backup_stale','regional_node_ram_warning','regional_node_cpu_warning','regional_node_storage_warning','database_archive_failing','database_base_backup_stale','thin_storage_blocked','database_delete_incomplete','regional_node_capacity_refusals','regional_node_pool_closed','database_volume_warning','database_volume_critical','control_cron_stalled','control_cron_step_failing','node_enrollment_refused','node_unexpected_reboot')),
  active INTEGER NOT NULL CHECK(active IN(0,1)),
  event_id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(payload)<=4096),
  delivered_at TEXT,
  last_attempt_at TEXT,
  PRIMARY KEY(region_id,kind)
) STRICT;
INSERT INTO infrastructure_alerts SELECT * FROM infrastructure_alerts_previous;
DROP TABLE infrastructure_alerts_previous;
