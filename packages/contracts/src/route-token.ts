// SPDX-License-Identifier: Apache-2.0
// Edge-to-gateway routing tokens. Pure WebCrypto so they run in Workers and Node.
//
// A route is signed for one node and verified only by that node's gateway:
//   Token:      <prefix>.<payloadB64u>.<sigB64u>
//   Signature:  HMAC-SHA256(K, "pgcf-route/<prefix>\n" + payloadB64u)
//   Node key:   K = HMAC-SHA256(master[kid], "pgcf-route-key/v2\n" + nodeId)
// The Edge holds the master keyring and signs; a gateway holds only the keyring derived for its
// own node, so a compromised node cannot mint a token for any other node.
//
// A v6 token is the route to an awake database (ULTRA plan 5.3, 5.8): it names the database
// generation the node runs, the admission route revision, the node and the invocation ID of the
// PostgreSQL unit that serves the database. The gateway admits it only on the unit its table shows.
//
// A v5 token is the Edge's wake ticket for a sleeping database: it carries the wake operation, the
// generation the wake claims in D1, the admission route revision and a hash of the role revisions,
// and no unit, because the unit does not exist when it is signed. `v: 5` is the wake flag; v5 is
// issued only for a wake ticket. The gateway routes a released ticket as the v6 route of the unit
// the agent started. Rust: packages/native-protocol (route.rs, wake.rs).
//
// The routes of the Kubernetes runtime (v2 to v4, keyed per region and naming a Pod) are deleted.
import { z } from "zod";
import { type DatabaseWakeTicket } from "./database-admission.ts";
import { base64urlToBytes, bytesToBase64url } from "./encoding.ts";
import {
  NODE_ID_PATTERN,
  NodeId,
  OperationId,
  REGION_ID_PATTERN,
  DATABASE_ID_PATTERN,
  RoleName,
} from "./ids.ts";

export const ROUTE_TOKEN_HEADER = "X-PGCF-Route";
export const ROUTE_TOKEN_MAX_LENGTH = 1280;
export const ROUTE_TOKEN_SIGN_TTL_SECONDS = 30;
export const ROUTE_TOKEN_MAX_LIFETIME_SECONDS = 30;
export const ROUTE_TOKEN_SKEW_SECONDS = 5;
export const ROUTE_KEY_MIN_BYTES = 32;

const WAKE_TOKEN_PREFIX = "v5";
const WAKE_SIGNATURE_DOMAIN = "pgcf-route/v5\n";
const NODE_TOKEN_PREFIX = "v6";
const NODE_SIGNATURE_DOMAIN = "pgcf-route/v6\n";
const NODE_KEY_DOMAIN = "pgcf-route-key/v2\n";
const SIGNATURE_BYTES = 32;
/** Authoritative wire constants for generated native consumers. */
export const ROUTE_TOKEN_WAKE_PREFIX = WAKE_TOKEN_PREFIX;
export const ROUTE_TOKEN_WAKE_SIGNATURE_DOMAIN = WAKE_SIGNATURE_DOMAIN;
export const ROUTE_TOKEN_NODE_PREFIX = NODE_TOKEN_PREFIX;
export const ROUTE_TOKEN_NODE_SIGNATURE_DOMAIN = NODE_SIGNATURE_DOMAIN;
export const ROUTE_TOKEN_NODE_KEY_DOMAIN = NODE_KEY_DOMAIN;
export const ROUTE_TOKEN_SIGNATURE_BYTES = SIGNATURE_BYTES;

const kidPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const cidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const connectionClaims = {
  db: z.string().regex(DATABASE_ID_PATTERN),
  user: RoleName,
  cid: z.string().regex(cidPattern),
  rg: z.string().regex(REGION_ID_PATTERN),
  kid: z.string().regex(kidPattern),
  iat: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  exp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};
const Revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const RoleRevisionHash = z.string().regex(/^[a-f0-9]{64}$/);
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
  inst: z.string().regex(cidPattern),
});
export type NodeRouteTokenClaims = z.infer<typeof nodeRouteTokenClaimsSchema>;
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
export type WakeRouteTokenClaims = z.infer<typeof wakeRouteTokenClaimsSchema>;
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
 * The same shape holds master keys (edge) and derived node keys (gateway).
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

/** K = HMAC-SHA256(master, "pgcf-route-key/v2\n" + nodeId), 32 raw bytes. */
export async function deriveNodeKey(
  master: Uint8Array,
  nodeId: string,
): Promise<Uint8Array> {
  if (!NODE_ID_PATTERN.test(nodeId)) throw new RangeError("invalid node id");
  if (master.length < ROUTE_KEY_MIN_BYTES)
    throw new RangeError("master key too short");
  return hmac(master, NODE_KEY_DOMAIN + nodeId);
}

