-- SPDX-License-Identifier: Apache-2.0
-- Retained intent fences admissions; physical disposal is not implemented here.
CREATE TABLE environment_deletions (
  environment_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  region_id TEXT NOT NULL REFERENCES regions(id),
  operation_id TEXT NOT NULL UNIQUE,
  stop_operation_id TEXT NOT NULL UNIQUE,
  expected_runtime_revision INTEGER NOT NULL CHECK (expected_runtime_revision BETWEEN 0 AND 9007199254740990),
  runtime_revision INTEGER NOT NULL CHECK (runtime_revision BETWEEN 1 AND 9007199254740991 AND runtime_revision IN (expected_runtime_revision,expected_runtime_revision + 1)),
  spec_revision INTEGER NOT NULL,
  spec_hash TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  observation_json TEXT NOT NULL,
  run_epoch TEXT,
  volume_policy TEXT NOT NULL CHECK (volume_policy = 'delete'),
  backup_policy TEXT NOT NULL CHECK (backup_policy = 'retain'),
  scope_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (organization_id,scope_key,idempotency_key),
  FOREIGN KEY (environment_id,organization_id,project_id)
    REFERENCES environments(id,organization_id,project_id),
  FOREIGN KEY (operation_id,organization_id) REFERENCES operations(id,organization_id),
  FOREIGN KEY (stop_operation_id,environment_id,runtime_revision)
    REFERENCES environment_suspend_specs(operation_id,environment_id,runtime_revision)
);

CREATE TRIGGER environment_deletion_ownership BEFORE INSERT ON environment_deletions
BEGIN
  SELECT RAISE(ABORT,'deletion binding mismatch') WHERE NOT EXISTS (
    SELECT 1 FROM environments e JOIN operations p ON p.id=NEW.operation_id
    JOIN operations c ON c.id=NEW.stop_operation_id
    JOIN environment_suspend_specs s ON s.operation_id=c.id
    JOIN environment_runtime r ON r.environment_id=e.id
    WHERE e.id=NEW.environment_id AND e.organization_id=NEW.organization_id
      AND e.project_id=NEW.project_id AND e.region_id=NEW.region_id
      AND e.status='ready' AND e.spec_revision=NEW.spec_revision
      AND e.spec_hash=NEW.spec_hash AND e.resolved_spec=NEW.spec_json
      AND e.observation_json=NEW.observation_json AND e.run_epoch IS NEW.run_epoch
      AND p.kind='environment.delete' AND p.status='queued'
      AND p.environment_id=e.id AND p.organization_id=e.organization_id
      AND p.project_id=e.project_id AND p.region_id=e.region_id
      AND c.kind='environment.suspend' AND c.status IN ('queued','running','succeeded')
      AND c.environment_id=e.id AND c.organization_id=e.organization_id
      AND c.project_id=e.project_id AND c.region_id=e.region_id
      AND s.environment_id=e.id AND s.runtime_revision=NEW.runtime_revision
      AND s.spec_revision=e.spec_revision AND s.spec_hash=e.spec_hash
      AND s.spec_json=e.resolved_spec AND s.run_epoch IS e.run_epoch
      AND s.cluster_uid=json_extract(e.observation_json,'$.clusterUid')
      AND r.operation_id=c.id AND r.revision=NEW.runtime_revision
      AND r.desired_state='suspended'
      AND ((r.phase='suspending' AND c.status IN ('queued','running')) OR (r.phase='suspended' AND c.status='succeeded'))
  );
END;
CREATE TRIGGER environment_deletion_no_update BEFORE UPDATE ON environment_deletions
BEGIN SELECT RAISE(ABORT,'deletion intention is immutable'); END;
CREATE TRIGGER environment_deletion_no_delete BEFORE DELETE ON environment_deletions
BEGIN SELECT RAISE(ABORT,'deletion intention is retained'); END;
CREATE TRIGGER environment_delete_operation_identity BEFORE UPDATE OF id,organization_id,project_id,
  environment_id,region_id,kind,created_at ON operations WHEN OLD.kind='environment.delete'
BEGIN SELECT RAISE(ABORT,'deletion operation identity is immutable'); END;
CREATE TRIGGER environment_delete_operation_no_delete BEFORE DELETE ON operations
WHEN OLD.kind='environment.delete'
BEGIN SELECT RAISE(ABORT,'deletion operation is retained'); END;
