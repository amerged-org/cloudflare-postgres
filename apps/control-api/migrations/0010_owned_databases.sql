CREATE TABLE logical_databases (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  region_id TEXT NOT NULL REFERENCES regions(id),
  spec_revision INTEGER NOT NULL CHECK (spec_revision BETWEEN 1 AND 9007199254740991),
  spec_hash TEXT NOT NULL,
  namespace_uid TEXT NOT NULL,
  cluster_uid TEXT NOT NULL,
  name TEXT NOT NULL,
  owner_role_id TEXT NOT NULL,
  owner_role_name TEXT NOT NULL,
  owner_role_uid TEXT NOT NULL,
  owner_credential_revision INTEGER NOT NULL,
  secret_uid TEXT NOT NULL,
  secret_resource_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'failed')),
  version_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  observed_at TEXT,
  observation_json TEXT,
  UNIQUE (environment_id, name),
  UNIQUE (id, owner_role_id),
  UNIQUE (id, organization_id, project_id, environment_id),
  FOREIGN KEY (environment_id, organization_id, project_id) REFERENCES environments(id, organization_id, project_id),
  FOREIGN KEY (owner_role_id, organization_id, project_id, environment_id) REFERENCES database_roles(id, organization_id, project_id, environment_id),
  FOREIGN KEY (owner_role_id, owner_credential_revision) REFERENCES role_credentials(role_id, credential_revision),
  CHECK ((status = 'pending' AND observed_at IS NULL AND observation_json IS NULL)
    OR (status = 'applied' AND observed_at IS NOT NULL AND observation_json IS NOT NULL)
    OR (status = 'failed' AND observed_at IS NOT NULL AND observation_json IS NULL))
);

CREATE TABLE database_operations (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL UNIQUE,
  owner_role_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'database.create'),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'applied', 'failed')),
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
  UNIQUE (id, database_id),
  FOREIGN KEY (database_id, owner_role_id) REFERENCES logical_databases(id, owner_role_id),
  CHECK ((status = 'queued' AND lease_epoch = 0 AND lease_actor_token_id IS NULL AND lease_token_hash IS NULL AND lease_expires_at IS NULL)
    OR (status IN ('running', 'applied', 'failed') AND lease_epoch > 0 AND lease_actor_token_id IS NOT NULL AND lease_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status IN ('queued', 'running') AND observed_at IS NULL AND result_code IS NULL AND result_hash IS NULL AND observation_json IS NULL)
    OR (status = 'applied' AND observed_at IS NOT NULL AND result_code = 'database_verified' AND result_hash IS NOT NULL AND observation_json IS NOT NULL)
    OR (status = 'failed' AND observed_at IS NOT NULL AND result_code IN ('ownership_mismatch', 'spec_conflict', 'database_name_conflict', 'database_verification_failed') AND result_hash IS NOT NULL AND observation_json IS NULL))
);
CREATE INDEX database_operation_claim_idx ON database_operations(status, lease_expires_at, created_at, id);
CREATE INDEX database_operation_owner_lock_idx ON database_operations(owner_role_id, status);

CREATE TABLE database_requests (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  database_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, scope_key, idempotency_key),
  FOREIGN KEY (database_id, organization_id, project_id, environment_id) REFERENCES logical_databases(id, organization_id, project_id, environment_id),
  FOREIGN KEY (operation_id, database_id) REFERENCES database_operations(id, database_id)
);

CREATE TRIGGER logical_database_identity_immutable
BEFORE UPDATE OF id, organization_id, project_id, environment_id, region_id, spec_revision, spec_hash,
  namespace_uid, cluster_uid, name, owner_role_id, owner_role_name, owner_role_uid,
  owner_credential_revision, secret_uid, secret_resource_version, created_at ON logical_databases
BEGIN SELECT RAISE(ABORT, 'database identity is immutable'); END;
CREATE TRIGGER logical_database_result_immutable BEFORE UPDATE ON logical_databases WHEN OLD.status IN ('applied', 'failed')
BEGIN SELECT RAISE(ABORT, 'database observation is immutable'); END;
CREATE TRIGGER logical_database_no_delete BEFORE DELETE ON logical_databases
BEGIN SELECT RAISE(ABORT, 'database identity is retained'); END;
CREATE TRIGGER database_operation_identity_immutable BEFORE UPDATE OF id, database_id, owner_role_id, kind, created_at ON database_operations
BEGIN SELECT RAISE(ABORT, 'database operation identity is immutable'); END;
CREATE TRIGGER database_operation_result_immutable BEFORE UPDATE ON database_operations WHEN OLD.status IN ('applied', 'failed')
BEGIN SELECT RAISE(ABORT, 'database result is immutable'); END;
CREATE TRIGGER database_operation_no_delete BEFORE DELETE ON database_operations
BEGIN SELECT RAISE(ABORT, 'database operation history is retained'); END;
CREATE TRIGGER database_request_no_update BEFORE UPDATE ON database_requests
BEGIN SELECT RAISE(ABORT, 'database intention is immutable'); END;
CREATE TRIGGER database_request_no_delete BEFORE DELETE ON database_requests
BEGIN SELECT RAISE(ABORT, 'database intention is retained'); END;
