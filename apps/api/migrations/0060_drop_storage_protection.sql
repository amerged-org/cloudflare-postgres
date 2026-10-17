-- SPDX-License-Identifier: Apache-2.0
-- Contract: protective stops are deleted. No running writer is stopped for storage, so nothing
-- marks, recovers or alarms a protected database any more.
DELETE FROM infrastructure_alerts WHERE kind='database_storage_protected';
ALTER TABLE databases DROP COLUMN storage_protected_operation;
ALTER TABLE databases DROP COLUMN storage_protected_generation;
ALTER TABLE databases DROP COLUMN storage_protected_at;
