-- The backfill of the digests of an archive written before digests were recorded. It counts the passes it made
-- over the archive, and sets `done_at` once it has looked at every backup or after a bounded number of passes.
-- Only a done archive is enforced: a backup that was never recorded is trusted until then.
CREATE TABLE archive_digest_backfill (
  archive_path TEXT PRIMARY KEY NOT NULL,
  passes INTEGER NOT NULL DEFAULT 0 CHECK(passes >= 0),
  done_at TEXT
);
