-- SPDX-License-Identifier: Apache-2.0
ALTER TABLE regions ADD COLUMN bootstrap_material_revision INTEGER NOT NULL DEFAULT 1
  CHECK(typeof(bootstrap_material_revision)='integer'
    AND bootstrap_material_revision BETWEEN 1 AND 2147483647);

ALTER TABLE regions ADD COLUMN bootstrap_material_provenance_sha256 TEXT
  CHECK(bootstrap_material_provenance_sha256 IS NULL OR
    (typeof(bootstrap_material_provenance_sha256)='text'
      AND length(bootstrap_material_provenance_sha256)=64
      AND length(CAST(bootstrap_material_provenance_sha256 AS BLOB))=64
      AND NOT bootstrap_material_provenance_sha256 GLOB '*[^0-9a-f]*'));
