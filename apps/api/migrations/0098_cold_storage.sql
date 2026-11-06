-- SPDX-License-Identifier: Apache-2.0
-- R2-only residency is independent of the database's power intent. This migration only records
-- existing facts; the qualified control/native rollout separately enables archival work.
ALTER TABLE regions ADD COLUMN native_cold_storage_required INTEGER NOT NULL DEFAULT 0
  CHECK(native_cold_storage_required IN(0,1));
CREATE TRIGGER cold_storage_protocol_floor_never_decreases BEFORE UPDATE OF native_cold_storage_required ON regions
WHEN OLD.native_cold_storage_required=1 AND NEW.native_cold_storage_required<>1
BEGIN SELECT RAISE(ABORT,'cold_storage_protocol_floor_cannot_decrease'); END;
ALTER TABLE databases ADD COLUMN storage_residency TEXT NOT NULL DEFAULT 'local'
  CHECK(storage_residency IN('local','archiving','archived','restoring'));
ALTER TABLE databases ADD COLUMN sleep_since TEXT
  CHECK(sleep_since IS NULL OR (length(sleep_since)=24 AND sleep_since GLOB '????-??-??T??:??:??.???Z'));
ALTER TABLE databases ADD COLUMN storage_operation_id TEXT
  CHECK(storage_operation_id IS NULL OR (length(storage_operation_id)=23 AND substr(storage_operation_id,1,3)='op_' AND NOT substr(storage_operation_id,4) GLOB '*[^a-z0-9]*'));

-- A generic updated_at timestamp is not a sleep clock. Only the current accepted recovery
-- proof may establish historical sleep; incomplete, stale or future-dated evidence stays null.
UPDATE databases SET sleep_since=json_extract(proven_sleep_json,'$.proven_at')
WHERE deleted_at IS NULL AND desired_state='suspended' AND observed_power='hibernated'
  AND observed_generation=generation AND node_id IS NOT NULL
  AND json_type(proven_sleep_json,'$.proven_at')='text'
  AND length(json_extract(proven_sleep_json,'$.proven_at'))=24
  AND json_extract(proven_sleep_json,'$.proven_at') GLOB '????-??-??T??:??:??.???Z'
  AND julianday(json_extract(proven_sleep_json,'$.proven_at'))<=julianday('now')
  AND EXISTS(SELECT 1 FROM database_recovery_points p WHERE p.database_id=databases.id
    AND p.node_id=databases.node_id AND p.storage_generation=databases.storage_generation
    AND p.generation=databases.generation AND p.state='asleep'
    AND p.proven_sleep_json=databases.proven_sleep_json);
CREATE INDEX databases_cold_storage_due_idx ON databases(storage_residency,sleep_since,id)
  WHERE deleted_at IS NULL;

-- The original operations.kind CHECK is intentionally left unchanged, as for role_deletions.
-- These rows participate in the public operation view through an additive UNION.
CREATE TABLE cold_storage_operations (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=23 AND substr(id,1,3)='op_' AND NOT substr(id,4) GLOB '*[^a-z0-9]*'),
  kind TEXT NOT NULL CHECK(kind IN('database.archive','database.rehydrate')),
  status TEXT NOT NULL CHECK(status IN('pending','running','succeeded','failed')),
  project_id TEXT NOT NULL REFERENCES projects(id),
  database_id TEXT NOT NULL REFERENCES databases(id),
  generation INTEGER NOT NULL CHECK(generation>=1),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK((status IN('pending','running'))=(completed_at IS NULL)),
  CHECK((status='failed')=(error_code IS NOT NULL)),
  CHECK(status='failed' OR error_message IS NULL)
);
CREATE INDEX cold_storage_operations_database_idx ON cold_storage_operations(database_id,created_at DESC,id DESC);
CREATE INDEX cold_storage_operations_completed_idx ON cold_storage_operations(kind,completed_at);
CREATE INDEX cold_storage_operations_pending_idx ON cold_storage_operations(created_at)
  WHERE status IN('pending','running');

-- Bounded cron passes continue after their last candidate even when an early candidate cannot
-- progress. The existing reconciliation_cursors has a closed name set and remains unchanged.
CREATE TABLE cold_storage_cursors (
  name TEXT PRIMARY KEY NOT NULL CHECK(name IN('cold_storage_operations','cold_storage_due')),
  cursor TEXT,
  CHECK(cursor IS NULL OR (
    name='cold_storage_operations' AND length(cursor)=23 AND substr(cursor,1,3)='op_'
      AND NOT substr(cursor,4) GLOB '*[^a-z0-9]*'
  ) OR (
    name='cold_storage_due' AND length(cursor)=20 AND substr(cursor,1,1) GLOB '[a-z]'
      AND NOT cursor GLOB '*[^a-z0-9]*'
  ))
);

