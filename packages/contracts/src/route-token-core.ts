// SPDX-License-Identifier: Apache-2.0
// Edge-to-gateway routing tokens: signing and the keyring, without zod. The Edge loads this module
// and not `route-token.ts`, because a fresh isolate pays for every byte of zod it evaluates (the
// Edge's request path is 27 KB of its own code and no zod, `apps/edge/test/bundle.node-test.ts`).
// `route-token.ts` keeps the zod schemas of the claims and the keyring, verifies with them and
// re-exports this module; `test/zod-free-core.test.ts` holds the claim and keyring checks below to
// those schemas on the shared vectors.
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
import type { DatabaseWakeTicket } from "./database-admission.ts";
import { base64urlToBytes, bytesToBase64url } from "./encoding.ts";
import {
  DATABASE_ID_PATTERN,
  NODE_ID_PATTERN,
  OPERATION_ID_PATTERN,
  REGION_ID_PATTERN,
  isNodeId,
  isRoleName,
} from "./ids-core.ts";

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

export const KID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
export const CID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ROLE_REVISION_HASH_PATTERN = /^[a-f0-9]{64}$/;

/** What every route token claims of its connection. */
interface ConnectionClaims {
  db: string;
  user: string;
  cid: string;
  rg: string;
  kid: string;
  iat: number;
  exp: number;
}
/**
 * The route to a node: the database generation, the admission route revision, the node and the
 * invocation ID of the PostgreSQL unit that serves the database (`UnitWriter.instance`).
 */
export interface NodeRouteTokenClaims extends ConnectionClaims {
  v: 6;
  rev: number;
  route_revision: number;
  node: string;
  inst: string;
}
/** A wake ticket: the operation, the claimed generation, the route revision and the role hash. */
export interface WakeRouteTokenClaims extends ConnectionClaims {
  v: 5;
  op: string;
  /** The generation the wake claims in D1: the Actor snapshot's generation + 1. */
  gen: number;
  route_revision: number;
  /** roleRevisionHash of the Actor snapshot's roles. */
  rh: string;
}

const matches = (value: unknown, pattern: RegExp) =>
  typeof value === "string" && pattern.test(value);
const isTime = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isRevision = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An object of exactly the claims in `checks`, each passing its own check; no other claim. */
function hasClaims(
  value: unknown,
  checks: Record<string, (claim: unknown) => boolean>,
): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => Object.hasOwn(checks, key)) &&
    Object.entries(checks).every(([key, check]) => check(value[key]))
  );
}

const connectionChecks = {
  db: (claim: unknown) => matches(claim, DATABASE_ID_PATTERN),
  user: isRoleName,
  cid: (claim: unknown) => matches(claim, CID_PATTERN),
  rg: (claim: unknown) => matches(claim, REGION_ID_PATTERN),
  kid: (claim: unknown) => matches(claim, KID_PATTERN),
  iat: isTime,
  exp: isTime,
};

export function isNodeRouteTokenClaims(
  value: unknown,
): value is NodeRouteTokenClaims {
  return hasClaims(value, {
    v: (claim) => claim === 6,
    ...connectionChecks,
    rev: isRevision,
    route_revision: isRevision,
    node: isNodeId,
    inst: (claim) => matches(claim, CID_PATTERN),
  });
}

export function isWakeRouteTokenClaims(
  value: unknown,
): value is WakeRouteTokenClaims {
  return hasClaims(value, {
    v: (claim) => claim === 5,
    ...connectionChecks,
    op: (claim) => matches(claim, OPERATION_ID_PATTERN),
    gen: isRevision,
    route_revision: isRevision,
    rh: (claim) => matches(claim, ROLE_REVISION_HASH_PATTERN),
  });
}

/** Keys are raw bytes by kid; `active` names the key used for signing. */
export interface RouteKeyring {
  readonly active: string;
  readonly keys: ReadonlyMap<string, Uint8Array>;
}

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
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    !matches(value.active, KID_PATTERN) ||
    !isRecord(value.keys) ||
    !Object.entries(value.keys).every(
      ([kid, encoded]) =>
        KID_PATTERN.test(kid) &&
        typeof encoded === "string" &&
        encoded.length <= 1024,
    )
  )
    throw new Error("invalid route keyring: wrong shape");
  const active = value.active as string;
  const keys = new Map<string, Uint8Array>();
  for (const [kid, encoded] of Object.entries(value.keys)) {
    const bytes = base64urlToBytes(encoded as string);
    if (bytes === null || bytes.length < ROUTE_KEY_MIN_BYTES)
      throw new Error(
        `invalid route keyring: key ${kid} must be base64url of at least ${ROUTE_KEY_MIN_BYTES} bytes`,
      );
    keys.set(kid, bytes);
  }
  if (!keys.has(active))
    throw new Error("invalid route keyring: active key missing");
  return { active, keys };
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
  readonly user: string;
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
    {
      v: 5,
      ...connection(input),
      op: input.wake?.operation,
      gen: input.wake?.generation,
      route_revision: input.wake?.route_revision,
      rh: input.wake?.role_revision_hash,
    },
    isWakeRouteTokenClaims,
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
    {
      v: 6,
      ...connection(input),
      rev: input.target?.revision,
      route_revision: input.target?.route_revision,
      node: input.node,
      inst: input.target?.instance,
    },
    isNodeRouteTokenClaims,
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
async function seal<Claims>(
  input: SignRouteInput,
  claims: unknown,
  valid: (claims: unknown) => claims is Claims,
  prefix: string,
  domain: string,
): Promise<string> {
  const master = input.keyring.keys.get(input.keyring.active);
  if (master === undefined) throw new RangeError("active key missing");
  if (!valid(claims)) throw new RangeError("invalid route token claims");
  const payload = bytesToBase64url(encoder.encode(JSON.stringify(claims)));
  const key = await deriveNodeKey(master, input.node);
  const signature = await hmac(key, domain + payload);
  return `${prefix}.${payload}.${bytesToBase64url(signature)}`;
}

const encoder = new TextEncoder();

export async function hmac(
  key: Uint8Array,
  message: string,
): Promise<Uint8Array> {
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
