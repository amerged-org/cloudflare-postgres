// SPDX-License-Identifier: Apache-2.0
// Edge-to-gateway routing tokens: the zod schemas of the claims and of the keyring, and the
// verification that uses them. Pure WebCrypto so they run in Workers and Node.
//
// The wire format, the constants, the keyring, key derivation and signing are in
// `route-token-core.ts`, which has no zod and is what the Edge loads; they are re-exported here,
// so this module's exports are what they were. The schemas are authoritative: the core's claim and
// keyring checks are held to them on the shared vectors (`test/zod-free-core.test.ts`).
import { z } from "zod";
import { base64urlToBytes } from "./encoding.ts";
import {
  DATABASE_ID_PATTERN,
  NodeId,
  OperationId,
  REGION_ID_PATTERN,
  RoleName,
} from "./ids.ts";
import {
  CID_PATTERN,
  KID_PATTERN,
  ROLE_REVISION_HASH_PATTERN,
  ROUTE_KEY_MIN_BYTES,
  ROUTE_TOKEN_MAX_LENGTH,
  ROUTE_TOKEN_MAX_LIFETIME_SECONDS,
  ROUTE_TOKEN_NODE_PREFIX,
  ROUTE_TOKEN_NODE_SIGNATURE_DOMAIN,
  ROUTE_TOKEN_SIGNATURE_BYTES,
  ROUTE_TOKEN_SKEW_SECONDS,
  ROUTE_TOKEN_WAKE_PREFIX,
  ROUTE_TOKEN_WAKE_SIGNATURE_DOMAIN,
  hmac,
  type NodeRouteTokenClaims,
  type WakeRouteTokenClaims,
} from "./route-token-core.ts";

export {
  ROUTE_KEY_MIN_BYTES,
  ROUTE_TOKEN_HEADER,
  ROUTE_TOKEN_MAX_LENGTH,
  ROUTE_TOKEN_MAX_LIFETIME_SECONDS,
  ROUTE_TOKEN_NODE_KEY_DOMAIN,
  ROUTE_TOKEN_NODE_PREFIX,
  ROUTE_TOKEN_NODE_SIGNATURE_DOMAIN,
  ROUTE_TOKEN_SIGN_TTL_SECONDS,
  ROUTE_TOKEN_SIGNATURE_BYTES,
  ROUTE_TOKEN_SKEW_SECONDS,
  ROUTE_TOKEN_WAKE_PREFIX,
  ROUTE_TOKEN_WAKE_SIGNATURE_DOMAIN,
  deriveNodeKey,
  deriveNodeKeyring,
  parseRouteKeyring,
  roleRevisionHash,
  serializeRouteKeyring,
  signNodeRouteToken,
  signWakeRouteToken,
  type NodeRouteTokenClaims,
  type RouteKeyring,
  type SignNodeRouteTokenInput,
  type SignRouteInput,
  type SignWakeRouteTokenInput,
  type WakeRouteTokenClaims,
} from "./route-token-core.ts";

const connectionClaims = {
  db: z.string().regex(DATABASE_ID_PATTERN),
  user: RoleName,
  cid: z.string().regex(CID_PATTERN),
  rg: z.string().regex(REGION_ID_PATTERN),
  kid: z.string().regex(KID_PATTERN),
  iat: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  exp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};
const Revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const RoleRevisionHash = z.string().regex(ROLE_REVISION_HASH_PATTERN);
/**
 * The route to a node: the database generation, the admission route revision, the node and the
 * invocation ID of the PostgreSQL unit that serves the database (`UnitWriter.instance`).
 */
export const nodeRouteTokenClaimsSchema = z.strictObject({
  v: z.literal(6),
  ...connectionClaims,
  rev: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  route_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  node: NodeId,
  inst: z.string().regex(CID_PATTERN),
});
/** A wake ticket: the operation, the claimed generation, the route revision and the role hash. */
export const wakeRouteTokenClaimsSchema = z.strictObject({
  v: z.literal(5),
  ...connectionClaims,
  op: OperationId,
  /** The generation the wake claims in D1: the Actor snapshot's generation + 1. */
  gen: Revision,
  route_revision: Revision,
  /** roleRevisionHash of the Actor snapshot's roles. */
  rh: RoleRevisionHash,
});

/** The shape of a keyring secret: the kid of the signing key and the keys by kid, base64url. */
export const routeKeyringJsonSchema = z.strictObject({
  active: z.string().regex(KID_PATTERN),
  keys: z.record(z.string().regex(KID_PATTERN), z.string().max(1024)),
});

export type RouteTokenFailure =
  | "missing"
  | "too_long"
  | "malformed"
  | "unknown_kid"
  | "bad_signature"
  | "invalid_claims"
  | "wrong_region"
  | "wrong_node"
  | "invalid_lifetime"
  | "not_yet_valid"
  | "expired"
  | "invalid_time";

