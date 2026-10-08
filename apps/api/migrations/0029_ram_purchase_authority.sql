-- SPDX-License-Identifier: Apache-2.0
-- Preserve existing finite policies. NULL explicitly means no owner-selected ceiling.
CREATE TABLE node_region_policies_next (
  region_id TEXT PRIMARY KEY NOT NULL REFERENCES regions(id),
  max_nodes INTEGER CHECK(max_nodes IS NULL OR max_nodes BETWEEN 1 AND 10000),
  purchases_enabled INTEGER NOT NULL DEFAULT 0 CHECK(purchases_enabled IN(0,1)),
  order_config TEXT CHECK(order_config IS NULL OR (json_valid(order_config) AND length(order_config)<=2048)),
  autoscale_enabled INTEGER NOT NULL DEFAULT 0 CHECK(autoscale_enabled IN(0,1)),
  adopt_instance_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(adopt_instance_ids)),
  placement_mode TEXT NOT NULL DEFAULT 'reserved' CHECK(placement_mode IN('reserved','actual_ram')),
  standing_cost_profile TEXT CHECK(standing_cost_profile IS NULL OR json_valid(standing_cost_profile)),
  standing_cost_profile_hash TEXT,
  maximum_database_memory_mib INTEGER CHECK(maximum_database_memory_mib>0 AND maximum_database_memory_mib%256=0),
  postgres_memory_request_mib INTEGER CHECK(postgres_memory_request_mib>0)
);
INSERT INTO node_region_policies_next SELECT region_id,max_nodes,purchases_enabled,order_config,autoscale_enabled,adopt_instance_ids,placement_mode,standing_cost_profile,standing_cost_profile_hash,maximum_database_memory_mib,postgres_memory_request_mib FROM node_region_policies;
DROP TABLE node_region_policies;
ALTER TABLE node_region_policies_next RENAME TO node_region_policies;

-- Unknown provider prices remain NULL; the existing ledger still records each exact intent once.
CREATE TABLE node_standing_approvals_next (
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES node_additions(operation_id) ON DELETE CASCADE,
  region_id TEXT NOT NULL REFERENCES regions(id),
  profile_id TEXT NOT NULL,
  profile_hash TEXT NOT NULL,
  monthly_units INTEGER CHECK(monthly_units IS NULL OR monthly_units>=0),
  setup_units INTEGER CHECK(setup_units IS NULL OR setup_units>=0),
  created_at TEXT NOT NULL
);
INSERT INTO node_standing_approvals_next SELECT * FROM node_standing_approvals;
DROP TABLE node_standing_approvals;
ALTER TABLE node_standing_approvals_next RENAME TO node_standing_approvals;
CREATE INDEX node_standing_approvals_profile_idx ON node_standing_approvals(region_id,profile_id);
