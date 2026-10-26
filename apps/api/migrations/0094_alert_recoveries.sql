-- SPDX-License-Identifier: Apache-2.0
-- Keep recoveries separately: a recurrent failure must not erase an undelivered recovery.
ALTER TABLE infrastructure_alerts ADD COLUMN resolved_at TEXT;
CREATE TABLE infrastructure_alert_recoveries (
  region_id TEXT NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  event_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(payload)<=4096),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active=1),
  fanout_initialized INTEGER NOT NULL DEFAULT 1 CHECK(fanout_initialized=1),
  announced INTEGER NOT NULL DEFAULT 0 CHECK(announced IN(0,1)),
  delivered_at TEXT,
  last_attempt_at TEXT,
  PRIMARY KEY(region_id,kind,event_id,occurred_at)
) STRICT;
CREATE TABLE infrastructure_alert_recovery_deliveries (
  region_id TEXT NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  event_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN('webhook','email')),
  recipient TEXT,
  delivered_at TEXT,
  last_attempt_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,
  last_error TEXT,
  PRIMARY KEY(region_id,kind,event_id,occurred_at,destination_id)
) STRICT;
CREATE TRIGGER infrastructure_alert_recovery AFTER UPDATE OF active ON infrastructure_alerts
WHEN OLD.active=1 AND NEW.active=0 AND NEW.resolved_at IS NOT NULL
BEGIN
  INSERT INTO infrastructure_alert_recoveries(region_id,kind,event_id,occurred_at,announced,payload)
  VALUES(OLD.region_id,OLD.kind,OLD.event_id,NEW.resolved_at,OLD.delivered_at IS NOT NULL,
    json_set(OLD.payload,'$.state','resolved','$.episode_started_at',json_extract(OLD.payload,'$.occurred_at'),
      '$.occurred_at',NEW.resolved_at))
  ON CONFLICT(region_id,kind,event_id,occurred_at) DO NOTHING;
END;
