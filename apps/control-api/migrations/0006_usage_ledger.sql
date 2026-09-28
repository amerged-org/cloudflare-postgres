CREATE TABLE accounting_fences (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  version_token TEXT NOT NULL
);

CREATE TABLE accounting_assertions (
  id TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CHECK (ok = 1)
);

CREATE TABLE usage_sources (
  source_id TEXT PRIMARY KEY,
  region_id TEXT NOT NULL UNIQUE REFERENCES regions(id),
  source_epoch INTEGER NOT NULL CHECK (source_epoch >= 1),
  created_at TEXT NOT NULL,
  UNIQUE (source_id, region_id, source_epoch)
);

CREATE TABLE usage_meter_tokens (
  id TEXT PRIMARY KEY,
  region_id TEXT NOT NULL REFERENCES regions(id),
  source_id TEXT NOT NULL,
  source_epoch INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL CHECK (scopes = 'usage:write'),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (source_id, region_id, source_epoch)
    REFERENCES usage_sources(source_id, region_id, source_epoch)
);

CREATE UNIQUE INDEX usage_meter_active_region_idx
  ON usage_meter_tokens(region_id) WHERE revoked_at IS NULL;

CREATE TABLE usage_facts (
  fact_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  region_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_epoch INTEGER NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN (
    'cpu_millicore_ms', 'memory_byte_ms', 'data_storage_byte_ms',
    'backup_storage_byte_ms', 'wal_storage_byte_ms', 'transfer_in_bytes', 'transfer_out_bytes'
  )),
  attribution TEXT NOT NULL CHECK (attribution IN ('primary', 'replica', 'backup', 'wal', 'platform')),
  interval_start TEXT NOT NULL,
  interval_end TEXT NOT NULL,
  head_revision INTEGER NOT NULL DEFAULT 0 CHECK (head_revision >= 0),
  settlement_version INTEGER NOT NULL DEFAULT 0 CHECK (settlement_version >= 0),
  FOREIGN KEY (environment_id, organization_id, project_id)
    REFERENCES environments(id, organization_id, project_id),
  FOREIGN KEY (source_id, region_id, source_epoch)
    REFERENCES usage_sources(source_id, region_id, source_epoch)
);

CREATE INDEX usage_facts_organization_interval_idx
  ON usage_facts(organization_id, interval_start, fact_id);

CREATE TRIGGER usage_fact_region_ownership
BEFORE INSERT ON usage_facts
BEGIN
  SELECT RAISE(ABORT, 'usage environment ownership mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM environments
    WHERE id = NEW.environment_id AND organization_id = NEW.organization_id
      AND project_id = NEW.project_id AND region_id = NEW.region_id
  );
END;

CREATE TRIGGER usage_fact_identity_immutable
BEFORE UPDATE OF fact_id, organization_id, project_id, environment_id, region_id,
  source_id, source_epoch, metric, attribution, interval_start, interval_end ON usage_facts
BEGIN
  SELECT RAISE(ABORT, 'usage fact identity is immutable');
END;

CREATE TABLE usage_versions (
  acceptance_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_id TEXT NOT NULL REFERENCES usage_facts(fact_id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  expected_previous_revision INTEGER NOT NULL CHECK (expected_previous_revision >= 0),
  quantity TEXT,
  status TEXT NOT NULL CHECK (status IN ('provisional', 'final', 'gap')),
  evidence_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  UNIQUE (fact_id, revision),
  CHECK (revision = expected_previous_revision + 1),
  CHECK (
    (status = 'gap' AND quantity IS NULL) OR
    (status != 'gap' AND typeof(quantity) = 'text' AND length(quantity) <= 78 AND
      (quantity = '0' OR (quantity GLOB '[1-9]*' AND quantity NOT GLOB '*[^0-9]*')))
  )
);

CREATE INDEX usage_versions_snapshot_idx
  ON usage_versions(fact_id, acceptance_seq DESC);

CREATE TRIGGER usage_version_immutable_update
BEFORE UPDATE ON usage_versions
BEGIN
  SELECT RAISE(ABORT, 'usage revisions are append only');
END;

CREATE TRIGGER usage_version_immutable_delete
BEFORE DELETE ON usage_versions
BEGIN
  SELECT RAISE(ABORT, 'usage revisions are append only');
END;
