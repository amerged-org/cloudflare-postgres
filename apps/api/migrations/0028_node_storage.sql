-- SPDX-License-Identifier: Apache-2.0
-- Current physical observation only; it does not qualify thin storage or change quota admission.
CREATE TABLE node_storage_observations (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  node_uid TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  physical_json TEXT CHECK(physical_json IS NULL OR json_valid(physical_json))
) STRICT;
