-- SPDX-License-Identifier: Apache-2.0
-- Expand only; no backfill and no table rebuild. Every existing role keeps the defaults of a plain
-- role: no expiry, no connection limit, no membership, NOBYPASSRLS.
--
-- A role deleted through the API keeps its row as a tombstone (`deleted_at` already exists) until
-- PostgreSQL confirms the removal; only then is the row purged and the name free again.
ALTER TABLE roles ADD COLUMN valid_until TEXT
  CHECK (valid_until IS NULL OR (length(valid_until) = 24 AND valid_until GLOB '????-??-??T??:??:??.???Z'));
ALTER TABLE roles ADD COLUMN connection_limit INTEGER
  CHECK (connection_limit IS NULL OR connection_limit BETWEEN 1 AND 10000);
ALTER TABLE roles ADD COLUMN member_of_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(member_of_json) AND json_type(member_of_json) = 'array');
ALTER TABLE roles ADD COLUMN bypass_rls INTEGER NOT NULL DEFAULT 0 CHECK (bypass_rls IN (0, 1));
-- The API key that issued the role and the one that deleted it; there is no audit log.
ALTER TABLE roles ADD COLUMN created_by_key_id TEXT;
ALTER TABLE roles ADD COLUMN deleted_by_key_id TEXT;
-- The removal operation currently responsible for the tombstone.
ALTER TABLE roles ADD COLUMN delete_operation_id TEXT;

-- Deferred role changes live in pool_role_mutations until the pool holder has drained; a deferred
-- creation must carry the same attributes the immediate one would have written.
ALTER TABLE pool_role_mutations ADD COLUMN valid_until TEXT;
ALTER TABLE pool_role_mutations ADD COLUMN connection_limit INTEGER;
ALTER TABLE pool_role_mutations ADD COLUMN member_of_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE pool_role_mutations ADD COLUMN bypass_rls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pool_role_mutations ADD COLUMN created_by_key_id TEXT;

-- Operations of kind database.role.delete. They cannot live in `operations`: its kind CHECK would
-- need a rebuild of a table that other tables reference with ON DELETE CASCADE. The row has the
-- columns of an operation so that one read serves both (see operationForRequest).
CREATE TABLE role_deletions (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 23 AND substr(id, 1, 3) = 'op_' AND NOT substr(id, 4) GLOB '*[^a-z0-9]*'),
  kind TEXT NOT NULL DEFAULT 'database.role.delete' CHECK (kind = 'database.role.delete'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  project_id TEXT NOT NULL REFERENCES projects(id),
  database_id TEXT NOT NULL REFERENCES databases(id),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  role_name TEXT NOT NULL CHECK (length(role_name) BETWEEN 1 AND 63),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 64),
  error_message TEXT CHECK (error_message IS NULL OR length(error_message) <= 4096),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z'),
  completed_at TEXT,
  CHECK ((status IN ('succeeded', 'failed')) = (completed_at IS NOT NULL)),
  CHECK (status = 'failed' OR (error_code IS NULL AND error_message IS NULL))
);
-- One removal at a time per role; a finished one never blocks a retry.
CREATE UNIQUE INDEX role_deletions_open_idx ON role_deletions(database_id, role_name)
  WHERE status IN ('pending', 'running');
CREATE INDEX role_deletions_database_idx ON role_deletions(database_id, created_at DESC);
CREATE INDEX role_deletions_status_idx ON role_deletions(status, updated_at);
