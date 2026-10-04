-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE operations_lifecycle (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 23 AND substr(id, 1, 3) = 'op_' AND NOT substr(id, 4) GLOB '*[^a-z0-9]*'),
  kind TEXT NOT NULL CHECK (kind IN ('database.create', 'database.delete', 'database.resize', 'database.suspend', 'database.resume', 'database.hibernate', 'database.wake')),
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

INSERT INTO operations_lifecycle (id,kind,status,project_id,database_id,generation,error_code,error_message,created_at,updated_at,completed_at) SELECT id,kind,status,project_id,database_id,generation,error_code,error_message,created_at,updated_at,completed_at FROM operations;
DROP TABLE operations;
ALTER TABLE operations_lifecycle RENAME TO operations;
CREATE INDEX operations_status_updated_idx ON operations(status, updated_at);
CREATE INDEX operations_database_idx ON operations(database_id, created_at DESC);

CREATE UNIQUE INDEX operations_resize_generation_idx ON operations(database_id,generation) WHERE kind='database.resize';

CREATE UNIQUE INDEX operations_power_generation_idx ON operations(database_id,generation) WHERE kind IN ('database.suspend','database.resume','database.hibernate','database.wake');
ALTER TABLE databases ADD COLUMN suspension_reason TEXT CHECK(suspension_reason IN ('manual','idle'));
ALTER TABLE databases ADD COLUMN observed_power TEXT NOT NULL DEFAULT 'awake' CHECK(observed_power IN ('awake','hibernated'));
ALTER TABLE databases ADD COLUMN power_operation TEXT CHECK(power_operation IS NULL OR (length(power_operation)=23 AND substr(power_operation,1,3)='op_' AND NOT substr(power_operation,4) GLOB '*[^a-z0-9]*'));
-- Legacy suspended rows have no verified power observation. Give them a real manual intent.
INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at)
SELECT 'op_'||lower(hex(randomblob(10))),'database.suspend','pending',project_id,id,generation+1,updated_at,updated_at FROM databases WHERE desired_state='suspended';
UPDATE databases SET suspension_reason='manual',generation=generation+1,power_operation=(SELECT id FROM operations WHERE database_id=databases.id AND kind='database.suspend' AND generation=databases.generation+1) WHERE desired_state='suspended';
