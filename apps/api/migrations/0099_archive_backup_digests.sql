-- The digest the Worker recorded of each base backup it saw reported, over the objects under the backup's
-- prefix. Recovery and retention trust a backup only while the archive still matches this digest.
CREATE TABLE archive_backup_digests (
  archive_path TEXT NOT NULL,
  backup_id TEXT NOT NULL CHECK(length(backup_id)=15),
  digest TEXT NOT NULL CHECK(length(digest)=64),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(archive_path, backup_id)
);
