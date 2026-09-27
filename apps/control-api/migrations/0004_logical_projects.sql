ALTER TABLE operations ADD COLUMN observed_at TEXT;
ALTER TABLE operations ADD COLUMN result_code TEXT;

-- Before this migration, project.create contained only a name and the Worker
-- had no regional claim or execution path. Convert only the old pending/queued
-- pair with exactly one operation for the project. Other states remain untouched
-- for operator review instead of being presented as completed work.
UPDATE operations
SET status = 'succeeded',
    observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    result_code = 'logical_container_created'
WHERE kind = 'project.create'
  AND status = 'queued'
  AND EXISTS (
    SELECT 1 FROM projects AS project
    WHERE project.id = operations.project_id
      AND project.organization_id = operations.organization_id
      AND project.status = 'pending'
  )
  AND (
    SELECT COUNT(*) FROM operations AS related
    WHERE related.project_id = operations.project_id
      AND related.organization_id = operations.organization_id
  ) = 1;

UPDATE projects
SET status = 'active'
WHERE status = 'pending'
  AND EXISTS (
    SELECT 1 FROM operations AS operation
    WHERE operation.project_id = projects.id
      AND operation.organization_id = projects.organization_id
      AND operation.kind = 'project.create'
      AND operation.status = 'succeeded'
      AND operation.result_code = 'logical_container_created'
  )
  AND (
    SELECT COUNT(*) FROM operations AS related
    WHERE related.project_id = projects.id
      AND related.organization_id = projects.organization_id
  ) = 1;