export type RouteTokenResult =
  | {
      readonly ok: true;
      readonly claims: WakeRouteTokenClaims | NodeRouteTokenClaims;
    }
  | { readonly ok: false; readonly reason: RouteTokenFailure };

export interface VerifyRouteTokenInput {
  /** The keys by kid (the gateway's node keyring). */
  readonly keys: ReadonlyMap<string, Uint8Array>;
  /** The region this verifier serves. */
  readonly region: string;
  /** The node this verifier serves; a v6 route names its node, and another one is refused. */
  readonly node?: string;
  /** Milliseconds since the epoch. */
  readonly now?: number;
}

/** Never throws on any token value; returns a reason code instead. */
export async function verifyRouteToken(
  token: string | null | undefined,
  input: VerifyRouteTokenInput,
): Promise<RouteTokenResult> {
  const time = input.now ?? Date.now();
  if (!Number.isFinite(time)) return fail("invalid_time");
  if (typeof token !== "string" || token.length === 0) return fail("missing");
  if (token.length > ROUTE_TOKEN_MAX_LENGTH) return fail("too_long");
  const parts = token.split(".");
  const wake = parts[0] === ROUTE_TOKEN_WAKE_PREFIX;
  const node = parts[0] === ROUTE_TOKEN_NODE_PREFIX;
  if (parts.length !== 3 || (!wake && !node)) return fail("malformed");
  const payload = parts[1] as string;
  const payloadBytes = base64urlToBytes(payload);
  const signature = base64urlToBytes(parts[2] as string);
  if (
    payloadBytes === null ||
    payloadBytes.length === 0 ||
    signature === null ||
    signature.length !== ROUTE_TOKEN_SIGNATURE_BYTES
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
  const expected = await hmac(
    key,
    (wake
      ? ROUTE_TOKEN_WAKE_SIGNATURE_DOMAIN
      : ROUTE_TOKEN_NODE_SIGNATURE_DOMAIN) + payload,
  );
  if (!constantTimeEqual(expected, signature)) return fail("bad_signature");

  const claims = (
    wake ? wakeRouteTokenClaimsSchema : nodeRouteTokenClaimsSchema
  ).safeParse(decoded);
  if (!claims.success) return fail("invalid_claims");
  const { rg, iat, exp } = claims.data;
  if (rg !== input.region) return fail("wrong_region");
  if (
    input.node !== undefined &&
    "node" in claims.data &&
    claims.data.node !== input.node
  )
    return fail("wrong_node");
  if (exp <= iat || exp - iat > ROUTE_TOKEN_MAX_LIFETIME_SECONDS)
    return fail("invalid_lifetime");
  const now = time / 1000;
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
interface ReplayPartition {
  readonly entries: Map<string, number>;
  latestExpiry: number;
}

export class ReplayCache {
  readonly #maxEntries: number;
  readonly #databases = new Map<string, ReplayPartition>();

  constructor(maxEntries = 50_000) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1)
      throw new RangeError("maxEntries must be a positive integer");
    this.#maxEntries = maxEntries;
  }

  get size(): number {
    let size = 0;
    for (const partition of this.#databases.values())
      size += partition.entries.size;
    return size;
  }

  /** Records one verified token in its database's independent capacity. */
  use(
    database: string,
    cid: string,
    exp: number,
    now: number = Date.now(),
  ): ReplayCheck {
    if (!Number.isFinite(now) || !Number.isFinite(exp)) return "full";
    this.#evict(now);
    const expiry = (exp + ROUTE_TOKEN_SKEW_SECONDS) * 1000;
    // Never retain already expired entries, including after a clock boundary.
    if (
      expiry < now ||
      expiry - now >
        (ROUTE_TOKEN_MAX_LIFETIME_SECONDS + 2 * ROUTE_TOKEN_SKEW_SECONDS) * 1000
    )
      return "full";
    let partition = this.#databases.get(database);
    if (!partition) {
      partition = { entries: new Map(), latestExpiry: expiry };
      this.#databases.set(database, partition);
    }
    const entries = partition.entries;
    // Most tokens expire in insertion order. Sweep only this partition at its cap.
    for (const [existing, until] of entries) {
      if (until >= now) break;
      entries.delete(existing);
    }
    if (entries.size >= this.#maxEntries)
      for (const [existing, until] of entries)
        if (until < now) entries.delete(existing);
    const existingExpiry = entries.get(cid);
    if (existingExpiry !== undefined && existingExpiry < now)
      entries.delete(cid);
    if (entries.has(cid)) return "replayed";
    if (entries.size >= this.#maxEntries) return "full";
    entries.set(cid, expiry);
    partition.latestExpiry = Math.max(partition.latestExpiry, expiry);
    return "fresh";
  }

  #evict(now: number): void {
    for (const [database, partition] of this.#databases)
      if (partition.latestExpiry < now) this.#databases.delete(database);
  }
}

const strictDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: false,
});

function fail(reason: RouteTokenFailure): RouteTokenResult {
  return { ok: false, reason };
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
