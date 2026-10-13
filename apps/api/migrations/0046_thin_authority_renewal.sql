-- SPDX-License-Identifier: Apache-2.0
-- Headroom samples from the region renew thin write authority against a nonce Cloudflare issued with
-- its own clock: 128 random bits per node, used once and refused when older than guard/2.
ALTER TABLE node_thin_storage ADD COLUMN sample_nonce TEXT
  CHECK (sample_nonce IS NULL OR (length(sample_nonce) = 32 AND sample_nonce NOT GLOB '*[^a-f0-9]*'));
ALTER TABLE node_thin_storage ADD COLUMN sample_nonce_issued_at TEXT
  CHECK ((sample_nonce IS NULL) = (sample_nonce_issued_at IS NULL));
-- The newest accepted sample: its nonce's issue and its pool data upper bound.
ALTER TABLE node_thin_storage ADD COLUMN sample_observed_at TEXT;
ALTER TABLE node_thin_storage ADD COLUMN sample_data_used_bytes INTEGER
  CHECK ((sample_observed_at IS NULL) = (sample_data_used_bytes IS NULL)
    AND (sample_data_used_bytes IS NULL OR sample_data_used_bytes BETWEEN 0 AND 9007199254740991));
-- The newest sample accepted before the current identity lease was issued; that lease's own LVM
-- reading must not show more data than it plus what Cloudflare allowed since.
ALTER TABLE node_thin_storage ADD COLUMN lease_sample_observed_at TEXT;
ALTER TABLE node_thin_storage ADD COLUMN lease_sample_data_used_bytes INTEGER
  CHECK ((lease_sample_observed_at IS NULL) = (lease_sample_data_used_bytes IS NULL)
    AND (lease_sample_data_used_bytes IS NULL OR lease_sample_data_used_bytes BETWEEN 0 AND 9007199254740991));

-- A scratch qualification run's node samples into the run's evidence and renews nothing.
ALTER TABLE thin_storage_qualification_runs ADD COLUMN sample_nonce TEXT
  CHECK (sample_nonce IS NULL OR (length(sample_nonce) = 32 AND sample_nonce NOT GLOB '*[^a-f0-9]*'));
ALTER TABLE thin_storage_qualification_runs ADD COLUMN sample_nonce_issued_at TEXT
  CHECK ((sample_nonce IS NULL) = (sample_nonce_issued_at IS NULL));
CREATE TABLE thin_storage_qualification_samples (
  run_id TEXT NOT NULL REFERENCES thin_storage_qualification_runs(id) ON DELETE CASCADE,
  nonce TEXT NOT NULL CHECK (length(nonce) = 32 AND nonce NOT GLOB '*[^a-f0-9]*'),
  -- The answered nonce's issue and the sample's receipt, both on Cloudflare's clock.
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  scrape_milliseconds INTEGER NOT NULL CHECK (scrape_milliseconds BETWEEN 0 AND 600000),
  PRIMARY KEY (run_id, nonce),
  CHECK (received_at >= observed_at)
) STRICT;
-- Evidence of an ended run never changes.
CREATE TRIGGER thin_storage_qualification_samples_running BEFORE INSERT ON thin_storage_qualification_samples
WHEN NOT EXISTS (SELECT 1 FROM thin_storage_qualification_runs q WHERE q.id = NEW.run_id AND q.status = 'running')
BEGIN SELECT RAISE(ABORT, 'thin_storage_qualification_terminal'); END;
