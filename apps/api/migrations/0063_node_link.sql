-- SPDX-License-Identifier: Apache-2.0
-- Contract: a node is linked to Cloudflare by its own Ed25519 key, not by a regional agent key.
-- The installer's one-time tokens, the node's key and link state, the per-minute node rollups,
-- the volume report, the event ids and the open orders get their tables. A release is one node
-- image for every node, so the per-node release assignment, the node release inventory and the
-- fleet update candidates go, and the releases of the Talos/Kubernetes spec with them. Rows of
-- kept tables keep their data.
PRAGMA defer_foreign_keys = ON;

-- The desired page of a node carries no maintenance credential: the agent reaches PostgreSQL itself.
DROP TABLE maintenance_credentials;
DROP TABLE fleet_update_candidates;
DROP TABLE fleet_update_policy;
DROP TABLE fleet_node_release_observations;
DROP TABLE fleet_node_releases;
UPDATE databases SET desired_postgres_release_id=NULL,desired_postgres_image=NULL,
  desired_postgres_version=NULL,desired_postgres_schema_revision=NULL;
DELETE FROM fleet_region_releases;
DELETE FROM fleet_releases;
-- A release is a node image and names no PostgreSQL component, so the trigger that demanded one in
-- the region's release would refuse every new database of a region as soon as its release is assigned.
DROP TRIGGER database_postgres_release_supported;

-- The regional agent key goes: `agent_key_hash` is NOT NULL UNIQUE and cannot be dropped, so the
-- table is rebuilt. Dropping it would cascade away the rows of its cascading children, so those
-- are copied and put back. The rows go back into a table named `regions`, which is what settles
-- the deferred foreign keys of its other children. `agent_last_seen_at` becomes the newest link
-- message of the region's nodes, read from `nodes.last_observed_at`.
CREATE TABLE node_link_keep_regions AS SELECT id,provider,provider_region,gateway_url,gateway_binding,
  backup_bucket,backup_endpoint_url,created_at,updated_at FROM regions;
CREATE TABLE node_link_keep_scope_fences AS SELECT * FROM admission_scope_fences;
CREATE TABLE node_link_keep_alerts AS SELECT * FROM infrastructure_alerts;
DROP TABLE regions;
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
INSERT INTO regions(id,provider,provider_region,gateway_url,gateway_binding,backup_bucket,
  backup_endpoint_url,created_at,updated_at)
SELECT id,provider,provider_region,gateway_url,gateway_binding,backup_bucket,backup_endpoint_url,
  created_at,updated_at FROM node_link_keep_regions;
-- Alert episodes gain the refused enrollment. SQLite cannot widen a CHECK in place, so the table is
-- rebuilt as 0053 did and the episodes copied before `regions` went are put back unchanged.
DROP TABLE infrastructure_alerts;
CREATE TABLE infrastructure_alerts (
  region_id TEXT NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN('regional_ram_warning','regional_node_cap_reached','regional_node_stale','infrastructure_backup_failed','infrastructure_backup_stale','regional_node_ram_warning','regional_node_cpu_warning','regional_node_storage_warning','database_archive_failing','database_base_backup_stale','thin_storage_blocked','database_storage_protected','control_cron_stalled','control_cron_step_failing','node_enrollment_refused')),
  active INTEGER NOT NULL CHECK(active IN(0,1)),
  event_id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(payload)<=4096),
  delivered_at TEXT,
  last_attempt_at TEXT,
  PRIMARY KEY(region_id,kind)
) STRICT;
-- Only the region fences went with `regions`; those of projects and nodes are still there.
INSERT OR IGNORE INTO admission_scope_fences SELECT * FROM node_link_keep_scope_fences;
INSERT INTO infrastructure_alerts SELECT * FROM node_link_keep_alerts;
DROP TABLE node_link_keep_regions;
DROP TABLE node_link_keep_scope_fences;
DROP TABLE node_link_keep_alerts;

