-- SPDX-License-Identifier: Apache-2.0
-- Current explicit policy and observed identity only; the Actor owns one revocable idle intent.
ALTER TABLE databases ADD COLUMN warm_reclaim_policy_json TEXT
  CHECK(warm_reclaim_policy_json IS NULL OR json_valid(warm_reclaim_policy_json));
ALTER TABLE databases ADD COLUMN runtime_attestation_json TEXT
  CHECK(runtime_attestation_json IS NULL OR json_valid(runtime_attestation_json));
ALTER TABLE nodes ADD COLUMN warm_reclaim_qualification_json TEXT
  CHECK(warm_reclaim_qualification_json IS NULL OR json_valid(warm_reclaim_qualification_json));
