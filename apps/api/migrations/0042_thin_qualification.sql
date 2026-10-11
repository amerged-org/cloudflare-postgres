-- SPDX-License-Identifier: Apache-2.0
-- A fenced scratch qualification run; only a completed run can back a release thin receipt.
CREATE TABLE thin_storage_qualification_runs (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 23 AND substr(id, 1, 3) = 'op_' AND NOT substr(id, 4) GLOB '*[^a-z0-9]*'),
  -- Evidence outlives node rows; a release receipt is not tied to the node's later lifecycle.
  node_id TEXT NOT NULL
    CHECK (length(node_id) = 24 AND substr(node_id, 1, 4) = 'nod_' AND NOT substr(node_id, 5) GLOB '*[^a-z0-9]*'),
  region_id TEXT NOT NULL,
  node_uid TEXT NOT NULL,
  cluster_uid TEXT NOT NULL,
  address TEXT NOT NULL,
  release_id TEXT NOT NULL REFERENCES fleet_releases(id),
  spec_sha256 TEXT NOT NULL CHECK (length(spec_sha256) = 64 AND spec_sha256 NOT GLOB '*[^a-f0-9]*'),
  assignment_revision INTEGER NOT NULL CHECK (assignment_revision > 0),
  region_revision INTEGER NOT NULL CHECK (region_revision > 0),
  material_revision INTEGER NOT NULL CHECK (material_revision > 0),
  profile_json TEXT NOT NULL CHECK (json_valid(profile_json)),
  profile_sha256 TEXT NOT NULL CHECK (length(profile_sha256) = 64 AND profile_sha256 NOT GLOB '*[^a-f0-9]*'),
  driver_image TEXT NOT NULL,
  host_extension_image TEXT NOT NULL,
  postgres_image TEXT NOT NULL,
  kernel_version TEXT,
  setup_json TEXT CHECK (setup_json IS NULL OR json_valid(setup_json)),
  gates_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(gates_json)),
  cleanup_json TEXT CHECK (cleanup_json IS NULL OR json_valid(cleanup_json)),
  journal_json TEXT NOT NULL DEFAULT '{"revision":0,"entries":[]}' CHECK (json_valid(journal_json)),
  step TEXT NOT NULL CHECK (step IN ('setup', 'data_full', 'metadata_full', 'noflush_quiescence', 'resume_marker',
    'startup_bound', 'trim_delete_recreate', 'retained_thick_preservation', 'cleanup', 'complete')),
  status TEXT NOT NULL CHECK (status IN ('running', 'failed', 'completed')),
  error_code TEXT,
  lease_id TEXT,
  lease_revision INTEGER NOT NULL DEFAULT 0 CHECK (lease_revision >= 0),
  lease_expires_at TEXT,
  receipt_sha256 TEXT UNIQUE
    CHECK (receipt_sha256 IS NULL OR (length(receipt_sha256) = 64 AND receipt_sha256 NOT GLOB '*[^a-f0-9]*')),
  qualified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((status = 'completed') = (receipt_sha256 IS NOT NULL)),
  CHECK (status <> 'completed' OR (step = 'complete' AND error_code IS NULL AND qualified_at IS NOT NULL
    AND kernel_version IS NOT NULL AND setup_json IS NOT NULL AND cleanup_json IS NOT NULL)),
  CHECK (status = 'running' OR (lease_id IS NULL AND completed_at IS NOT NULL))
) STRICT;

-- One scratch run per node; its pool, LVs and namespace exist until cleanup reports.
CREATE UNIQUE INDEX thin_storage_qualification_running_node
  ON thin_storage_qualification_runs(node_id) WHERE status = 'running';

-- Terminal evidence and produced receipts never change.
CREATE TRIGGER thin_storage_qualification_terminal BEFORE UPDATE ON thin_storage_qualification_runs
WHEN OLD.status <> 'running'
BEGIN SELECT RAISE(ABORT, 'thin_storage_qualification_terminal'); END;

-- Product thin selection never shares a node with an unfinished scratch run.
CREATE TRIGGER thin_storage_qualification_excludes_selection BEFORE INSERT ON node_thin_storage
WHEN EXISTS (SELECT 1 FROM thin_storage_qualification_runs q WHERE q.node_id = NEW.node_id AND q.status = 'running')
BEGIN SELECT RAISE(ABORT, 'thin_storage_qualification_running'); END;