CREATE TABLE database_cold_storage (
  operation TEXT PRIMARY KEY NOT NULL REFERENCES cold_storage_operations(id),
  kind TEXT NOT NULL CHECK(kind IN('archive','rehydrate')),
  database_id TEXT NOT NULL REFERENCES databases(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  region_id TEXT NOT NULL REFERENCES regions(id),
  source_operation TEXT REFERENCES database_cold_storage(operation),
  phase TEXT NOT NULL CHECK(phase IN('verifying','retiring','archived','waiting_capacity','restoring','succeeded','failed','cancelled')),
  source_node_id TEXT NOT NULL REFERENCES nodes(id),
  source_generation INTEGER NOT NULL CHECK(source_generation>=1),
  source_storage_generation INTEGER NOT NULL CHECK(source_storage_generation>=1),
  source_archive_path TEXT NOT NULL CHECK(length(source_archive_path)<=512),
  source_backup_id TEXT NOT NULL CHECK(length(source_backup_id)=15),
  proven_sleep_json TEXT NOT NULL CHECK(json_valid(proven_sleep_json)),
  inventory_sha256 TEXT CHECK(inventory_sha256 IS NULL OR (length(inventory_sha256)=64 AND NOT inventory_sha256 GLOB '*[^a-f0-9]*')),
  inventory_json TEXT CHECK(inventory_json IS NULL OR json_valid(inventory_json)),
  verification_node_id TEXT REFERENCES nodes(id),
  verification_dispatched_at TEXT,
  verification_receipt_json TEXT CHECK(verification_receipt_json IS NULL OR json_valid(verification_receipt_json)),
  retirement_operation TEXT REFERENCES lifecycle_orders(operation),
  source_removed_at TEXT,
  source_archive_deleted_at TEXT,
  target_node_id TEXT REFERENCES nodes(id),
  target_started_at TEXT,
  target_generation INTEGER CHECK(target_generation IS NULL OR target_generation>source_generation),
  target_storage_generation INTEGER CHECK(target_storage_generation IS NULL OR target_storage_generation>source_storage_generation),
  target_archive_path TEXT CHECK(target_archive_path IS NULL OR length(target_archive_path)<=512),
  wake_requested INTEGER NOT NULL DEFAULT 0 CHECK(wake_requested IN(0,1)),
  manual_resume_requested INTEGER NOT NULL DEFAULT 0 CHECK(manual_resume_requested IN(0,1)),
  failure TEXT CHECK(failure IS NULL OR (length(failure) BETWEEN 1 AND 64 AND NOT failure GLOB '*[^a-z0-9_]*')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK((kind='archive' AND source_operation IS NULL) OR (kind='rehydrate' AND source_operation IS NOT NULL)),
  CHECK(kind='archive' OR phase NOT IN('verifying','retiring','archived')),
  CHECK(kind='rehydrate' OR phase NOT IN('waiting_capacity','restoring','succeeded')),
  CHECK((target_generation IS NULL)=(target_storage_generation IS NULL)),
  CHECK((target_generation IS NULL)=(target_archive_path IS NULL)),
  CHECK(instr(source_archive_path,'/'||region_id||'/'||database_id||'/g'||source_storage_generation||'-op_')>5),
  CHECK(target_archive_path IS NULL OR instr(target_archive_path,'/'||region_id||'/'||database_id||'/g'||target_storage_generation||'-op_')>5),
  CHECK(phase NOT IN('retiring','archived') OR verification_receipt_json IS NOT NULL),
  CHECK(phase<>'archived' OR source_removed_at IS NOT NULL),
  CHECK(phase NOT IN('restoring','succeeded') OR (target_generation IS NOT NULL AND target_node_id IS NOT NULL))
);
CREATE UNIQUE INDEX database_cold_storage_active_idx ON database_cold_storage(database_id)
  WHERE phase IN('verifying','retiring','waiting_capacity','restoring');
CREATE UNIQUE INDEX database_cold_storage_region_verifying_idx ON database_cold_storage(region_id)
  WHERE phase='verifying';
CREATE INDEX database_cold_storage_work_idx ON database_cold_storage(phase,updated_at,operation);
CREATE INDEX database_cold_storage_target_idx ON database_cold_storage(target_node_id) WHERE phase='restoring';
CREATE INDEX database_cold_storage_verifier_idx ON database_cold_storage(verification_node_id) WHERE phase='verifying';
CREATE TRIGGER database_cold_storage_source_immutable BEFORE UPDATE ON database_cold_storage
WHEN NEW.operation<>OLD.operation OR NEW.kind<>OLD.kind OR NEW.database_id<>OLD.database_id
  OR NEW.project_id<>OLD.project_id OR NEW.region_id<>OLD.region_id OR NEW.source_operation IS NOT OLD.source_operation
  OR NEW.source_node_id<>OLD.source_node_id OR NEW.source_generation<>OLD.source_generation
  OR NEW.source_storage_generation<>OLD.source_storage_generation OR NEW.source_archive_path<>OLD.source_archive_path
  OR NEW.source_backup_id<>OLD.source_backup_id OR NEW.proven_sleep_json<>OLD.proven_sleep_json OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'cold_storage_source_immutable'); END;
CREATE TRIGGER cold_storage_protocol_floor_operation_insert AFTER INSERT ON database_cold_storage
BEGIN UPDATE regions SET native_cold_storage_required=1 WHERE id=NEW.region_id AND native_cold_storage_required=0; END;

-- Pins survive the archive operation ending, node loss and failed recovery attempts. The last
-- usable source may be released only after a verified successor or explicit database deletion.
CREATE TABLE archive_pins (
  operation TEXT NOT NULL REFERENCES cold_storage_operations(id),
  archive_path TEXT NOT NULL CHECK(length(archive_path)<=512),
  database_id TEXT NOT NULL REFERENCES databases(id),
  created_at TEXT NOT NULL,
  released_at TEXT,
  PRIMARY KEY(operation,archive_path)
);
CREATE INDEX archive_pins_active_path_idx ON archive_pins(archive_path) WHERE released_at IS NULL;
CREATE INDEX archive_pins_database_idx ON archive_pins(database_id) WHERE released_at IS NULL;

-- Retention's exact R2 delete batch is durable before dispatch. A new source pin cannot race
-- an in-flight delete; interrupted batches are reconciled before the claim is released.
CREATE TABLE archive_retention_claims (
  archive_path TEXT PRIMARY KEY NOT NULL CHECK(length(archive_path)<=512),
  claim TEXT NOT NULL,
  keys_json TEXT CHECK(keys_json IS NULL OR (json_valid(keys_json) AND json_type(keys_json)='array')),
  created_at TEXT NOT NULL
);
CREATE TRIGGER archive_pin_excludes_retention_insert BEFORE INSERT ON archive_pins
WHEN NEW.released_at IS NULL AND EXISTS(SELECT 1 FROM archive_retention_claims WHERE archive_path=NEW.archive_path)
BEGIN SELECT RAISE(ABORT,'archive_retention_in_progress'); END;
CREATE TRIGGER archive_pin_excludes_retention_update BEFORE UPDATE OF released_at,archive_path ON archive_pins
WHEN NEW.released_at IS NULL AND EXISTS(SELECT 1 FROM archive_retention_claims WHERE archive_path=NEW.archive_path)
BEGIN SELECT RAISE(ABORT,'archive_retention_in_progress'); END;
CREATE TRIGGER archive_retention_excludes_pin_insert BEFORE INSERT ON archive_retention_claims
WHEN EXISTS(SELECT 1 FROM archive_pins WHERE archive_path=NEW.archive_path AND released_at IS NULL)
BEGIN SELECT RAISE(ABORT,'archive_pinned'); END;
CREATE TRIGGER archive_retention_claim_path_immutable BEFORE UPDATE OF archive_path ON archive_retention_claims
WHEN NEW.archive_path<>OLD.archive_path
BEGIN SELECT RAISE(ABORT,'archive_retention_claim_immutable'); END;
CREATE TRIGGER archive_retention_claim_batch_immutable BEFORE UPDATE OF claim,keys_json ON archive_retention_claims
WHEN NEW.claim<>OLD.claim OR (OLD.keys_json IS NOT NULL AND NEW.keys_json IS NOT OLD.keys_json)
BEGIN SELECT RAISE(ABORT,'archive_retention_claim_immutable'); END;
