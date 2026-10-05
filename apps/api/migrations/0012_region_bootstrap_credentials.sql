-- Region bootstrap material is private encrypted custody, never a public region field.
CREATE TABLE region_bootstrap_credentials (
  region_id TEXT NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('agent_key','region_seed','join_bundle')),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  version INTEGER NOT NULL CHECK (version=1),
  kid TEXT NOT NULL CHECK (length(kid) BETWEEN 1 AND 64),
  iv TEXT NOT NULL CHECK (length(iv)=16 AND NOT iv GLOB '*[^A-Za-z0-9_-]*'),
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) BETWEEN 22 AND 349547 AND NOT ciphertext GLOB '*[^A-Za-z0-9_-]*'),
  created_at TEXT NOT NULL CHECK (length(created_at)=24 AND created_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (region_id,purpose,revision),
  CHECK (purpose<>'agent_key' OR revision=1)
);
