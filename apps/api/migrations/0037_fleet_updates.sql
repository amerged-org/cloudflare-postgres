-- SPDX-License-Identifier: Apache-2.0
-- Candidate metadata only. Actual mutations keep the existing fleet_patch_operations journal.
CREATE TABLE fleet_update_policy (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
  policy_json TEXT NOT NULL CHECK(json_valid(policy_json) AND length(policy_json)<=8192),
  discovery_revision INTEGER NOT NULL DEFAULT 0 CHECK(discovery_revision>=0),
  discovery_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(discovery_json) AND length(discovery_json)<=16384),
  updated_at TEXT NOT NULL
) STRICT;
-- No row is inserted: an unconfigured installation has no automatic update authority.
CREATE TABLE fleet_update_candidates (
  id TEXT PRIMARY KEY CHECK(length(id)=67 AND substr(id,1,3)='fu-' AND substr(id,4) NOT GLOB '*[^a-f0-9]*'),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 2147483647),
  policy_revision INTEGER NOT NULL CHECK(policy_revision>0),
  base_release_id TEXT NOT NULL REFERENCES fleet_releases(id),
  base_spec_sha256 TEXT NOT NULL CHECK(length(base_spec_sha256)=64),
  component TEXT NOT NULL,
  current_version TEXT NOT NULL,
  target_version TEXT NOT NULL,
  facts_json TEXT NOT NULL CHECK(json_valid(facts_json) AND length(facts_json)<=16384),
  state TEXT NOT NULL CHECK(state IN('awaiting_ci','qualified','canary','promoting','promoted','rejected','blocked')),
  reason TEXT NOT NULL,
  operator_reason TEXT CHECK(operator_reason IS NULL OR length(operator_reason)<=512),
  candidate_release_id TEXT REFERENCES fleet_releases(id),
  candidate_spec_sha256 TEXT,
  qualification_run_id TEXT,
  qualification_sha256 TEXT,
  qualified_at TEXT,
  canary_receipt_sha256 TEXT,
  canary_completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  CHECK(state NOT IN('qualified','canary','promoting','promoted') OR
    (candidate_release_id IS NOT NULL AND candidate_spec_sha256 IS NOT NULL AND qualification_run_id IS NOT NULL AND qualification_sha256 IS NOT NULL AND qualified_at IS NOT NULL)),
  CHECK(state<>'promoted' OR (canary_receipt_sha256 IS NOT NULL AND canary_completed_at IS NOT NULL))
) STRICT;
CREATE INDEX fleet_update_candidate_page ON fleet_update_candidates(id);
CREATE UNIQUE INDEX fleet_update_active_candidate ON fleet_update_candidates((1))
  WHERE state IN('qualified','canary','promoting');
