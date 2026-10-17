-- SPDX-License-Identifier: Apache-2.0
-- Contract: the parked sleep tier is deleted. An idle sleep is a hibernation and a cold database
-- wakes into a pool slot; nothing reads the controller's parked report or the region's policy.
ALTER TABLE databases DROP COLUMN parked_json;
ALTER TABLE node_region_policies DROP COLUMN parked_tier_json;
