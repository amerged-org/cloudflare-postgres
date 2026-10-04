-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE usage_rollup_progress (
  database_id TEXT PRIMARY KEY NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  next_hour TEXT NOT NULL CHECK (length(next_hour)=24 AND next_hour GLOB '????-??-??T??:00:00.000Z')
);
CREATE TABLE usage_cron_cursor (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton=1),
  cursor TEXT CHECK (cursor IS NULL OR (length(cursor)=20 AND substr(cursor,1,1) BETWEEN 'a' AND 'z' AND NOT cursor GLOB '*[^a-z0-9]*'))
);
CREATE TABLE region_hint_cursor (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton=1),
  region_id TEXT,
  database_id TEXT,
  CHECK ((region_id IS NULL)=(database_id IS NULL)),
  CHECK (region_id IS NULL OR length(region_id) BETWEEN 3 AND 32),
  CHECK (database_id IS NULL OR (length(database_id)=20 AND substr(database_id,1,1) BETWEEN 'a' AND 'z' AND NOT database_id GLOB '*[^a-z0-9]*'))
);
-- API deletion is a tombstone. A physical metadata deletion also removes its dependent measurements.
CREATE TRIGGER usage_database_metadata_delete BEFORE DELETE ON databases BEGIN
  DELETE FROM usage_samples WHERE database_id=OLD.id;
  DELETE FROM usage_hourly WHERE database_id=OLD.id;
END;
