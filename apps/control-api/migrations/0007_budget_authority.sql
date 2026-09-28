CREATE TABLE budget_tokens (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX budget_tokens_active_organization_idx
  ON budget_tokens(organization_id) WHERE revoked_at IS NULL;

-- Budget units and ledger counters are decimal TEXT. Arithmetic belongs to
-- checked BigInt application code; SQL guards compare immutable snapshots.
CREATE TABLE budget_targets (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  environment_id TEXT REFERENCES environments(id),
  active_account_id TEXT,
  revision TEXT NOT NULL,
  execution_epoch TEXT NOT NULL,
  requested_state TEXT NOT NULL CHECK (requested_state IN ('running', 'paused')),
  updated_at TEXT NOT NULL
);

CREATE TABLE budget_accounts (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES budget_targets(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  granted_json TEXT NOT NULL,
  consumed_json TEXT NOT NULL,
  reserved_json TEXT NOT NULL,
  gap_count TEXT NOT NULL,
  version_token TEXT NOT NULL,
  UNIQUE (target_id, period_start, period_end)
);

CREATE INDEX budget_targets_project_idx ON budget_targets(project_id);

CREATE TABLE budget_revisions (
  target_id TEXT NOT NULL REFERENCES budget_targets(id),
  revision TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES budget_accounts(id),
  execution_epoch TEXT NOT NULL,
  requested_state TEXT NOT NULL,
  granted_json TEXT NOT NULL,
  actor_token_id TEXT NOT NULL REFERENCES budget_tokens(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (target_id, revision)
);

CREATE TABLE allowance_reservations (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  region_id TEXT NOT NULL REFERENCES regions(id),
  environment_id TEXT NOT NULL REFERENCES environments(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  spec_revision INTEGER NOT NULL,
  spec_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  execution_epoch TEXT NOT NULL,
  fence_token_hash TEXT NOT NULL,
  fence_ciphertext TEXT NOT NULL,
  fence_iv TEXT NOT NULL,
  fence_key_version TEXT NOT NULL,
  units_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('issued', 'settled')),
  revision TEXT NOT NULL,
  gap_count TEXT NOT NULL,
  version_token TEXT NOT NULL,
  stopped_at TEXT,
  stop_evidence_hash TEXT,
  settled_at TEXT,
  UNIQUE (region_id, request_id)
);

CREATE INDEX allowance_reservations_project_status_idx
  ON allowance_reservations(project_id, status, expires_at);

CREATE TABLE allowance_accounts (
  reservation_id TEXT NOT NULL REFERENCES allowance_reservations(id),
  account_id TEXT NOT NULL REFERENCES budget_accounts(id),
  target_revision TEXT NOT NULL,
  target_execution_epoch TEXT NOT NULL,
  reserved_json TEXT NOT NULL,
  PRIMARY KEY (reservation_id, account_id)
);

CREATE TABLE allowance_usage_links (
  fact_id TEXT PRIMARY KEY REFERENCES usage_facts(fact_id),
  reservation_id TEXT NOT NULL REFERENCES allowance_reservations(id),
  metric TEXT NOT NULL,
  linked_revision INTEGER NOT NULL,
  charged_quantity TEXT NOT NULL,
  coverage_status TEXT NOT NULL,
  version_token TEXT NOT NULL
);

CREATE INDEX allowance_usage_links_reservation_idx
  ON allowance_usage_links(reservation_id);

CREATE TABLE allowance_settlement_versions (
  reservation_id TEXT NOT NULL REFERENCES allowance_reservations(id),
  revision TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (reservation_id, revision),
  UNIQUE (reservation_id, request_hash)
);

CREATE TABLE allowance_usage_corrections (
  reservation_id TEXT NOT NULL REFERENCES allowance_reservations(id),
  fact_id TEXT NOT NULL REFERENCES usage_facts(fact_id),
  usage_revision INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  delta_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (reservation_id, fact_id, usage_revision)
);

CREATE TRIGGER budget_revisions_no_update BEFORE UPDATE ON budget_revisions
BEGIN SELECT RAISE(ABORT, 'budget revision is immutable'); END;
CREATE TRIGGER budget_revisions_no_delete BEFORE DELETE ON budget_revisions
BEGIN SELECT RAISE(ABORT, 'budget revision is immutable'); END;
CREATE TRIGGER allowance_settlement_no_update BEFORE UPDATE ON allowance_settlement_versions
BEGIN SELECT RAISE(ABORT, 'settlement evidence is immutable'); END;
CREATE TRIGGER allowance_settlement_no_delete BEFORE DELETE ON allowance_settlement_versions
BEGIN SELECT RAISE(ABORT, 'settlement evidence is immutable'); END;
CREATE TRIGGER allowance_correction_no_update BEFORE UPDATE ON allowance_usage_corrections
BEGIN SELECT RAISE(ABORT, 'usage correction is immutable'); END;
CREATE TRIGGER allowance_correction_no_delete BEFORE DELETE ON allowance_usage_corrections
BEGIN SELECT RAISE(ABORT, 'usage correction is immutable'); END;
CREATE TRIGGER budget_account_period_no_update
BEFORE UPDATE OF target_id, period_start, period_end ON budget_accounts
BEGIN SELECT RAISE(ABORT, 'budget period is immutable'); END;
CREATE TRIGGER allowance_identity_no_update
BEFORE UPDATE OF id, request_id, region_id, environment_id, organization_id,
  project_id, spec_revision, spec_hash, request_hash, issued_at, expires_at,
  execution_epoch, fence_token_hash, fence_ciphertext, fence_iv, fence_key_version, units_json
ON allowance_reservations
BEGIN SELECT RAISE(ABORT, 'allowance receipt is immutable'); END;
