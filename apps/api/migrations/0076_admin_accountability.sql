-- SPDX-License-Identifier: Apache-2.0
-- Contract: an API key may expire, and a read-only administrator scope exists (`admin_read`: the
-- administrator's reads, nothing that changes). The CHECK on `scope` cannot be widened in place, so
-- `api_keys` is rebuilt as 0017 rebuilt `node_additions`: the new table is filled from the old one,
-- the old one is dropped and the new one takes its name. `idempotency_keys` references `api_keys` by
-- name, which is why the new table is renamed to `api_keys` and the old one is never renamed away:
-- renaming the old table would repoint that foreign key at the dropped copy. Deferring the foreign
-- keys to the commit lets the rows of `idempotency_keys` outlive the drop; they find their key again
-- before the migration ends. Every existing key keeps its identity, hash and history, and none of
-- them expires (`expires_at` is NULL).
PRAGMA defer_foreign_keys = ON;
CREATE TABLE api_keys_next (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 24 AND substr(id, 1, 4) = 'key_' AND NOT substr(id, 5) GLOB '*[^a-z0-9]*'),
  lookup_id TEXT NOT NULL UNIQUE
    CHECK (length(lookup_id) = 12 AND NOT lookup_id GLOB '*[^a-z0-9]*'),
  key_hash TEXT NOT NULL UNIQUE
    CHECK (length(key_hash) = 64 AND NOT key_hash GLOB '*[^0-9a-f]*'),
  scope TEXT NOT NULL CHECK (scope IN ('admin', 'admin_read', 'integrator')),
  project_id TEXT REFERENCES projects(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(created_at, 1, 4) || substr(created_at, 6, 2) || substr(created_at, 9, 2)
        || substr(created_at, 12, 2) || substr(created_at, 15, 2) || substr(created_at, 18, 2)
        || substr(created_at, 21, 3)) NOT GLOB '*[^0-9]*'),
  last_used_at TEXT,
  revoked_at TEXT,
  -- From this instant the key is refused like a revoked one; NULL never expires.
  expires_at TEXT
    CHECK (expires_at IS NULL OR (length(expires_at) = 24 AND expires_at GLOB '????-??-??T??:??:??.???Z')),
  CHECK ((scope IN ('admin', 'admin_read') AND project_id IS NULL) OR (scope = 'integrator' AND project_id IS NOT NULL))
);
INSERT INTO api_keys_next(id, lookup_id, key_hash, scope, project_id, name, created_at, last_used_at, revoked_at)
SELECT id, lookup_id, key_hash, scope, project_id, name, created_at, last_used_at, revoked_at FROM api_keys;
DROP TABLE api_keys;
ALTER TABLE api_keys_next RENAME TO api_keys;
CREATE INDEX api_keys_created_idx ON api_keys(created_at DESC, id DESC);
CREATE INDEX api_keys_project_idx ON api_keys(project_id) WHERE project_id IS NOT NULL;
PRAGMA defer_foreign_keys = OFF;

-- Contract: one row per request that an administrator key (`admin` or `admin_read`) made with a
-- method other than GET or HEAD, written before the request runs and completed with its status
-- afterwards, and one row per refusal (401) of a revoked or an expired administrator key presented
-- with its real secret; a wrong secret is not recorded, because the lookup identifier is not secret
-- and anyone could otherwise grow the table. `status` is NULL until the answer is
-- known, and stays NULL when it could not be written or the Worker stopped first; the change may
-- then have happened. `route` is the route template (`/v1/api-keys/{id}`), never the path asked
-- for. No body, query, key material or address is kept, and `key_id` carries no foreign key: a row
-- outlives whatever happens to its key. A row older than 90 days is not listed, and the next row
-- written (a change, or a refused administrator key) deletes it: the minute cron has no statement
-- to spare.
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  key_id TEXT NOT NULL CHECK (length(key_id) = 24 AND substr(key_id, 1, 4) = 'key_'),
  scope TEXT NOT NULL CHECK (scope IN ('admin', 'admin_read')),
  method TEXT NOT NULL CHECK (method IN ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE')),
  route TEXT NOT NULL CHECK (length(route) BETWEEN 1 AND 200),
  status INTEGER CHECK (status IS NULL OR status BETWEEN 100 AND 599),
  request_id TEXT NOT NULL
    CHECK (length(request_id) BETWEEN 1 AND 128 AND NOT request_id GLOB '*[^A-Za-z0-9._~-]*'),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z')
) STRICT;
CREATE INDEX audit_events_created_idx ON audit_events(created_at DESC, id DESC);
