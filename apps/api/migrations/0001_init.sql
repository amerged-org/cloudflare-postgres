-- SPDX-License-Identifier: Apache-2.0
-- Timestamps are ISO-8601 UTC TEXT exactly as Date#toISOString renders them,
-- so string order equals time order for keyset pagination.
-- Keep GLOB patterns short: Workers D1 rejects long LIKE/GLOB patterns.
-- The separate digit check preserves the exact timestamp shape.

CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 24 AND substr(id, 1, 4) = 'prj_' AND NOT substr(id, 5) GLOB '*[^a-z0-9]*'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  external_id TEXT CHECK (external_id IS NULL OR length(external_id) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(created_at, 1, 4) || substr(created_at, 6, 2) || substr(created_at, 9, 2)
        || substr(created_at, 12, 2) || substr(created_at, 15, 2) || substr(created_at, 18, 2)
        || substr(created_at, 21, 3)) NOT GLOB '*[^0-9]*'),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(updated_at, 1, 4) || substr(updated_at, 6, 2) || substr(updated_at, 9, 2)
        || substr(updated_at, 12, 2) || substr(updated_at, 15, 2) || substr(updated_at, 18, 2)
        || substr(updated_at, 21, 3)) NOT GLOB '*[^0-9]*'),
  deleted_at TEXT
);

CREATE UNIQUE INDEX projects_external_id_live_idx
  ON projects(external_id) WHERE external_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX projects_created_idx ON projects(created_at DESC, id DESC);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 24 AND substr(id, 1, 4) = 'key_' AND NOT substr(id, 5) GLOB '*[^a-z0-9]*'),
  lookup_id TEXT NOT NULL UNIQUE
    CHECK (length(lookup_id) = 12 AND NOT lookup_id GLOB '*[^a-z0-9]*'),
  key_hash TEXT NOT NULL UNIQUE
    CHECK (length(key_hash) = 64 AND NOT key_hash GLOB '*[^0-9a-f]*'),
  scope TEXT NOT NULL CHECK (scope IN ('admin', 'integrator')),
  project_id TEXT REFERENCES projects(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(created_at, 1, 4) || substr(created_at, 6, 2) || substr(created_at, 9, 2)
        || substr(created_at, 12, 2) || substr(created_at, 15, 2) || substr(created_at, 18, 2)
        || substr(created_at, 21, 3)) NOT GLOB '*[^0-9]*'),
  last_used_at TEXT,
  revoked_at TEXT,
  CHECK ((scope = 'admin' AND project_id IS NULL) OR (scope = 'integrator' AND project_id IS NOT NULL))
);

CREATE INDEX api_keys_created_idx ON api_keys(created_at DESC, id DESC);
CREATE INDEX api_keys_project_idx ON api_keys(project_id) WHERE project_id IS NOT NULL;

CREATE TABLE size_classes (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) BETWEEN 2 AND 32 AND substr(id, 1, 1) BETWEEN 'a' AND 'z'
      AND substr(id, -1) <> '-' AND NOT id GLOB '*[^a-z0-9-]*'),
  memory_mib INTEGER NOT NULL CHECK (memory_mib BETWEEN 256 AND 1048576),
  cpu_millicores INTEGER NOT NULL CHECK (cpu_millicores BETWEEN 100 AND 256000),
  storage_gib INTEGER NOT NULL CHECK (storage_gib BETWEEN 1 AND 65536),
  max_connections INTEGER NOT NULL CHECK (max_connections BETWEEN 10 AND 10000),
  sleep_after_seconds INTEGER
    CHECK (sleep_after_seconds IS NULL OR sleep_after_seconds BETWEEN 60 AND 2592000),
  archive_timeout_seconds INTEGER NOT NULL CHECK (archive_timeout_seconds BETWEEN 30 AND 3600),
  backup_retention_days INTEGER NOT NULL CHECK (backup_retention_days BETWEEN 1 AND 3650),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(created_at, 1, 4) || substr(created_at, 6, 2) || substr(created_at, 9, 2)
        || substr(created_at, 12, 2) || substr(created_at, 15, 2) || substr(created_at, 18, 2)
        || substr(created_at, 21, 3)) NOT GLOB '*[^0-9]*'),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(updated_at, 1, 4) || substr(updated_at, 6, 2) || substr(updated_at, 9, 2)
        || substr(updated_at, 12, 2) || substr(updated_at, 15, 2) || substr(updated_at, 18, 2)
        || substr(updated_at, 21, 3)) NOT GLOB '*[^0-9]*')
);

