-- SPDX-License-Identifier: Apache-2.0
-- Contract: the role names of the Kubernetes runtime are ordinary customer roles, and the node's own
-- backup role is not (plan W2-C).
--
-- `roles.name` refused `streaming_replica` and `cnpg_*` in a column CHECK, next to what PostgreSQL
-- reserves itself. SQLite cannot change a CHECK in place, so the table is built again without those
-- two terms and with one new one, `pgcf_backup`: the role barman's base backups log in as, which the
-- node agent creates and never restores. A customer role of that name would be altered, lose the
-- privileges of the backup role and, because PostgreSQL cannot drop it, leave that database without
-- base backups for good. Every row is copied unchanged: the credential, the attributes, the
-- tombstones. What the name still refuses is `postgres`, `pgcf_backup`, the `pg_` prefix and
-- anything that is not a lower-case identifier of 1 to 63 characters. Nothing references `roles`,
-- so no foreign key is in play.
--
-- Deploy order. This migration, the API Worker and the Edge Worker come after the node release that
-- accepts these names (R-2) is observed on every node, and every image a node can be installed or
-- recovered from holds R-2 or newer. A node below R-2 refuses a whole desired page that names a role
-- it still holds reserved, and that page also carries the node's release: the node can then never
-- receive a newer release, and rolling forward cannot fix it. Until the Edge Worker is redeployed, a
-- role of such a name is created but every connection as it answers 28P01. From the merge of this
-- change until R-2 is observed on every node, deploy no API Worker from main and apply no
-- `wrangler d1 migrations apply`, which applies every pending migration, this one included.
-- Check before R-2 and again before this migration that no row of `roles`, tombstones included, is
-- named `pgcf_backup`: the CHECK below refuses the copy of such a row and the migration stops, and
-- a node on R-2 refuses the page of its database.

CREATE TABLE roles_next (
  database_id TEXT NOT NULL REFERENCES databases(id),
  name TEXT NOT NULL
    CHECK (length(name) BETWEEN 1 AND 63 AND substr(name, 1, 1) BETWEEN 'a' AND 'z'
      AND NOT name GLOB '*[^a-z0-9_]*'
      AND name NOT IN ('postgres', 'pgcf_backup') AND name NOT GLOB 'pg_*'),
  owner INTEGER NOT NULL DEFAULT 0 CHECK (owner IN (0, 1)),
  -- AES-GCM ciphertext and IV (base64url), key ID; AAD is "<database_id>|<name>|<kid>".
  password_ciphertext TEXT NOT NULL CHECK (length(password_ciphertext) BETWEEN 1 AND 512),
  password_iv TEXT NOT NULL CHECK (length(password_iv) = 16),
  password_kid TEXT NOT NULL CHECK (length(password_kid) BETWEEN 1 AND 64),
  password_revision INTEGER NOT NULL DEFAULT 1 CHECK (password_revision >= 1),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(created_at, 1, 4) || substr(created_at, 6, 2) || substr(created_at, 9, 2)
        || substr(created_at, 12, 2) || substr(created_at, 15, 2) || substr(created_at, 18, 2)
        || substr(created_at, 21, 3)) NOT GLOB '*[^0-9]*'),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z'
      AND (substr(updated_at, 1, 4) || substr(updated_at, 6, 2) || substr(updated_at, 9, 2)
        || substr(updated_at, 12, 2) || substr(updated_at, 15, 2) || substr(updated_at, 18, 2)
        || substr(updated_at, 21, 3)) NOT GLOB '*[^0-9]*'),
  deleted_at TEXT,
  valid_until TEXT
    CHECK (valid_until IS NULL OR (length(valid_until) = 24 AND valid_until GLOB '????-??-??T??:??:??.???Z')),
  connection_limit INTEGER
    CHECK (connection_limit IS NULL OR connection_limit BETWEEN 1 AND 10000),
  member_of_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(member_of_json) AND json_type(member_of_json) = 'array'),
  bypass_rls INTEGER NOT NULL DEFAULT 0 CHECK (bypass_rls IN (0, 1)),
  created_by_key_id TEXT,
  deleted_by_key_id TEXT,
  delete_operation_id TEXT,
  -- Routing index: the edge resolves (database, user) from the StartupMessage.
  PRIMARY KEY (database_id, name)
);
INSERT INTO roles_next(database_id, name, owner, password_ciphertext, password_iv, password_kid,
  password_revision, created_at, updated_at, deleted_at, valid_until, connection_limit,
  member_of_json, bypass_rls, created_by_key_id, deleted_by_key_id, delete_operation_id)
SELECT database_id, name, owner, password_ciphertext, password_iv, password_kid,
  password_revision, created_at, updated_at, deleted_at, valid_until, connection_limit,
  member_of_json, bypass_rls, created_by_key_id, deleted_by_key_id, delete_operation_id
FROM roles;
DROP TABLE roles;
ALTER TABLE roles_next RENAME TO roles;
CREATE UNIQUE INDEX roles_one_owner_idx ON roles(database_id) WHERE owner = 1;
