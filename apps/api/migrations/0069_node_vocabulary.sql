-- SPDX-License-Identifier: Apache-2.0
-- Contract: the vocabulary of the plain Linux node (plan 5.3, 11.2). The hostname replaces the
-- Kubernetes node name, the node's report of its unit is the runtime, and the Talos bootstrap's
-- checkpoint, network and capacity proofs go: no node bootstrap writes them any more, and the pull
-- installer has its own table (`node_installs`).
ALTER TABLE nodes RENAME COLUMN k8s_node_name TO hostname;
ALTER TABLE databases RENAME COLUMN runtime_attestation_json TO runtime_json;
ALTER TABLE node_additions DROP COLUMN checkpoint_json;
ALTER TABLE node_additions DROP COLUMN network_json;
ALTER TABLE node_additions DROP COLUMN capacity_json;
