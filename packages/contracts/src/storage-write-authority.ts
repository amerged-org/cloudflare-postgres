// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { DatabaseId } from "./ids.ts";
import { StorageLvmUuid } from "./database-storage.ts";
import { base64urlToBytes, bytesToBase64url } from "./encoding.ts";

export const STORAGE_AUTHORITY_PREFIX = "sa1";
export const STORAGE_AUTHORITY_DOMAIN = "pgcf-storage-authority/v1\n";
export const STORAGE_AUTHORITY_LEDGER_KEY = "write-authority";
export const STORAGE_PROTECTION_LEDGER_KEY = "storage-protection.json";
export const STORAGE_AUTHORITY_MAX_LENGTH = 4096;
export const STORAGE_AUTHORITY_MAX_SECONDS = 120;
export const STORAGE_AUTHORITY_SKEW_MS = 5000;
export const STORAGE_AUTHORITY_KEY_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
/** Deployment-pinned retained thick cohort; absence always requires a signed thin gate. */
export const LegacyStorageBinding = z.strictObject({
  database_id: DatabaseId,
  storage_uid: z.uuid(),
  namespace_uid: z.uuid(),
  cluster_uid: z.uuid(),
  physical_generation: z.number().int().positive(),
  volume_identity: z.strictObject({
    handle: z.string().regex(/^pvc-[a-f0-9-]{36}$/),
    claimUid: z.uuid(),
    volumeUid: z.uuid(),
    lvUuid: StorageLvmUuid.optional(),
  }),
});
export type LegacyStorageBinding = z.infer<typeof LegacyStorageBinding>;
export const LegacyStorageBindings = z
  .array(LegacyStorageBinding)
  .max(2000)
  .refine(
    (rows) => new Set(rows.map((row) => row.database_id)).size === rows.length,
    { message: "Legacy storage assignments must be unique" },
  );
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
export type StorageAuthorityCryptoKey = Awaited<
  ReturnType<typeof crypto.subtle.importKey>
>;

export function storageWriteClaimsValidAt(
  value: StorageWriteClaims,
  now: number,
): boolean {
  return (
    Number.isSafeInteger(now) &&
    now >= 0 &&
    value.iat <= now + STORAGE_AUTHORITY_SKEW_MS &&
    value.observed_at <= now + STORAGE_AUTHORITY_SKEW_MS &&
    value.observed_at >= now - STORAGE_AUTHORITY_MAX_SECONDS * 1000 &&
    value.iat >= value.observed_at - STORAGE_AUTHORITY_SKEW_MS &&
    value.exp > now &&
    value.exp > value.iat &&
    value.exp <= value.observed_at + value.guard_seconds * 1000
  );
}

export async function signStorageWriteAuthority(
  value: StorageWriteClaims,
  privateKey: StorageAuthorityCryptoKey,
  now = Date.now(),
): Promise<string> {
  const claims = StorageWriteClaims.parse(value);
  if (
    privateKey.type !== "private" ||
    privateKey.algorithm.name !== "Ed25519" ||
    !storageWriteClaimsValidAt(claims, now)
  )
    throw new Error("invalid_storage_authority_signing_input");
  const body = bytesToBase64url(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      privateKey,
      new TextEncoder().encode(STORAGE_AUTHORITY_DOMAIN + body),
    ),
  );
  const token = `${STORAGE_AUTHORITY_PREFIX}.${body}.${bytesToBase64url(signature)}`;
  if (token.length > STORAGE_AUTHORITY_MAX_LENGTH)
    throw new Error("storage_authority_too_large");
  return token;
}

export async function verifyStorageWriteAuthority(
  token: string,
  trusted: ReadonlyMap<string, StorageAuthorityCryptoKey>,
  now = Date.now(),
): Promise<StorageWriteClaims | null> {
  if (token.length > STORAGE_AUTHORITY_MAX_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== STORAGE_AUTHORITY_PREFIX) return null;
  const body = base64urlToBytes(parts[1]!),
    signature = base64urlToBytes(parts[2]!);
  if (
    !body ||
    !signature ||
    signature.length !== 64 ||
    bytesToBase64url(body) !== parts[1] ||
    bytesToBase64url(signature) !== parts[2]
  )
    return null;
  try {
    const parsed = StorageWriteClaims.safeParse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body),
      ),
    );
    if (!parsed.success || !storageWriteClaimsValidAt(parsed.data, now))
      return null;
    const key = trusted.get(parsed.data.kid);
    if (
      !key ||
      key.type !== "public" ||
      key.algorithm.name !== "Ed25519" ||
      !(await crypto.subtle.verify(
        "Ed25519",
        key,
        // Own the decoded bytes at the WebCrypto boundary (never a SharedArrayBuffer view).
        new Uint8Array(signature).buffer,
        new TextEncoder().encode(STORAGE_AUTHORITY_DOMAIN + parts[1]),
      ))
    )
      return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/** Public trust material is hashed independently of JSON whitespace or property order. */
export function canonicalStorageAuthorityKeys(
  keys: Record<string, string>,
): string {
  const names = Object.keys(keys).sort();
  if (!names.length || names.length > 8)
    throw new Error("storage_authority_keys_invalid");
  for (const name of names) {
    const raw = base64urlToBytes(keys[name]!);
    if (
      !STORAGE_AUTHORITY_KEY_ID_PATTERN.test(name) ||
      !raw ||
      raw.length !== 32 ||
      bytesToBase64url(raw) !== keys[name]
    )
      throw new Error("storage_authority_keys_invalid");
  }
  return JSON.stringify(
    Object.fromEntries(names.map((name) => [name, keys[name]!])),
  );
}
