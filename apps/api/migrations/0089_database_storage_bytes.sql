-- SPDX-License-Identifier: Apache-2.0
-- The size of a database's filesystem as its node last told it (plan 4.3, resize).
--
-- A resize used to end when the node reported the database ready at the new generation, whether or
-- not its filesystem had grown: the volume had (US1, 2026-10-23: 25 GiB to 50 GiB, `resize2fs`
-- failed with -28, the API showed the new storage and the tenant ran out of space at the old one).
-- The node now reports the size its filesystem has with `ready` and `asleep`
-- (`NodeDatabaseObservation.storage_bytes`), a resize ends when it has the storage that was asked
-- for, and a database that reports less than its effective storage raises `database_volume_critical`.
-- Null until the node first tells it: an agent of an earlier release never does.
ALTER TABLE databases ADD COLUMN observed_storage_bytes INTEGER
  CHECK(observed_storage_bytes IS NULL OR observed_storage_bytes>0);
