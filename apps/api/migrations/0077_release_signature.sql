-- SPDX-License-Identifier: Apache-2.0
-- Contract: a release carries the release key's signature of its manifest, which the
-- spec stores and every reader sees, and which a node checks before it installs anything of the
-- release. A release is immutable and every one registered so far lacks the signature, so none
-- can be read as the spec any more: they go with the region assignments that name them, as in
-- 0072. The nodes keep what they run. The first signed release is registered from the first build
-- of main whose apps/node-agent/release-signing.pub holds the real public key (the build of the
-- commit that carries the placeholder is never signed), and the regions are assigned again from
-- revision 0; docs/operations/release-signing.md has the order.
DELETE FROM fleet_region_releases;
DELETE FROM fleet_releases;
