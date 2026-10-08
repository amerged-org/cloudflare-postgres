-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE fleet_releases (
  id TEXT PRIMARY KEY,
  spec_json TEXT NOT NULL CHECK(json_valid(spec_json)),
  spec_sha256 TEXT NOT NULL CHECK(length(spec_sha256)=64 AND length(CAST(spec_sha256 AS BLOB))=64 AND NOT spec_sha256 GLOB '*[^0-9a-f]*'),
  approved_at TEXT NOT NULL
) STRICT;
CREATE TABLE fleet_region_releases (
  region_id TEXT PRIMARY KEY REFERENCES regions(id) ON DELETE CASCADE,
  release_id TEXT NOT NULL REFERENCES fleet_releases(id),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE fleet_node_releases (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  node_uid TEXT NOT NULL,
  release_id TEXT NOT NULL REFERENCES fleet_releases(id),
  role TEXT NOT NULL CHECK(role IN('control_relay','customer')),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE fleet_node_release_observations (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  node_uid TEXT NOT NULL,
  assignment_revision INTEGER NOT NULL CHECK(assignment_revision BETWEEN 1 AND 2147483647),
  agent_key_hash TEXT NOT NULL,
  facts_json TEXT NOT NULL CHECK(json_valid(facts_json)),
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER fleet_releases_immutable_update BEFORE UPDATE ON fleet_releases
BEGIN SELECT RAISE(ABORT,'Fleet releases are immutable'); END;
