// SPDX-License-Identifier: Apache-2.0
// Edge-to-gateway routing token. Pure WebCrypto so it runs in Workers and Node.
//
// Token:      v1.<payloadB64u>.<sigB64u>
// Signature:  HMAC-SHA256(K, "pgcf-route/v1\n" + payloadB64u)
// Region key: K = HMAC-SHA256(master[kid], "pgcf-route-key/v1\n" + regionId)
//
// The edge holds the master keyring and signs; a gateway holds only the keyring
// derived for its own region, so a compromised gateway cannot mint tokens for
// any other region.
import { z } from "zod";
import { base64urlToBytes, bytesToBase64url } from "./encoding.ts";
import { DATABASE_ID_PATTERN, REGION_ID_PATTERN } from "./ids.ts";

export const ROUTE_TOKEN_HEADER = "X-PGCF-Route";
export const ROUTE_TOKEN_MAX_LENGTH = 512;
export const ROUTE_TOKEN_SIGN_TTL_SECONDS = 30;
export const ROUTE_TOKEN_MAX_LIFETIME_SECONDS = 60;
export const ROUTE_TOKEN_SKEW_SECONDS = 5;
export const ROUTE_KEY_MIN_BYTES = 32;

const TOKEN_PREFIX = "v1";
const SIGNATURE_DOMAIN = "pgcf-route/v1\n";
const KEY_DOMAIN = "pgcf-route-key/v1\n";
const SIGNATURE_BYTES = 32;

const kidPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const cidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const routeTokenClaimsSchema = z.strictObject({
  v: z.literal(1),
  db: z.string().regex(DATABASE_ID_PATTERN),
  cid: z.string().regex(cidPattern),
  rg: z.string().regex(REGION_ID_PATTERN),
  kid: z.string().regex(kidPattern),
  iat: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  exp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type RouteTokenClaims = z.infer<typeof routeTokenClaimsSchema>;

/** Keys are raw bytes by kid; `active` names the key used for signing. */
export interface RouteKeyring {
  readonly active: string;
  readonly keys: ReadonlyMap<string, Uint8Array>;
}

const keyringJsonSchema = z.strictObject({
  active: z.string().regex(kidPattern),
  keys: z.record(z.string().regex(kidPattern), z.string().max(1024)),
});

/**
 * Parses a keyring secret `{"active":"<kid>","keys":{"<kid>":"<base64url>"}}`.
 * The same shape holds master keys (edge) and derived region keys (gateway).
 * Throws on invalid configuration; the error never contains key material.
 */
export function parseRouteKeyring(json: string): RouteKeyring {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("invalid route keyring: not JSON");
  }
  const parsed = keyringJsonSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid route keyring: wrong shape");
  const keys = new Map<string, Uint8Array>();
  for (const [kid, encoded] of Object.entries(parsed.data.keys)) {
    const bytes = base64urlToBytes(encoded);
    if (bytes === null || bytes.length < ROUTE_KEY_MIN_BYTES)
      throw new Error(
        `invalid route keyring: key ${kid} must be base64url of at least ${ROUTE_KEY_MIN_BYTES} bytes`,
      );
    keys.set(kid, bytes);
  }
  if (!keys.has(parsed.data.active))
    throw new Error("invalid route keyring: active key missing");
  return { active: parsed.data.active, keys };
}

export function serializeRouteKeyring(keyring: RouteKeyring): string {
  const keys: Record<string, string> = {};
  for (const [kid, bytes] of keyring.keys) keys[kid] = bytesToBase64url(bytes);
  return JSON.stringify({ active: keyring.active, keys });
}

/** K = HMAC-SHA256(master, "pgcf-route-key/v1\n" + regionId), 32 raw bytes. */
export async function deriveRegionKey(
  master: Uint8Array,
  regionId: string,
): Promise<Uint8Array> {
  if (!REGION_ID_PATTERN.test(regionId))
    throw new RangeError("invalid region id");
  if (master.length < ROUTE_KEY_MIN_BYTES)
    throw new RangeError("master key too short");
  return hmac(master, KEY_DOMAIN + regionId);
}

/** Derives the keyring a gateway of `regionId` verifies with. */
export async function deriveRegionKeyring(
  master: RouteKeyring,
  regionId: string,
): Promise<RouteKeyring> {
  const keys = new Map<string, Uint8Array>();
  for (const [kid, bytes] of master.keys)
    keys.set(kid, await deriveRegionKey(bytes, regionId));
  return { active: master.active, keys };
}

export interface SignRouteTokenInput {
  /** Master keyring; the active key signs. */
  readonly keyring: RouteKeyring;
  readonly region: string;
  readonly db: string;
  readonly cid: string;
  /** Milliseconds since the epoch. */
  readonly now?: number;
  readonly ttlSeconds?: number;
}

export async function signRouteToken(
  input: SignRouteTokenInput,
): Promise<string> {
  const ttl = input.ttlSeconds ?? ROUTE_TOKEN_SIGN_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > ROUTE_TOKEN_SIGN_TTL_SECONDS)
    throw new RangeError("ttlSeconds must be an integer in 1..30");
  const master = input.keyring.keys.get(input.keyring.active);
  if (master === undefined) throw new RangeError("active key missing");
  const iat = Math.floor((input.now ?? Date.now()) / 1000);
  const claims = routeTokenClaimsSchema.safeParse({
    v: 1,
    db: input.db,
    cid: input.cid,
    rg: input.region,
    kid: input.keyring.active,
    iat,
    exp: iat + ttl,
  });
  if (!claims.success) throw new RangeError("invalid route token claims");
  const payload = bytesToBase64url(encoder.encode(JSON.stringify(claims.data)));
  const key = await deriveRegionKey(master, input.region);
  const signature = await hmac(key, SIGNATURE_DOMAIN + payload);
  return `${TOKEN_PREFIX}.${payload}.${bytesToBase64url(signature)}`;
}

