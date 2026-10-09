-- SPDX-License-Identifier: Apache-2.0
ALTER TABLE node_region_policies ADD COLUMN compute_pool_json TEXT CHECK(compute_pool_json IS NULL OR json_valid(compute_pool_json));
ALTER TABLE node_region_policies ADD COLUMN thin_storage_json TEXT CHECK(thin_storage_json IS NULL OR json_valid(thin_storage_json));
CREATE TABLE node_host_configurations (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  node_uid TEXT NOT NULL,
  region_id TEXT NOT NULL REFERENCES regions(id),
  cluster_uid TEXT NOT NULL,
  material_revision INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
  sha256 TEXT NOT NULL,
  release_id TEXT NOT NULL REFERENCES fleet_releases(id),
  pool_policy_revision INTEGER NOT NULL,
  profile_sha256 TEXT NOT NULL,
  kid TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
