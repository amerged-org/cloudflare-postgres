-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE reconciliation_cursors (
  name TEXT PRIMARY KEY NOT NULL CHECK (name = 'database_actors'),
  cursor TEXT CHECK (
    cursor IS NULL OR
    (length(cursor) = 20 AND substr(cursor,1,1) BETWEEN 'a' AND 'z'
     AND NOT cursor GLOB '*[^a-z0-9]*')
  )
);
