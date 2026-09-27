CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX api_tokens_organization_idx ON api_tokens(organization_id);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (id, organization_id)
);

CREATE INDEX projects_organization_idx ON projects(organization_id);

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (id, organization_id),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id)
);

CREATE INDEX operations_organization_idx ON operations(organization_id);

CREATE TABLE idempotency_requests (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  project_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, idempotency_key),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id),
  FOREIGN KEY (operation_id, organization_id) REFERENCES operations(id, organization_id)
);
