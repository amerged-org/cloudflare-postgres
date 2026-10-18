-- SPDX-License-Identifier: Apache-2.0
-- Contract: per-database resources and placement by measured activity (ULTRA plan 3.5, 4.8, 4.10).
--
-- A database may carry its own memory, CPU and storage; NULL takes the value of its size class.
-- The view `database_resources` is the one place that says which value applies.
ALTER TABLE databases ADD COLUMN own_memory_mib INTEGER
  CHECK(own_memory_mib IS NULL OR (own_memory_mib>=256 AND own_memory_mib%256=0));
ALTER TABLE databases ADD COLUMN own_cpu_millicores INTEGER
  CHECK(own_cpu_millicores IS NULL OR own_cpu_millicores>=100);
ALTER TABLE databases ADD COLUMN own_storage_gib INTEGER
  CHECK(own_storage_gib IS NULL OR own_storage_gib>=1);
-- When the database was placed on its node, or last grew its memory there. Such a database counts
-- at its full memory until the first 30-minute average that includes it exists (plan 4.8).
ALTER TABLE databases ADD COLUMN placed_at TEXT;

-- Placement no longer records a thin storage profile on the database, so the two triggers that
-- demanded one on every node with thin storage would refuse every placement there.
DROP TRIGGER IF EXISTS database_selected_thin_insert;
DROP TRIGGER IF EXISTS database_selected_thin_placement;

CREATE VIEW database_resources AS
SELECT d.id database_id,
  COALESCE(d.own_memory_mib,s.memory_mib) memory_mib,
  COALESCE(d.own_cpu_millicores,s.cpu_millicores) cpu_millicores,
  COALESCE(d.own_storage_gib,s.storage_gib) storage_gib
FROM databases d JOIN size_classes s ON s.id=d.size_class_id;

-- Placement and the capacity alerts read a node's newest sample (`nodes.last_sample_json`), its
-- per-minute rollups (`node_minutes`) and its volume report (`node_volumes`), which 0063 created.
--
-- Alert episodes gain the kinds of the capacity alerts (plan 4.10). SQLite cannot widen a CHECK in
-- place, so the table is rebuilt as 0053 did and every episode is copied unchanged.
ALTER TABLE infrastructure_alerts RENAME TO infrastructure_alerts_previous;
CREATE TABLE infrastructure_alerts (
  region_id TEXT NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN('regional_ram_warning','regional_node_cap_reached','regional_node_stale','infrastructure_backup_failed','infrastructure_backup_stale','regional_node_ram_warning','regional_node_cpu_warning','regional_node_storage_warning','database_archive_failing','database_base_backup_stale','thin_storage_blocked','regional_node_capacity_refusals','regional_node_pool_closed','database_volume_warning','database_volume_critical','control_cron_stalled','control_cron_step_failing','node_enrollment_refused')),
  active INTEGER NOT NULL CHECK(active IN(0,1)),
  event_id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(payload)<=4096),
  delivered_at TEXT,
  last_attempt_at TEXT,
  PRIMARY KEY(region_id,kind)
) STRICT;
INSERT INTO infrastructure_alerts SELECT * FROM infrastructure_alerts_previous;
DROP TABLE infrastructure_alerts_previous;
