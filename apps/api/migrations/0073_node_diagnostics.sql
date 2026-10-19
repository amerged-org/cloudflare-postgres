-- SPDX-License-Identifier: Apache-2.0
-- Contract: after every reboot the agent reports the tail of the previous boot's journal (SEC-05),
-- and the API says whether a maintenance order asked for the reboot. One row per boot of a node: a
-- report sent again, because the answer was lost, finds its row. `body` is the report as the node
-- sent it (at most 1 MiB, `NODE_BOOT_REPORT_MAX_BYTES`), so a row stays far below D1's 2 MB row
-- limit. `expected_reboot` is 1 when a maintenance order of the node was open when its last sample
-- of the previous boot arrived, or closed after it, 0 when none was, and NULL when the agent knew
-- no earlier boot (`previous_boot_id` is NULL), so no reboot is claimed. The minute cron deletes a
-- row after 30 days.
CREATE TABLE node_diagnostics (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN('boot')),
  boot_id TEXT NOT NULL CHECK(length(boot_id)=36),
  previous_boot_id TEXT CHECK(previous_boot_id IS NULL OR length(previous_boot_id)=36),
  received_at TEXT NOT NULL CHECK(length(received_at)=24 AND received_at GLOB '????-??-??T??:??:??.???Z'),
  expected_reboot INTEGER CHECK(expected_reboot IS NULL OR expected_reboot IN(0,1)),
  body TEXT NOT NULL CHECK(json_valid(body) AND length(body)<=1048576),
  CHECK((expected_reboot IS NULL)=(previous_boot_id IS NULL)),
  UNIQUE(node_id, boot_id)
) STRICT;
CREATE INDEX node_diagnostics_node_idx ON node_diagnostics(node_id, received_at DESC, id DESC);
CREATE INDEX node_diagnostics_age_idx ON node_diagnostics(received_at);

-- The newest sample of the boot before the one the node's last hello said: the hello of a new boot
-- copies `last_observed_at` here before this boot's samples replace it. A maintenance order that
-- asked for the reboot is read against it, however late the report comes.
ALTER TABLE nodes ADD COLUMN os_previous_observed_at TEXT;

-- Alert episodes gain `node_unexpected_reboot`. SQLite cannot widen a CHECK in place, so the table
-- is rebuilt as 0064 did and every episode is copied unchanged.
ALTER TABLE infrastructure_alerts RENAME TO infrastructure_alerts_previous;
CREATE TABLE infrastructure_alerts (
  region_id TEXT NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN('regional_ram_warning','regional_node_cap_reached','regional_node_stale','infrastructure_backup_failed','infrastructure_backup_stale','regional_node_ram_warning','regional_node_cpu_warning','regional_node_storage_warning','database_archive_failing','database_base_backup_stale','thin_storage_blocked','regional_node_capacity_refusals','regional_node_pool_closed','database_volume_warning','database_volume_critical','control_cron_stalled','control_cron_step_failing','node_enrollment_refused','node_unexpected_reboot')),
  active INTEGER NOT NULL CHECK(active IN(0,1)),
  event_id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(payload)<=4096),
  delivered_at TEXT,
  last_attempt_at TEXT,
  PRIMARY KEY(region_id,kind)
) STRICT;
INSERT INTO infrastructure_alerts SELECT * FROM infrastructure_alerts_previous;
DROP TABLE infrastructure_alerts_previous;
