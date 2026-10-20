-- SPDX-License-Identifier: Apache-2.0
-- Contract: the node policy's `admission` group gains `cpu_boost_ms`, the time after a wake during
-- which a database runs without the CPU quota of its class (plan 4.4). The field is optional for
-- its first release (plan 9.3, "Changing the page"): a policy that lacks it reads as 0, the quota
-- with the wake as before. The operator's value, 5000, is written into each stored policy that
-- lacks the field, so that the burst is on from the first wake once the nodes run an agent that
-- applies it; a policy that has the field keeps its value. The agent of main `1ace7446` refuses a
-- page that carries the field, so the release whose agent ignores unknown properties is assigned
-- before this migration is deployed (plan 11.2, CPU burst).
UPDATE node_region_policies
SET node_policy_json = json_set(node_policy_json, '$.admission.cpu_boost_ms', 5000)
WHERE node_policy_json IS NOT NULL
  AND json_type(node_policy_json, '$.admission.cpu_boost_ms') IS NULL;
