-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE operations_restore (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 23 AND substr(id, 1, 3) = 'op_' AND NOT substr(id, 4) GLOB '*[^a-z0-9]*'),
  kind TEXT NOT NULL CHECK (kind IN ('database.create', 'database.delete', 'database.resize', 'database.suspend', 'database.resume', 'database.hibernate', 'database.wake', 'database.restore')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  project_id TEXT NOT NULL REFERENCES projects(id),
  database_id TEXT NOT NULL REFERENCES databases(id),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 64),
  error_message TEXT CHECK (error_message IS NULL OR length(error_message) <= 4096),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(created_at, 1, 4) || substr(created_at, 6, 2) || substr(created_at, 9, 2)
        || substr(created_at, 12, 2) || substr(created_at, 15, 2) || substr(created_at, 18, 2)
        || substr(created_at, 21, 3)) NOT GLOB '*[^0-9]*'),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(updated_at, 1, 4) || substr(updated_at, 6, 2) || substr(updated_at, 9, 2)
        || substr(updated_at, 12, 2) || substr(updated_at, 15, 2) || substr(updated_at, 18, 2)
        || substr(updated_at, 21, 3)) NOT GLOB '*[^0-9]*'),
  completed_at TEXT,
  CHECK ((status IN ('succeeded', 'failed')) = (completed_at IS NOT NULL)),
  CHECK (status = 'failed' OR (error_code IS NULL AND error_message IS NULL))
);

INSERT INTO operations_restore (id,kind,status,project_id,database_id,generation,error_code,error_message,created_at,updated_at,completed_at) SELECT id,kind,status,project_id,database_id,generation,error_code,error_message,created_at,updated_at,completed_at FROM operations;
DROP TABLE operations;
ALTER TABLE operations_restore RENAME TO operations;
CREATE INDEX operations_status_updated_idx ON operations(status, updated_at);
CREATE INDEX operations_database_idx ON operations(database_id, created_at DESC);

CREATE UNIQUE INDEX operations_resize_generation_idx ON operations(database_id,generation) WHERE kind='database.resize';

CREATE UNIQUE INDEX operations_power_generation_idx ON operations(database_id,generation) WHERE kind IN ('database.suspend','database.resume','database.hibernate','database.wake');

ALTER TABLE databases ADD COLUMN storage_generation INTEGER NOT NULL DEFAULT 1 CHECK(storage_generation>=1);
CREATE TABLE retained_archives (
 source_database_id TEXT PRIMARY KEY NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
 project_id TEXT NOT NULL REFERENCES projects(id), region_id TEXT NOT NULL REFERENCES regions(id),
 archive_path TEXT NOT NULL, storage_generation INTEGER NOT NULL CHECK(storage_generation>=1),
 roles_json TEXT NOT NULL CHECK(json_valid(roles_json)),
 deleted_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK(expires_at>deleted_at),
 cleanup_claim TEXT, CHECK(cleanup_claim IS NULL OR length(cleanup_claim)=36)
);
CREATE INDEX retained_archives_expiry_idx ON retained_archives(expires_at,source_database_id);
CREATE TABLE database_restores (
 target_database_id TEXT PRIMARY KEY NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
 operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE CASCADE,
 source_database_id TEXT NOT NULL REFERENCES databases(id),
 source_archive_path TEXT NOT NULL, source_storage_generation INTEGER NOT NULL CHECK(source_storage_generation>=1),
 backup_id TEXT NOT NULL CHECK(length(backup_id)=15), target_time TEXT,
 verified_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX database_restores_source_idx ON database_restores(source_database_id);
INSERT INTO retained_archives(source_database_id,project_id,region_id,archive_path,storage_generation,roles_json,deleted_at,expires_at)
SELECT d.id,d.project_id,d.region_id,d.archive_path,d.storage_generation,
 (SELECT json_group_array(json_object('database_id',r.database_id,'name',r.name,'owner',r.owner,'password_ciphertext',r.password_ciphertext,'password_iv',r.password_iv,'password_kid',r.password_kid,'password_revision',r.password_revision,'updated_at',r.updated_at)) FROM roles r WHERE r.database_id=d.id AND r.deleted_at IS NULL),
 d.deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ',d.deleted_at,'+'||s.backup_retention_days||' days')
FROM databases d JOIN size_classes s ON s.id=d.size_class_id WHERE d.deleted_at IS NOT NULL;