CREATE TABLE regions (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) BETWEEN 3 AND 32 AND substr(id, 1, 1) BETWEEN 'a' AND 'z'
      AND substr(id, -1) <> '-' AND NOT id GLOB '*[^a-z0-9-]*'),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 2 AND 32),
  provider_region TEXT NOT NULL CHECK (length(provider_region) BETWEEN 1 AND 64),
  gateway_url TEXT NOT NULL
    CHECK (length(gateway_url) <= 2048 AND (gateway_url LIKE 'https://%' OR gateway_url LIKE 'http://%')),
  gateway_binding TEXT CHECK (gateway_binding IS NULL OR length(gateway_binding) BETWEEN 1 AND 64),
  backup_bucket TEXT NOT NULL CHECK (length(backup_bucket) BETWEEN 3 AND 63),
  backup_endpoint_url TEXT NOT NULL
    CHECK (length(backup_endpoint_url) <= 2048 AND backup_endpoint_url LIKE 'https://%'),
  agent_key_hash TEXT NOT NULL UNIQUE
    CHECK (length(agent_key_hash) = 64 AND NOT agent_key_hash GLOB '*[^0-9a-f]*'),
  agent_last_seen_at TEXT,
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(created_at, 1, 4) || substr(created_at, 6, 2) || substr(created_at, 9, 2)
        || substr(created_at, 12, 2) || substr(created_at, 15, 2) || substr(created_at, 18, 2)
        || substr(created_at, 21, 3)) NOT GLOB '*[^0-9]*'),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(updated_at, 1, 4) || substr(updated_at, 6, 2) || substr(updated_at, 9, 2)
        || substr(updated_at, 12, 2) || substr(updated_at, 15, 2) || substr(updated_at, 18, 2)
        || substr(updated_at, 21, 3)) NOT GLOB '*[^0-9]*')
);

CREATE TABLE nodes (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 24 AND substr(id, 1, 4) = 'nod_' AND NOT substr(id, 5) GLOB '*[^a-z0-9]*'),
  region_id TEXT NOT NULL REFERENCES regions(id),
  k8s_node_name TEXT NOT NULL CHECK (length(k8s_node_name) BETWEEN 1 AND 253),
  provider_instance_id TEXT CHECK (provider_instance_id IS NULL OR length(provider_instance_id) BETWEEN 1 AND 128),
  provider_product TEXT CHECK (provider_product IS NULL OR length(provider_product) BETWEEN 1 AND 128),
  monthly_price TEXT CHECK (monthly_price IS NULL OR length(monthly_price) BETWEEN 1 AND 14),
  currency TEXT CHECK (currency IS NULL OR (length(currency) = 3 AND NOT currency GLOB '*[^A-Z]*')),
  ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1)),
  schedulable INTEGER NOT NULL DEFAULT 1 CHECK (schedulable IN (0, 1)),
  allocatable_memory_mib INTEGER NOT NULL CHECK (allocatable_memory_mib >= 0),
  allocatable_cpu_millicores INTEGER NOT NULL CHECK (allocatable_cpu_millicores >= 0),
  storage_gib_total INTEGER CHECK (storage_gib_total IS NULL OR storage_gib_total >= 0),
  platform_reserved_memory_mib INTEGER NOT NULL DEFAULT 0 CHECK (platform_reserved_memory_mib >= 0),
  last_observed_at TEXT,
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(created_at, 1, 4) || substr(created_at, 6, 2) || substr(created_at, 9, 2)
        || substr(created_at, 12, 2) || substr(created_at, 15, 2) || substr(created_at, 18, 2)
        || substr(created_at, 21, 3)) NOT GLOB '*[^0-9]*'),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(updated_at, 1, 4) || substr(updated_at, 6, 2) || substr(updated_at, 9, 2)
        || substr(updated_at, 12, 2) || substr(updated_at, 15, 2) || substr(updated_at, 18, 2)
        || substr(updated_at, 21, 3)) NOT GLOB '*[^0-9]*'),
  CHECK ((monthly_price IS NULL) = (currency IS NULL))
);

