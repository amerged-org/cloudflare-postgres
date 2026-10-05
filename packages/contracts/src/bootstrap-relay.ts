// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { NodeId, OperationId, RegionId } from "./ids.ts";
import { base64urlToBytes, bytesToBase64url } from "./encoding.ts";

export const BOOTSTRAP_RELAY_PATH = "/_pgcf/bootstrap-relay";
export const BOOTSTRAP_RELAY_IDENTITY_PATH = `${BOOTSTRAP_RELAY_PATH}/identity`;
export const BOOTSTRAP_RELAY_HEADER = "X-PGCF-Bootstrap";
export const BOOTSTRAP_RELAY_TOKEN_MAX_LENGTH = 2048;
export const BOOTSTRAP_RELAY_MAX_TOKEN_SECONDS = 60;
export const bootstrapCapabilitySchema = z.enum([
  "rescue_ssh",
  "talos_api",
  "kubernetes_api",
]);
export type BootstrapCapability = z.infer<typeof bootstrapCapabilitySchema>;
export const BOOTSTRAP_PORTS: Readonly<Record<BootstrapCapability, number>> =
  Object.freeze({ rescue_ssh: 22, talos_api: 50000, kubernetes_api: 6443 });
const kid = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/);
export const bootstrapLiteralIpSchema = z
  .union([z.ipv4(), z.ipv6()])
  .refine((value) => !value.includes("%"));
export const bootstrapTargetRegionsSchema = z
  .array(RegionId)
  .min(1)
  .max(16)
  .refine((regions) => new Set(regions).size === regions.length);
const relayScopeFields = {
  v: z.literal(1),
  region: RegionId,
  issuer_region: RegionId,
  relay_epoch: z.uuid(),
};
export const bootstrapRelayIdentitySchema = z
  .strictObject({
    ...relayScopeFields,
    allowed_target_regions: bootstrapTargetRegionsSchema,
    capabilities: z
      .array(bootstrapCapabilitySchema)
      .min(1)
      .max(3)
      .refine(
        (capabilities) => new Set(capabilities).size === capabilities.length,
      ),
  })
  .refine((identity) => identity.issuer_region === identity.region);
