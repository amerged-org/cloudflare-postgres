-- SPDX-License-Identifier: Apache-2.0
-- Uniform membership options: bit 1 INHERIT, bit 0 SET; ADMIN is always false.
-- Existing roles retain INHERIT TRUE / SET TRUE. Native support must precede API activation.
ALTER TABLE roles ADD COLUMN membership_options INTEGER NOT NULL DEFAULT 3
  CHECK (membership_options IN (0, 1, 2, 3));

-- Neither duplicate field is used when restoring: the archive supplies source_database_id,
-- and a restored role receives fresh created_at/updated_at. Removing them leaves room for
-- membership options within D1's 100,000-byte dump/import statement limit at 100 roles.
-- Historical role attributes and encrypted credentials are retained byte-for-byte as values.
UPDATE retained_archives
SET roles_json = (
  SELECT json_group_array(json_remove(value, '$.database_id', '$.updated_at'))
  FROM json_each(retained_archives.roles_json)
);
