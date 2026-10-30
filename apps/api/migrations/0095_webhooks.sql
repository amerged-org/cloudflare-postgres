-- SPDX-License-Identifier: Apache-2.0
-- Webhook subscriptions of a project. The signing secret and the static request headers are
-- sealed with the credential keyring; events and their deliveries live in each database's
-- TriggerActor, not here.
CREATE TABLE webhook_subscriptions (
  id TEXT PRIMARY KEY CHECK(length(id)=24 AND id GLOB 'whk_*'),
  project_id TEXT NOT NULL REFERENCES projects(id),
  url TEXT NOT NULL CHECK(length(url)<=2048),
  event_types TEXT NOT NULL CHECK(json_valid(event_types) AND json_type(event_types)='array'
    AND json_array_length(event_types) BETWEEN 1 AND 16),
  database_ids TEXT CHECK(database_ids IS NULL OR (json_valid(database_ids)
    AND json_type(database_ids)='array' AND json_array_length(database_ids) BETWEEN 1 AND 100)),
  secret_ciphertext TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  secret_kid TEXT NOT NULL,
  headers_ciphertext TEXT,
  headers_iv TEXT,
  headers_kid TEXT,
  header_names TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(header_names)
    AND json_type(header_names)='array'),
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK((headers_ciphertext IS NULL)=(headers_iv IS NULL)
    AND (headers_iv IS NULL)=(headers_kid IS NULL))
) STRICT;
CREATE INDEX webhook_subscriptions_project
  ON webhook_subscriptions(project_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;

-- Where the event producer stopped reading the lifecycle log and the finished operations. A new
-- installation of this migration starts at the present: history is not announced.
CREATE TABLE webhook_cursors (
  name TEXT PRIMARY KEY CHECK(name IN('lifecycle','operations')),
  cursor TEXT NOT NULL
) STRICT;
INSERT INTO webhook_cursors(name, cursor) VALUES
  ('lifecycle', CAST((SELECT COALESCE(MAX(id),0) FROM lifecycle_events) AS TEXT)),
  ('operations', strftime('%Y-%m-%dT%H:%M:%fZ','now') || '|');
