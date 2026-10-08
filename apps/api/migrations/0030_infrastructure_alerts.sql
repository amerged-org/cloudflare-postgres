-- SPDX-License-Identifier: Apache-2.0
-- One durable warning episode per region/kind; stable event IDs survive callback retries.
CREATE TABLE infrastructure_alerts (
  region_id TEXT NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN('regional_ram_warning','regional_node_cap_reached')),
  active INTEGER NOT NULL CHECK(active IN(0,1)),
  event_id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(payload)<=4096),
  delivered_at TEXT,
  last_attempt_at TEXT,
  PRIMARY KEY(region_id,kind)
) STRICT;
