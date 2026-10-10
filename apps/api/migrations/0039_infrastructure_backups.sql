-- SPDX-License-Identifier: Apache-2.0
-- One operator-configured daily control-plane backup, using existing R2 buckets.
CREATE TABLE infrastructure_backup_config (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),
  d1_account_id TEXT,
  d1_database_id TEXT,
  d1_region_id TEXT REFERENCES regions(id),
  notification_recipient TEXT,
  notification_sender TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  enabled_at TEXT,
  updated_at TEXT
) STRICT;
INSERT INTO infrastructure_backup_config(singleton) VALUES(1);
CREATE TABLE infrastructure_backup_runs (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL UNIQUE,
  config_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN('pending','running','complete','failed')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  expires_at TEXT NOT NULL,
  error_code TEXT
) STRICT;
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
CREATE INDEX infrastructure_backup_health_idx ON infrastructure_backup_artifacts(kind,region_id,completed_at);
ALTER TABLE infrastructure_alerts RENAME TO infrastructure_alerts_previous;
CREATE TABLE infrastructure_alerts (
  region_id TEXT NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN('regional_ram_warning','regional_node_cap_reached','regional_node_stale','infrastructure_backup_failed','infrastructure_backup_stale')),
  active INTEGER NOT NULL CHECK(active IN(0,1)),
  event_id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(payload)<=4096),
  delivered_at TEXT,
  last_attempt_at TEXT,
  PRIMARY KEY(region_id,kind)
) STRICT;
INSERT INTO infrastructure_alerts SELECT * FROM infrastructure_alerts_previous;
DROP TABLE infrastructure_alerts_previous;