export const bootstrapRelayClaimsSchema = z
  .strictObject({
    ...relayScopeFields,
    purpose: z.literal("bootstrap"),
    operation: OperationId,
    node: NodeId,
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    capability: bootstrapCapabilitySchema,
    target: z.strictObject({
      address: bootstrapLiteralIpSchema,
      port: z.union([z.literal(22), z.literal(50000), z.literal(6443)]),
    }),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
    kid,
    iat: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    exp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .refine(
    (claims) =>
      claims.target.port === BOOTSTRAP_PORTS[claims.capability] &&
      claims.exp > claims.iat &&
      claims.exp - claims.iat <= BOOTSTRAP_RELAY_MAX_TOKEN_SECONDS,
  );
export type BootstrapRelayClaims = z.infer<typeof bootstrapRelayClaimsSchema>;
export type BootstrapCryptoKey = Awaited<
  ReturnType<typeof crypto.subtle.importKey>
>;
export type BootstrapVerificationKeys = ReadonlyMap<string, BootstrapCryptoKey>;
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const purpose = "pgcf-bootstrap-relay/v1\n";
const validClock = (value: number) => Number.isSafeInteger(value) && value >= 0;

export async function importBootstrapVerificationKeys(
  input: unknown,
): Promise<BootstrapVerificationKeys> {
  const values = z
    .record(kid, z.string().regex(/^[A-Za-z0-9_-]{43}$/))
    .parse(input);
  const entries = Object.entries(values);
  if (entries.length < 1 || entries.length > 8)
    throw new Error("bootstrap_verification_keys_invalid");
  const keys = new Map<string, BootstrapCryptoKey>();
  for (const [name, value] of entries) {
    const bytes = base64urlToBytes(value);
    if (!bytes || bytes.length !== 32 || bytesToBase64url(bytes) !== value)
      throw new Error("bootstrap_verification_keys_invalid");
    keys.set(
      name,
      await crypto.subtle.importKey(
        "raw",
        Uint8Array.from(bytes),
        "Ed25519",
        false,
        ["verify"],
      ),
    );
  }
  return keys;
}

/** The Worker caller must first authorize the exact approved operation/node/checkpoint and actual endpoint. This library exposes no minting route. */
export async function signBootstrapRelay(input: {
  privateKey: BootstrapCryptoKey;
  kid: string;
  operation: string;
  node: string;
  region: string;
  issuer_region: string;
  relay_epoch: string;
  revision: number;
  capability: BootstrapCapability;
  address: string;
  now?: number;
  ttlSeconds?: number;
}): Promise<string> {
  const now = input.now ?? Date.now(),
    ttl = input.ttlSeconds ?? 30;
  if (
    !validClock(now) ||
    !Number.isInteger(ttl) ||
    ttl < 1 ||
    ttl > BOOTSTRAP_RELAY_MAX_TOKEN_SECONDS ||
    input.privateKey.type !== "private" ||
    input.privateKey.algorithm.name !== "Ed25519" ||
    !input.privateKey.usages.includes("sign")
  )
    throw new Error("bootstrap_signing_input_invalid");
  const iat = Math.floor(now / 1000);
  const claims = bootstrapRelayClaimsSchema.parse({
    v: 1,
    purpose: "bootstrap",
    operation: input.operation,
    node: input.node,
    region: input.region,
    issuer_region: input.issuer_region,
    relay_epoch: input.relay_epoch,
    revision: input.revision,
    capability: input.capability,
    target: { address: input.address, port: BOOTSTRAP_PORTS[input.capability] },
    nonce: bytesToBase64url(crypto.getRandomValues(new Uint8Array(24))),
    kid: input.kid,
    iat,
    exp: iat + ttl,
  });
  const payload = bytesToBase64url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    "Ed25519",
    input.privateKey,
    encoder.encode(purpose + payload),
  );
  return `br1.${payload}.${bytesToBase64url(new Uint8Array(signature))}`;
}

export async function verifyBootstrapRelay(
  token: unknown,
  expected: {
    keys: BootstrapVerificationKeys;
    /** Actual relay/issuer region; claims.region is the target region. */
    region: string;
    issuer_region: string;
    relay_epoch: string;
    allowedTargetRegions: readonly string[];
    now?: number;
  },
): Promise<{ ok: true; claims: BootstrapRelayClaims } | { ok: false }> {
  try {
    if (
      typeof token !== "string" ||
      token.length > BOOTSTRAP_RELAY_TOKEN_MAX_LENGTH
    )
      return { ok: false };
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "br1") return { ok: false };
    const payload = base64urlToBytes(parts[1]!),
      signature = base64urlToBytes(parts[2]!);
    if (
      !payload ||
      !signature ||
      signature.length !== 64 ||
      bytesToBase64url(payload) !== parts[1] ||
      bytesToBase64url(signature) !== parts[2]
    )
      return { ok: false };
    const parsed = bootstrapRelayClaimsSchema.safeParse(
      JSON.parse(decoder.decode(payload)),
    );
    if (
      !parsed.success ||
      bytesToBase64url(encoder.encode(JSON.stringify(parsed.data))) !== parts[1]
    )
      return { ok: false };
    const claims = parsed.data,
      key = expected.keys.get(claims.kid),
      now = expected.now ?? Date.now();
    if (
      !validClock(now) ||
      !key ||
      key.type !== "public" ||
      key.algorithm.name !== "Ed25519" ||
      !key.usages.includes("verify") ||
      now / 1000 < claims.iat ||
      now / 1000 >= claims.exp
    )
      return { ok: false };
    if (
      !(await crypto.subtle.verify(
        "Ed25519",
        key,
        Uint8Array.from(signature),
        encoder.encode(purpose + parts[1]),
      ))
    )
      return { ok: false };
    const allowed = bootstrapTargetRegionsSchema.safeParse(
      expected.allowedTargetRegions,
    );
    if (
      !allowed.success ||
      expected.issuer_region !== expected.region ||
      claims.issuer_region !== expected.region ||
      claims.relay_epoch !== expected.relay_epoch ||
      !allowed.data.includes(claims.region)
    )
      return { ok: false };
    return { ok: true, claims };
  } catch {
    return { ok: false };
  }
}
