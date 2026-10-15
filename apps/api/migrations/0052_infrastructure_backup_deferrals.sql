-- SPDX-License-Identifier: Apache-2.0
-- Expand only: a new table; no backfill and no rebuild of an existing table.
-- A daily attempt that is due but held back (a fleet patch is running, or a thin database start is
-- in flight) is not an attempt: it takes no attempt number and never counts against the day's
-- attempts. The minute Cron keeps one row per UTC day and reason with its first and latest check.
CREATE TABLE infrastructure_backup_deferrals (
  day TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN('deferred_by_patch','deferred_by_thin_start')),
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  checks INTEGER NOT NULL CHECK(checks>=1),
  PRIMARY KEY(day,reason)
) STRICT;
