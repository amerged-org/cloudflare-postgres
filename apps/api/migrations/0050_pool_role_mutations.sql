-- SPDX-License-Identifier: Apache-2.0
-- Preserve operations/startup-admission foreign keys; deferred credentials stay encrypted.
CREATE TABLE pool_role_mutations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN('database.role.create','database.role.reset_password')),
  status TEXT NOT NULL CHECK(status IN('pending','running','succeeded','failed')),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK(generation>0),
  expected_generation INTEGER NOT NULL CHECK(expected_generation>0),
  binding_id TEXT NOT NULL REFERENCES pool_bindings(id),
  resume_operation_id TEXT REFERENCES operations(id),
  holder_revision INTEGER NOT NULL CHECK(holder_revision>0),
  name TEXT NOT NULL,
  expected_password_revision INTEGER NOT NULL CHECK(expected_password_revision>=0),
  password_ciphertext TEXT, password_iv TEXT, password_kid TEXT,
  drain_deadline INTEGER NOT NULL CHECK(drain_deadline>=0),
  error_code TEXT, error_message TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
  CHECK((status='pending' AND password_ciphertext IS NOT NULL AND password_iv IS NOT NULL AND password_kid IS NOT NULL)
    OR (status='running' AND resume_operation_id IS NOT NULL AND password_ciphertext IS NULL AND password_iv IS NULL AND password_kid IS NULL)
    OR (status IN('succeeded','failed') AND password_ciphertext IS NULL AND password_iv IS NULL AND password_kid IS NULL))
) STRICT;
CREATE UNIQUE INDEX pool_role_mutations_pending_idx ON pool_role_mutations(database_id) WHERE status IN('pending','running');
CREATE TABLE pool_role_mutation_cursor(singleton INTEGER PRIMARY KEY CHECK(singleton=1),cursor TEXT) STRICT;
INSERT INTO pool_role_mutation_cursor(singleton,cursor) VALUES(1,NULL);
