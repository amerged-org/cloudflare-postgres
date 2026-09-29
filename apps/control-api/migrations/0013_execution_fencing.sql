-- SPDX-License-Identifier: Apache-2.0
-- Existing environments and immutable suspend snapshots retain a NULL epoch.
-- This initial protocol neither advances an epoch nor enables resume.
ALTER TABLE environments ADD COLUMN run_epoch TEXT CHECK (
  run_epoch IS NULL OR (
    length(run_epoch) BETWEEN 1 AND 19
    AND run_epoch NOT GLOB '*[^0-9]*'
    AND substr(run_epoch, 1, 1) GLOB '[1-9]'
  )
);
ALTER TABLE environment_suspend_specs ADD COLUMN run_epoch TEXT CHECK (
  run_epoch IS NULL OR (
    length(run_epoch) BETWEEN 1 AND 19
    AND run_epoch NOT GLOB '*[^0-9]*'
    AND substr(run_epoch, 1, 1) GLOB '[1-9]'
  )
);

CREATE TRIGGER environment_initial_run_epoch
BEFORE INSERT ON environments
BEGIN
  SELECT RAISE(ABORT, 'initial execution epoch does not match profile policy')
  WHERE NOT COALESCE(
    (json_type(NEW.resolved_spec, '$.profile.executionFencing') IS NULL AND NEW.run_epoch IS NULL)
    OR (
      json_type(NEW.resolved_spec, '$.profile.executionFencing') = 'object'
      AND json_extract(NEW.resolved_spec, '$.profile.executionFencing.version') = 1
      AND (SELECT COUNT(*) FROM json_each(NEW.resolved_spec, '$.profile.executionFencing')) = 1
      AND NEW.run_epoch = '1'
    ), 0
  );
END;

CREATE TRIGGER environment_run_epoch_immutable
BEFORE UPDATE OF run_epoch ON environments
BEGIN SELECT RAISE(ABORT, 'execution epoch is immutable in the initial protocol'); END;

-- The existing snapshot no-update trigger also covers this added column.
CREATE TRIGGER environment_suspend_run_epoch_ownership
BEFORE INSERT ON environment_suspend_specs
BEGIN
  SELECT RAISE(ABORT, 'suspend execution epoch does not match environment')
  WHERE NOT EXISTS (
    SELECT 1 FROM environments e
    WHERE e.id = NEW.environment_id AND e.run_epoch IS NEW.run_epoch
      AND json_extract(e.observation_json, '$.runEpoch') IS e.run_epoch
  );
END;
