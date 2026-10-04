-- SPDX-License-Identifier: Apache-2.0
-- Snapshot identities intentionally survive removal of runtime node/region metadata.
CREATE TABLE infrastructure_node_cost_facts (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id)=36),
  node_id TEXT NOT NULL CHECK (length(node_id)=24 AND substr(node_id,1,4)='nod_' AND NOT substr(node_id,5) GLOB '*[^a-z0-9]*'),
  region_id TEXT NOT NULL CHECK (length(region_id) BETWEEN 3 AND 32),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 2 AND 32),
  effective_from TEXT NOT NULL CHECK (length(effective_from)=24),
  effective_to TEXT NOT NULL CHECK (length(effective_to)=24 AND effective_to>effective_from),
  payload TEXT NOT NULL CHECK (json_valid(payload) AND length(payload)<=4096),
  recorded_at TEXT NOT NULL CHECK (length(recorded_at)=24),
  recorded_by_key_id TEXT NOT NULL,
  UNIQUE(node_id,effective_from,effective_to)
);
CREATE INDEX infrastructure_cost_node_period_idx ON infrastructure_node_cost_facts(node_id,effective_from,effective_to);
CREATE INDEX infrastructure_cost_region_node_idx ON infrastructure_node_cost_facts(region_id,node_id);
CREATE TRIGGER infrastructure_cost_immutable BEFORE UPDATE ON infrastructure_node_cost_facts
BEGIN SELECT RAISE(ABORT,'infrastructure_cost_fact_immutable'); END;
CREATE TRIGGER infrastructure_cost_no_overlap BEFORE INSERT ON infrastructure_node_cost_facts
WHEN EXISTS(SELECT 1 FROM infrastructure_node_cost_facts WHERE node_id=NEW.node_id AND effective_from<NEW.effective_to AND effective_to>NEW.effective_from)
BEGIN SELECT RAISE(ABORT,'infrastructure_cost_period_overlap'); END;
CREATE TRIGGER infrastructure_cost_region_consistent BEFORE INSERT ON infrastructure_node_cost_facts
WHEN EXISTS(SELECT 1 FROM infrastructure_node_cost_facts WHERE node_id=NEW.node_id AND (region_id<>NEW.region_id OR provider<>NEW.provider))
BEGIN SELECT RAISE(ABORT,'infrastructure_cost_node_identity_changed'); END;
