-- SPDX-License-Identifier: Apache-2.0
-- Placement control never changes Kubernetes readiness or management of existing databases.
ALTER TABLE nodes ADD COLUMN database_placement_enabled INTEGER NOT NULL DEFAULT 1 CHECK(database_placement_enabled IN(0,1));
ALTER TABLE nodes ADD COLUMN database_placement_closed_at TEXT;
ALTER TABLE nodes ADD COLUMN memory_window_observed_at TEXT;
ALTER TABLE nodes ADD COLUMN memory_window_valid INTEGER NOT NULL DEFAULT 0 CHECK(memory_window_valid IN(0,1));
ALTER TABLE nodes ADD COLUMN memory_utilization_ppm INTEGER CHECK(memory_utilization_ppm BETWEEN 0 AND 1000000);
ALTER TABLE nodes ADD COLUMN memory_expansion_triggered_at TEXT;
ALTER TABLE node_region_policies ADD COLUMN placement_mode TEXT NOT NULL DEFAULT 'reserved' CHECK(placement_mode IN('reserved','actual_ram'));
ALTER TABLE node_region_policies ADD COLUMN standing_cost_profile TEXT CHECK(standing_cost_profile IS NULL OR json_valid(standing_cost_profile));
ALTER TABLE node_region_policies ADD COLUMN standing_cost_profile_hash TEXT;
ALTER TABLE node_region_policies ADD COLUMN maximum_database_memory_mib INTEGER CHECK(maximum_database_memory_mib>0 AND maximum_database_memory_mib%256=0);
ALTER TABLE node_region_policies ADD COLUMN postgres_memory_request_mib INTEGER CHECK(postgres_memory_request_mib>0);
CREATE TABLE node_memory_samples(
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  node_uid TEXT NOT NULL,
  minute INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  working_set_bytes INTEGER CHECK(working_set_bytes>=0),
  capacity_memory_bytes INTEGER CHECK(capacity_memory_bytes>0),
  available_bytes INTEGER CHECK(available_bytes>=0),
  memory_pressure INTEGER CHECK(memory_pressure IN(0,1)),
  PRIMARY KEY(node_id,node_uid,minute),
  CHECK(working_set_bytes IS NULL OR working_set_bytes<=capacity_memory_bytes),
  CHECK(available_bytes IS NULL OR available_bytes<=capacity_memory_bytes)
);
CREATE TABLE node_standing_approvals(
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES node_additions(operation_id) ON DELETE CASCADE,
  region_id TEXT NOT NULL REFERENCES regions(id),
  profile_id TEXT NOT NULL,
  profile_hash TEXT NOT NULL,
  monthly_units INTEGER NOT NULL CHECK(monthly_units>=0),
  setup_units INTEGER NOT NULL CHECK(setup_units>=0),
  created_at TEXT NOT NULL
);
CREATE INDEX node_standing_approvals_profile_idx ON node_standing_approvals(region_id,profile_id);
