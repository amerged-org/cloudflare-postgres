// SPDX-License-Identifier: Apache-2.0
// The ID schemas. The patterns and the checks are in `ids-core.ts`, which has no zod and is what the
// Edge loads; they are re-exported here, so this module's exports are what they were.
import { z } from "zod";
import {
  API_KEY_ID_PATTERN,
  DATABASE_ID_PATTERN,
  NODE_ID_PATTERN,
  OPERATION_ID_PATTERN,
  PROJECT_ID_PATTERN,
  REGION_ID_PATTERN,
  ROLE_NAME_PATTERN,
  SIZE_CLASS_ID_PATTERN,
  isReservedRoleName,
} from "./ids-core.ts";

export * from "./ids-core.ts";

export const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const LETTERS = "abcdefghijklmnopqrstuvwxyz";
export const ID_RANDOM_LENGTH = 20;

export const ID_PREFIXES = {
  project: "prj_",
  operation: "op_",
  apiKey: "key_",
  node: "nod_",
} as const;
export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

/** The CNPG owner role of every database (`initdb.owner`). */
export const OWNER_ROLE_NAME = "app";

export const ProjectId = z
  .string()
  .regex(PROJECT_ID_PATTERN)
  .meta({ id: "ProjectId" });
export type ProjectId = z.infer<typeof ProjectId>;

export const OperationId = z
  .string()
  .regex(OPERATION_ID_PATTERN)
  .meta({ id: "OperationId" });
export type OperationId = z.infer<typeof OperationId>;

export const ApiKeyId = z
  .string()
  .regex(API_KEY_ID_PATTERN)
  .meta({ id: "ApiKeyId" });
export type ApiKeyId = z.infer<typeof ApiKeyId>;

export const NodeId = z.string().regex(NODE_ID_PATTERN).meta({ id: "NodeId" });
export type NodeId = z.infer<typeof NodeId>;

export const DatabaseId = z
  .string()
  .regex(DATABASE_ID_PATTERN)
  .meta({ id: "DatabaseId" });
export type DatabaseId = z.infer<typeof DatabaseId>;

export const RegionId = z
  .string()
  .regex(REGION_ID_PATTERN)
  .meta({ id: "RegionId" });
export type RegionId = z.infer<typeof RegionId>;

export const SizeClassId = z
  .string()
  .regex(SIZE_CLASS_ID_PATTERN)
  .meta({ id: "SizeClassId" });
export type SizeClassId = z.infer<typeof SizeClassId>;

export const RoleName = z
  .string()
  .regex(ROLE_NAME_PATTERN)
  .refine((name) => !isReservedRoleName(name), {
    message: "reserved role name",
  })
  .meta({ id: "RoleName" });
export type RoleName = z.infer<typeof RoleName>;

/**
 * Uniform random string over `alphabet` from crypto.getRandomValues.
 * Bytes at or above the largest multiple of the alphabet size are rejected,
 * so every character is equally likely.
 */
export function randomString(alphabet: string, length: number): string {
  if (alphabet.length < 2 || alphabet.length > 256) {
    throw new RangeError("alphabet must have 2 to 256 characters");
  }
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  const buffer = new Uint8Array(Math.max(16, length * 2));
  while (out.length < length) {
    crypto.getRandomValues(buffer);
    for (const byte of buffer) {
      if (byte >= limit) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export function newId<P extends IdPrefix>(prefix: P): `${P}${string}` {
  return `${prefix}${randomString(ID_ALPHABET, ID_RANDOM_LENGTH)}`;
}

export const newProjectId = (): ProjectId => newId(ID_PREFIXES.project);
export const newOperationId = (): OperationId => newId(ID_PREFIXES.operation);
export const newApiKeyId = (): ApiKeyId => newId(ID_PREFIXES.apiKey);
export const newNodeId = (): NodeId => newId(ID_PREFIXES.node);

/** A database ID; it is also the PostgreSQL database name, so it starts with a letter. */
export function newDatabaseId(): DatabaseId {
  return (
    randomString(LETTERS, 1) + randomString(ID_ALPHABET, ID_RANDOM_LENGTH - 1)
  );
}
