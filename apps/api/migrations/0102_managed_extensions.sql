-- SPDX-License-Identifier: Apache-2.0
ALTER TABLE databases ADD COLUMN managed_extensions_json TEXT NOT NULL DEFAULT '[]'
  CHECK(managed_extensions_json IN('[]','["pg_jsonschema"]','["postgis"]','["pg_jsonschema","postgis"]'));
ALTER TABLE regions ADD COLUMN native_managed_extensions_required INTEGER NOT NULL DEFAULT 0
  CHECK(native_managed_extensions_required IN(0,1));

CREATE TABLE managed_extension_region_releases (
  region_id TEXT NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  release_id TEXT NOT NULL REFERENCES fleet_releases(id),
  PRIMARY KEY(region_id,release_id)
) STRICT;

-- Retained archives and cached pages can still depend on both libraries after database deletion.
CREATE TRIGGER managed_extension_floor_never_decreases
BEFORE UPDATE OF native_managed_extensions_required ON regions
WHEN OLD.native_managed_extensions_required=1 AND NEW.native_managed_extensions_required<>1
BEGIN SELECT RAISE(ABORT,'managed_extension_floor_cannot_decrease'); END;

-- A managed create is admitted only while the current assignment is qualified.
-- Keep that exact pair when the first opt-in and its floor commit together.
CREATE TRIGGER managed_extension_floor_insert AFTER INSERT ON databases
WHEN NEW.managed_extensions_json<>'[]' AND EXISTS(
  SELECT 1 FROM regions WHERE id=NEW.region_id AND native_managed_extensions_required=0)
BEGIN
  INSERT INTO managed_extension_region_releases(region_id,release_id)
    SELECT region_id,release_id FROM fleet_region_releases WHERE region_id=NEW.region_id;
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'managed_extension_release_missing') END;
  UPDATE regions SET native_managed_extensions_required=1 WHERE id=NEW.region_id;
END;

-- A rolled-back Worker may not know the managed extension floor. Reject its assignment at
-- the database boundary even when it uses the older INSERT ... ON CONFLICT UPDATE statement.
CREATE TRIGGER managed_extension_release_insert BEFORE INSERT ON fleet_region_releases
WHEN EXISTS(SELECT 1 FROM regions WHERE id=NEW.region_id AND native_managed_extensions_required=1)
  AND NOT EXISTS(SELECT 1 FROM managed_extension_region_releases
    WHERE region_id=NEW.region_id AND release_id=NEW.release_id)
BEGIN SELECT RAISE(ABORT,'managed_extension_release_unqualified'); END;

CREATE TRIGGER managed_extension_release_update BEFORE UPDATE OF region_id,release_id ON fleet_region_releases
WHEN EXISTS(SELECT 1 FROM regions WHERE id=NEW.region_id AND native_managed_extensions_required=1)
  AND NOT EXISTS(SELECT 1 FROM managed_extension_region_releases
    WHERE region_id=NEW.region_id AND release_id=NEW.release_id)
BEGIN SELECT RAISE(ABORT,'managed_extension_release_unqualified'); END;

CREATE TRIGGER managed_extensions_immutable BEFORE UPDATE OF managed_extensions_json,region_id ON databases
WHEN OLD.managed_extensions_json<>NEW.managed_extensions_json
  OR (OLD.managed_extensions_json<>'[]' AND OLD.region_id<>NEW.region_id)
BEGIN SELECT RAISE(ABORT,'managed_extensions_are_immutable'); END;
