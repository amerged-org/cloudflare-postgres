-- SPDX-License-Identifier: Apache-2.0
-- Provisioning status and immutable execution specifications remain unchanged.
ALTER TABLE operations ADD COLUMN lease_actor_token_id TEXT REFERENCES region_tokens(id);

CREATE TABLE environment_suspend_specs (
  operation_id TEXT PRIMARY KEY REFERENCES operations(id),
  environment_id TEXT NOT NULL REFERENCES environments(id),
  runtime_revision INTEGER NOT NULL CHECK (runtime_revision BETWEEN 1 AND 9007199254740991),
  spec_revision INTEGER NOT NULL CHECK (spec_revision BETWEEN 1 AND 9007199254740991),
  spec_hash TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  cluster_uid TEXT NOT NULL,
  pooler_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (operation_id, environment_id, runtime_revision)
);

CREATE TABLE environment_runtime (
  environment_id TEXT PRIMARY KEY REFERENCES environments(id),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  desired_state TEXT NOT NULL CHECK (desired_state IN ('running', 'suspended')),
  phase TEXT NOT NULL CHECK (phase IN ('running', 'suspending', 'suspended')),
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),
  version_token TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  observed_at TEXT,
  observation_json TEXT,
  FOREIGN KEY (operation_id, environment_id, revision)
    REFERENCES environment_suspend_specs(operation_id, environment_id, runtime_revision),
  CHECK (
    (phase = 'suspending' AND desired_state = 'suspended' AND observed_at IS NULL AND observation_json IS NULL)
    OR (phase = 'suspended' AND desired_state = 'suspended' AND observed_at IS NOT NULL AND observation_json IS NOT NULL)
    OR (phase = 'running' AND desired_state = 'running')
  )
);

CREATE TABLE environment_suspend_requests (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, scope_key, idempotency_key),
  FOREIGN KEY (environment_id, organization_id, project_id)
    REFERENCES environments(id, organization_id, project_id),
  FOREIGN KEY (operation_id, organization_id)
    REFERENCES operations(id, organization_id)
);

CREATE INDEX environment_suspend_claim_idx
  ON operations(region_id, status, lease_expires_at, created_at, id)
  WHERE kind = 'environment.suspend';

CREATE TRIGGER environment_suspend_operation_ownership
BEFORE INSERT ON operations WHEN NEW.kind = 'environment.suspend'
BEGIN
  SELECT RAISE(ABORT, 'suspend environment ownership mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM environments e
    WHERE e.id = NEW.environment_id AND e.organization_id = NEW.organization_id
      AND e.project_id = NEW.project_id AND e.region_id = NEW.region_id
  );
END;

CREATE TRIGGER environment_suspend_spec_ownership
BEFORE INSERT ON environment_suspend_specs
BEGIN
  SELECT RAISE(ABORT, 'suspend specification ownership mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM operations o JOIN environments e ON e.id = o.environment_id
    WHERE o.id = NEW.operation_id AND o.kind = 'environment.suspend'
      AND o.environment_id = NEW.environment_id
      AND o.organization_id = e.organization_id AND o.project_id = e.project_id
      AND o.region_id = e.region_id AND e.spec_revision = NEW.spec_revision
      AND e.spec_hash = NEW.spec_hash AND e.resolved_spec = NEW.spec_json
      AND json_extract(e.observation_json, '$.clusterUid') = NEW.cluster_uid
  );
END;

CREATE TRIGGER environment_runtime_identity_immutable
BEFORE UPDATE OF environment_id ON environment_runtime
BEGIN SELECT RAISE(ABORT, 'runtime environment identity is immutable'); END;

CREATE TRIGGER environment_suspend_spec_no_update
BEFORE UPDATE ON environment_suspend_specs
BEGIN SELECT RAISE(ABORT, 'suspend specification is immutable'); END;
CREATE TRIGGER environment_suspend_spec_no_delete
BEFORE DELETE ON environment_suspend_specs
BEGIN SELECT RAISE(ABORT, 'suspend specification is retained'); END;
CREATE TRIGGER environment_suspend_request_no_update
BEFORE UPDATE ON environment_suspend_requests
BEGIN SELECT RAISE(ABORT, 'suspend intention is immutable'); END;
CREATE TRIGGER environment_suspend_request_no_delete
BEFORE DELETE ON environment_suspend_requests
BEGIN SELECT RAISE(ABORT, 'suspend intention is retained'); END;
CREATE TRIGGER environment_suspend_operation_identity_immutable
BEFORE UPDATE OF id, organization_id, project_id, environment_id, region_id, kind, created_at ON operations
WHEN OLD.kind = 'environment.suspend'
BEGIN SELECT RAISE(ABORT, 'suspend operation identity is immutable'); END;
CREATE TRIGGER environment_suspend_operation_result_immutable
BEFORE UPDATE ON operations WHEN OLD.kind = 'environment.suspend' AND OLD.status = 'succeeded'
BEGIN SELECT RAISE(ABORT, 'suspend result is immutable'); END;
CREATE TRIGGER environment_suspend_operation_no_delete
BEFORE DELETE ON operations WHEN OLD.kind = 'environment.suspend'
BEGIN SELECT RAISE(ABORT, 'suspend operation history is retained'); END;
