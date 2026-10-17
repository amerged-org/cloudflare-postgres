-- SPDX-License-Identifier: Apache-2.0
-- Contract: fast headroom samples and the write tokens they renewed are deleted. A thin start needs
-- room in the node's minute physical sample (node_storage_observations), and the identity proof
-- composes its authority from its own reading. Each column goes after the column whose CHECK names
-- it; a qualification run's own samples stay until its sample gates go.
ALTER TABLE node_thin_storage DROP COLUMN sample_nonce_issued_at;
ALTER TABLE node_thin_storage DROP COLUMN sample_nonce;
ALTER TABLE node_thin_storage DROP COLUMN sample_data_used_bytes;
ALTER TABLE node_thin_storage DROP COLUMN sample_observed_at;
ALTER TABLE node_thin_storage DROP COLUMN lease_sample_data_used_bytes;
ALTER TABLE node_thin_storage DROP COLUMN lease_sample_observed_at;
