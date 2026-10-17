-- SPDX-License-Identifier: Apache-2.0
-- Contract: the Kubernetes runtime is gone. Fleet patches, the NodeBootstrap installer and its
-- relay, region custody material, node proofs, inspection and installation, host configuration,
-- the compute pool, warm reclaim, thin execution and qualification, and the backup holds they
-- needed lose their tables and columns. Rows of kept tables keep their data.
PRAGMA defer_foreign_keys = ON;

DROP TRIGGER IF EXISTS thin_storage_qualification_excludes_selection;
DROP TRIGGER IF EXISTS fleet_releases_thin_facts;
DROP VIEW IF EXISTS fleet_release_thin_facts;

DROP TABLE fleet_patch_operations;
DROP TABLE node_bootstrap_jobs;
DROP TABLE node_host_configurations;
DROP TABLE node_installation_bindings;
DROP TABLE node_installation_profiles;
DROP TABLE node_compute_pool_observations;
DROP TABLE node_compute_pool_policies;
DROP TABLE thin_storage_qualification_samples;
DROP TABLE thin_storage_qualification_runs;
DROP TABLE region_bootstrap_credentials;
DROP TABLE node_network_mutations;
DROP TABLE node_network_firewalls;
DROP TABLE node_network_preparations;
DROP TABLE infrastructure_backup_deferrals;

ALTER TABLE nodes DROP COLUMN warm_reclaim_qualification_json;
ALTER TABLE regions DROP COLUMN bootstrap_material_provenance_sha256;
ALTER TABLE regions DROP COLUMN bootstrap_material_revision;
ALTER TABLE node_region_policies DROP COLUMN compute_pool_json;
ALTER TABLE node_region_policies DROP COLUMN thin_storage_json;
ALTER TABLE databases DROP COLUMN warm_reclaim_policy_json;
ALTER TABLE fleet_releases DROP COLUMN thin_continuity;
ALTER TABLE fleet_releases DROP COLUMN thin_sampling_version;
DROP INDEX IF EXISTS fleet_region_rollout;
ALTER TABLE fleet_region_releases DROP COLUMN rollout_json;
-- Receipts of earlier runs stay; only the node and cluster identity of their etcd snapshots goes.
ALTER TABLE infrastructure_backup_artifacts DROP COLUMN node_id;
ALTER TABLE infrastructure_backup_artifacts DROP COLUMN node_uid;
ALTER TABLE infrastructure_backup_artifacts DROP COLUMN cluster_uid;
ALTER TABLE infrastructure_backup_artifacts DROP COLUMN material_revision;

-- Thin storage keeps its profile and the last authority read; the relay address, the cluster,
-- the custody material, the host lease, the pool turns and the qualification go. A table CHECK
-- names the lease, so the table is rebuilt, and the two triggers on databases that read it are
-- created again unchanged. Qualifying and blocked nodes become selected.
DROP TRIGGER database_selected_thin_insert;
DROP TRIGGER database_selected_thin_placement;
CREATE TABLE node_thin_storage_next (
  node_id TEXT PRIMARY KEY NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  node_uid TEXT NOT NULL,
  volume_group_uuid TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK(profile_revision>0),
  profile_sha256 TEXT NOT NULL CHECK(length(profile_sha256)=64 AND profile_sha256 NOT GLOB '*[^a-f0-9]*'),
  profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
  allow_new_databases INTEGER NOT NULL DEFAULT 0 CHECK(allow_new_databases IN(0,1)),
  authority_revision INTEGER NOT NULL DEFAULT 0 CHECK(authority_revision>=0),
  authority_json TEXT CHECK(authority_json IS NULL OR json_valid(authority_json)),
  authority_received_at TEXT,
  status TEXT NOT NULL CHECK(status IN('selected','ready')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((authority_json IS NULL)=(authority_received_at IS NULL)),
  CHECK(authority_json IS NOT NULL OR authority_revision=0)
) STRICT;
INSERT INTO node_thin_storage_next(node_id,node_uid,volume_group_uuid,profile_revision,profile_sha256,
  profile_json,allow_new_databases,authority_revision,authority_json,authority_received_at,status,
  error_code,created_at,updated_at)
SELECT node_id,node_uid,volume_group_uuid,profile_revision,profile_sha256,profile_json,
  allow_new_databases,authority_revision,authority_json,authority_received_at,
  CASE status WHEN 'ready' THEN 'ready' ELSE 'selected' END,error_code,created_at,updated_at
FROM node_thin_storage;
DROP TABLE node_thin_storage;
ALTER TABLE node_thin_storage_next RENAME TO node_thin_storage;
CREATE TRIGGER database_selected_thin_insert BEFORE INSERT ON databases
WHEN NEW.node_id IS NOT NULL AND NEW.storage_profile_json IS NULL
  AND EXISTS(SELECT 1 FROM node_thin_storage t WHERE t.node_id=NEW.node_id)
BEGIN SELECT RAISE(ABORT,'database_selected_thin_profile_required'); END;
CREATE TRIGGER database_selected_thin_placement BEFORE UPDATE OF node_id ON databases
WHEN NEW.node_id IS NOT NULL AND NEW.node_id IS NOT OLD.node_id AND NEW.storage_profile_json IS NULL
  AND EXISTS(SELECT 1 FROM node_thin_storage t WHERE t.node_id=NEW.node_id)
BEGIN SELECT RAISE(ABORT,'database_selected_thin_profile_required'); END;
