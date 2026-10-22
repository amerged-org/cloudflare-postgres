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

export const RESERVED_ROLE_NAMES: ReadonlySet<string> = new Set([
  "postgres",
  "streaming_replica",
]);
export const RESERVED_ROLE_PREFIXES = ["pg_", "cnpg_"] as const;

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
