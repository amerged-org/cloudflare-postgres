// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { DatabaseId, OperationId } from "./ids.ts";
import { PoolThinPhysicalStorage } from "./postgres-pool.ts";
import {
  STORAGE_AUTHORITY_KEY_ID_PATTERN,
  type StorageAuthorityCryptoKey,
} from "./storage-write-authority.ts";
import { base64urlToBytes, bytesToBase64url } from "./encoding.ts";
export const POOL_CLEANUP_PREFIX = "pc1";
export const POOL_CLEANUP_DOMAIN = "pgcf-pool-cleanup/v1\n";
export const POOL_CLEANUP_MAX_LENGTH = 8192;
export const POOL_CLEANUP_MAX_MS = 120000;
const Safe = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  Positive = Safe.positive(),
  Hash = z.string().regex(/^[a-f0-9]{64}$/);
/** A finite drain/unmount grant backed by the LV's full allocation reserve.
 * The reserve is not a total BIO write-byte cap; metadata/swap bypass io.max.
 * It never grants tenant, postmaster or bundle startup. */
export const PoolCleanupClaims = z.strictObject({
  v: z.literal(1),
  kid: z.string().regex(STORAGE_AUTHORITY_KEY_ID_PATTERN),
  binding_id: z.uuid(),
  scope_sha256: Hash,
  holder_revision: Positive,
  operation_id: OperationId,
  cleanup_io_sha256: Hash,
  holder_generation: Positive,
  database_generation: Positive,
  operation_target_generation: Positive,
  authority_revision: Positive,
  database_id: DatabaseId,
  node_uid: z.uuid(),
  boot_id: z.uuid(),
  storage: PoolThinPhysicalStorage,
  device_major: Safe.max(4294967295),
  device_minor: Safe.max(4294967295),
  allocation_reserve_bytes: Positive,
  cleanup_mode: z.literal("drain_unmount"),
  write_bytes_per_second: Positive,
  write_iops_per_second: Positive,
  iat: Safe,
  exp: Safe,
});
export type PoolCleanupClaims = z.infer<typeof PoolCleanupClaims>;
export function poolCleanupValidAt(
  claims: PoolCleanupClaims,
  now: number,
): boolean {
  return (
    Number.isSafeInteger(now) &&
    now >= 0 &&
    claims.iat <= now + 5000 &&
    claims.exp > now &&
    claims.exp > claims.iat &&
    claims.exp <=
      claims.iat +
        Math.min(
          POOL_CLEANUP_MAX_MS,
          claims.storage.profile.drain_seconds * 1000,
        ) &&
    claims.write_bytes_per_second <=
      claims.storage.profile.write_bytes_per_second &&
    claims.write_iops_per_second <=
      claims.storage.profile.write_iops_per_second &&
    claims.storage.profile.node_uid === claims.node_uid &&
    claims.storage.profile.volume_group_uuid ===
      claims.storage.volume_group_uuid
  );
}
export async function signPoolCleanupAuthority(
  value: PoolCleanupClaims,
  key: StorageAuthorityCryptoKey,
  now = Date.now(),
): Promise<string> {
  const claims = PoolCleanupClaims.parse(value);
  if (
    key.type !== "private" ||
    key.algorithm.name !== "Ed25519" ||
    !poolCleanupValidAt(claims, now)
  )
    throw new Error("invalid_pool_cleanup_authority");
  const body = bytesToBase64url(
      new TextEncoder().encode(JSON.stringify(claims)),
    ),
    signature = new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        key,
        new TextEncoder().encode(POOL_CLEANUP_DOMAIN + body),
      ),
    );
  const token = `${POOL_CLEANUP_PREFIX}.${body}.${bytesToBase64url(signature)}`;
  if (token.length > POOL_CLEANUP_MAX_LENGTH)
    throw new Error("pool_cleanup_authority_too_large");
  return token;
}
export async function verifyPoolCleanupAuthority(
  token: string,
  keys: ReadonlyMap<string, StorageAuthorityCryptoKey>,
  now = Date.now(),
): Promise<PoolCleanupClaims | null> {
  if (token.length > POOL_CLEANUP_MAX_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== POOL_CLEANUP_PREFIX) return null;
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
    const parsed = PoolCleanupClaims.safeParse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body),
      ),
    );
    if (!parsed.success || !poolCleanupValidAt(parsed.data, now)) return null;
    const key = keys.get(parsed.data.kid);
    if (
      !key ||
      key.type !== "public" ||
      key.algorithm.name !== "Ed25519" ||
      !(await crypto.subtle.verify(
        "Ed25519",
        key,
        new Uint8Array(signature).buffer,
        new TextEncoder().encode(POOL_CLEANUP_DOMAIN + parts[1]),
      ))
    )
      return null;
    return parsed.data;
  } catch {
    return null;
  }
}
