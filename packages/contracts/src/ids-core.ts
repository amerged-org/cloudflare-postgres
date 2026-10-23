// SPDX-License-Identifier: Apache-2.0
// The ID patterns and checks, without zod. The Edge loads this module and not `ids.ts`, because a
// fresh isolate pays for every byte of zod it evaluates; `ids.ts` keeps the schemas, re-exports
// this module, and `test/zod-free-core.test.ts` holds each check to its schema.

export const PROJECT_ID_PATTERN = /^prj_[a-z0-9]{20}$/;
export const OPERATION_ID_PATTERN = /^op_[a-z0-9]{20}$/;
export const API_KEY_ID_PATTERN = /^key_[a-z0-9]{20}$/;
export const NODE_ID_PATTERN = /^nod_[a-z0-9]{20}$/;
export const DATABASE_ID_PATTERN = /^[a-z][a-z0-9]{19}$/;
export const REGION_ID_PATTERN = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
export const SIZE_CLASS_ID_PATTERN = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
export const ROLE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

// What a customer role cannot take. Two names are the node's own: `postgres`, the superuser the
// node agent runs as, and `pgcf_backup`, the role barman's base backups log in as, which the node
// agent creates and never restores (a customer role of that name would be altered, lose its backup
// privileges and could not be dropped). Two names PostgreSQL itself refuses in `CREATE ROLE`, quoted
// or not: `public` and `none` ("role name is reserved"); a role of either name would fail the role
// step of its database at every start. PostgreSQL also reserves the `pg_` prefix of its predefined
// roles. The role names of the Kubernetes runtime (`streaming_replica`, `cnpg_*`,
// `pgcf_maintenance`) mean nothing on a node and are ordinary names, and so are the keywords that
// PostgreSQL accepts as a quoted role name (`current_user`, `session_user`, `current_role`).
export const RESERVED_ROLE_NAMES: ReadonlySet<string> = new Set([
  "postgres",
  "pgcf_backup",
  "public",
  "none",
]);
export const RESERVED_ROLE_PREFIXES = ["pg_"] as const;

export function isReservedRoleName(name: string): boolean {
  return (
    RESERVED_ROLE_NAMES.has(name) ||
    RESERVED_ROLE_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

const matches =
  (pattern: RegExp) =>
  (value: unknown): value is string =>
    typeof value === "string" && pattern.test(value);

export const isProjectId = matches(PROJECT_ID_PATTERN);
export const isOperationId = matches(OPERATION_ID_PATTERN);
export const isApiKeyId = matches(API_KEY_ID_PATTERN);
export const isNodeId = matches(NODE_ID_PATTERN);
export const isDatabaseId = matches(DATABASE_ID_PATTERN);
export const isRegionId = matches(REGION_ID_PATTERN);
export const isSizeClassId = matches(SIZE_CLASS_ID_PATTERN);
export const isRoleName = (value: unknown): value is string =>
  typeof value === "string" &&
  ROLE_NAME_PATTERN.test(value) &&
  !isReservedRoleName(value);
