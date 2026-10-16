-- SPDX-License-Identifier: Apache-2.0
-- Contract: the shared warm PostgreSQL pool is deleted from the code, and nothing reads or writes
-- its tables any more. Children first, then the tables they point to; no table outside this set
-- references any of them, and their indexes and triggers go with them.
DROP TABLE IF EXISTS pool_role_mutation_cursor;
DROP TABLE IF EXISTS pool_role_mutations;
DROP TABLE IF EXISTS pool_claim_attempts;
DROP TABLE IF EXISTS pool_cleanup_io_attestations;
DROP TABLE IF EXISTS pool_cleanup_grants;
DROP TABLE IF EXISTS pool_io_attestations;
DROP TABLE IF EXISTS database_runtime_holders;
DROP TABLE IF EXISTS pool_bindings;
DROP TABLE IF EXISTS pool_pods;
DROP TABLE IF EXISTS pool_storage_observations;
DROP TABLE IF EXISTS pool_preparation_contexts;
DROP TABLE IF EXISTS node_postgres_pool_policies;
DROP TABLE IF EXISTS postgres_pool_qualification_receipts;
DROP TABLE IF EXISTS postgres_pool_qualification_runs;
