-- SPDX-License-Identifier: Apache-2.0
-- NULL preserves the scheduling request of existing size classes (their CPU limit).
ALTER TABLE size_classes ADD COLUMN cpu_request_millicores INTEGER
  CHECK (cpu_request_millicores IS NULL OR
    (typeof(cpu_request_millicores) = 'integer' AND
      cpu_request_millicores > 0 AND cpu_request_millicores <= cpu_millicores));
