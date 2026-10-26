-- SPDX-License-Identifier: Apache-2.0
-- Integer MiB is authoritative. Copy every existing allocation exactly; no volume is resized.
-- The API still accepts legacy whole-GiB requests. Native readers must understand both units
-- before a non-whole-GiB class is published. Keep all table/resource identities and foreign keys.
DROP VIEW database_resources;
DROP TRIGGER replacement_holds_database_config;
DROP TRIGGER replacement_holds_size_class;
DROP TRIGGER database_thin_start_requires_storage_hold;

ALTER TABLE size_classes ADD COLUMN storage_mib INTEGER NOT NULL DEFAULT 1024
  CHECK(typeof(storage_mib)='integer' AND storage_mib BETWEEN 4 AND 67108864 AND storage_mib%4=0);
UPDATE size_classes SET storage_mib=storage_gib*1024;
ALTER TABLE size_classes DROP COLUMN storage_gib;

ALTER TABLE databases ADD COLUMN own_storage_mib INTEGER
  CHECK(own_storage_mib IS NULL OR (typeof(own_storage_mib)='integer' AND own_storage_mib BETWEEN 4 AND 67108864 AND own_storage_mib%4=0));
UPDATE databases SET own_storage_mib=own_storage_gib*1024;
ALTER TABLE databases DROP COLUMN own_storage_gib;

CREATE VIEW database_resources AS
SELECT d.id database_id,
  COALESCE(d.own_memory_mib,s.memory_mib) memory_mib,
  COALESCE(d.own_cpu_millicores,s.cpu_millicores) cpu_millicores,
  COALESCE(d.own_storage_mib,s.storage_mib) storage_mib
FROM databases d JOIN size_classes s ON s.id=d.size_class_id;

CREATE TRIGGER database_thin_start_requires_storage_hold BEFORE INSERT ON database_start_admissions
WHEN EXISTS(SELECT 1 FROM databases d JOIN size_classes s ON s.id=d.size_class_id WHERE d.id=NEW.database_id AND d.storage_profile_json IS NOT NULL
  AND (NEW.storage_budget_bytes IS NOT MAX(json_extract(d.storage_profile_json,'$.startup_reserve_bytes'),s.storage_mib*1048576)
    OR NEW.node_uid IS NOT json_extract(d.storage_profile_json,'$.node_uid')))
BEGIN SELECT RAISE(ABORT,'database_thin_storage_hold_required'); END;

CREATE TRIGGER replacement_holds_database_config BEFORE UPDATE OF name,size_class_id,sleep_after_seconds,deleted_at,own_memory_mib,own_cpu_millicores,own_storage_mib ON databases
WHEN EXISTS(SELECT 1 FROM database_replacements p WHERE p.database_id=OLD.id AND p.phase IN('proving','restoring','rolling_back'))
BEGIN SELECT RAISE(ABORT,'database_replacement_in_progress'); END;
CREATE TRIGGER replacement_holds_size_class BEFORE UPDATE ON size_classes
WHEN EXISTS(SELECT 1 FROM database_replacements p JOIN databases d ON d.id=p.database_id
 WHERE d.size_class_id=OLD.id AND p.phase IN('proving','restoring','rolling_back'))
BEGIN SELECT RAISE(ABORT,'database_replacement_in_progress'); END;
