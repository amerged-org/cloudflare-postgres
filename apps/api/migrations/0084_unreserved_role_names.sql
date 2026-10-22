-- SPDX-License-Identifier: Apache-2.0
-- Contract: the role names of the Kubernetes runtime are ordinary customer roles, and the names the
-- node or PostgreSQL itself refuses are not (plan W2-C).
--
-- `roles.name` refused `streaming_replica` and `cnpg_*` in a column CHECK, next to `postgres` and
-- the `pg_` prefix. SQLite cannot change a CHECK in place, so the table is built again without those
-- two terms and with three new ones. `pgcf_backup` is the role barman's base backups log in as,
-- which the node agent creates and never restores: a customer role of that name would be altered,
-- lose the privileges of the backup role and, because PostgreSQL cannot drop it, leave that
-- database without base backups for good. `public` and `none` are names PostgreSQL itself refuses
-- in CREATE ROLE ("role name is reserved"), quoted or not; D1 took them until now, and a role of
-- either name stops its database from waking, because the node's role step fails at every start.
-- Every row is copied unchanged: the credential, the attributes, the tombstones. What the name
-- still refuses is `postgres`, `pgcf_backup`, `public`, `none`, the `pg_` prefix and anything that
-- is not a lower-case identifier of 1 to 63 characters. Nothing references `roles`, so no foreign
-- key is in play.
--
-- Deploy order: this migration first, then the node release that accepts these names (R-2), then
-- the API Worker, then the Edge Worker. Check first, as the last act before the apply, that no row of
-- `roles`, tombstones included, is named `pgcf_backup`, `public` or `none`; the CHECK below refuses
-- the copy of such a row, the migration stops and the table stays as it was, so a row that appears
-- after the check delays the apply and is deleted in D1 first. The migration opens nothing: the
-- Workers of today still refuse `cnpg_*`, `streaming_replica` and `pgcf_maintenance`, and a restore
-- copies only names that D1 already holds. What it closes are the three names above, which the old
-- API accepted until now. The old API's insert of one of them fails on the CHECK, an error
-- `isConstraintError` does not map (it matches only UNIQUE), so it answers 500 and creates nothing.
-- The API Worker of this change waits until R-2 is observed on every node and every image a node can
-- be installed or recovered from holds R-2 or newer. A node below R-2 refuses a whole desired page
-- that names a role it still holds reserved, and applies nothing of it. The agent's start asks for
-- the first full page and retries it without end, and the gateway is served after that page, so
-- once such a role exists, a node below R-2 accepts no new connection for any of its databases from
-- its next start on (a release install, a reboot, a crash, or a rollback to a release below R-2).
-- Pulls after the start only log the refusal, and a targeted pull for another database of the node
-- is applied and carries the release.
-- Until the Edge Worker is redeployed, a role of a released name is created but every connection
-- as it answers 28P01. The names it frees were refused before; the three above are the whole
-- narrowing of this change.

CREATE TABLE roles_next (
  database_id TEXT NOT NULL REFERENCES databases(id),
  name TEXT NOT NULL
    CHECK (length(name) BETWEEN 1 AND 63 AND substr(name, 1, 1) BETWEEN 'a' AND 'z'
      AND NOT name GLOB '*[^a-z0-9_]*'
      AND name NOT IN ('postgres', 'pgcf_backup', 'public', 'none') AND name NOT GLOB 'pg_*'),
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
