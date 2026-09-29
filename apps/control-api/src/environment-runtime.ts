// SPDX-License-Identifier: Apache-2.0
// The alias comes only from first-party query definitions, never HTTP input.
export function environmentNotDeleting(alias: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(alias))
    throw new Error("runtime_query_alias_invalid");
  return `NOT EXISTS (SELECT 1 FROM environment_deletions deletion WHERE deletion.environment_id = ${alias}.id)`;
}
export function runtimeAllowsExecution(alias: string): string {
  return `${environmentNotDeleting(alias)} AND NOT EXISTS (SELECT 1 FROM environment_runtime rt WHERE rt.environment_id = ${alias}.id AND (rt.desired_state <> 'running' OR rt.phase <> 'running'))`;
}
export function environmentRunning(alias: string): string {
  return `(${alias}.status = 'ready' AND ${runtimeAllowsExecution(alias)})`;
}
