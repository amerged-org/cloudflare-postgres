CREATE TABLE environment_backups (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  region_id TEXT NOT NULL REFERENCES regions(id),
  spec_revision INTEGER NOT NULL CHECK (spec_revision BETWEEN 1 AND 9007199254740991),
  spec_hash TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  archive_hash TEXT NOT NULL,
  cluster_uid TEXT NOT NULL,
  run_epoch TEXT,
  runtime_revision INTEGER NOT NULL CHECK (runtime_revision BETWEEN 0 AND 9007199254740991),
  resource_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  version_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  observed_at TEXT,
  observation_json TEXT,
  UNIQUE (id, organization_id, project_id, environment_id),
  UNIQUE (environment_id, resource_name),
  FOREIGN KEY (environment_id, organization_id, project_id) REFERENCES environments(id, organization_id, project_id),
  CHECK ((status = 'pending' AND observed_at IS NULL AND observation_json IS NULL)
    OR (status IN ('completed','failed') AND observed_at IS NOT NULL AND observation_json IS NOT NULL))
);
CREATE INDEX environment_backup_collection_idx ON environment_backups(organization_id,project_id,environment_id,created_at DESC,id DESC);
CREATE TABLE backup_operations (
  id TEXT PRIMARY KEY,
  backup_id TEXT NOT NULL UNIQUE REFERENCES environment_backups(id),
  kind TEXT NOT NULL CHECK (kind = 'environment.backup'),
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed')),
  lease_actor_token_id TEXT REFERENCES region_tokens(id),
  lease_token_hash TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch BETWEEN 0 AND 9007199254740991),
  lease_expires_at TEXT,
  version_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  observed_at TEXT,
  result_code TEXT,
  result_hash TEXT,
  observation_json TEXT,
  UNIQUE (id,backup_id),
  CHECK ((status = 'queued' AND lease_epoch = 0 AND lease_actor_token_id IS NULL AND lease_token_hash IS NULL AND lease_expires_at IS NULL)
    OR (status IN ('running','completed','failed') AND lease_epoch > 0 AND lease_actor_token_id IS NOT NULL AND lease_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status IN ('queued','running') AND observed_at IS NULL AND result_code IS NULL AND result_hash IS NULL AND observation_json IS NULL)
    OR (status = 'completed' AND observed_at IS NOT NULL AND result_code = 'base_backup_completed' AND result_hash IS NOT NULL AND observation_json IS NOT NULL)
    OR (status = 'failed' AND observed_at IS NOT NULL AND result_code = 'backup_failed' AND result_hash IS NOT NULL AND observation_json IS NOT NULL))
);
CREATE INDEX backup_operation_claim_idx ON backup_operations(status,lease_expires_at,created_at,id);
CREATE TABLE backup_requests (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  backup_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id,scope_key,idempotency_key),
  FOREIGN KEY (backup_id,organization_id,project_id,environment_id) REFERENCES environment_backups(id,organization_id,project_id,environment_id),
  FOREIGN KEY (operation_id,backup_id) REFERENCES backup_operations(id,backup_id)
);
CREATE TABLE backup_dispatches (
  operation_id TEXT PRIMARY KEY,
  backup_id TEXT NOT NULL UNIQUE,
  nonce TEXT NOT NULL UNIQUE,
  lease_actor_token_id TEXT NOT NULL REFERENCES region_tokens(id),
  lease_token_hash TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL CHECK (lease_epoch BETWEEN 1 AND 9007199254740991),
  binding_json TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (operation_id,backup_id) REFERENCES backup_operations(id,backup_id)
);
CREATE TRIGGER environment_backup_identity_immutable BEFORE UPDATE OF id,organization_id,project_id,environment_id,region_id,spec_revision,spec_hash,spec_json,archive_hash,cluster_uid,run_epoch,runtime_revision,resource_name,created_at ON environment_backups
BEGIN SELECT RAISE(ABORT,'backup identity is immutable'); END;
CREATE TRIGGER environment_backup_result_immutable BEFORE UPDATE ON environment_backups WHEN OLD.status IN ('completed','failed')
BEGIN SELECT RAISE(ABORT,'backup observation is immutable'); END;
CREATE TRIGGER environment_backup_no_delete BEFORE DELETE ON environment_backups
BEGIN SELECT RAISE(ABORT,'backup history is retained'); END;
CREATE TRIGGER backup_operation_identity_immutable BEFORE UPDATE OF id,backup_id,kind,created_at ON backup_operations
BEGIN SELECT RAISE(ABORT,'backup operation identity is immutable'); END;
CREATE TRIGGER backup_operation_result_immutable BEFORE UPDATE ON backup_operations WHEN OLD.status IN ('completed','failed')
BEGIN SELECT RAISE(ABORT,'backup result is immutable'); END;
CREATE TRIGGER backup_operation_no_delete BEFORE DELETE ON backup_operations
BEGIN SELECT RAISE(ABORT,'backup operation history is retained'); END;
CREATE TRIGGER backup_request_no_update BEFORE UPDATE ON backup_requests
BEGIN SELECT RAISE(ABORT,'backup intention is immutable'); END;
CREATE TRIGGER backup_request_no_delete BEFORE DELETE ON backup_requests
BEGIN SELECT RAISE(ABORT,'backup intention is retained'); END;
CREATE TRIGGER backup_dispatch_no_update BEFORE UPDATE ON backup_dispatches
BEGIN SELECT RAISE(ABORT,'backup dispatch is immutable'); END;
CREATE TRIGGER backup_dispatch_no_delete BEFORE DELETE ON backup_dispatches
BEGIN SELECT RAISE(ABORT,'backup dispatch is retained'); END;
