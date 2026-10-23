-- SPDX-License-Identifier: Apache-2.0
-- Explicit same-identity PITR. The serving row stays on its stopped source until a replacement
-- or a forward-generation rollback is ready and has a DONE base backup. No generation is reused.
ALTER TABLE nodes ADD COLUMN restore_in_place_capable INTEGER NOT NULL DEFAULT 0 CHECK(restore_in_place_capable IN(0,1));
CREATE TABLE database_replacements (
 operation TEXT PRIMARY KEY NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
 database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
 node_id TEXT NOT NULL REFERENCES nodes(id),
 project_id TEXT NOT NULL REFERENCES projects(id),
 region_id TEXT NOT NULL REFERENCES regions(id),
 phase TEXT NOT NULL CHECK(phase IN('proving','restoring','rolling_back','succeeded','failed')),
 source_generation INTEGER NOT NULL CHECK(source_generation>=1),
 source_storage_generation INTEGER NOT NULL CHECK(source_storage_generation>=1),
 source_archive_path TEXT NOT NULL,
 source_backup_id TEXT,
 source_proof_json TEXT CHECK(source_proof_json IS NULL OR json_valid(source_proof_json)),
 source_acknowledged_at TEXT,
 requested_backup_id TEXT NOT NULL,
 target_time TEXT NOT NULL,
 target_generation INTEGER,
 target_storage_generation INTEGER,
 target_archive_path TEXT,
 rollback_generation INTEGER,
 rollback_storage_generation INTEGER,
 rollback_archive_path TEXT,
 failure TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 completed_at TEXT,
 retained_until TEXT,
 source_cleanup_claim TEXT,
 target_cleanup_claim TEXT,
 rollback_cleanup_claim TEXT,
 source_archive_deleted_at TEXT,
 target_archive_deleted_at TEXT,
 rollback_archive_deleted_at TEXT,
 CHECK((phase IN('succeeded','failed'))=(completed_at IS NOT NULL)),
 CHECK(target_storage_generation IS NULL OR target_storage_generation>source_storage_generation),
 CHECK(rollback_storage_generation IS NULL OR rollback_storage_generation>target_storage_generation),
 CHECK(phase NOT IN('rolling_back','failed') OR failure IS NOT NULL),
 CHECK(phase<>'succeeded' OR failure IS NULL),
 CHECK(phase NOT IN('restoring','rolling_back','succeeded') OR target_generation IS NOT NULL),
 CHECK(phase<>'rolling_back' OR rollback_generation IS NOT NULL)
);
CREATE UNIQUE INDEX database_replacements_active_idx ON database_replacements(database_id)
 WHERE phase IN('proving','restoring','rolling_back');
CREATE INDEX database_replacements_node_idx ON database_replacements(node_id,phase);
CREATE INDEX database_replacements_history_idx ON database_replacements(database_id,created_at DESC);
CREATE TRIGGER database_replacements_monotonic BEFORE UPDATE ON database_replacements
WHEN NEW.operation<>OLD.operation OR NEW.database_id<>OLD.database_id OR NEW.node_id<>OLD.node_id
 OR NEW.source_storage_generation<>OLD.source_storage_generation OR NEW.source_archive_path<>OLD.source_archive_path
 OR NEW.target_time<>OLD.target_time OR NEW.requested_backup_id<>OLD.requested_backup_id
 OR (OLD.phase IN('succeeded','failed') AND (NEW.phase<>OLD.phase OR NEW.completed_at IS NOT OLD.completed_at))
 OR (OLD.phase='restoring' AND NEW.phase='proving')
 OR (OLD.phase='rolling_back' AND NEW.phase IN('proving','restoring'))
 OR (OLD.target_storage_generation IS NOT NULL AND (NEW.target_storage_generation IS NOT OLD.target_storage_generation
   OR NEW.target_archive_path IS NOT OLD.target_archive_path OR NEW.target_generation IS NOT OLD.target_generation
   OR NEW.source_generation<>OLD.source_generation OR NEW.source_backup_id IS NOT OLD.source_backup_id OR NEW.source_proof_json IS NOT OLD.source_proof_json))
 OR (OLD.rollback_storage_generation IS NOT NULL AND (NEW.rollback_storage_generation IS NOT OLD.rollback_storage_generation
   OR NEW.rollback_archive_path IS NOT OLD.rollback_archive_path OR NEW.rollback_generation IS NOT OLD.rollback_generation))
