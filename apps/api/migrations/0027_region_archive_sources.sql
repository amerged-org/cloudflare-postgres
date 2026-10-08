-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE region_archive_sources (
  target_region_id TEXT NOT NULL REFERENCES regions(id),
  source_region_id TEXT NOT NULL REFERENCES regions(id),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
  bucket TEXT NOT NULL,
  endpoint_url TEXT NOT NULL,
  kid TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(target_region_id,source_region_id),
  CHECK(target_region_id<>source_region_id)
) STRICT;
