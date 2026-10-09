-- SPDX-License-Identifier: Apache-2.0
-- CF owns immutable per-volume policy, current Native physical authority and bounded starts.
ALTER TABLE databases ADD COLUMN storage_profile_json TEXT CHECK(storage_profile_json IS NULL OR json_valid(storage_profile_json));
ALTER TABLE databases ADD COLUMN storage_volume_json TEXT CHECK(storage_volume_json IS NULL OR json_valid(storage_volume_json));
ALTER TABLE databases ADD COLUMN storage_protected_at TEXT;
ALTER TABLE databases ADD COLUMN storage_protected_generation INTEGER CHECK(storage_protected_generation IS NULL OR storage_protected_generation>0);
ALTER TABLE databases ADD COLUMN storage_protected_operation TEXT REFERENCES operations(id);
-- Preserve the existing ledger and every uncertain row; only genuine stop-only physical
-- drains may have zero additional tenant RAM. SQLite requires rebuilding its CHECK constraint.
CREATE TABLE database_start_admissions_storage_next (
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation > 0),
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  node_uid TEXT NOT NULL,
  budget_bytes INTEGER NOT NULL CHECK (typeof(budget_bytes) = 'integer' AND budget_bytes BETWEEN 0 AND 9007199254740991),
  granted_at TEXT NOT NULL
    CHECK (length(granted_at) = 24 AND granted_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(granted_at, 1, 4) || substr(granted_at, 6, 2) || substr(granted_at, 9, 2)
        || substr(granted_at, 12, 2) || substr(granted_at, 15, 2) || substr(granted_at, 18, 2)
        || substr(granted_at, 21, 3)) NOT GLOB '*[^0-9]*'),
  grant_sample_observed_at TEXT NOT NULL
    CHECK (length(grant_sample_observed_at) = 24 AND grant_sample_observed_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(grant_sample_observed_at, 1, 4) || substr(grant_sample_observed_at, 6, 2) || substr(grant_sample_observed_at, 9, 2)
        || substr(grant_sample_observed_at, 12, 2) || substr(grant_sample_observed_at, 15, 2) || substr(grant_sample_observed_at, 18, 2)
        || substr(grant_sample_observed_at, 21, 3)) NOT GLOB '*[^0-9]*'),
  ready_at TEXT
    CHECK (ready_at IS NULL OR (length(ready_at) = 24 AND ready_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(ready_at, 1, 4) || substr(ready_at, 6, 2) || substr(ready_at, 9, 2)
        || substr(ready_at, 12, 2) || substr(ready_at, 15, 2) || substr(ready_at, 18, 2)
        || substr(ready_at, 21, 3)) NOT GLOB '*[^0-9]*')),
  ready_sample_observed_at TEXT
    CHECK (ready_sample_observed_at IS NULL OR (length(ready_sample_observed_at) = 24 AND ready_sample_observed_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(ready_sample_observed_at, 1, 4) || substr(ready_sample_observed_at, 6, 2) || substr(ready_sample_observed_at, 9, 2)
        || substr(ready_sample_observed_at, 12, 2) || substr(ready_sample_observed_at, 15, 2) || substr(ready_sample_observed_at, 18, 2)
        || substr(ready_sample_observed_at, 21, 3)) NOT GLOB '*[^0-9]*')),
  storage_budget_bytes INTEGER NOT NULL DEFAULT 0 CHECK(typeof(storage_budget_bytes)='integer' AND storage_budget_bytes BETWEEN 0 AND 9007199254740991),
  storage_volume_json TEXT CHECK(storage_volume_json IS NULL OR json_valid(storage_volume_json)),
  UNIQUE (database_id, generation),
  CHECK ((ready_at IS NULL) = (ready_sample_observed_at IS NULL))
);

INSERT INTO database_start_admissions_storage_next(rowid,operation_id,database_id,generation,node_id,node_uid,budget_bytes,granted_at,grant_sample_observed_at,ready_at,ready_sample_observed_at) SELECT rowid,operation_id,database_id,generation,node_id,node_uid,budget_bytes,granted_at,grant_sample_observed_at,ready_at,ready_sample_observed_at FROM database_start_admissions;
DROP TABLE database_start_admissions;
ALTER TABLE database_start_admissions_storage_next RENAME TO database_start_admissions;
CREATE INDEX database_start_admissions_node_idx ON database_start_admissions(node_id, node_uid);

