-- SPDX-License-Identifier: Apache-2.0
-- Existing events deliberately retain NULL snapshots; current size classes cannot backfill history.
ALTER TABLE lifecycle_events ADD COLUMN resource_snapshot TEXT
  CHECK (resource_snapshot IS NULL OR (json_valid(resource_snapshot) AND length(resource_snapshot) <= 1024));
CREATE TRIGGER lifecycle_events_immutable BEFORE UPDATE ON lifecycle_events
BEGIN SELECT RAISE(ABORT, 'lifecycle events are immutable'); END;

CREATE TABLE usage_samples (
  database_id TEXT NOT NULL REFERENCES databases(id),
  source TEXT NOT NULL CHECK (source IN ('agent', 'gateway', 'backup')),
  producer_id TEXT NOT NULL CHECK (length(producer_id) BETWEEN 1 AND 128),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  interval_start TEXT NOT NULL,
  interval_end TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload) AND length(payload) <= 8192),
  PRIMARY KEY (database_id, source, producer_id, sequence)
);
CREATE INDEX usage_samples_window_idx ON usage_samples(database_id, interval_start, interval_end);
CREATE TRIGGER usage_samples_immutable BEFORE UPDATE ON usage_samples
BEGIN SELECT RAISE(ABORT, 'usage samples are immutable'); END;

CREATE TABLE usage_revisions (
  database_id TEXT PRIMARY KEY NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0)
);
CREATE TRIGGER usage_lifecycle_insert AFTER INSERT ON lifecycle_events BEGIN
  INSERT INTO usage_revisions(database_id,revision) VALUES(NEW.database_id,1)
  ON CONFLICT(database_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER usage_lifecycle_delete AFTER DELETE ON lifecycle_events BEGIN
  INSERT INTO usage_revisions(database_id,revision) VALUES(OLD.database_id,1)
  ON CONFLICT(database_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER usage_samples_insert AFTER INSERT ON usage_samples BEGIN
  INSERT INTO usage_revisions(database_id,revision) VALUES(NEW.database_id,1)
  ON CONFLICT(database_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER usage_samples_delete AFTER DELETE ON usage_samples BEGIN
  INSERT INTO usage_revisions(database_id,revision) VALUES(OLD.database_id,1)
  ON CONFLICT(database_id) DO UPDATE SET revision=revision+1;
END;

CREATE TABLE usage_hourly (
  database_id TEXT NOT NULL REFERENCES databases(id),
  hour TEXT NOT NULL,
  metrics TEXT NOT NULL CHECK (json_valid(metrics) AND length(metrics) <= 4096),
  gaps TEXT NOT NULL CHECK (json_valid(gaps) AND length(gaps) <= 2048),
  final INTEGER NOT NULL CHECK (final IN (0, 1)),
  computed_at TEXT NOT NULL,
  PRIMARY KEY (database_id, hour)
);
CREATE INDEX usage_hourly_hour_idx ON usage_hourly(hour, database_id);
