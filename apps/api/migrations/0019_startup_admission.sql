-- SPDX-License-Identifier: Apache-2.0
-- An uncertain start retains its full peak-memory hold without a timeout.
-- Only bound readiness and its later memory observation acknowledge the hold.
CREATE TABLE database_start_admissions (
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation > 0),
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  node_uid TEXT NOT NULL,
  budget_bytes INTEGER NOT NULL CHECK (typeof(budget_bytes) = 'integer' AND budget_bytes BETWEEN 1 AND 9007199254740991),
  granted_at TEXT NOT NULL
    CHECK (length(granted_at) = 24 AND granted_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(granted_at, 1, 4) || substr(granted_at, 6, 2) || substr(granted_at, 9, 2)
        || substr(granted_at, 12, 2) || substr(granted_at, 15, 2) || substr(granted_at, 18, 2)
        || substr(granted_at, 21, 3)) NOT GLOB '*[^0-9]*'),
  grant_sample_observed_at TEXT NOT NULL
    CHECK (length(grant_sample_observed_at) = 24 AND grant_sample_observed_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(grant_sample_observed_at, 1, 4) || substr(grant_sample_observed_at, 6, 2) || substr(grant_sample_observed_at, 9, 2)
        || substr(grant_sample_observed_at, 12, 2) || substr(grant_sample_observed_at, 15, 2) || substr(grant_sample_observed_at, 18, 2)
        || substr(grant_sample_observed_at, 21, 3)) NOT GLOB '*[^0-9]*'),
  ready_at TEXT
    CHECK (ready_at IS NULL OR (length(ready_at) = 24 AND ready_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(ready_at, 1, 4) || substr(ready_at, 6, 2) || substr(ready_at, 9, 2)
        || substr(ready_at, 12, 2) || substr(ready_at, 15, 2) || substr(ready_at, 18, 2)
        || substr(ready_at, 21, 3)) NOT GLOB '*[^0-9]*')),
  ready_sample_observed_at TEXT
    CHECK (ready_sample_observed_at IS NULL OR (length(ready_sample_observed_at) = 24 AND ready_sample_observed_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(ready_sample_observed_at, 1, 4) || substr(ready_sample_observed_at, 6, 2) || substr(ready_sample_observed_at, 9, 2)
        || substr(ready_sample_observed_at, 12, 2) || substr(ready_sample_observed_at, 15, 2) || substr(ready_sample_observed_at, 18, 2)
        || substr(ready_sample_observed_at, 21, 3)) NOT GLOB '*[^0-9]*')),
  UNIQUE (database_id, generation),
  CHECK ((ready_at IS NULL) = (ready_sample_observed_at IS NULL))
);

CREATE INDEX database_start_admissions_node_idx ON database_start_admissions(node_id, node_uid);

CREATE TRIGGER database_start_admission_immutable BEFORE UPDATE ON database_start_admissions
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.database_id IS NOT OLD.database_id
  OR NEW.generation IS NOT OLD.generation OR NEW.node_id IS NOT OLD.node_id
  OR NEW.node_uid IS NOT OLD.node_uid OR NEW.budget_bytes IS NOT OLD.budget_bytes
  OR NEW.granted_at IS NOT OLD.granted_at OR NEW.grant_sample_observed_at IS NOT OLD.grant_sample_observed_at
  OR (OLD.ready_at IS NOT NULL AND (NEW.ready_at IS NOT OLD.ready_at OR NEW.ready_sample_observed_at IS NOT OLD.ready_sample_observed_at))
BEGIN SELECT RAISE(ABORT, 'database_start_admission_immutable'); END;