-- A node: its key and what its link last reported. `node_uid` (the install identity) and
-- `last_observed_at` (the newest link message) already exist; the key is the node's own.
ALTER TABLE nodes ADD COLUMN public_key TEXT
  CHECK(public_key IS NULL OR (length(public_key)=43 AND public_key NOT GLOB '*[^A-Za-z0-9_-]*'));
ALTER TABLE nodes ADD COLUMN enrolled_at TEXT;
ALTER TABLE nodes ADD COLUMN agent_version TEXT CHECK(agent_version IS NULL OR length(agent_version) BETWEEN 1 AND 64);
-- The release the agent named in its last hello.
ALTER TABLE nodes ADD COLUMN reported_release_id TEXT;
-- The revision of the Tunnel token and route keyring the node must apply; the sample repeats the
-- revision the node applied.
ALTER TABLE nodes ADD COLUMN credentials_revision INTEGER NOT NULL DEFAULT 1 CHECK(credentials_revision>=1);
-- The newest sample over the link, as the node sent it.
ALTER TABLE nodes ADD COLUMN last_sample_json TEXT CHECK(last_sample_json IS NULL OR json_valid(last_sample_json));

-- The latest proven-sleep record of a database; the node reports it with every `asleep`.
ALTER TABLE databases ADD COLUMN proven_sleep_json TEXT CHECK(proven_sleep_json IS NULL OR json_valid(proven_sleep_json));

-- The installer of a node (plan 9.2, 8): two one-time tokens stored as HMACs. The progress token
-- reports the installer's checkpoints until `rebooting` or `failed`; the enrollment token is burnt
-- by the node's enrollment, which must come from the public IPv4 the provider reports for the
-- instance, after the checkpoints up to `rebooting` arrived.
CREATE TABLE node_installs (
  node_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(node_id) = 24 AND substr(node_id, 1, 4) = 'nod_' AND NOT substr(node_id, 5) GLOB '*[^a-z0-9]*'),
  image_version TEXT NOT NULL CHECK(length(image_version) BETWEEN 1 AND 64),
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  progress_hash TEXT NOT NULL UNIQUE CHECK(length(progress_hash)=64 AND progress_hash NOT GLOB '*[^0-9a-f]*'),
  allowed_sources_json TEXT NOT NULL CHECK(json_valid(allowed_sources_json) AND json_type(allowed_sources_json)='array'),
  checkpoints_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(checkpoints_json) AND json_type(checkpoints_json)='array'),
  progress_closed_at TEXT,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK(expires_at>issued_at),
  enrolled_at TEXT,
  enrolled_public_key TEXT,
  enrolled_node_uid TEXT,
  -- The last time the right token was presented in vain: after the node enrolled with another key,
  -- or after the token expired. It raises an alert; a new install of a node that did not enroll
  -- starts clean.
  refused_at TEXT,
  refusal TEXT CHECK(refusal IS NULL OR refusal IN('repeat','expired')),
  CHECK((enrolled_at IS NULL)=(enrolled_public_key IS NULL) AND (enrolled_at IS NULL)=(enrolled_node_uid IS NULL)),
  CHECK((refused_at IS NULL)=(refusal IS NULL))
) STRICT;

