-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE maintenance_credentials (
  database_id TEXT PRIMARY KEY NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  password_ciphertext TEXT NOT NULL CHECK (length(password_ciphertext) BETWEEN 1 AND 512),
  password_iv TEXT NOT NULL CHECK (length(password_iv)=16),
  password_kid TEXT NOT NULL CHECK (length(password_kid) BETWEEN 1 AND 64),
  password_revision INTEGER NOT NULL CHECK (password_revision >= 1),
  created_at TEXT NOT NULL CHECK (length(created_at)=24 AND created_at GLOB '????-??-??T??:??:??.???Z')
);
