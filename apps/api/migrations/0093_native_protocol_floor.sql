-- SPDX-License-Identifier: Apache-2.0
-- Desired values can change before the node has rewritten its state, and deletion can leave
-- volumes, backups and cached pages behind. Once used, the native format floor never falls.
ALTER TABLE regions ADD COLUMN native_extended_resources_required INTEGER NOT NULL DEFAULT 0
  CHECK(native_extended_resources_required IN(0,1));
UPDATE regions SET native_extended_resources_required=1 WHERE EXISTS(
  SELECT 1 FROM databases d JOIN database_resources r ON r.database_id=d.id
  WHERE d.region_id=regions.id AND (r.storage_mib%1024<>0
    OR EXISTS(SELECT 1 FROM roles a WHERE a.database_id=d.id AND a.membership_options<>3)
    OR EXISTS(SELECT 1 FROM retained_archives a,json_each(a.roles_json) role
      WHERE a.source_database_id=d.id AND COALESCE(json_extract(role.value,'$.membership_options'),3)<>3))
);
CREATE TRIGGER native_protocol_floor_never_decreases BEFORE UPDATE OF native_extended_resources_required ON regions
WHEN OLD.native_extended_resources_required=1 AND NEW.native_extended_resources_required<>1
BEGIN SELECT RAISE(ABORT,'native_protocol_floor_cannot_decrease'); END;

CREATE TRIGGER native_protocol_floor_database_insert AFTER INSERT ON databases
WHEN COALESCE(NEW.own_storage_mib,(SELECT storage_mib FROM size_classes WHERE id=NEW.size_class_id))%1024<>0
BEGIN UPDATE regions SET native_extended_resources_required=1 WHERE id=NEW.region_id AND native_extended_resources_required=0; END;
CREATE TRIGGER native_protocol_floor_database_update AFTER UPDATE OF own_storage_mib,size_class_id,region_id ON databases
WHEN COALESCE(NEW.own_storage_mib,(SELECT storage_mib FROM size_classes WHERE id=NEW.size_class_id))%1024<>0
  OR EXISTS(SELECT 1 FROM roles WHERE database_id=NEW.id AND membership_options<>3)
BEGIN UPDATE regions SET native_extended_resources_required=1 WHERE id=NEW.region_id AND native_extended_resources_required=0; END;
CREATE TRIGGER native_protocol_floor_role_insert AFTER INSERT ON roles WHEN NEW.membership_options<>3
BEGIN UPDATE regions SET native_extended_resources_required=1 WHERE id=(SELECT region_id FROM databases WHERE id=NEW.database_id) AND native_extended_resources_required=0; END;
CREATE TRIGGER native_protocol_floor_role_update AFTER UPDATE OF membership_options,database_id ON roles WHEN NEW.membership_options<>3
BEGIN UPDATE regions SET native_extended_resources_required=1 WHERE id=(SELECT region_id FROM databases WHERE id=NEW.database_id) AND native_extended_resources_required=0; END;
CREATE TRIGGER native_protocol_floor_class_update AFTER UPDATE OF storage_mib ON size_classes WHEN NEW.storage_mib%1024<>0
BEGIN UPDATE regions SET native_extended_resources_required=1 WHERE native_extended_resources_required=0 AND id IN(
  SELECT region_id FROM databases WHERE size_class_id=NEW.id AND own_storage_mib IS NULL
); END;
