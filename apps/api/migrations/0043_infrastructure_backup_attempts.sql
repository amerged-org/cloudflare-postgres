-- SPDX-License-Identifier: Apache-2.0
-- A failed UTC day may be retried: runs are unique per day and attempt; existing runs are attempt 1.
-- Renaming the runs repoints the artifacts' foreign key to the previous table, so the artifacts are
-- copied into a table that references the new runs before either previous table is dropped.
ALTER TABLE infrastructure_backup_runs RENAME TO infrastructure_backup_runs_previous;
CREATE TABLE infrastructure_backup_runs (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK(attempt>=1),
  config_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN('pending','running','complete','failed')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  expires_at TEXT NOT NULL,
  error_code TEXT,
  UNIQUE(day,attempt)
) STRICT;
INSERT INTO infrastructure_backup_runs(id,day,attempt,config_revision,status,created_at,completed_at,expires_at,error_code)
  SELECT id,day,1,config_revision,status,created_at,completed_at,expires_at,error_code FROM infrastructure_backup_runs_previous;
ALTER TABLE infrastructure_backup_artifacts RENAME TO infrastructure_backup_artifacts_previous;
CREATE TABLE infrastructure_backup_artifacts (
  run_id TEXT NOT NULL REFERENCES infrastructure_backup_runs(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN('etcd','d1')),
  day TEXT NOT NULL,
  region_id TEXT NOT NULL REFERENCES regions(id),
  source_id TEXT NOT NULL,
  node_id TEXT,
  node_uid TEXT,
  cluster_uid TEXT,
  material_revision INTEGER,
  status TEXT NOT NULL CHECK(status IN('pending','prepared','complete','failed')),
  completed_at TEXT,
  error_code TEXT,
  object_key TEXT NOT NULL UNIQUE,
  kid TEXT,
  plaintext_sha256 TEXT,
  plaintext_bytes INTEGER,
  encrypted_sha256 TEXT,
  encrypted_bytes INTEGER,
  PRIMARY KEY(run_id,id)
) STRICT;
INSERT INTO infrastructure_backup_artifacts SELECT * FROM infrastructure_backup_artifacts_previous;
DROP TABLE infrastructure_backup_artifacts_previous;
DROP TABLE infrastructure_backup_runs_previous;
CREATE INDEX infrastructure_backup_health_idx ON infrastructure_backup_artifacts(kind,region_id,completed_at);
