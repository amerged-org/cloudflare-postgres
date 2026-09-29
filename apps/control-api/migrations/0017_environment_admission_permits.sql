-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE environment_admission_permits (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  region_id TEXT NOT NULL,
  catalog_version TEXT NOT NULL,
  binding_json TEXT NOT NULL CHECK (json_valid(binding_json) AND json_type(binding_json) = 'object'),
  spec_hash TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > issued_at),
  consumed_environment_id TEXT UNIQUE REFERENCES environments(id),
  consumed_operation_id TEXT UNIQUE REFERENCES operations(id),
  consumed_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id),
  FOREIGN KEY (region_id, catalog_version) REFERENCES region_catalogs(region_id, version),
  CHECK ((consumed_environment_id IS NULL AND consumed_operation_id IS NULL AND consumed_at IS NULL)
    OR (consumed_environment_id IS NOT NULL AND consumed_operation_id IS NOT NULL AND consumed_at IS NOT NULL AND revoked_at IS NULL))
);
CREATE TRIGGER admission_permit_immutable
BEFORE UPDATE OF id, organization_id, project_id, region_id, catalog_version,
  binding_json, spec_hash, issued_at, expires_at ON environment_admission_permits
BEGIN
  SELECT RAISE(ABORT, 'admission permit binding is immutable');
END;
CREATE TRIGGER admission_permit_terminal
BEFORE UPDATE OF consumed_environment_id, consumed_operation_id, consumed_at, revoked_at ON environment_admission_permits
BEGIN
  SELECT RAISE(ABORT, 'admission permit is terminal')
  WHERE OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL;
  SELECT RAISE(ABORT, 'admission permit consumption mismatch')
  WHERE NEW.consumed_at IS NOT NULL AND (
    NEW.consumed_at < OLD.issued_at OR NEW.consumed_at >= OLD.expires_at OR NOT EXISTS (
      SELECT 1 FROM environments e JOIN operations o ON o.environment_id=e.id
      JOIN region_catalogs c ON c.region_id=e.region_id AND c.version=e.catalog_version
      WHERE e.id=NEW.consumed_environment_id AND o.id=NEW.consumed_operation_id
        AND e.organization_id=OLD.organization_id AND e.project_id=OLD.project_id
        AND e.region_id=OLD.region_id AND e.catalog_version=OLD.catalog_version
        AND e.spec_hash=OLD.spec_hash AND e.name=json_extract(OLD.binding_json,'$.name')
        AND e.profile_id=json_extract(OLD.binding_json,'$.profileId')
        AND json_extract(e.resolved_spec,'$.volumeGiB')=json_extract(OLD.binding_json,'$.volumeGiB')
        AND c.catalog_hash=json_extract(OLD.binding_json,'$.catalogHash')
        AND o.kind='environment.create' AND o.organization_id=e.organization_id
        AND o.project_id=e.project_id AND o.region_id=e.region_id
    )
  );
END;
CREATE TRIGGER admission_permit_no_delete
BEFORE DELETE ON environment_admission_permits
BEGIN
  SELECT RAISE(ABORT, 'admission permit is retained');
END;
CREATE TABLE admission_permit_requests (
  idempotency_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('issue', 'revoke')),
  permit_id TEXT NOT NULL REFERENCES environment_admission_permits(id),
  created_at TEXT NOT NULL
);
CREATE TRIGGER admission_permit_request_no_update
BEFORE UPDATE ON admission_permit_requests
BEGIN
  SELECT RAISE(ABORT, 'admission permit replay is immutable');
END;
CREATE TRIGGER admission_permit_request_no_delete
BEFORE DELETE ON admission_permit_requests
BEGIN
  SELECT RAISE(ABORT, 'admission permit replay is retained');
END;
