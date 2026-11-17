-- SPDX-License-Identifier: Apache-2.0
-- Identifiers are retained through revocation and deletion for incident review.
CREATE TABLE credential_disclosures (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  key_id TEXT NOT NULL CHECK (
    length(key_id) = 24 AND substr(key_id,1,4) = 'key_' AND NOT substr(key_id,5) GLOB '*[^a-z0-9]*'
  ),
  project_id TEXT NOT NULL CHECK (
    length(project_id) = 24 AND substr(project_id,1,4) = 'prj_' AND NOT substr(project_id,5) GLOB '*[^a-z0-9]*'
  ),
  database_id TEXT NOT NULL CHECK (
    length(database_id) = 20 AND substr(database_id,1,1) GLOB '[a-z]' AND NOT database_id GLOB '*[^a-z0-9]*'
  ),
  role TEXT NOT NULL CHECK (
    length(role) BETWEEN 1 AND 63 AND substr(role,1,1) GLOB '[a-z]' AND NOT role GLOB '*[^a-z0-9_]*'
  ),
  role_created_at TEXT NOT NULL CHECK (
    length(role_created_at) = 24 AND role_created_at GLOB '????-??-??T??:??:??.???Z'
  ),
  password_revision INTEGER NOT NULL CHECK (password_revision > 0),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'
  )
) STRICT;
CREATE INDEX credential_disclosures_created_idx ON credential_disclosures(created_at DESC, id DESC);
CREATE INDEX credential_disclosures_key_created_idx ON credential_disclosures(key_id, created_at DESC, id DESC);
