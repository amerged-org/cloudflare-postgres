-- SPDX-License-Identifier: Apache-2.0
-- Contract: a release carries the host files of its image (systemd units and their masks, and the
-- configuration of sshd, journald, sysctl, tmpfiles, sysusers and modprobe) with the digest of each
-- and how it takes effect, which the release key signs, and a node's hello reports the digest of
-- the host files it holds. The column holds what the node's last hello said. A release is
-- immutable and every one registered so far lacks the files, so none can be read as the spec any
-- more: they go with the region assignments that name them, as in 0072 and 0077. The nodes keep
-- what they run. The first release with host files is registered from the next build of main, and
-- the regions are assigned again from revision 0.
ALTER TABLE nodes ADD COLUMN os_host_files_sha256 TEXT
  CHECK(os_host_files_sha256 IS NULL OR (length(os_host_files_sha256)=64 AND os_host_files_sha256 NOT GLOB '*[^0-9a-f]*'));

DELETE FROM fleet_region_releases;
DELETE FROM fleet_releases;
