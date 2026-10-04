-- SPDX-License-Identifier: Apache-2.0
ALTER TABLE nodes ADD COLUMN platform_reserved_cpu_millicores INTEGER
  CHECK (platform_reserved_cpu_millicores >= 0);
