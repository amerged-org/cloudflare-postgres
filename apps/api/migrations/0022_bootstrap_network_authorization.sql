-- SPDX-License-Identifier: Apache-2.0
ALTER TABLE node_bootstrap_jobs ADD COLUMN network_authorization_json TEXT
  CHECK(network_authorization_json IS NULL OR
    (json_valid(network_authorization_json) AND length(network_authorization_json)<=8192));

CREATE TRIGGER bootstrap_network_authorization_immutable
BEFORE UPDATE OF network_authorization_json ON node_bootstrap_jobs
WHEN OLD.network_authorization_json IS NOT NULL
  AND NEW.network_authorization_json IS NOT OLD.network_authorization_json
BEGIN SELECT RAISE(ABORT,'bootstrap_network_authorization_immutable'); END;