CREATE UNIQUE INDEX nodes_region_name_idx ON nodes(region_id, k8s_node_name);

CREATE TABLE databases (
  -- The ID is also the PostgreSQL database name, so it starts with a letter.
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 20 AND substr(id, 1, 1) BETWEEN 'a' AND 'z' AND NOT id GLOB '*[^a-z0-9]*'),
  project_id TEXT NOT NULL REFERENCES projects(id),
  region_id TEXT NOT NULL REFERENCES regions(id),
  node_id TEXT REFERENCES nodes(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 63),
  size_class_id TEXT NOT NULL REFERENCES size_classes(id),
  pg_major INTEGER NOT NULL DEFAULT 18 CHECK (pg_major = 18),
  desired_state TEXT NOT NULL CHECK (desired_state IN ('running', 'suspended', 'deleted')),
  observed_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (observed_state IN ('pending', 'provisioning', 'ready', 'error', 'deleting', 'deleted')),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  observed_generation INTEGER NOT NULL DEFAULT 0
    CHECK (observed_generation >= 0 AND observed_generation <= generation),
  status_message TEXT CHECK (status_message IS NULL OR length(status_message) <= 4096),
  -- s3://<bucket>/<region>/<id>/g<generation>-<operation id>, fixed per generation.
  archive_path TEXT NOT NULL CHECK (archive_path LIKE 's3://%' AND length(archive_path) <= 512),
  archiving_health TEXT NOT NULL DEFAULT 'unknown'
    CHECK (archiving_health IN ('ok', 'failing', 'unknown')),
  archiving_health_since TEXT,
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(created_at, 1, 4) || substr(created_at, 6, 2) || substr(created_at, 9, 2)
        || substr(created_at, 12, 2) || substr(created_at, 15, 2) || substr(created_at, 18, 2)
        || substr(created_at, 21, 3)) NOT GLOB '*[^0-9]*'),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(updated_at, 1, 4) || substr(updated_at, 6, 2) || substr(updated_at, 9, 2)
        || substr(updated_at, 12, 2) || substr(updated_at, 15, 2) || substr(updated_at, 18, 2)
        || substr(updated_at, 21, 3)) NOT GLOB '*[^0-9]*'),
  deleted_at TEXT,
  CHECK ((desired_state = 'deleted') = (deleted_at IS NOT NULL))
);

CREATE UNIQUE INDEX databases_project_name_live_idx
  ON databases(project_id, name) WHERE deleted_at IS NULL;
CREATE INDEX databases_project_created_idx ON databases(project_id, created_at DESC, id DESC);
CREATE INDEX databases_created_idx ON databases(created_at DESC, id DESC);
CREATE INDEX databases_region_idx ON databases(region_id, id);
CREATE INDEX databases_node_live_idx ON databases(node_id) WHERE observed_state <> 'deleted';

CREATE TABLE roles (
  database_id TEXT NOT NULL REFERENCES databases(id),
  name TEXT NOT NULL
    CHECK (length(name) BETWEEN 1 AND 63 AND substr(name, 1, 1) BETWEEN 'a' AND 'z'
      AND NOT name GLOB '*[^a-z0-9_]*'
      AND name NOT IN ('postgres', 'streaming_replica')
      AND name NOT GLOB 'pg_*' AND name NOT GLOB 'cnpg_*'),
  owner INTEGER NOT NULL DEFAULT 0 CHECK (owner IN (0, 1)),
  -- AES-GCM ciphertext and IV (base64url), key ID; AAD is "<database_id>|<name>|<kid>".
  password_ciphertext TEXT NOT NULL CHECK (length(password_ciphertext) BETWEEN 1 AND 512),
  password_iv TEXT NOT NULL CHECK (length(password_iv) = 16),
  password_kid TEXT NOT NULL CHECK (length(password_kid) BETWEEN 1 AND 64),
  password_revision INTEGER NOT NULL DEFAULT 1 CHECK (password_revision >= 1),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(created_at, 1, 4) || substr(created_at, 6, 2) || substr(created_at, 9, 2)
        || substr(created_at, 12, 2) || substr(created_at, 15, 2) || substr(created_at, 18, 2)
        || substr(created_at, 21, 3)) NOT GLOB '*[^0-9]*'),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(updated_at, 1, 4) || substr(updated_at, 6, 2) || substr(updated_at, 9, 2)
        || substr(updated_at, 12, 2) || substr(updated_at, 15, 2) || substr(updated_at, 18, 2)
        || substr(updated_at, 21, 3)) NOT GLOB '*[^0-9]*'),
  deleted_at TEXT,
  -- Routing index: the edge resolves (database, user) from the StartupMessage.
  PRIMARY KEY (database_id, name)
);

