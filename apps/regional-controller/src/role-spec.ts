// SPDX-License-Identifier: Apache-2.0
/** CNPG 1.30.1 omits these false booleans and empty slice on Go JSON writes.
 * Inherit defaults true and is a pointer: it deliberately stays mandatory.
 * This only normalizes absence, preserving null, wrong types, true and members.
 */
export function restrictedRoleSpec(
  value: unknown,
): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const spec = { ...value } as Record<string, unknown>;
  for (const key of [
    "superuser",
    "createdb",
    "createrole",
    "replication",
    "bypassrls",
  ])
    if (!Object.hasOwn(value, key)) spec[key] = false;
  if (!Object.hasOwn(value, "inRoles")) spec.inRoles = [];
  return spec;
}
