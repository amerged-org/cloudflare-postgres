-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE power_timeout_cursor (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  database_id TEXT
);
