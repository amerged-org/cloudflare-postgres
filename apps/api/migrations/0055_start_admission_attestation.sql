-- SPDX-License-Identifier: Apache-2.0
-- Expand only: the column is nullable and unset means the start remembers no attestation; no
-- backfill and no table rebuild.
--
-- A thin start's hold remembers the runtime attestation of the controller's last accepted ready
-- report for it. databases.runtime_attestation_json is cleared by any later ready report that
-- carries none, and the writer a hold backs, until the node's identity proof evidences its Pod,
-- would lose its token with it.
ALTER TABLE database_start_admissions ADD COLUMN attested_json TEXT
  CHECK(attested_json IS NULL OR json_valid(attested_json));
