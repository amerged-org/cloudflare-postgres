CREATE TABLE regions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('registered', 'active', 'disabled')),
  created_at TEXT NOT NULL
);

CREATE INDEX regions_created_id_idx
  ON regions(created_at DESC, id DESC);

CREATE UNIQUE INDEX regions_name_unique_idx
  ON regions(name COLLATE BINARY);

CREATE TABLE region_tokens (
  id TEXT PRIMARY KEY,
  region_id TEXT NOT NULL REFERENCES regions(id),
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE UNIQUE INDEX region_tokens_active_region_idx
  ON region_tokens(region_id) WHERE revoked_at IS NULL;
