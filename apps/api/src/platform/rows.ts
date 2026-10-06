// SPDX-License-Identifier: Apache-2.0
import { ApiKey, Node, Project, Region, SizeClass } from "@pgcf/contracts";
export type Row = Record<string, unknown>;
export const projectRow = (row: Row): Project =>
  Project.parse({
    id: row.id,
    name: row.name,
    external_id: row.external_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
export const keyRow = (row: Row): ApiKey =>
  ApiKey.parse({
    id: row.id,
    scope: row.scope,
    project_id: row.project_id,
    name: row.name,
    lookup_id: row.lookup_id,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
  });
export const sizeRow = (row: Row): SizeClass =>
  SizeClass.parse({ ...row, enabled: row.enabled === 1 });
export const regionRow = (row: Row): Region =>
  Region.parse({
    id: row.id,
    provider: row.provider,
    provider_region: row.provider_region,
    gateway_url: row.gateway_url,
    gateway_binding: row.gateway_binding,
    backup_bucket: row.backup_bucket,
    backup_endpoint_url: row.backup_endpoint_url,
    agent_last_seen_at: row.agent_last_seen_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
export const nodeRow = (row: Row): Node =>
  Node.parse({
    ...row,
    platform_reserved_cpu_millicores:
      row.platform_reserved_cpu_millicores ?? null,
    ready: row.ready === 1,
    schedulable: row.schedulable === 1,
    database_placement_enabled: row.database_placement_enabled === 1,
    memory_window_valid: row.memory_window_valid === 1,
  });
