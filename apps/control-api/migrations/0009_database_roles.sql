CREATE TABLE database_roles (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  region_id TEXT NOT NULL REFERENCES regions(id),
  spec_revision INTEGER NOT NULL CHECK (spec_revision BETWEEN 1 AND 9007199254740991),
  spec_hash TEXT NOT NULL,
  cluster_uid TEXT NOT NULL,
  name TEXT NOT NULL,
  connection_limit INTEGER NOT NULL CHECK (connection_limit BETWEEN 1 AND 1000),
  desired_credential_revision INTEGER NOT NULL CHECK (desired_credential_revision BETWEEN 1 AND 9007199254740991),
  applied_credential_revision INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'failed')),
  version_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  observed_at TEXT,
  observation_json TEXT,
  UNIQUE (environment_id, name),
  UNIQUE (id, organization_id, project_id, environment_id),
  CHECK (applied_credential_revision >= 0 AND applied_credential_revision <= desired_credential_revision),
  FOREIGN KEY (environment_id, organization_id, project_id) REFERENCES environments(id, organization_id, project_id)
);

CREATE TABLE role_credentials (
  role_id TEXT NOT NULL REFERENCES database_roles(id),
  credential_revision INTEGER NOT NULL CHECK (credential_revision BETWEEN 1 AND 9007199254740991),
  encrypted_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (role_id, credential_revision)
);

CREATE TABLE role_operations (
  id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES database_roles(id),
  credential_revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'database.role.apply'),
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
  UNIQUE (role_id, credential_revision),
  UNIQUE (id, role_id),
  FOREIGN KEY (role_id, credential_revision) REFERENCES role_credentials(role_id, credential_revision),
  CHECK (
    (status = 'queued' AND lease_epoch = 0 AND lease_actor_token_id IS NULL
      AND lease_token_hash IS NULL AND lease_expires_at IS NULL) OR
    (status IN ('running', 'applied', 'failed') AND lease_epoch > 0
      AND lease_actor_token_id IS NOT NULL AND lease_token_hash IS NOT NULL
      AND lease_expires_at IS NOT NULL)
  ),
  CHECK (
    (status IN ('queued', 'running') AND observed_at IS NULL AND result_code IS NULL
      AND result_hash IS NULL AND observation_json IS NULL) OR
    (status = 'applied' AND observed_at IS NOT NULL AND result_code = 'role_verified'
      AND result_hash IS NOT NULL AND observation_json IS NOT NULL) OR
    (status = 'failed' AND observed_at IS NOT NULL
      AND result_code IN ('ownership_mismatch', 'spec_conflict', 'credential_verification_failed')
      AND result_hash IS NOT NULL AND observation_json IS NULL)
  )
);
CREATE UNIQUE INDEX role_operation_active_role_idx ON role_operations(role_id) WHERE status IN ('queued', 'running');
CREATE INDEX role_operation_claim_idx ON role_operations(status, lease_expires_at, created_at, id);

CREATE TABLE role_requests (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  role_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, scope_key, idempotency_key),
  FOREIGN KEY (role_id, organization_id, project_id, environment_id) REFERENCES database_roles(id, organization_id, project_id, environment_id),
  FOREIGN KEY (operation_id, role_id) REFERENCES role_operations(id, role_id)
);
CREATE TRIGGER database_role_identity_immutable BEFORE UPDATE OF id, organization_id, project_id, environment_id, region_id,
  spec_revision, spec_hash, cluster_uid, name, connection_limit, created_at ON database_roles
BEGIN SELECT RAISE(ABORT, 'database role identity is immutable'); END;
CREATE TRIGGER role_credential_no_update BEFORE UPDATE ON role_credentials
BEGIN SELECT RAISE(ABORT, 'credential version is immutable'); END;
CREATE TRIGGER role_credential_no_delete BEFORE DELETE ON role_credentials
BEGIN SELECT RAISE(ABORT, 'credential version is retained'); END;
CREATE TRIGGER role_operation_identity_immutable BEFORE UPDATE OF id, role_id, credential_revision, kind, created_at ON role_operations
BEGIN SELECT RAISE(ABORT, 'role operation identity is immutable'); END;
CREATE TRIGGER role_operation_result_immutable BEFORE UPDATE ON role_operations WHEN OLD.status IN ('applied', 'failed')
BEGIN SELECT RAISE(ABORT, 'role result is immutable'); END;
CREATE TRIGGER role_operation_no_delete BEFORE DELETE ON role_operations
BEGIN SELECT RAISE(ABORT, 'role operation history is retained'); END;
CREATE TRIGGER role_request_no_update BEFORE UPDATE ON role_requests
BEGIN SELECT RAISE(ABORT, 'role intention is immutable'); END;
CREATE TRIGGER role_request_no_delete BEFORE DELETE ON role_requests
BEGIN SELECT RAISE(ABORT, 'role intention is retained'); END;
