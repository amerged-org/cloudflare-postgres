-- SPDX-License-Identifier: Apache-2.0
-- Contract: a node's hello reports its boot and operating system (SEC-03), and a release states the
-- kernel and the digest of the installed packages that a node running it reports. The columns hold
-- what the node's last hello said. A release is immutable and every one registered so far lacks the
-- two facts, so none can be read as the spec any more: they go with the region assignments that
-- name them, as in 0063. Registering the build again uploads nothing that is stored already; the
-- region is assigned again from revision 0.
ALTER TABLE nodes ADD COLUMN os_boot_id TEXT
  CHECK(os_boot_id IS NULL OR length(os_boot_id)=36);
ALTER TABLE nodes ADD COLUMN os_booted_at TEXT
  CHECK(os_booted_at IS NULL OR length(os_booted_at)=24);
ALTER TABLE nodes ADD COLUMN os_kernel_release TEXT
  CHECK(os_kernel_release IS NULL OR length(os_kernel_release) BETWEEN 1 AND 64);
ALTER TABLE nodes ADD COLUMN os_packages_sha256 TEXT
  CHECK(os_packages_sha256 IS NULL OR (length(os_packages_sha256)=64 AND os_packages_sha256 NOT GLOB '*[^0-9a-f]*'));

DELETE FROM fleet_region_releases;
DELETE FROM fleet_releases;
