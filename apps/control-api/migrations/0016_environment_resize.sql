-- SPDX-License-Identifier: Apache-2.0
-- A customer intention is durable, but this migration grants no regional
-- lease, target funding, capacity reservation, or Kubernetes mutation.
CREATE TABLE resize_operations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  region_id TEXT NOT NULL REFERENCES regions(id),
  kind TEXT NOT NULL CHECK (kind = 'environment.resize'),
  cause TEXT NOT NULL CHECK (cause = 'manual'),
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed')),
  spec_revision INTEGER NOT NULL CHECK (spec_revision BETWEEN 1 AND 9007199254740991),
  spec_hash TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  cluster_uid TEXT NOT NULL,
  run_epoch TEXT,
  runtime_revision INTEGER NOT NULL CHECK (runtime_revision BETWEEN 0 AND 9007199254740991),
  policy_hash TEXT NOT NULL,
  compute_revision INTEGER NOT NULL CHECK (compute_revision BETWEEN 1 AND 9007199254740991),
  from_size_id TEXT NOT NULL,
  target_size_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  observed_at TEXT,
  result_code TEXT,
  UNIQUE (id,environment_id,organization_id,project_id),
  UNIQUE (environment_id,compute_revision),
  FOREIGN KEY (environment_id,organization_id,project_id)
    REFERENCES environments(id,organization_id,project_id),
  CHECK ((status IN ('queued','running') AND observed_at IS NULL)
    OR (status IN ('completed','failed') AND observed_at IS NOT NULL)),
  CHECK (from_size_id <> target_size_id)
);
CREATE UNIQUE INDEX resize_one_pending_per_environment
  ON resize_operations(environment_id) WHERE status IN ('queued','running');
CREATE INDEX resize_operation_history
  ON resize_operations(organization_id,project_id,environment_id,created_at DESC,id DESC);

CREATE TABLE environment_compute (
  environment_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  requested_size_id TEXT NOT NULL,
  effective_size_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('requested','applying','effective','failed')),
  operation_id TEXT NOT NULL UNIQUE,
  version_token TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  observed_at TEXT,
  FOREIGN KEY (environment_id,organization_id,project_id)
    REFERENCES environments(id,organization_id,project_id),
  FOREIGN KEY (operation_id,environment_id,organization_id,project_id)
    REFERENCES resize_operations(id,environment_id,organization_id,project_id),
  CHECK ((phase IN ('requested','applying') AND observed_at IS NULL)
    OR (phase IN ('effective','failed') AND observed_at IS NOT NULL))
);

CREATE TABLE resize_requests (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id,scope_key,idempotency_key),
  FOREIGN KEY (environment_id,organization_id,project_id)
    REFERENCES environments(id,organization_id,project_id),
  FOREIGN KEY (operation_id,environment_id,organization_id,project_id)
    REFERENCES resize_operations(id,environment_id,organization_id,project_id)
);

CREATE TRIGGER resize_operation_identity_immutable
BEFORE UPDATE OF id,organization_id,project_id,environment_id,region_id,kind,cause,
  spec_revision,spec_hash,spec_json,cluster_uid,run_epoch,runtime_revision,
  policy_hash,compute_revision,from_size_id,target_size_id,created_at
ON resize_operations
BEGIN SELECT RAISE(ABORT,'resize identity is immutable'); END;
CREATE TRIGGER resize_operation_result_immutable BEFORE UPDATE ON resize_operations
WHEN OLD.status IN ('completed','failed')
BEGIN SELECT RAISE(ABORT,'resize result is immutable'); END;
CREATE TRIGGER resize_operation_no_delete BEFORE DELETE ON resize_operations
BEGIN SELECT RAISE(ABORT,'resize history is retained'); END;
CREATE TRIGGER environment_compute_identity_immutable
BEFORE UPDATE OF environment_id,organization_id,project_id ON environment_compute
BEGIN SELECT RAISE(ABORT,'compute identity is immutable'); END;
CREATE TRIGGER environment_compute_revision_monotonic BEFORE UPDATE ON environment_compute
WHEN NEW.revision < OLD.revision
BEGIN SELECT RAISE(ABORT,'compute revision cannot decrease'); END;
CREATE TRIGGER environment_compute_no_delete BEFORE DELETE ON environment_compute
BEGIN SELECT RAISE(ABORT,'compute state is retained'); END;
CREATE TRIGGER resize_request_no_update BEFORE UPDATE ON resize_requests
BEGIN SELECT RAISE(ABORT,'resize intention is immutable'); END;
CREATE TRIGGER resize_request_no_delete BEFORE DELETE ON resize_requests
BEGIN SELECT RAISE(ABORT,'resize intention is retained'); END;
