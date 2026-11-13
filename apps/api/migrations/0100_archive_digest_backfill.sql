-- An archive whose base backups were all taken before their digests were recorded is marked here once the
-- backfill has recorded every backup of it that can be recorded. Only then, or once one backup is recorded,
-- the archive is enforced: a backup that is neither recorded nor marked is not trusted.
CREATE TABLE archive_digest_backfill (
  archive_path TEXT PRIMARY KEY NOT NULL,
  done_at TEXT NOT NULL
);