-- One row per node and minute (plan 4.8, 4.9): what placement reads. Sums and counts keep the
-- averages exact across minutes; the maxima are the peaks. The pool columns are the minute's
-- last reading. The event counters are the node's decisions of the minute.
CREATE TABLE node_minutes (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  minute INTEGER NOT NULL CHECK(minute>0),
  samples INTEGER NOT NULL CHECK(samples>=0),
  memory_total_bytes INTEGER,
  memory_used_bytes_sum INTEGER NOT NULL DEFAULT 0 CHECK(memory_used_bytes_sum>=0),
  memory_used_bytes_max INTEGER NOT NULL DEFAULT 0 CHECK(memory_used_bytes_max>=0),
  cpu_cores INTEGER,
  cpu_busy_millicores_sum INTEGER NOT NULL DEFAULT 0 CHECK(cpu_busy_millicores_sum>=0),
  cpu_busy_millicores_max INTEGER NOT NULL DEFAULT 0 CHECK(cpu_busy_millicores_max>=0),
  awake_sum INTEGER NOT NULL DEFAULT 0 CHECK(awake_sum>=0),
  awake_max INTEGER NOT NULL DEFAULT 0 CHECK(awake_max>=0),
  awake_memory_mib_sum INTEGER NOT NULL DEFAULT 0 CHECK(awake_memory_mib_sum>=0),
  awake_memory_mib_max INTEGER NOT NULL DEFAULT 0 CHECK(awake_memory_mib_max>=0),
  starting_max INTEGER NOT NULL DEFAULT 0 CHECK(starting_max>=0),
  queued_max INTEGER NOT NULL DEFAULT 0 CHECK(queued_max>=0),
  no_room_samples INTEGER NOT NULL DEFAULT 0 CHECK(no_room_samples>=0),
  pool_data_total_bytes INTEGER,
  pool_data_used_bytes INTEGER,
  pool_metadata_total_bytes INTEGER,
  pool_metadata_used_bytes INTEGER,
  pool_nominal_bytes INTEGER,
  volumes_total INTEGER,
  volumes_mounted INTEGER,
  archive_ready_files INTEGER,
  archive_oldest_ready_seconds INTEGER,
  admitted INTEGER NOT NULL DEFAULT 0 CHECK(admitted>=0),
  refused_no_room INTEGER NOT NULL DEFAULT 0 CHECK(refused_no_room>=0),
  refused_no_headroom INTEGER NOT NULL DEFAULT 0 CHECK(refused_no_headroom>=0),
  early_sleeps INTEGER NOT NULL DEFAULT 0 CHECK(early_sleeps>=0),
  queue_waits INTEGER NOT NULL DEFAULT 0 CHECK(queue_waits>=0),
  queue_wait_ms_sum INTEGER NOT NULL DEFAULT 0 CHECK(queue_wait_ms_sum>=0),
  queue_wait_ms_max INTEGER NOT NULL DEFAULT 0 CHECK(queue_wait_ms_max>=0),
  PRIMARY KEY(node_id, minute)
) STRICT;
CREATE INDEX node_minutes_age ON node_minutes(minute);

-- The latest volume report of a node, orphans included (plan 4.3).
CREATE TABLE node_volumes (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  database_id TEXT NOT NULL
    CHECK (length(database_id) = 20 AND substr(database_id, 1, 1) BETWEEN 'a' AND 'z' AND NOT database_id GLOB '*[^a-z0-9]*'),
  storage_generation INTEGER NOT NULL CHECK(storage_generation>=1),
  mounted INTEGER NOT NULL CHECK(mounted IN(0,1)),
  size_bytes INTEGER NOT NULL CHECK(size_bytes>0),
  pool_used_bytes INTEGER NOT NULL CHECK(pool_used_bytes>=0),
  filesystem_total_bytes INTEGER,
  filesystem_used_bytes INTEGER,
  inodes_total INTEGER,
  inodes_used INTEGER,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(node_id, database_id, storage_generation),
  CHECK((mounted=1)=(filesystem_total_bytes IS NOT NULL) AND (mounted=1)=(filesystem_used_bytes IS NOT NULL)
    AND (mounted=1)=(inodes_total IS NOT NULL) AND (mounted=1)=(inodes_used IS NOT NULL))
) STRICT;
CREATE INDEX node_volumes_database ON node_volumes(database_id);

-- The ids of the events a node posted, so that a retried post counts once (NODE_EVENT_RETRY_SECONDS).
CREATE TABLE node_event_ids (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL CHECK(length(event_id)=36),
  received_at INTEGER NOT NULL,
  PRIMARY KEY(node_id, event_id)
) STRICT;
CREATE INDEX node_event_ids_age ON node_event_ids(received_at);

-- The rules Cloudflare sets for the decisions a node takes alone (plan 4.5): one policy per region.
ALTER TABLE node_region_policies ADD COLUMN node_policy_json TEXT
  CHECK(node_policy_json IS NULL OR json_valid(node_policy_json));
