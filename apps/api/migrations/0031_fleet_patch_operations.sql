-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE fleet_patch_operations (
  operation_id TEXT PRIMARY KEY,
  finalization_of TEXT REFERENCES fleet_patch_operations(operation_id),
  bootstrap_operation_id TEXT REFERENCES node_bootstrap_jobs(operation_id),
  bootstrap_joined_reference TEXT,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  region_id TEXT NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  node_uid TEXT NOT NULL,
  cluster_uid TEXT NOT NULL,
  release_id TEXT NOT NULL REFERENCES fleet_releases(id),
  spec_sha256 TEXT NOT NULL,
  assignment_revision INTEGER NOT NULL CHECK(assignment_revision > 0),
  region_revision INTEGER NOT NULL CHECK(region_revision > 0),
  material_revision INTEGER NOT NULL CHECK(material_revision > 0),
  address TEXT NOT NULL,
  cluster_nodes_json TEXT NOT NULL CHECK(json_valid(cluster_nodes_json)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  stage TEXT NOT NULL CHECK(stage IN('preflight','host_config','host_service','talos','talos_reboot','kubernetes','kubernetes_images','verify','runtime_verified','flux','platform','regional','runtime_admission','postgres','release_verify','complete','host_ready')),
  state TEXT NOT NULL CHECK(state IN('pending','dispatched','confirmed','halted')),
  baseline_json TEXT CHECK(baseline_json IS NULL OR json_valid(baseline_json)),
  observed_json TEXT CHECK(observed_json IS NULL OR json_valid(observed_json)),
  talos_upgrade_receipt_json TEXT CHECK(talos_upgrade_receipt_json IS NULL OR json_valid(talos_upgrade_receipt_json)),
  postgres_progress_json TEXT CHECK(postgres_progress_json IS NULL OR json_valid(postgres_progress_json)),
  host_configuration_revision INTEGER CHECK(host_configuration_revision > 0),
  host_configuration_sha256 TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX fleet_patch_active_region ON fleet_patch_operations(region_id)
  WHERE stage NOT IN('complete','host_ready');

CREATE UNIQUE INDEX fleet_patch_bootstrap_parent ON fleet_patch_operations(bootstrap_operation_id) WHERE bootstrap_operation_id IS NOT NULL;

CREATE UNIQUE INDEX fleet_patch_finalization ON fleet_patch_operations(finalization_of) WHERE finalization_of IS NOT NULL;
