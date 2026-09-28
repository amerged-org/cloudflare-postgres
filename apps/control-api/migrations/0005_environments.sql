CREATE TABLE region_catalogs (
  region_id TEXT NOT NULL REFERENCES regions(id),
  version TEXT NOT NULL,
  profiles_json TEXT NOT NULL,
  catalog_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (region_id, version)
);

CREATE TRIGGER region_catalogs_immutable_update
BEFORE UPDATE ON region_catalogs
BEGIN
  SELECT RAISE(ABORT, 'region catalog is immutable');
END;

CREATE TRIGGER region_catalogs_immutable_delete
BEFORE DELETE ON region_catalogs
BEGIN
  SELECT RAISE(ABORT, 'region catalog is immutable');
END;

CREATE TABLE region_admission (
  region_id TEXT PRIMARY KEY REFERENCES regions(id),
  catalog_version TEXT NOT NULL,
  accepting_new_environments INTEGER NOT NULL DEFAULT 0
    CHECK (accepting_new_environments IN (0, 1)),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (region_id, catalog_version) REFERENCES region_catalogs(region_id, version)
);

CREATE TABLE environments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  region_id TEXT NOT NULL,
  catalog_version TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'provisioning', 'ready', 'failed')),
  spec_revision INTEGER NOT NULL CHECK (spec_revision = 1),
  spec_hash TEXT NOT NULL,
  resolved_spec TEXT NOT NULL,
  created_at TEXT NOT NULL,
  observed_at TEXT,
  observation_json TEXT,
  UNIQUE (id, organization_id, project_id),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id),
  FOREIGN KEY (region_id, catalog_version) REFERENCES region_catalogs(region_id, version)
);

CREATE INDEX environments_project_created_id_idx
  ON environments(organization_id, project_id, created_at DESC, id DESC);

CREATE TRIGGER environments_immutable_spec
BEFORE UPDATE OF id, organization_id, project_id, region_id, catalog_version,
  profile_id, name, spec_revision, spec_hash, resolved_spec, created_at ON environments
BEGIN
  SELECT RAISE(ABORT, 'environment spec is immutable');
END;

ALTER TABLE operations ADD COLUMN environment_id TEXT REFERENCES environments(id);
ALTER TABLE operations ADD COLUMN region_id TEXT REFERENCES regions(id);
ALTER TABLE operations ADD COLUMN lease_token_hash TEXT;
ALTER TABLE operations ADD COLUMN lease_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE operations ADD COLUMN lease_expires_at TEXT;
ALTER TABLE operations ADD COLUMN result_hash TEXT;
ALTER TABLE operations ADD COLUMN observation_json TEXT;

CREATE INDEX operations_regional_claim_idx
  ON operations(region_id, status, lease_expires_at, created_at, id)
  WHERE kind = 'environment.create';

CREATE TRIGGER environment_operation_ownership
BEFORE INSERT ON operations WHEN NEW.kind = 'environment.create'
BEGIN
  SELECT RAISE(ABORT, 'environment operation ownership mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM environments
    WHERE id = NEW.environment_id
      AND organization_id = NEW.organization_id
      AND project_id = NEW.project_id
      AND region_id = NEW.region_id
  );
END;

CREATE TRIGGER environment_operation_immutable_identity
BEFORE UPDATE OF environment_id, organization_id, project_id, region_id, kind ON operations
WHEN OLD.kind = 'environment.create'
BEGIN
  SELECT RAISE(ABORT, 'environment operation identity is immutable');
END;

CREATE TABLE environment_requests (
  organization_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, idempotency_key),
  FOREIGN KEY (environment_id, organization_id, project_id)
    REFERENCES environments(id, organization_id, project_id),
  FOREIGN KEY (operation_id, organization_id) REFERENCES operations(id, organization_id)
);
