-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE node_compute_pool_policies (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  node_uid TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
  release_id TEXT NOT NULL REFERENCES fleet_releases(id),
  policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE node_compute_pool_observations (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  node_uid TEXT NOT NULL,
  policy_revision INTEGER NOT NULL,
  material_revision INTEGER NOT NULL,
  observation_json TEXT NOT NULL CHECK(json_valid(observation_json)),
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL
) STRICT;
