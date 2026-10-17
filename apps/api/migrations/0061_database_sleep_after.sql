-- SPDX-License-Identifier: Apache-2.0
-- Contract: a database may set its own idle time before it sleeps. NULL leaves it to its size
-- class, and a class without one is always warm.
ALTER TABLE databases ADD COLUMN sleep_after_seconds INTEGER
  CHECK (sleep_after_seconds IS NULL OR sleep_after_seconds BETWEEN 60 AND 900);
