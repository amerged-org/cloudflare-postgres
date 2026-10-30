-- SPDX-License-Identifier: Apache-2.0
-- What a database's schedules, events and webhook deliveries did in each hour. Each database's
-- TriggerActor counts in its own storage and writes a closed hour here once (an absolute value, so
-- a repeated write is harmless). A database and hour without a row had no executions.
CREATE TABLE execution_usage (
  database_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  hour_start TEXT NOT NULL CHECK(length(hour_start)=24 AND hour_start GLOB '*:00:00.000Z'),
  metric TEXT NOT NULL CHECK(metric IN(
    'schedule_runs_succeeded','schedule_runs_failed','schedule_runs_timed_out',
    'schedule_runs_outcome_unknown','schedule_runs_rejected','schedule_runs_skipped',
    'events_emitted','event_bytes',
    'webhook_attempts','webhook_deliveries_delivered','webhook_deliveries_dead_lettered')),
  value INTEGER NOT NULL CHECK(value>=0),
  PRIMARY KEY(database_id, hour_start, metric)
) STRICT;
CREATE INDEX execution_usage_project ON execution_usage(project_id, hour_start);
