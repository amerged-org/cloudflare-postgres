// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { bytesToHex, newSecret } from "./encoding.ts";
import { ID_ALPHABET, REGION_ID_PATTERN, randomString } from "./ids.ts";
import type { RegionId } from "./ids.ts";

export const API_KEY_SCOPES = ["admin", "integrator"] as const;
export const ApiKeyScope = z.enum(API_KEY_SCOPES).meta({ id: "ApiKeyScope" });
export type ApiKeyScope = z.infer<typeof ApiKeyScope>;

export const API_KEY_LOOKUP_ID_LENGTH = 12;
export const SECRET_LENGTH = 43;

export const API_KEY_PATTERN = /^pgcf_sk_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;
// Region IDs contain no underscore, so the first underscore after the prefix ends the region ID.
export const AGENT_KEY_PATTERN = new RegExp(
  `^pgcf_ak_(${REGION_ID_PATTERN.source.slice(1, -1)})_([A-Za-z0-9_-]{43})$`,
);
export const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const ApiKeyString = z.string().regex(API_KEY_PATTERN);
export const AgentKeyString = z.string().regex(AGENT_KEY_PATTERN);

export interface ParsedApiKey {
  lookupId: string;
  secret: string;
}

export interface ParsedAgentKey {
  regionId: RegionId;
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

export function formatAgentKey(regionId: RegionId, secret: string): string {
  const key = `pgcf_ak_${regionId}_${secret}`;
  if (!AGENT_KEY_PATTERN.test(key))
    throw new TypeError("invalid agent key parts");
  return key;
}

export function parseAgentKey(key: string): ParsedAgentKey | null {
  const match = AGENT_KEY_PATTERN.exec(key);
  if (!match) return null;
  return { regionId: match[1]!, secret: match[2]! };
}

/** A fresh API key; only its hash is stored. */
export function newApiKey(): { lookupId: string; key: string } {
  const lookupId = randomString(ID_ALPHABET, API_KEY_LOOKUP_ID_LENGTH);
  return { lookupId, key: formatApiKey(lookupId, newSecret()) };
}

export function newAgentKey(regionId: RegionId): string {
  return formatAgentKey(regionId, newSecret());
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

/** Stored form of API and agent keys: hex(HMAC-SHA256(pepper, fullKey)). */
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