CREATE TRIGGER database_start_admission_immutable BEFORE UPDATE ON database_start_admissions
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.database_id IS NOT OLD.database_id
  OR NEW.generation IS NOT OLD.generation OR NEW.node_id IS NOT OLD.node_id
  OR NEW.node_uid IS NOT OLD.node_uid OR NEW.budget_bytes IS NOT OLD.budget_bytes
  OR NEW.granted_at IS NOT OLD.granted_at OR NEW.grant_sample_observed_at IS NOT OLD.grant_sample_observed_at
  OR (OLD.ready_at IS NOT NULL AND (NEW.ready_at IS NOT OLD.ready_at OR NEW.ready_sample_observed_at IS NOT OLD.ready_sample_observed_at))
BEGIN SELECT RAISE(ABORT, 'database_start_admission_immutable'); END;


CREATE TABLE node_thin_storage (
  node_id TEXT PRIMARY KEY NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  node_uid TEXT NOT NULL,
  cluster_uid TEXT NOT NULL,
  address TEXT NOT NULL,
  volume_group_uuid TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK(profile_revision>0),
  profile_sha256 TEXT NOT NULL CHECK(length(profile_sha256)=64 AND profile_sha256 NOT GLOB '*[^a-f0-9]*'),
  profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
  allow_new_databases INTEGER NOT NULL DEFAULT 0 CHECK(allow_new_databases IN(0,1)),
  authority_revision INTEGER NOT NULL DEFAULT 0 CHECK(authority_revision>=0),
  authority_json TEXT CHECK(authority_json IS NULL OR json_valid(authority_json)),
  authority_received_at TEXT,
  lease_id TEXT,
  lease_revision INTEGER NOT NULL DEFAULT 0 CHECK(lease_revision>=0),
  lease_expires_at TEXT,
  material_revision INTEGER NOT NULL CHECK(material_revision>0),
  action_json TEXT CHECK(action_json IS NULL OR json_valid(action_json)),
  qualified_driver_image TEXT,
  qualification_json TEXT CHECK(qualification_json IS NULL OR json_valid(qualification_json)),
  status TEXT NOT NULL CHECK(status IN('selected','qualifying','ready','blocked')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((authority_json IS NULL)=(authority_received_at IS NULL)),
  CHECK(authority_json IS NOT NULL OR authority_revision=0),
  CHECK((lease_id IS NULL)=(lease_expires_at IS NULL))
) STRICT;

-- A new start can never alter an existing operation's storage debit.
CREATE TRIGGER database_start_storage_immutable BEFORE UPDATE ON database_start_admissions
WHEN NEW.storage_budget_bytes IS NOT OLD.storage_budget_bytes
BEGIN SELECT RAISE(ABORT,'database_start_storage_immutable'); END;
CREATE TRIGGER database_start_storage_binding_immutable BEFORE UPDATE OF storage_volume_json ON database_start_admissions
WHEN OLD.storage_volume_json IS NOT NULL AND NEW.storage_volume_json IS NOT OLD.storage_volume_json
BEGIN SELECT RAISE(ABORT,'database_start_storage_binding_immutable'); END;
CREATE TRIGGER database_storage_drain_only BEFORE INSERT ON database_start_admissions
WHEN NEW.budget_bytes=0 AND NOT EXISTS(SELECT 1 FROM databases d JOIN operations o ON o.database_id=d.id AND o.project_id=d.project_id JOIN nodes n ON n.id=d.node_id
 WHERE o.id=NEW.operation_id AND o.generation=NEW.generation AND d.generation=NEW.generation
 AND d.id=NEW.database_id AND d.node_id=NEW.node_id AND n.node_uid=NEW.node_uid AND n.lost_at IS NULL
 AND d.storage_profile_json IS NOT NULL AND NEW.storage_budget_bytes>0 AND NEW.storage_volume_json IS NOT NULL AND d.storage_volume_json IS NOT NULL
 AND (json_extract(NEW.storage_volume_json,'$.storage_generation')=json_extract(d.storage_volume_json,'$.storage_generation') AND json_extract(NEW.storage_volume_json,'$.storage_uid')=json_extract(d.storage_volume_json,'$.storage_uid') AND json_extract(NEW.storage_volume_json,'$.namespace_uid')=json_extract(d.storage_volume_json,'$.namespace_uid') AND json_extract(NEW.storage_volume_json,'$.cluster_uid')=json_extract(d.storage_volume_json,'$.cluster_uid') AND json_extract(NEW.storage_volume_json,'$.node_uid')=json_extract(d.storage_volume_json,'$.node_uid') AND json_extract(NEW.storage_volume_json,'$.volume_group_uuid')=json_extract(d.storage_volume_json,'$.volume_group_uuid') AND json_extract(NEW.storage_volume_json,'$.pool_uuid')=json_extract(d.storage_volume_json,'$.pool_uuid') AND json_extract(NEW.storage_volume_json,'$.volume_handle')=json_extract(d.storage_volume_json,'$.volume_handle') AND json_extract(NEW.storage_volume_json,'$.lv_uuid')=json_extract(d.storage_volume_json,'$.lv_uuid') AND json_extract(NEW.storage_volume_json,'$.pvc_uid')=json_extract(d.storage_volume_json,'$.pvc_uid') AND json_extract(NEW.storage_volume_json,'$.pv_uid')=json_extract(d.storage_volume_json,'$.pv_uid'))
 AND (o.status IN('pending','running') OR (o.status='failed' AND o.error_code='operation_timeout'))
 AND ((d.desired_state='suspended' AND o.id=d.power_operation AND ((o.kind='database.suspend' AND d.suspension_reason='manual') OR(o.kind='database.hibernate' AND d.suspension_reason='idle')))
 OR (d.desired_state='deleted' AND o.kind='database.delete' AND d.observed_state<>'deleted')))
BEGIN SELECT RAISE(ABORT,'database_storage_drain_only'); END;


-- Existing thick databases remain thick. Thin volume policy is selected once at placement.
CREATE TRIGGER database_storage_profile_immutable BEFORE UPDATE ON databases
WHEN OLD.storage_profile_json IS NOT NULL AND NEW.storage_profile_json IS NOT OLD.storage_profile_json
BEGIN SELECT RAISE(ABORT,'database_storage_profile_immutable'); END;

CREATE TRIGGER database_storage_profile_first_placement BEFORE UPDATE ON databases
WHEN OLD.storage_profile_json IS NULL AND NEW.storage_profile_json IS NOT NULL AND OLD.node_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_storage_profile_first_placement'); END;

-- Rolling delivery/rollback cannot reinterpret a selected node as thick capacity.
CREATE TRIGGER database_selected_thin_insert BEFORE INSERT ON databases
WHEN NEW.node_id IS NOT NULL AND NEW.storage_profile_json IS NULL
  AND EXISTS(SELECT 1 FROM node_thin_storage t WHERE t.node_id=NEW.node_id)
BEGIN SELECT RAISE(ABORT,'database_selected_thin_profile_required'); END;
CREATE TRIGGER database_selected_thin_placement BEFORE UPDATE OF node_id ON databases
WHEN NEW.node_id IS NOT NULL AND NEW.node_id IS NOT OLD.node_id AND NEW.storage_profile_json IS NULL
  AND EXISTS(SELECT 1 FROM node_thin_storage t WHERE t.node_id=NEW.node_id)
BEGIN SELECT RAISE(ABORT,'database_selected_thin_profile_required'); END;
CREATE TRIGGER database_thin_start_requires_storage_hold BEFORE INSERT ON database_start_admissions
WHEN EXISTS(SELECT 1 FROM databases d JOIN size_classes s ON s.id=d.size_class_id WHERE d.id=NEW.database_id AND d.storage_profile_json IS NOT NULL
  AND (NEW.storage_budget_bytes IS NOT MAX(json_extract(d.storage_profile_json,'$.startup_reserve_bytes'),s.storage_gib*1073741824)
    OR NEW.node_uid IS NOT json_extract(d.storage_profile_json,'$.node_uid')))
BEGIN SELECT RAISE(ABORT,'database_thin_storage_hold_required'); END;