CREATE UNIQUE INDEX roles_one_owner_idx ON roles(database_id) WHERE owner = 1;

CREATE TABLE operations (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 23 AND substr(id, 1, 3) = 'op_' AND NOT substr(id, 4) GLOB '*[^a-z0-9]*'),
  kind TEXT NOT NULL CHECK (kind IN ('database.create', 'database.delete')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  project_id TEXT NOT NULL REFERENCES projects(id),
  database_id TEXT NOT NULL REFERENCES databases(id),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 64),
  error_message TEXT CHECK (error_message IS NULL OR length(error_message) <= 4096),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(created_at, 1, 4) || substr(created_at, 6, 2) || substr(created_at, 9, 2)
        || substr(created_at, 12, 2) || substr(created_at, 15, 2) || substr(created_at, 18, 2)
        || substr(created_at, 21, 3)) NOT GLOB '*[^0-9]*'),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(updated_at, 1, 4) || substr(updated_at, 6, 2) || substr(updated_at, 9, 2)
        || substr(updated_at, 12, 2) || substr(updated_at, 15, 2) || substr(updated_at, 18, 2)
        || substr(updated_at, 21, 3)) NOT GLOB '*[^0-9]*'),
  completed_at TEXT,
  CHECK ((status IN ('succeeded', 'failed')) = (completed_at IS NOT NULL)),
  CHECK (status = 'failed' OR (error_code IS NULL AND error_message IS NULL))
);

CREATE INDEX operations_status_updated_idx ON operations(status, updated_at);
CREATE INDEX operations_database_idx ON operations(database_id, created_at DESC);

-- Stores the request hash and the resulting resource ID, never response bodies.
CREATE TABLE idempotency_keys (
  api_key_id TEXT NOT NULL REFERENCES api_keys(id),
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 128 AND NOT key GLOB '*[^A-Za-z0-9._~-]*'),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND NOT request_hash GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('in_progress', 'completed')),
  resource_id TEXT CHECK (resource_id IS NULL OR length(resource_id) BETWEEN 1 AND 64),
  response_status INTEGER CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(created_at, 1, 4) || substr(created_at, 6, 2) || substr(created_at, 9, 2)
        || substr(created_at, 12, 2) || substr(created_at, 15, 2) || substr(created_at, 18, 2)
        || substr(created_at, 21, 3)) NOT GLOB '*[^0-9]*'),
  PRIMARY KEY (api_key_id, key),
  CHECK ((state = 'completed') = (response_status IS NOT NULL))
);

CREATE INDEX idempotency_keys_created_idx ON idempotency_keys(created_at);

CREATE TABLE lifecycle_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  database_id TEXT NOT NULL REFERENCES databases(id),
  kind TEXT NOT NULL
    CHECK (kind IN ('created', 'ready', 'hibernated', 'woke', 'resized', 'suspended', 'deleted')),
  node_id TEXT REFERENCES nodes(id),
  size_class_id TEXT NOT NULL REFERENCES size_classes(id),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  occurred_at TEXT NOT NULL
    CHECK (length(occurred_at) = 24 AND occurred_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(occurred_at, 1, 4) || substr(occurred_at, 6, 2) || substr(occurred_at, 9, 2)
        || substr(occurred_at, 12, 2) || substr(occurred_at, 15, 2) || substr(occurred_at, 18, 2)
        || substr(occurred_at, 21, 3)) NOT GLOB '*[^0-9]*')
);

CREATE INDEX lifecycle_events_database_idx ON lifecycle_events(database_id, occurred_at);
CREATE INDEX lifecycle_events_occurred_idx ON lifecycle_events(occurred_at);
