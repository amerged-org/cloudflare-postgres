-- SPDX-License-Identifier: Apache-2.0
-- Expand only: both columns are nullable and unset means off; no backfill and no table rebuild.
-- databases.parked_json is the controller's hint that a hibernated database still holds its own
-- instance Pod with PostgreSQL stopped. node_region_policies.parked_tier_json is the region policy.
ALTER TABLE databases ADD COLUMN parked_json TEXT
  CHECK(parked_json IS NULL OR json_valid(parked_json));
ALTER TABLE node_region_policies ADD COLUMN parked_tier_json TEXT
  CHECK(parked_tier_json IS NULL OR json_valid(parked_tier_json));
