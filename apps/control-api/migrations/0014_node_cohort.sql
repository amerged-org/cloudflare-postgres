-- SPDX-License-Identifier: Apache-2.0
-- No historical workload is assigned a reconstructed node cohort.
ALTER TABLE environment_suspend_specs ADD COLUMN node_cohort_json TEXT CHECK (
  node_cohort_json IS NULL OR (
    json_valid(node_cohort_json) AND json_type(node_cohort_json) = 'object'
    AND json_type(node_cohort_json, '$.uid') = 'text'
    AND length(json_extract(node_cohort_json, '$.uid')) = 36
    AND json_type(node_cohort_json, '$.hash') = 'text'
    AND length(json_extract(node_cohort_json, '$.hash')) = 64
    AND json_extract(node_cohort_json, '$.hash') NOT GLOB '*[^a-f0-9]*'
  )
);

CREATE TRIGGER environment_node_tracking_policy
BEFORE INSERT ON environments
BEGIN
  SELECT RAISE(ABORT, 'node tracking requires initial execution fencing')
  WHERE json_type(NEW.resolved_spec, '$.profile.nodeTracking') IS NOT NULL
    AND NOT COALESCE(
      json_type(NEW.resolved_spec, '$.profile.nodeTracking') = 'object'
      AND json_extract(NEW.resolved_spec, '$.profile.nodeTracking.version') = 1
      AND (SELECT COUNT(*) FROM json_each(NEW.resolved_spec, '$.profile.nodeTracking')) = 1
      AND json_extract(NEW.resolved_spec, '$.profile.executionFencing.version') = 1
      AND NEW.run_epoch = '1', 0
    );
END;

-- The existing BEFORE UPDATE/DELETE snapshot guards cover the added column.
CREATE TRIGGER environment_suspend_node_cohort_ownership
BEFORE INSERT ON environment_suspend_specs
BEGIN
  SELECT RAISE(ABORT, 'suspend node cohort does not match ready environment')
  WHERE NOT EXISTS (
    SELECT 1 FROM environments e WHERE e.id = NEW.environment_id
    AND (
      (NEW.node_cohort_json IS NULL
        AND json_type(e.resolved_spec, '$.profile.nodeTracking') IS NULL
        AND json_type(e.observation_json, '$.nodeCohort') IS NULL)
      OR (NEW.node_cohort_json IS NOT NULL
        AND json_extract(e.resolved_spec, '$.profile.nodeTracking.version') = 1
        AND e.run_epoch = NEW.run_epoch
        AND (SELECT COUNT(*) FROM json_each(NEW.node_cohort_json)) = 2
        AND json_extract(e.observation_json, '$.nodeCohort.uid') = json_extract(NEW.node_cohort_json, '$.uid')
        AND json_extract(e.observation_json, '$.nodeCohort.hash') = json_extract(NEW.node_cohort_json, '$.hash'))
    )
  );
END;