BEGIN SELECT RAISE(ABORT,'database_replacement_immutable'); END;
-- These guards also cover callers that read before the replacement acquired its admission fence.
CREATE TRIGGER replacement_holds_database_config BEFORE UPDATE OF name,size_class_id,sleep_after_seconds,deleted_at,own_memory_mib,own_cpu_millicores,own_storage_gib ON databases
WHEN EXISTS(SELECT 1 FROM database_replacements p WHERE p.database_id=OLD.id AND p.phase IN('proving','restoring','rolling_back'))
BEGIN SELECT RAISE(ABORT,'database_replacement_in_progress'); END;
CREATE TRIGGER replacement_holds_role_insert BEFORE INSERT ON roles
WHEN EXISTS(SELECT 1 FROM database_replacements p WHERE p.database_id=NEW.database_id AND p.phase IN('proving','restoring','rolling_back'))
BEGIN SELECT RAISE(ABORT,'database_replacement_in_progress'); END;
CREATE TRIGGER replacement_holds_role_update BEFORE UPDATE ON roles
WHEN EXISTS(SELECT 1 FROM database_replacements p WHERE p.database_id=OLD.database_id AND p.phase IN('proving','restoring','rolling_back'))
BEGIN SELECT RAISE(ABORT,'database_replacement_in_progress'); END;
CREATE TRIGGER replacement_holds_role_delete BEFORE DELETE ON roles
WHEN EXISTS(SELECT 1 FROM database_replacements p WHERE p.database_id=OLD.database_id AND p.phase IN('proving','restoring','rolling_back'))
BEGIN SELECT RAISE(ABORT,'database_replacement_in_progress'); END;
-- The source's authenticated idle-sleep observation may still advance its power state while
-- proving. A public suspend/resume, deletion or compensation cannot take over an active restore.
CREATE TRIGGER replacement_holds_power BEFORE UPDATE OF desired_state,suspension_reason,power_operation ON databases
WHEN EXISTS(SELECT 1 FROM database_replacements p WHERE p.database_id=OLD.id AND p.phase IN('proving','restoring','rolling_back'))
 AND NOT (OLD.desired_state='running' AND NEW.desired_state='suspended' AND NEW.suspension_reason='idle' AND NEW.generation=OLD.generation+1
   AND EXISTS(SELECT 1 FROM database_replacements p WHERE p.database_id=OLD.id AND p.phase='proving'))
 AND NOT EXISTS(SELECT 1 FROM database_replacements p JOIN database_admission_epochs a ON a.database_id=p.database_id
   WHERE p.database_id=OLD.id AND a.mutation_status='pending'
     AND ((p.phase='restoring' AND NEW.storage_generation=p.target_storage_generation AND NEW.generation=p.target_generation)
       OR (p.phase='rolling_back' AND NEW.storage_generation=p.rollback_storage_generation AND NEW.generation=p.rollback_generation)))
BEGIN SELECT RAISE(ABORT,'database_replacement_in_progress'); END;
CREATE TRIGGER replacement_holds_size_class BEFORE UPDATE ON size_classes
WHEN EXISTS(SELECT 1 FROM database_replacements p JOIN databases d ON d.id=p.database_id
 WHERE d.size_class_id=OLD.id AND p.phase IN('proving','restoring','rolling_back'))
BEGIN SELECT RAISE(ABORT,'database_replacement_in_progress'); END;
