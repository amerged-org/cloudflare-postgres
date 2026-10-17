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

-- What placement and the capacity alerts read of a node: its samples and its volumes (plan 4.9).
-- The node link writes them, about once a minute per node; this migration creates the tables only
-- where the link has not. Pool columns are all NULL while the pool is unavailable, never zero;
-- `capacity_refusals` counts the wakes the node refused for awake capacity since the previous row.
CREATE TABLE IF NOT EXISTS node_samples (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  observed_at TEXT NOT NULL CHECK(length(observed_at)=24),
  memory_total_bytes INTEGER NOT NULL CHECK(memory_total_bytes>0),
  memory_available_bytes INTEGER NOT NULL CHECK(memory_available_bytes BETWEEN 0 AND memory_total_bytes),
  cpu_cores INTEGER NOT NULL CHECK(cpu_cores>0),
  cpu_busy_millicores INTEGER NOT NULL CHECK(cpu_busy_millicores BETWEEN 0 AND cpu_cores*1000),
  pool_data_total_bytes INTEGER CHECK(pool_data_total_bytes>0),
  pool_data_used_bytes INTEGER CHECK(pool_data_used_bytes>=0),
  pool_metadata_total_bytes INTEGER CHECK(pool_metadata_total_bytes>0),
  pool_metadata_used_bytes INTEGER CHECK(pool_metadata_used_bytes>=0),
  pool_nominal_bytes INTEGER CHECK(pool_nominal_bytes>=0),
  room INTEGER NOT NULL CHECK(room IN(0,1)),
  capacity_refusals INTEGER NOT NULL DEFAULT 0 CHECK(capacity_refusals>=0),
  PRIMARY KEY(node_id,observed_at),
  CHECK((pool_data_total_bytes IS NULL)=(pool_data_used_bytes IS NULL)
    AND (pool_data_total_bytes IS NULL)=(pool_metadata_total_bytes IS NULL)
    AND (pool_data_total_bytes IS NULL)=(pool_metadata_used_bytes IS NULL)
    AND (pool_data_total_bytes IS NULL)=(pool_nominal_bytes IS NULL))
) STRICT;

-- The newest report of every thin volume of a node. The filesystem figures are NULL while the
-- volume is not mounted.
CREATE TABLE IF NOT EXISTS node_volumes (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  database_id TEXT NOT NULL,
  storage_generation INTEGER NOT NULL CHECK(storage_generation>0),
  observed_at TEXT NOT NULL CHECK(length(observed_at)=24),
  fs_total_bytes INTEGER CHECK(fs_total_bytes>0),
  fs_used_bytes INTEGER CHECK(fs_used_bytes>=0),
  inodes_total INTEGER CHECK(inodes_total>0),
  inodes_used INTEGER CHECK(inodes_used>=0),
  PRIMARY KEY(node_id,database_id,storage_generation),
  CHECK((fs_total_bytes IS NULL)=(fs_used_bytes IS NULL)
    AND (fs_total_bytes IS NULL)=(inodes_total IS NULL)
    AND (fs_total_bytes IS NULL)=(inodes_used IS NULL))
) STRICT;

-- Alert episodes gain the kinds of the capacity alerts (plan 4.10). SQLite cannot widen a CHECK in
-- place, so the table is rebuilt as 0053 did and every episode is copied unchanged.
ALTER TABLE infrastructure_alerts RENAME TO infrastructure_alerts_previous;
CREATE TABLE infrastructure_alerts (
  region_id TEXT NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN('regional_ram_warning','regional_node_cap_reached','regional_node_stale','infrastructure_backup_failed','infrastructure_backup_stale','regional_node_ram_warning','regional_node_cpu_warning','regional_node_storage_warning','database_archive_failing','database_base_backup_stale','thin_storage_blocked','regional_node_capacity_refusals','database_volume_warning','database_volume_critical','control_cron_stalled','control_cron_step_failing')),
  active INTEGER NOT NULL CHECK(active IN(0,1)),
  event_id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(payload)<=4096),
  delivered_at TEXT,
  last_attempt_at TEXT,
  PRIMARY KEY(region_id,kind)
) STRICT;
INSERT INTO infrastructure_alerts SELECT * FROM infrastructure_alerts_previous;
DROP TABLE infrastructure_alerts_previous;
