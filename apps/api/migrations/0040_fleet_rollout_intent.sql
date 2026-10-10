-- SPDX-License-Identifier: Apache-2.0
-- Release assignment is desired intent; fleet_patch_operations remains the only mutation journal.
ALTER TABLE fleet_region_releases ADD COLUMN rollout_json TEXT
  CHECK(rollout_json IS NULL OR json_valid(rollout_json));
CREATE INDEX fleet_region_rollout ON fleet_region_releases(json_extract(rollout_json,'$.rollout_id'))
  WHERE rollout_json IS NOT NULL;
