-- SPDX-License-Identifier: Apache-2.0
-- Every connection admission looks up each current member's confirmed patch of its region's
-- release (routeTokenV3Sql in the API); without this index each lookup scans all patch history.
CREATE INDEX fleet_patch_confirmed_node ON fleet_patch_operations(node_id, release_id, region_revision)
  WHERE stage='complete' AND state='confirmed';
