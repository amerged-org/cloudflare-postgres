-- SPDX-License-Identifier: Apache-2.0
-- Contract: a release carries the release key's signature of its manifest, which the
-- spec stores and every reader sees, and which a node checks before it installs anything of the
-- release. A release is immutable and every one registered so far lacks the signature, so none
-- can be read as the spec any more: they go with the region assignments that name them, as in
-- 0072. The nodes keep what they run. The first signed release is registered from the build of
-- this commit (docs/operations/release-signing.md) and the regions are assigned again from
-- revision 0.
DELETE FROM fleet_region_releases;
DELETE FROM fleet_releases;
