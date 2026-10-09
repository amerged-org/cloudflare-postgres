-- SPDX-License-Identifier: Apache-2.0
-- Thresholds are operator-selected; fresh policies have no expansion or warning threshold.
ALTER TABLE node_region_policies ADD COLUMN ram_expansion_threshold_ppm INTEGER
  CHECK(ram_expansion_threshold_ppm IS NULL OR
    (typeof(ram_expansion_threshold_ppm)='integer' AND ram_expansion_threshold_ppm BETWEEN 1 AND 1000000));
ALTER TABLE node_region_policies ADD COLUMN ram_warning_threshold_ppm INTEGER
  CHECK(ram_warning_threshold_ppm IS NULL OR
    (typeof(ram_warning_threshold_ppm)='integer' AND ram_warning_threshold_ppm BETWEEN 1 AND 1000000));
ALTER TABLE node_region_policies ADD COLUMN cap_warning_enabled INTEGER NOT NULL DEFAULT 0
  CHECK(cap_warning_enabled IN(0,1));

-- Preserve the prior expansion threshold only for already configured actual-RAM policies.
-- Purchase switches, provider profiles, approval hashes and recorded alert episodes are unchanged.
UPDATE node_region_policies SET ram_expansion_threshold_ppm=760000 WHERE placement_mode='actual_ram';
