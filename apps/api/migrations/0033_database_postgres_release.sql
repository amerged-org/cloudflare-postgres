-- SPDX-License-Identifier: Apache-2.0
ALTER TABLE databases ADD COLUMN desired_postgres_release_id TEXT REFERENCES fleet_releases(id);
ALTER TABLE databases ADD COLUMN desired_postgres_image TEXT;
ALTER TABLE databases ADD COLUMN desired_postgres_version TEXT;
ALTER TABLE databases ADD COLUMN desired_postgres_schema_revision INTEGER CHECK(desired_postgres_schema_revision IS NULL OR desired_postgres_schema_revision=1);
ALTER TABLE databases ADD COLUMN observed_postgres_image TEXT;
ALTER TABLE databases ADD COLUMN observed_postgres_image_id TEXT;
-- New databases, including restore targets and pending placements, inherit the current immutable selection atomically.
CREATE TRIGGER database_postgres_release_supported BEFORE INSERT ON databases
WHEN EXISTS(SELECT 1 FROM fleet_region_releases WHERE region_id=NEW.region_id)
  AND NOT EXISTS(SELECT 1 FROM fleet_region_releases f JOIN fleet_releases r ON r.id=f.release_id,json_each(r.spec_json,'$.components') c
    WHERE f.region_id=NEW.region_id AND json_extract(r.spec_json,'$.configuration_schema_revision')=1
      AND json_extract(c.value,'$.name')='postgres' AND json_extract(c.value,'$.kind')='image'
      AND substr(json_extract(c.value,'$.version'),1,3)='18.'
      AND length(json_extract(c.value,'$.version')) BETWEEN 4 AND 32
      AND substr(json_extract(c.value,'$.version'),4) NOT GLOB '*[^0-9.]*'
      AND json_extract(c.value,'$.version') NOT LIKE '%..%' AND substr(json_extract(c.value,'$.version'),-1)<>'.'
      AND length(json_extract(c.value,'$.version'))-length(replace(json_extract(c.value,'$.version'),'.','')) BETWEEN 1 AND 2
      AND substr(json_extract(c.value,'$.reference'),-72)='@sha256:'||json_extract(c.value,'$.sha256'))
BEGIN SELECT RAISE(ABORT,'Selected PostgreSQL release is unsupported'); END;
