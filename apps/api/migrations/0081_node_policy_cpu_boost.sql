-- SPDX-License-Identifier: Apache-2.0
-- Contract: the node policy's `admission` group gains `cpu_boost_ms`, the time after a wake during
-- which a database runs without the CPU quota of its class (plan 4.4). The field is required, and
-- the policy is stored as JSON that every read parses with the contract, so a policy stored
-- without it would fail the region's node-policy read and the page of every node of the region.
-- The default of the operator documentation, 5000, is written into each stored policy that lacks
-- the field; a policy that has it keeps its value. A node whose agent predates the field refuses a
-- page that carries it and keeps what it runs (operator-installation.md, "Replacing the agent by
-- hand", for the first node).
UPDATE node_region_policies
SET node_policy_json = json_set(node_policy_json, '$.admission.cpu_boost_ms', 5000)
WHERE node_policy_json IS NOT NULL
  AND json_type(node_policy_json, '$.admission.cpu_boost_ms') IS NULL;
