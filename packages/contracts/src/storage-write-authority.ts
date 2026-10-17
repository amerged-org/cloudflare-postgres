// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { DatabaseId } from "./ids.ts";
import { StorageLvmUuid } from "./database-storage.ts";

export const STORAGE_AUTHORITY_PREFIX = "sa1";
export const STORAGE_AUTHORITY_DOMAIN = "pgcf-storage-authority/v1\n";
export const STORAGE_AUTHORITY_MAX_LENGTH = 4096;
export const STORAGE_AUTHORITY_MAX_SECONDS = 120;
export const STORAGE_AUTHORITY_SKEW_MS = 5000;
export const STORAGE_AUTHORITY_KEY_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const Integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Flat generated wire schema; semantic clock/binding checks follow signature verification. */
export const StorageWriteClaims = z.strictObject({
  v: z.literal(1),
  kid: z.string().regex(STORAGE_AUTHORITY_KEY_ID_PATTERN),
  database_id: DatabaseId,
  generation: Integer.positive(),
  authority_revision: Integer.positive(),
  storage_uid: z.uuid(),
  node_uid: z.uuid(),
  volume_group_uuid: StorageLvmUuid,
  pool_uuid: StorageLvmUuid,
  profile_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  volume_handle: z.string().regex(/^pvc-[a-f0-9-]{36}$/),
  lv_uuid: StorageLvmUuid,
  pvc_uid: z.uuid(),
  pv_uid: z.uuid(),
  pod_uid: z.uuid(),
  observed_at: Integer,
  iat: Integer,
  exp: Integer,
  guard_seconds: Integer.positive().max(STORAGE_AUTHORITY_MAX_SECONDS),
  drain_seconds: Integer.positive().max(STORAGE_AUTHORITY_MAX_SECONDS),
  write_allowed: z.boolean(),
});
export type StorageWriteClaims = z.infer<typeof StorageWriteClaims>;
