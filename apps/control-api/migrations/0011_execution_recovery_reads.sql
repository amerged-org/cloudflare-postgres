CREATE INDEX projects_recovery_page_idx ON projects(organization_id, created_at DESC, id DESC);
CREATE INDEX roles_recovery_page_idx ON database_roles(organization_id, project_id, environment_id, created_at DESC, id DESC);
CREATE INDEX databases_recovery_page_idx ON logical_databases(organization_id, project_id, environment_id, created_at DESC, id DESC);
CREATE INDEX project_request_recovery_link_idx ON idempotency_requests(project_id, organization_id, operation_id);
CREATE INDEX environment_request_recovery_link_idx ON environment_requests(environment_id, organization_id, project_id, operation_id);
