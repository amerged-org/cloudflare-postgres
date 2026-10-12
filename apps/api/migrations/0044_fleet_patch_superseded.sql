-- SPDX-License-Identifier: Apache-2.0
-- An operator-superseded declarative platform stage never resumes. It no longer holds its region's
-- one active patch, so a successor release may patch the same region; every other unfinished
-- operation still does. The predicate matches fleetPatchSupersededSql in the API.
DROP INDEX fleet_patch_active_region;
CREATE UNIQUE INDEX fleet_patch_active_region ON fleet_patch_operations(region_id)
  WHERE stage NOT IN('complete','host_ready')
    AND NOT(stage IN('flux','platform','regional') AND state='halted' AND error_code IS 'operator_hold_superseded');
