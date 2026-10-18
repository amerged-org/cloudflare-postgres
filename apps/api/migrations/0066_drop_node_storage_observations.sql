-- SPDX-License-Identifier: Apache-2.0
-- The Kubernetes agent's physical node storage observation: nothing writes it since the node link,
-- and the endpoint that read it is gone. A node's pool is in its newest sample (nodes.last_sample_json).
DROP TABLE node_storage_observations;
