// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { base64urlToBytes, bytesToHex, newSecret } from "./encoding.ts";
import { ID_ALPHABET, randomString } from "./ids.ts";

/**
 * `admin` changes anything; `admin_read` reads what an administrator reads and can change nothing;
 * `integrator` is bound to one project.
 */
export const API_KEY_SCOPES = ["admin", "admin_read", "integrator"] as const;
export const ApiKeyScope = z.enum(API_KEY_SCOPES).meta({
  id: "ApiKeyScope",
  description:
    "admin: every administrator operation. admin_read: the administrator's reads only; a request that is not a GET is refused with 403 whatever its route. integrator: bound to one project.",
});
export type ApiKeyScope = z.infer<typeof ApiKeyScope>;
/** The scopes of the operator's keys, which the audit log records. */
export const AdminScope = z.enum(["admin", "admin_read"]);
export type AdminScope = z.infer<typeof AdminScope>;
export const isAdminScope = (scope: ApiKeyScope): scope is AdminScope =>
  scope !== "integrator";

export const API_KEY_LOOKUP_ID_LENGTH = 12;
export const SECRET_LENGTH = 43;

export const API_KEY_PATTERN = /^pgcf_sk_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;
export const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const ApiKeyString = z.string().regex(API_KEY_PATTERN);

export const ROUTE_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
export const RouteKeyId = z.string().regex(ROUTE_KEY_ID_PATTERN);
export type RouteKeyId = z.infer<typeof RouteKeyId>;

const RegionRouteKey = z
  .string()
  .length(43)
  .refine((value) => base64urlToBytes(value)?.length === 32, {
    message: "routing keys must be canonical base64url of 32 bytes",
  });

/** The keys derived for one node's gateway; never the master keyring. */
export const RegionRouteKeyring = z
  .strictObject({
    active: RouteKeyId,
    keys: z.record(RouteKeyId, RegionRouteKey),
  })
  .refine((keyring) => Object.hasOwn(keyring.keys, keyring.active), {
    path: ["active"],
    message: "active routing key must be present",
  });
export type RegionRouteKeyring = z.infer<typeof RegionRouteKeyring>;

export interface ParsedApiKey {
  lookupId: string;
  secret: string;
}

export function formatApiKey(lookupId: string, secret: string): string {
  const key = `pgcf_sk_${lookupId}_${secret}`;
  if (!API_KEY_PATTERN.test(key)) throw new TypeError("invalid API key parts");
  return key;
}

export function parseApiKey(key: string): ParsedApiKey | null {
  const match = API_KEY_PATTERN.exec(key);
  if (!match) return null;
  return { lookupId: match[1]!, secret: match[2]! };
}

/** A fresh API key; only its hash is stored. */
export function newApiKey(): { lookupId: string; key: string } {
  const lookupId = randomString(ID_ALPHABET, API_KEY_LOOKUP_ID_LENGTH);
  return { lookupId, key: formatApiKey(lookupId, newSecret()) };
}

/** Database role passwords: 32 random bytes, base64url, safe in URIs without escaping. */
export const RolePassword = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export type RolePassword = z.infer<typeof RolePassword>;

export function newRolePassword(): RolePassword {
  return newSecret();
}

export async function hmacSha256Hex(
  key: string,
  message: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(message),
  );
  return bytesToHex(new Uint8Array(signature));
}

/** Stored form of API keys and enrollment tokens: hex(HMAC-SHA256(pepper, fullKey)). */
export async function hashApiKey(pepper: string, key: string): Promise<string> {
  if (pepper.length === 0) throw new TypeError("pepper must not be empty");
  return hmacSha256Hex(pepper, key);
}

/**
 * Constant-time string comparison. Runtime depends only on the longer input's
 * length, never on where the strings differ.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let i = 0; i < length; i += 1) {
    difference |=
      (i < a.length ? a.charCodeAt(i) : 0) ^
      (i < b.length ? b.charCodeAt(i) : 0);
  }
  return difference === 0;
}
