// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { DatabaseId, RegionId } from "./ids.ts";
import { gatewayPodUidSchema } from "./gateway-control.ts";
import { base64urlToBytes, bytesToBase64url } from "./encoding.ts";
import {
  GATEWAY_ACTIVITY_FIELDS,
  refineGatewayActivity,
} from "./node-local.ts";
import type { RouteKeyring } from "./route-token.ts";

export const GATEWAY_ACTIVITY_PATH = "/_pgcf/gateway/activity";
export const GATEWAY_ACTIVITY_HEADER = "X-PGCF-Activity";
export const GATEWAY_ACTIVITY_MAX_LENGTH = 1024;
export const GATEWAY_ACTIVITY_TOKEN_PREFIX = "ga1";
export const GATEWAY_ACTIVITY_MAX_LIFETIME_SECONDS = 30;
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const gatewayActivityClaimsSchema = z.strictObject({
  v: z.literal(1),
  region: RegionId,
  database: DatabaseId,
  revision: Count.positive(),
  pod: gatewayPodUidSchema,
  nonce: z.uuid(),
  kid: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/),
  iat: Count,
  exp: Count,
});
export type GatewayActivityClaims = z.infer<typeof gatewayActivityClaimsSchema>;
/**
 * The per-pod report of the Kubernetes era. The node's local channel carries the same counters
 * as `GatewayLocalActivityReport`, without region, database, revision and pod.
 */
export const gatewayActivityReportSchema = z
  .strictObject({
    region: RegionId,
    database: DatabaseId,
    revision: Count.positive(),
    pod: gatewayPodUidSchema,
    ...GATEWAY_ACTIVITY_FIELDS,
  })
  .superRefine(refineGatewayActivity);
export type GatewayActivityReport = z.infer<typeof gatewayActivityReportSchema>;
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const keyPurpose = "pgcf-gateway-activity-key/v1\n",
  signingPurpose = "pgcf-gateway-activity/v1\n";
export const GATEWAY_ACTIVITY_SIGNING_PURPOSE = signingPurpose;
export const GATEWAY_ACTIVITY_KEY_PURPOSE = keyPurpose;
async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, encoder.encode(value)),
  );
}
export async function signGatewayActivity(input: {
  keyring: RouteKeyring;
  region: string;
  database: string;
  revision: number;
  pod: string;
  now?: number;
  ttlSeconds?: number;
}): Promise<string> {
  const ttl = input.ttlSeconds ?? GATEWAY_ACTIVITY_MAX_LIFETIME_SECONDS,
    now = input.now ?? Date.now();
  if (
    !Number.isInteger(ttl) ||
    ttl < 1 ||
    ttl > GATEWAY_ACTIVITY_MAX_LIFETIME_SECONDS ||
    !Number.isFinite(now) ||
    now < 0
  )
    throw new Error("invalid activity lifetime");
  const key = input.keyring.keys.get(input.keyring.active);
  if (!key || key.length < 32) throw new Error("activity key unavailable");
  const iat = Math.floor(now / 1000),
    claims = gatewayActivityClaimsSchema.parse({
      v: 1,
      region: input.region,
      database: input.database,
      revision: input.revision,
      pod: input.pod,
      nonce: crypto.randomUUID(),
      kid: input.keyring.active,
      iat,
      exp: iat + ttl,
    });
  const payload = bytesToBase64url(encoder.encode(JSON.stringify(claims)));
  return `${GATEWAY_ACTIVITY_TOKEN_PREFIX}.${payload}.${bytesToBase64url(await hmac(await hmac(key, keyPurpose), signingPurpose + payload))}`;
}
export async function verifyGatewayActivity(
  value: unknown,
  expected: {
    keys: ReadonlyMap<string, Uint8Array>;
    region: string;
    pod: string;
    now?: number;
  },
): Promise<{ ok: true; claims: GatewayActivityClaims } | { ok: false }> {
  try {
    if (typeof value !== "string" || value.length > GATEWAY_ACTIVITY_MAX_LENGTH)
      return { ok: false };
    const parts = value.split(".");
    if (parts.length !== 3 || parts[0] !== GATEWAY_ACTIVITY_TOKEN_PREFIX)
      return { ok: false };
    const bytes = base64urlToBytes(parts[1]!),
      signature = base64urlToBytes(parts[2]!);
    if (
      !bytes ||
      !signature ||
      signature.length !== 32 ||
      bytesToBase64url(bytes) !== parts[1] ||
      bytesToBase64url(signature) !== parts[2]
    )
      return { ok: false };
    const parsed = gatewayActivityClaimsSchema.safeParse(
      JSON.parse(decoder.decode(bytes)),
    );
    if (!parsed.success) return { ok: false };
    const claims = parsed.data,
      key = expected.keys.get(claims.kid);
    if (!key || key.length < 32) return { ok: false };
    const wanted = await hmac(
      await hmac(key, keyPurpose),
      signingPurpose + parts[1],
    );
    let difference = 0;
    for (let index = 0; index < 32; index++)
      difference |= wanted[index]! ^ signature[index]!;
    const now = (expected.now ?? Date.now()) / 1000;
    if (
      difference !== 0 ||
      !Number.isFinite(now) ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > GATEWAY_ACTIVITY_MAX_LIFETIME_SECONDS ||
      now < claims.iat ||
      now >= claims.exp ||
      claims.region !== expected.region ||
      claims.pod !== expected.pod
    )
      return { ok: false };
    return { ok: true, claims };
  } catch {
    return { ok: false };
  }
}
