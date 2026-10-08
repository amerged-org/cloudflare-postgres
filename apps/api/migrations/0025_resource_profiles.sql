-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE resource_profiles (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 2 AND 32),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  rollout_revision INTEGER NOT NULL DEFAULT 0 CHECK(rollout_revision >= 0 AND rollout_revision <= revision),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE resource_profile_revisions (
  profile_id TEXT NOT NULL REFERENCES resource_profiles(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  size_class_id TEXT NOT NULL UNIQUE REFERENCES size_classes(id),
  resources_json TEXT NOT NULL CHECK(json_valid(resources_json)),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  created_at TEXT NOT NULL,
  PRIMARY KEY(profile_id, revision)
) STRICT;
-- Reuse the existing bounded reconciliation cursor for profile fan-out.
CREATE TABLE reconciliation_cursors_updated (
  name TEXT PRIMARY KEY NOT NULL CHECK(name IN('database_actors','resource_profiles')),
  cursor TEXT CHECK(cursor IS NULL OR
    (length(cursor)=20 AND substr(cursor,1,1) BETWEEN 'a' AND 'z' AND NOT cursor GLOB '*[^a-z0-9]*'))
) STRICT;
INSERT INTO reconciliation_cursors_updated SELECT name,cursor FROM reconciliation_cursors;
DROP TABLE reconciliation_cursors;
ALTER TABLE reconciliation_cursors_updated RENAME TO reconciliation_cursors;
