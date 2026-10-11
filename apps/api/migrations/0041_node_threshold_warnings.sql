-- SPDX-License-Identifier: Apache-2.0
-- Per-node warning thresholds are operator-selected and off by default; recorded episodes are unchanged.
ALTER TABLE node_region_policies ADD COLUMN node_ram_warning_threshold_ppm INTEGER
  CHECK(node_ram_warning_threshold_ppm IS NULL OR
    (typeof(node_ram_warning_threshold_ppm)='integer' AND node_ram_warning_threshold_ppm BETWEEN 1 AND 1000000));
ALTER TABLE node_region_policies ADD COLUMN node_cpu_warning_threshold_ppm INTEGER
  CHECK(node_cpu_warning_threshold_ppm IS NULL OR
    (typeof(node_cpu_warning_threshold_ppm)='integer' AND node_cpu_warning_threshold_ppm BETWEEN 1 AND 1000000));
ALTER TABLE node_region_policies ADD COLUMN node_storage_warning_threshold_ppm INTEGER
  CHECK(node_storage_warning_threshold_ppm IS NULL OR
    (typeof(node_storage_warning_threshold_ppm)='integer' AND node_storage_warning_threshold_ppm BETWEEN 1 AND 1000000));
-- Kubelet CPU usage in nanocores and node CPU capacity in millicores; older reporters leave both NULL.
ALTER TABLE node_memory_samples ADD COLUMN capacity_cpu_millicores INTEGER
  CHECK(capacity_cpu_millicores IS NULL OR
    (typeof(capacity_cpu_millicores)='integer' AND capacity_cpu_millicores>0));
ALTER TABLE node_memory_samples ADD COLUMN cpu_usage_nano_cores INTEGER
  CHECK(cpu_usage_nano_cores IS NULL OR
    (typeof(cpu_usage_nano_cores)='integer' AND cpu_usage_nano_cores>=0 AND capacity_cpu_millicores IS NOT NULL));
ALTER TABLE infrastructure_alerts RENAME TO infrastructure_alerts_previous;
CREATE TABLE infrastructure_alerts (
  region_id TEXT NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN('regional_ram_warning','regional_node_cap_reached','regional_node_stale','infrastructure_backup_failed','infrastructure_backup_stale','regional_node_ram_warning','regional_node_cpu_warning','regional_node_storage_warning')),
  active INTEGER NOT NULL CHECK(active IN(0,1)),
  event_id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(payload)<=4096),
  delivered_at TEXT,
  last_attempt_at TEXT,
  PRIMARY KEY(region_id,kind)
) STRICT;
INSERT INTO infrastructure_alerts SELECT * FROM infrastructure_alerts_previous;
DROP TABLE infrastructure_alerts_previous;
