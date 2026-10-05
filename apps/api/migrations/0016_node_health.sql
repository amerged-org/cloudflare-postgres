-- SPDX-License-Identifier: Apache-2.0
ALTER TABLE nodes ADD COLUMN lost_at TEXT;
ALTER TABLE nodes ADD COLUMN lost_reason TEXT CHECK(lost_reason IS NULL OR length(lost_reason) BETWEEN 1 AND 500);
CREATE INDEX nodes_active_region_idx ON nodes(region_id) WHERE lost_at IS NULL;
CREATE TRIGGER lost_node_identity_immutable BEFORE UPDATE ON nodes
WHEN OLD.lost_at IS NOT NULL AND (
  NEW.lost_at IS NOT OLD.lost_at OR NEW.lost_reason IS NOT OLD.lost_reason
  OR NEW.node_uid IS NOT OLD.node_uid OR NEW.provider_instance_id IS NOT OLD.provider_instance_id
  OR NEW.k8s_node_name IS NOT OLD.k8s_node_name OR NEW.region_id<>OLD.region_id
  OR NEW.ready<>0 OR NEW.schedulable<>0)
BEGIN SELECT RAISE(ABORT,'lost_node_identity_immutable'); END;
