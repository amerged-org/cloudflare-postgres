CREATE TABLE maintenance_preparer_tokens (
  id TEXT PRIMARY KEY,
  region_id TEXT NOT NULL REFERENCES regions(id),
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL CHECK (scopes = 'maintenance:prepare:claim maintenance:prepare:report'),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE UNIQUE INDEX maintenance_preparer_active_region_idx
  ON maintenance_preparer_tokens(region_id) WHERE revoked_at IS NULL;

CREATE TABLE maintenance_preparations (
  id TEXT PRIMARY KEY,
  region_id TEXT NOT NULL REFERENCES regions(id),
  kind TEXT NOT NULL CHECK (kind = 'maintenance.prepare'),
  plan_hash TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'assessed')),
  eligibility TEXT CHECK (eligibility IN ('blocked', 'eligible')),
  created_at TEXT NOT NULL,
  assessed_at TEXT,
  assessment_json TEXT,
  lease_preparer_token_id TEXT REFERENCES maintenance_preparer_tokens(id),
  lease_token_hash TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0 AND lease_epoch <= 9007199254740991),
  lease_expires_at TEXT,
  result_hash TEXT,
  UNIQUE (id, region_id),
  CHECK (
    (status = 'queued' AND lease_epoch = 0 AND lease_preparer_token_id IS NULL
      AND lease_token_hash IS NULL AND lease_expires_at IS NULL) OR
    (status IN ('running', 'assessed') AND lease_epoch > 0
      AND lease_preparer_token_id IS NOT NULL AND lease_token_hash IS NOT NULL
      AND lease_expires_at IS NOT NULL)
  ),
  CHECK (
    (status != 'assessed' AND eligibility IS NULL AND assessed_at IS NULL
      AND assessment_json IS NULL AND result_hash IS NULL) OR
    (status = 'assessed' AND eligibility IS NOT NULL AND assessed_at IS NOT NULL
      AND assessment_json IS NOT NULL AND result_hash IS NOT NULL)
  )
);

CREATE INDEX maintenance_preparation_claim_idx
  ON maintenance_preparations(region_id, status, lease_expires_at, created_at, id);

CREATE TRIGGER maintenance_preparation_plan_immutable
BEFORE UPDATE OF id, region_id, kind, plan_hash, plan_json, created_at ON maintenance_preparations
BEGIN
  SELECT RAISE(ABORT, 'maintenance preparation plan is immutable');
END;

CREATE TRIGGER maintenance_preparation_assessment_immutable
BEFORE UPDATE ON maintenance_preparations WHEN OLD.status = 'assessed'
BEGIN
  SELECT RAISE(ABORT, 'maintenance assessment is immutable');
END;

CREATE TRIGGER maintenance_preparation_retained
BEFORE DELETE ON maintenance_preparations
BEGIN
  SELECT RAISE(ABORT, 'maintenance preparation history is retained');
END;

CREATE TABLE maintenance_preparation_requests (
  region_id TEXT NOT NULL REFERENCES regions(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (region_id, idempotency_key),
  FOREIGN KEY (operation_id, region_id) REFERENCES maintenance_preparations(id, region_id)
);

CREATE TRIGGER maintenance_preparation_request_immutable_update
BEFORE UPDATE ON maintenance_preparation_requests
BEGIN
  SELECT RAISE(ABORT, 'maintenance preparation request is immutable');
END;

CREATE TRIGGER maintenance_preparation_request_immutable_delete
BEFORE DELETE ON maintenance_preparation_requests
BEGIN
  SELECT RAISE(ABORT, 'maintenance preparation request is immutable');
END;
