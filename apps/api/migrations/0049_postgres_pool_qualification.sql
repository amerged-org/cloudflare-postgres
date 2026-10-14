-- SPDX-License-Identifier: Apache-2.0
-- Test authority is scoped to one existing thin database and one immutable candidate.
-- Evidence outlives the node/database; those identifiers intentionally are not cascading FKs.
CREATE TABLE postgres_pool_qualification_runs (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),
  region_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  node_uid TEXT NOT NULL CHECK(length(node_uid)=36),
  boot_id TEXT NOT NULL CHECK(length(boot_id)=36),
  database_id TEXT NOT NULL,
  database_generation INTEGER NOT NULL CHECK(database_generation>0),
  candidate_release_id TEXT NOT NULL REFERENCES fleet_releases(id),
  candidate_spec_sha256 TEXT NOT NULL CHECK(length(candidate_spec_sha256)=64 AND candidate_spec_sha256 NOT GLOB '*[^a-f0-9]*'),
  scope_sha256 TEXT NOT NULL CHECK(length(scope_sha256)=64 AND scope_sha256 NOT GLOB '*[^a-f0-9]*'),
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
  status TEXT NOT NULL CHECK(status IN('running','cleanup','completed','failed')),
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(evidence_json)),
  cleanup_json TEXT CHECK(cleanup_json IS NULL OR json_valid(cleanup_json)),
  error_code TEXT,
  receipt_sha256 TEXT UNIQUE CHECK(receipt_sha256 IS NULL OR (length(receipt_sha256)=64 AND receipt_sha256 NOT GLOB '*[^a-f0-9]*')),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
  expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
  completed_at INTEGER CHECK(completed_at IS NULL OR completed_at>=created_at),
  CHECK((status IN('completed','failed'))=(completed_at IS NOT NULL)),
  CHECK((status='completed')=(receipt_sha256 IS NOT NULL)),
  CHECK(status NOT IN('completed','failed') OR cleanup_json IS NOT NULL),
  CHECK(status<>'completed' OR error_code IS NULL),
  CHECK(status<>'failed' OR error_code IS NOT NULL)
) STRICT;

-- Expiration removes permission, but never claims that a mounted volume has been released.
CREATE UNIQUE INDEX postgres_pool_qualification_active_node
  ON postgres_pool_qualification_runs(node_id) WHERE status IN('running','cleanup');
CREATE UNIQUE INDEX postgres_pool_qualification_active_database
  ON postgres_pool_qualification_runs(database_id) WHERE status IN('running','cleanup');

CREATE TRIGGER postgres_pool_qualification_scope_immutable
BEFORE UPDATE ON postgres_pool_qualification_runs WHEN
  NEW.id IS NOT OLD.id OR NEW.region_id IS NOT OLD.region_id OR NEW.node_id IS NOT OLD.node_id
  OR NEW.node_uid IS NOT OLD.node_uid OR NEW.boot_id IS NOT OLD.boot_id
  OR NEW.database_id IS NOT OLD.database_id OR NEW.database_generation IS NOT OLD.database_generation
  OR NEW.candidate_release_id IS NOT OLD.candidate_release_id OR NEW.candidate_spec_sha256 IS NOT OLD.candidate_spec_sha256
  OR NEW.scope_sha256 IS NOT OLD.scope_sha256 OR NEW.scope_json IS NOT OLD.scope_json
  OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
BEGIN SELECT RAISE(ABORT,'pool_qualification_scope_immutable'); END;

CREATE TRIGGER postgres_pool_qualification_forward_state
BEFORE UPDATE OF status ON postgres_pool_qualification_runs WHEN NEW.status<>OLD.status AND NOT(
  (OLD.status='running' AND NEW.status='cleanup')
  OR (OLD.status='cleanup' AND NEW.status IN('completed','failed')))
BEGIN SELECT RAISE(ABORT,'pool_qualification_state_cannot_move_backwards'); END;

CREATE TRIGGER postgres_pool_qualification_terminal
BEFORE UPDATE ON postgres_pool_qualification_runs WHEN OLD.status IN('completed','failed')
BEGIN SELECT RAISE(ABORT,'pool_qualification_terminal'); END;