/** Derives the keyring the gateway of `nodeId` verifies with. */
export async function deriveNodeKeyring(
  master: RouteKeyring,
  nodeId: string,
): Promise<RouteKeyring> {
  const keys = new Map<string, Uint8Array>();
  for (const [kid, bytes] of master.keys)
    keys.set(kid, await deriveNodeKey(bytes, nodeId));
  return { active: master.active, keys };
}

/** What every route signs: the connection and the node whose key seals it. */
export interface SignRouteInput {
  /** Master keyring; the active key signs. */
  readonly keyring: RouteKeyring;
  readonly region: string;
  /** The node the database runs on; its key signs, and only its gateway verifies. */
  readonly node: string;
  readonly db: string;
  readonly user: RoleName;
  readonly cid: string;
  /** Milliseconds since the epoch. */
  readonly now?: number;
  readonly ttlSeconds?: number;
}

export interface SignWakeRouteTokenInput extends SignRouteInput {
  readonly wake: DatabaseWakeTicket;
}

/** A v5 wake ticket for a sleeping database. */
export async function signWakeRouteToken(
  input: SignWakeRouteTokenInput,
): Promise<string> {
  return seal(
    input,
    wakeRouteTokenClaimsSchema.safeParse({
      v: 5,
      ...connection(input),
      op: input.wake?.operation,
      gen: input.wake?.generation,
      route_revision: input.wake?.route_revision,
      rh: input.wake?.role_revision_hash,
    }),
    WAKE_TOKEN_PREFIX,
    WAKE_SIGNATURE_DOMAIN,
  );
}

export interface SignNodeRouteTokenInput extends SignRouteInput {
  /** What the node's unit runs: its generation, the route revision and its invocation ID. */
  readonly target: {
    readonly revision: number;
    readonly route_revision: number;
    readonly instance: string;
  };
}

/** A v6 route to a node for an awake database. */
export async function signNodeRouteToken(
  input: SignNodeRouteTokenInput,
): Promise<string> {
  return seal(
    input,
    nodeRouteTokenClaimsSchema.safeParse({
      v: 6,
      ...connection(input),
      rev: input.target?.revision,
      route_revision: input.target?.route_revision,
      node: input.node,
      inst: input.target?.instance,
    }),
    NODE_TOKEN_PREFIX,
    NODE_SIGNATURE_DOMAIN,
  );
}

/** SHA-256 (lowercase hex) of the sorted lines "<name>\t<revision>\n", one per live role. */
export async function roleRevisionHash(
  roles: readonly { readonly name: string; readonly revision: number }[],
): Promise<string> {
  const lines = roles
    .map(({ name, revision }) => `${name}\t${revision}\n`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(lines.join(""))),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function connection(input: SignRouteInput) {
  const ttl = input.ttlSeconds ?? ROUTE_TOKEN_SIGN_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > ROUTE_TOKEN_SIGN_TTL_SECONDS)
    throw new RangeError("ttlSeconds must be an integer in 1..30");
  const iat = Math.floor((input.now ?? Date.now()) / 1000);
  return {
    db: input.db,
    user: input.user,
    cid: input.cid,
    rg: input.region,
    kid: input.keyring.active,
    iat,
    exp: iat + ttl,
  };
}

/** Signs with the key of the node. */
async function seal(
  input: SignRouteInput,
  claims: z.ZodSafeParseResult<WakeRouteTokenClaims | NodeRouteTokenClaims>,
  prefix: string,
  domain: string,
): Promise<string> {
  const master = input.keyring.keys.get(input.keyring.active);
  if (master === undefined) throw new RangeError("active key missing");
  if (!claims.success) throw new RangeError("invalid route token claims");
  const payload = bytesToBase64url(encoder.encode(JSON.stringify(claims.data)));
  const key = await deriveNodeKey(master, input.node);
  const signature = await hmac(key, domain + payload);
  return `${prefix}.${payload}.${bytesToBase64url(signature)}`;
}

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
  const wake = parts[0] === WAKE_TOKEN_PREFIX;
  const node = parts[0] === NODE_TOKEN_PREFIX;
  if (parts.length !== 3 || (!wake && !node)) return fail("malformed");
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
  const expected = await hmac(
    key,
    (wake ? WAKE_SIGNATURE_DOMAIN : NODE_SIGNATURE_DOMAIN) + payload,
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
