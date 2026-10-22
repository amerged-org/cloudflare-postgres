-- SPDX-License-Identifier: Apache-2.0
-- Contract: the install and reinstall of a node trusts the image of a release only when the release
-- key signed it. The signed manifest is v3 and names the image's compressed and raw sha256 and size
-- (pgcf-release-manifest/v3), the API verifies the signature when a release is registered and again
-- where an installer is rendered, and a node's page carries the image's four facts, which the agent
-- needs to build the same manifest. Every release registered so far was signed as v2 (or, before
-- 0077, not at all) and cannot verify, and an agent of an earlier build refuses a page whose release
-- holds an image: they go with the region assignments that name them, as in 0072, 0077 and 0079. The
-- nodes keep what they run. The next build of main is registered signed as v3 and the regions are
-- assigned again from revision 0.
DELETE FROM fleet_region_releases;
DELETE FROM fleet_releases;

-- An audited addition whose release the release key did not sign waits with
-- `install_blocker = 'release_unverified'` until a signed release is assigned. SQLite cannot change
-- a CHECK, so the column (added by 0071, nothing else refers to it, and it holds a reason that the
-- next pass writes again) is dropped and added again with both reasons.
ALTER TABLE node_additions DROP COLUMN install_blocker;
ALTER TABLE node_additions ADD COLUMN install_blocker TEXT
  CHECK (install_blocker IS NULL OR install_blocker IN('node_firewall_unconfirmed','release_unverified'));