export type RouteTokenFailure =
  | "missing"
  | "too_long"
  | "malformed"
  | "unknown_kid"
  | "bad_signature"
  | "invalid_claims"
  | "wrong_region"
  | "invalid_lifetime"
  | "not_yet_valid"
  | "expired";

export type RouteTokenResult =
  | { readonly ok: true; readonly claims: RouteTokenClaims }
  | { readonly ok: false; readonly reason: RouteTokenFailure };

export interface VerifyRouteTokenInput {
  /** Region keys by kid (the gateway's derived keyring). */
  readonly keys: ReadonlyMap<string, Uint8Array>;
  /** The region this verifier serves. */
  readonly region: string;
  /** Milliseconds since the epoch. */
  readonly now?: number;
}

/** Never throws on any token value; returns a reason code instead. */
export async function verifyRouteToken(
  token: string | null | undefined,
  input: VerifyRouteTokenInput,
): Promise<RouteTokenResult> {
  if (typeof token !== "string" || token.length === 0) return fail("missing");
  if (token.length > ROUTE_TOKEN_MAX_LENGTH) return fail("too_long");
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return fail("malformed");
  const payload = parts[1] as string;
  const payloadBytes = base64urlToBytes(payload);
  const signature = base64urlToBytes(parts[2] as string);
  if (
    payloadBytes === null ||
    payloadBytes.length === 0 ||
    signature === null ||
    signature.length !== SIGNATURE_BYTES
  )
    return fail("malformed");
  let decoded: unknown;
  try {
    decoded = JSON.parse(strictDecoder.decode(payloadBytes));
  } catch {
    return fail("malformed");
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded))
    return fail("malformed");
  const kid: unknown = (decoded as { kid?: unknown }).kid;
  if (typeof kid !== "string") return fail("malformed");
  const key = input.keys.get(kid);
  if (key === undefined || key.length < ROUTE_KEY_MIN_BYTES)
    return fail("unknown_kid");
  const expected = await hmac(key, SIGNATURE_DOMAIN + payload);
  if (!constantTimeEqual(expected, signature)) return fail("bad_signature");

  const claims = routeTokenClaimsSchema.safeParse(decoded);
  if (!claims.success) return fail("invalid_claims");
  const { rg, iat, exp } = claims.data;
  if (rg !== input.region) return fail("wrong_region");
  if (exp <= iat || exp - iat > ROUTE_TOKEN_MAX_LIFETIME_SECONDS)
    return fail("invalid_lifetime");
  const now = (input.now ?? Date.now()) / 1000;
  if (iat > now + ROUTE_TOKEN_SKEW_SECONDS) return fail("not_yet_valid");
  if (now > exp + ROUTE_TOKEN_SKEW_SECONDS) return fail("expired");
  return { ok: true, claims: claims.data };
}

export type ReplayCheck = "fresh" | "replayed" | "full";

/**
 * Single-use guard for token `cid`s inside one gateway replica. An entry lives
 * until its token can no longer verify (exp + skew), so a replay is always
 * caught; when the cache is full of live entries it fails closed.
 */
export class ReplayCache {
  readonly #maxEntries: number;
  readonly #expiries = new Map<string, number>();

  constructor(maxEntries = 50_000) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1)
      throw new RangeError("maxEntries must be a positive integer");
    this.#maxEntries = maxEntries;
  }

  get size(): number {
    return this.#expiries.size;
  }

  /** Records `cid` for a verified token with expiry `exp` (seconds). */
  use(cid: string, exp: number, now: number = Date.now()): ReplayCheck {
    this.#evictFront(now);
    if (this.#expiries.has(cid)) return "replayed";
    if (this.#expiries.size >= this.#maxEntries) {
      this.#evictAll(now);
      if (this.#expiries.size >= this.#maxEntries) return "full";
    }
    this.#expiries.set(cid, (exp + ROUTE_TOKEN_SKEW_SECONDS) * 1000);
    return "fresh";
  }

  // Insertion order roughly follows expiry, so trimming the front is cheap and
  // usually enough; a full sweep runs only when the cache is at capacity.
  #evictFront(now: number): void {
    for (const [cid, expiry] of this.#expiries) {
      if (expiry >= now) return;
      this.#expiries.delete(cid);
    }
  }

  #evictAll(now: number): void {
    for (const [cid, expiry] of this.#expiries)
      if (expiry < now) this.#expiries.delete(cid);
  }
}

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: false,
});

function fail(reason: RouteTokenFailure): RouteTokenResult {
  return { ok: false, reason };
}

async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message)),
  );
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
