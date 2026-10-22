// SPDX-License-Identifier: Apache-2.0
/**
 * The contract between a node's agent and Cloudflare (ULTRA plan 4.6-4.9, 5.3, 5.6, 7.3, 7.9-7.11,
 * 8, 9.2-9.5). A node enrolls once with the installer's one-time token and an Ed25519 key it
 * generated, then signs every request with that key. It pulls its desired page (its databases,
 * release, policy and orders), reads its credentials, keeps the link to its NodeActor with a
 * sample every 15 s, and posts observations, volume reports and events. The Rust node agent reads
 * the JSON Schemas and vectors in `native/node.generated.json` and `node-vectors.generated.json`.
 *
 * Changing it: the objects here are strict, and so is the API, which never sends or accepts a
 * property by accident. The node reads what Cloudflare sends it with every object open
 * (`native/node-schema.ts`). The rule for a change, and the order of its releases by the kind of
 * change and the direction (what the node receives or sends), is written once in the plan, 9.3
 * "Changing the page" (its table); `test/node-required.ts` and `test/node-closed-sets.ts` fail
 * until a required property or a value of a closed set is a deliberate line. What this file does
 * for it: a new property is `.optional()` or `.default(...)` with the default in its comment.
 */
import { z } from "zod";
import {
  BucketName,
  HttpsUrl,
  ROLE_CONNECTION_LIMIT_MAX,
  ROLE_LIMIT,
  ROLE_MEMBER_OF_MAX,
  TEXT_MAX_LENGTH,
  Timestamp,
} from "./api.ts";
import { RegionRouteKeyring, RolePassword } from "./auth.ts";
import { base64urlToBytes, bytesToBase64url, bytesToHex } from "./encoding.ts";
import {
  ApiKeyId,
  DATABASE_ID_PATTERN,
  DatabaseId,
  NodeId,
  OPERATION_ID_PATTERN,
  OperationId,
  OWNER_ROLE_NAME,
  REGION_ID_PATTERN,
  RegionId,
  RoleName,
} from "./ids.ts";
import { MAINTENANCE_ROLE } from "./maintenance.ts";
import {
  FleetReleaseBinaries,
  FleetReleaseId,
  FleetReleaseOs,
  ImageIdentity,
  ImageVersion,
  KernelRelease,
  NodeHostFiles,
} from "./releases.ts";
import { USAGE_HOUR_MS } from "./usage.ts";
import {
  ADMISSION_REFUSALS,
  WAKE_OUTCOMES,
  WAKE_PHASES,
  WAKE_REASONS,
  WAKE_STALE,
  refusalRetryHint,
} from "./node-local.ts";

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const Count = z.number().int().nonnegative().max(MAX_SAFE);
const Positive = z.number().int().min(1).max(MAX_SAFE);
const Bytes = Count;
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
/** The pattern carries the scheme into the JSON Schema, which drops the URL check. */
const Https = HttpsUrl.regex(/^https:\/\//);
/**
 * The API's origin: https, a host and a port, nothing else. The agent dials it for every request
 * and refuses a path or a query, so the installer and the seed take exactly this shape.
 */
const API_ORIGIN_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?\/?$/;
const ApiOrigin = HttpsUrl.regex(API_ORIGIN_PATTERN);

export const NODE_PROTOCOL_VERSION = 1;
/** Every path a node calls; each but `enroll` carries a signed node request. */
export const NODE_API_PATHS = {
  enroll: "/node/v1/enroll",
  link: "/node/v1/link",
  desired: "/node/v1/desired",
  credentials: "/node/v1/credentials",
  archiveCredentials: "/node/v1/archive-credentials/",
  observations: "/node/v1/observations",
  volumes: "/node/v1/volumes",
  events: "/node/v1/events",
  usage: "/node/v1/usage",
  diagnostics: "/node/v1/diagnostics",
} as const;
/**
 * A node declared lost (plan 9.4) is fenced: its Tunnel token is revoked, and its key still signs
 * exactly these paths (compared without the query). Everything else, the link included, is
 * answered 403 `NodeFencedResponse`. The desired page of a fenced node carries its `fence` and
 * `superseded` orders and nothing else, and its observations are read for the results of those
 * orders only. A node that comes back therefore learns that it is fenced and which generations
 * are superseded, and can report that it obeyed; it learns no credential.
 */
export const NODE_FENCED_PATHS = [
  NODE_API_PATHS.desired,
  NODE_API_PATHS.observations,
] as const;
export const NODE_FENCED_ERROR = "node_fenced";
/** The body of that 403; the agent treats it as a fence and pulls its desired page. */
export const NodeFencedResponse = z.strictObject({
  error: z.literal(NODE_FENCED_ERROR),
});
export type NodeFencedResponse = z.infer<typeof NodeFencedResponse>;
/** The installer's checkpoints go here with its one-time progress token (plan 9.2). */
export const INSTALLER_PROGRESS_PATH = "/node/v1/installer/progress";
export const NODE_SAMPLE_INTERVAL_MS = 15_000;
export const NODE_VOLUME_REPORT_INTERVAL_MS = 60_000;
/** A node whose link stays silent this long is stale; staleness never declares it lost. */
export const NODE_STALE_MS = 180_000;
/**
 * The anti-entropy of observations (plan 5.3). A node posts what it observed of a database when
 * that changes, and the API keeps it; a report that does not name a database says nothing of it,
 * in particular never that it is gone. To repair what a lost change, a restored D1 or an API
 * that lost its state would leave behind, the node says again what it said of each database, once
 * in this period, at a point of the period that its identifier fixes, so that the databases never
 * come in one minute. The period is never shortened: at 15 minutes 300 databases
 * are 20 observations a minute, where a full pass each minute was 300 and filled the API's minute
 * at about 1,200 databases. The node's own sample and volume report (every 15 s and 60 s) are its
 * liveness, and they stay. A database that Cloudflare waits for, a build, a restore or a move
 * (an entry with an origin, or an open move order), is not on this clock: the node keeps posting
 * it with every full pull, because the API's create, restore and move steps wait for the next
 * report that names it.
 *
 * Who reads the time of a database's own observation, and what each needs:
 * - `databases.backup_observed_at` (`health.backup` of a database and of the operator listing, and
 *   the alert `database_base_backup_stale`) is the one reader that needs it: a database that is
 *   unchanged and alive was last named at most one period ago, so these judge a report fresh for
 *   `NODE_DATABASE_STALE_MS`. The API touches the column when an unchanged observation arrives.
 * - `regional_node_stale`, placement, `thin_storage_blocked` (`thin_pool_unobserved`), the node
 *   alerts and the fleet release state read the node's own sample (`nodes.last_observed_at`), not
 *   a database's observation: unchanged at 180 s.
 * - Storage samples, `health.disk` and the volume alerts come from the volume report of the node,
 *   one per minute, and from nothing a database observation carries: unchanged.
 * - The proven-sleep record and the recovery points are facts, written when they change; their
 *   time is when they were observed, never a proof of life, and nothing judges their age.
 * - The Actor's admission snapshot is published by every report that names the database, changed
 *   or not, and a publish that fails within a second fails the report, which the node sends
 *   again: the period is how often a snapshot that a lost publish left behind is repaired. The
 *   cron step `database_actors` republishes a page of 200 databases a minute and is the other
 *   repair; it reads D1's rows and no observation time.
 */
export const NODE_OBSERVATION_RESEND_MS = 15 * 60_000;
/** A database's own observation is stale when it is older than three periods of the resend. */
export const NODE_DATABASE_STALE_MS = 3 * NODE_OBSERVATION_RESEND_MS;
export const NODE_LINK_MESSAGE_MAX_BYTES = 64 * 1024;
export const NODE_DESIRED_PAGE_LIMIT_MAX = 200;
export const NODE_ORDER_LIMIT = 1000;
export const NODE_AWAKE_LIMIT = 2000;
export const NODE_VOLUME_LIMIT = 10_000;
export const NODE_EVENT_BATCH_MAX = 500;
export const NODE_USAGE_BATCH_MAX = 500;
/**
 * The agent re-posts an unanswered event batch unchanged for this long and then drops it; the API
 * remembers the ids of a batch for this long and the request lifetime beyond it.
 */
export const NODE_EVENT_RETRY_SECONDS = 600;

// ---------- Identity and enrollment ----------

export const NODE_HOSTNAME_PATTERN = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
export const NodeHostname = z.string().regex(NODE_HOSTNAME_PATTERN);
/** The node record of one install; a reinstall is a new install with a new UID and key. */
export const NodeIdentity = z.strictObject({
  id: NodeId,
  uid: z.uuid(),
  hostname: NodeHostname,
  region_id: RegionId,
});
export type NodeIdentity = z.infer<typeof NodeIdentity>;

export const ENROLLMENT_TOKEN_PATTERN = /^pgcf_et_[A-Za-z0-9_-]{43}$/;
/**
 * A token lives this long, is bound to one image version and is burnt by its enrollment. A repeat
 * of the same enrollment (same token, same public key) within the lifetime returns the same
 * identity, because the response of the first may have been lost; only another key, or an expired
 * token, is refused and raises an alert.
 */
export const ENROLLMENT_TOKEN_LIFETIME_SECONDS = 1800;
export const EnrollmentToken = z.string().regex(ENROLLMENT_TOKEN_PATTERN);

/** `/var/lib/pgcf/enrollment/seed.json`, written by the installer and deleted after enrollment. */
export const NODE_ENROLLMENT_SEED_PATH = "/var/lib/pgcf/enrollment/seed.json";
export const NodeEnrollmentSeed = z.strictObject({
  node_id: NodeId,
  region: RegionId,
  api_url: ApiOrigin,
  enrollment_token: EnrollmentToken,
});
export type NodeEnrollmentSeed = z.infer<typeof NodeEnrollmentSeed>;

export const NODE_PUBLIC_KEY_BYTES = 32;
export const NODE_SIGNATURE_BYTES = 64;
/** A raw Ed25519 public key as unpadded base64url. */
export const NodePublicKey = z
  .string()
  .length(43)
  .refine(
    (value) => base64urlToBytes(value)?.length === NODE_PUBLIC_KEY_BYTES,
    { message: "An Ed25519 public key is 32 bytes of canonical base64url" },
  );

/**
 * POST /node/v1/enroll. The Worker accepts it only from the instance's own public IPv4, after the
 * installer's checkpoints for this token arrived, and for the image version the token names. A
 * repeat with the same token and public key answers the same `NodeEnrollmentResponse`.
 */
export const NodeEnrollmentRequest = z.strictObject({
  node_id: NodeId,
  enrollment_token: EnrollmentToken,
  public_key: NodePublicKey,
  image_version: ImageVersion,
});
export type NodeEnrollmentRequest = z.infer<typeof NodeEnrollmentRequest>;
export const NodeEnrollmentResponse = NodeIdentity;
export type NodeEnrollmentResponse = z.infer<typeof NodeEnrollmentResponse>;

export const INSTALLER_CHECKPOINTS = [
  "started",
  "hardware_ok",
  "image_verified",
  "disk_written",
  "configured",
  "rebooting",
  "failed",
] as const;
/** One checkpoint of the pull installer; `detail` names the failed step. */
export const InstallerProgress = z.strictObject({
  checkpoint: z.enum(INSTALLER_CHECKPOINTS),
  detail: z.string().regex(/^[a-z_]{0,64}$/),
});
export type InstallerProgress = z.infer<typeof InstallerProgress>;

// ---------- Signed node requests ----------

export const NODE_REQUEST_TOKEN_PREFIX = "pgcf_nr1";
export const NODE_REQUEST_SIGNATURE_DOMAIN = "pgcf-node-request/v1\n";
export const NODE_REQUEST_MAX_LIFETIME_SECONDS = 60;
export const NODE_REQUEST_SKEW_SECONDS = 30;
export const NODE_REQUEST_MAX_LENGTH = 2048;

/**
 * The claims of `Authorization: Bearer pgcf_nr1.<base64url(JSON claims)>.<base64url(Ed25519
 * signature of NODE_REQUEST_SIGNATURE_DOMAIN + payload)>`. They bind the request's method, its
 * path with the query and the SHA-256 of its body bytes (of nothing for a GET or the link).
 */
export const NodeRequestClaims = z.strictObject({
  v: z.literal(1),
  node: NodeId,
  uid: z.uuid(),
  method: z.enum(["GET", "POST", "PUT"]),
  path: z
    .string()
    .max(1024)
    .regex(/^\/node\/v1\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/),
  body: Sha256,
  iat: Count,
  exp: Count,
});
export type NodeRequestClaims = z.infer<typeof NodeRequestClaims>;
export type NodeRequestFailure =
  | "malformed"
  | "signature"
  | "claims"
  | "node_mismatch"
  | "request_mismatch"
  | "invalid_lifetime"
  | "not_yet_valid"
  | "expired";

const encoder = new TextEncoder(),
  strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
    ),
  );
}

/** A WebCrypto Ed25519 key, in Workers and in Node.js alike. */
export type NodeKey = Parameters<typeof crypto.subtle.sign>[1];

/** The node's public key as the enrollment sends it. */
export async function nodePublicKey(key: NodeKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  if (!(raw instanceof ArrayBuffer)) throw new TypeError("not a raw key");
  return bytesToBase64url(new Uint8Array(raw));
}

export async function nodeRequestClaims(input: {
  node: string;
  uid: string;
  method: NodeRequestClaims["method"];
  path: string;
  body: Uint8Array;
  now?: number;
  ttlSeconds?: number;
}): Promise<NodeRequestClaims> {
  const iat = Math.floor((input.now ?? Date.now()) / 1000);
  return NodeRequestClaims.parse({
    v: 1,
    node: input.node,
    uid: input.uid,
    method: input.method,
    path: input.path,
    body: await sha256Hex(input.body),
    iat,
    exp: iat + (input.ttlSeconds ?? NODE_REQUEST_MAX_LIFETIME_SECONDS),
  });
}

function lifetimeValid(claims: NodeRequestClaims): boolean {
  return (
    claims.exp > claims.iat &&
    claims.exp - claims.iat <= NODE_REQUEST_MAX_LIFETIME_SECONDS
  );
}

/** Signs claims with the node's private key; the agent does the same in Rust. */
export async function signNodeRequest(
  privateKey: NodeKey,
  claims: NodeRequestClaims,
): Promise<string> {
  const parsed = NodeRequestClaims.parse(claims);
  if (!lifetimeValid(parsed)) throw new TypeError("invalid request lifetime");
  const payload = bytesToBase64url(encoder.encode(JSON.stringify(parsed)));
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      privateKey,
      encoder.encode(NODE_REQUEST_SIGNATURE_DOMAIN + payload),
    ),
  );
  return `${NODE_REQUEST_TOKEN_PREFIX}.${payload}.${bytesToBase64url(signature)}`;
}

function decodeToken(
  token: string,
): { payload: string; claims: unknown; signature: Uint8Array } | null {
  const parts = token.split(".");
  if (
    token.length > NODE_REQUEST_MAX_LENGTH ||
    parts.length !== 3 ||
    parts[0] !== NODE_REQUEST_TOKEN_PREFIX
  )
    return null;
  const payload = base64urlToBytes(parts[1]!),
    signature = base64urlToBytes(parts[2]!);
  if (
    payload === null ||
    payload.length === 0 ||
    signature?.length !== NODE_SIGNATURE_BYTES
  )
    return null;
  try {
    return {
      payload: parts[1]!,
      claims: JSON.parse(strictDecoder.decode(payload)),
      signature,
    };
  } catch {
    return null;
  }
}

/** The node and install a token claims, unverified, to look up the key that must verify it. */
export function nodeRequestSubject(
  token: string,
): { node: string; uid: string } | null {
  const claims = NodeRequestClaims.safeParse(decodeToken(token)?.claims);
  return claims.success
    ? { node: claims.data.node, uid: claims.data.uid }
    : null;
}

export async function verifyNodeRequest(
  token: string,
  expected: {
    publicKey: string;
    node: string;
    uid: string;
    method: string;
    path: string;
    body: Uint8Array;
    now?: number;
  },
): Promise<
  | { ok: true; claims: NodeRequestClaims }
  | { ok: false; reason: NodeRequestFailure }
> {
  const fail = (reason: NodeRequestFailure) => ({ ok: false, reason }) as const;
  const decoded = decodeToken(token),
    publicKey = base64urlToBytes(expected.publicKey);
  if (decoded === null || publicKey?.length !== NODE_PUBLIC_KEY_BYTES)
    return fail("malformed");
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(publicKey),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  if (
    !(await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      Uint8Array.from(decoded.signature),
      encoder.encode(NODE_REQUEST_SIGNATURE_DOMAIN + decoded.payload),
    ))
  )
    return fail("signature");
  const claims = NodeRequestClaims.safeParse(decoded.claims);
  if (!claims.success) return fail("claims");
  if (claims.data.node !== expected.node || claims.data.uid !== expected.uid)
    return fail("node_mismatch");
  if (
    claims.data.method !== expected.method ||
    claims.data.path !== expected.path ||
    claims.data.body !== (await sha256Hex(expected.body))
  )
    return fail("request_mismatch");
  if (!lifetimeValid(claims.data)) return fail("invalid_lifetime");
  const now = (expected.now ?? Date.now()) / 1000;
  if (claims.data.iat > now + NODE_REQUEST_SKEW_SECONDS)
    return fail("not_yet_valid");
  if (now > claims.data.exp + NODE_REQUEST_SKEW_SECONDS) return fail("expired");
  return { ok: true, claims: claims.data };
}

// ---------- Credentials ----------

/**
 * The public key of the CA that signs the operator shell's user certificates (plan 8): exactly
 * `ssh-ed25519 <base64>`, 80 characters, on one line. The pattern is the whole check: no options
 * before the type, no comment after the key, no line break, no other key type. The blob is the
 * encoding of the type name `ssh-ed25519` and a 32-byte key, so only the last 43 characters vary;
 * the first of them holds the low two bits of the length byte 0x20, which are zero, and the top
 * four bits of the key, so it is one of A to P.
 */
export const NODE_SHELL_CA_PUBLIC_KEY_PATTERN =
  /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-P][A-Za-z0-9+/]{42}$/;
export const NodeShellCaPublicKey = z
  .string()
  .regex(NODE_SHELL_CA_PUBLIC_KEY_PATTERN);

/**
 * The CA public key an operator configured as the API Worker's `NODE_SSH_USER_CA_PUBLIC_KEY`, or
 * null when the variable is unset or not exactly one valid key line. A variable that is not valid
 * gives the node no key, so no login: it fails closed.
 */
export function nodeShellCaPublicKey(
  variable: string | undefined,
): string | null {
  const parsed = NodeShellCaPublicKey.safeParse(variable);
  return parsed.success ? parsed.data : null;
}

/**
 * GET /node/v1/credentials: what the gateway, the Tunnel and the operator shell need, after
 * enrollment. The agent reads it when the page's `credentials_revision` is above the revision it
 * applied.
 */
export const NodeCredentials = z.strictObject({
  /**
   * The revision these credentials hold; it only rises, with every change of either secret and
   * with every change of the shell's state (the shell hostname on or off, or another CA key).
   */
  revision: Positive,
  tunnel_token: z.string().regex(/^[A-Za-z0-9+/=_-]{32,4096}$/),
  /** The node's route keyring for the gateway (`PGCF_ROUTE_KEY`). */
  route_keyring: RegionRouteKeyring,
  /**
   * The operator shell's CA public key. It is there only while the API's `NODE_SHELL_HOSTNAME` is
   * `true` and its `NODE_SSH_USER_CA_PUBLIC_KEY` is valid. The agent writes it to the file sshd
   * trusts (`/etc/ssh/pgcf_user_ca.pub`) and, when the field is absent, removes that file: sshd
   * refuses every key without it.
   */
  shell_ca_public_key: NodeShellCaPublicKey.optional(),
});
export type NodeCredentials = z.infer<typeof NodeCredentials>;

export const ARCHIVE_CREDENTIAL_ID_PATTERN = /^crd_[a-z0-9]{20}$/;
/** Which temporary R2 credential a desired page means; the secret is read separately. */
export const ArchiveCredentialReference = z.strictObject({
  id: z.string().regex(ARCHIVE_CREDENTIAL_ID_PATTERN),
  /** Renewed by Cloudflare after a third of its lifetime; an alert fires below a quarter. */
  expires_at: Timestamp,
});
export type ArchiveCredentialReference = z.infer<
  typeof ArchiveCredentialReference
>;

// ---------- Archive paths and roles ----------

/** Barman `serverName` for every database; the path prefix already makes it unique. */
export const ARCHIVE_SERVER_NAME = "database";
export const ARCHIVE_DESTINATION_PATTERN =
  /^s3:\/\/([a-z0-9][a-z0-9-]{1,61}[a-z0-9])\/([a-z][a-z0-9-]{1,30}[a-z0-9])\/([a-z][a-z0-9]{19})\/g([1-9][0-9]{0,15})-(op_[a-z0-9]{20})$/;
export function archiveDestinationPath(
  bucket: string,
  regionId: string,
  databaseId: string,
  generation: number,
  operationId: string,
): string {
  if (!BucketName.safeParse(bucket).success)
    throw new TypeError("invalid bucket name");
  if (!REGION_ID_PATTERN.test(regionId))
    throw new TypeError("invalid region id");
  if (!DATABASE_ID_PATTERN.test(databaseId))
    throw new TypeError("invalid database id");
  if (!Number.isSafeInteger(generation) || generation < 1)
    throw new TypeError("invalid generation");
  if (!OPERATION_ID_PATTERN.test(operationId))
    throw new TypeError("invalid operation id");
  return `s3://${bucket}/${regionId}/${databaseId}/g${generation}-${operationId}`;
}
/** The bucket, region, database, storage generation and operation an archive path names. */
export function parseArchivePath(path: string): {
  bucket: string;
  region: string;
  database: string;
  generation: number;
  operation: string;
} | null {
  const match = ARCHIVE_DESTINATION_PATTERN.exec(path);
  return match
    ? {
        bucket: match[1]!,
        region: match[2]!,
        database: match[3]!,
        generation: Number(match[4]),
        operation: match[5]!,
      }
    : null;
}
export const ArchivePath = z.string().regex(ARCHIVE_DESTINATION_PATTERN);

/** A temporary R2 credential, scoped to one archive path and never able to delete. */
export const ArchiveCredential = z.strictObject({
  id: ArchiveCredentialReference.shape.id,
  path: ArchivePath,
  access: z.enum(["read_write", "read_only"]),
  endpoint_url: Https,
  access_key_id: z.string().regex(/^[A-Za-z0-9]{16,128}$/),
  secret_access_key: z.string().regex(/^[A-Za-z0-9/+=_-]{16,256}$/),
  session_token: z.string().regex(/^[A-Za-z0-9._~+/=-]{16,8192}$/),
  expires_at: Timestamp,
});
export type ArchiveCredential = z.infer<typeof ArchiveCredential>;

/**
 * A role the database holds. The attributes appear only where they differ from a plain role
 * (no expiry, no limit, no membership, NOBYPASSRLS).
 */
export const DesiredRole = z.strictObject({
  name: RoleName,
  owner: z.boolean(),
  password: RolePassword,
  revision: z.number().int().min(1),
  valid_until: Timestamp.describe(
    "VALID UNTIL; applied at whole seconds, truncated. Absent means no expiry.",
  ).optional(),
  connection_limit: z
    .number()
    .int()
    .min(1)
    .max(ROLE_CONNECTION_LIMIT_MAX)
    .describe("CONNECTION LIMIT. Absent means unlimited.")
    .optional(),
  member_of: z
    .array(RoleName)
    .max(ROLE_MEMBER_OF_MAX)
    .describe(
      "Other present roles of this record the role is a member of. Absent means none.",
    )
    .optional(),
  bypass_rls: z
    .literal(true)
    .describe("BYPASSRLS. Absent means NOBYPASSRLS.")
    .optional(),
});
export type DesiredRole = z.infer<typeof DesiredRole>;
/**
 * A role deleted through the API whose removal from PostgreSQL is not yet confirmed. The node
 * sets it to NOLOGIN, ends its sessions, then drops it, and reports the outcome.
 */
export const DesiredRoleRemoval = z
  .strictObject({
    name: RoleName,
    state: z.literal("absent"),
  })
  .describe("A deleted role the node must remove; it carries no credential.");
export type DesiredRoleRemoval = z.infer<typeof DesiredRoleRemoval>;
export function isRoleRemoval(
  role: DesiredRole | DesiredRoleRemoval,
): role is DesiredRoleRemoval {
  return "state" in role;
}
/** The roles a database holds now, without those awaiting removal. */
export function presentRoles(db: {
  roles: readonly (DesiredRole | DesiredRoleRemoval)[];
}): DesiredRole[] {
  return db.roles.filter((role): role is DesiredRole => !isRoleRemoval(role));
}
/**
 * The rules of a database's roles: unique names, never the internal maintenance role, the owner
 * is `app` and is never removed, a database that exists has exactly one owner, and a membership
 * names another present role.
 */
export function refineRoles(
  roles: readonly (DesiredRole | DesiredRoleRemoval)[],
  exists: boolean,
  ctx: z.RefinementCtx,
): void {
  const names = new Set<string>();
  let owners = 0;
  for (const role of roles) {
    if (role.name === MAINTENANCE_ROLE)
      ctx.addIssue({
        code: "custom",
        path: ["roles"],
        message: "Internal maintenance role cannot be a customer role",
      });
    if (names.has(role.name))
      ctx.addIssue({
        code: "custom",
        path: ["roles"],
        message: `duplicate role ${role.name}`,
      });
    names.add(role.name);
    if (isRoleRemoval(role)) {
      if (role.name === OWNER_ROLE_NAME)
        ctx.addIssue({
          code: "custom",
          path: ["roles"],
          message: "The owner role cannot be removed",
        });
      continue;
    }
    if (role.owner) {
      owners += 1;
      if (role.name !== OWNER_ROLE_NAME)
        ctx.addIssue({
          code: "custom",
          path: ["roles"],
          message: `owner role must be ${OWNER_ROLE_NAME}`,
        });
    }
  }
  const present = new Map(
    presentRoles({ roles }).map((role) => [role.name, role] as const),
  );
  for (const role of present.values())
    for (const target of role.member_of ?? [])
      if (
        target === role.name ||
        target === OWNER_ROLE_NAME ||
        present.get(target)?.owner !== false
      )
        ctx.addIssue({
          code: "custom",
          path: ["roles"],
          message: `${role.name} is a member of ${target}, which is not another role of this database`,
        });
  if (owners > 1 || (exists && owners !== 1))
    ctx.addIssue({
      code: "custom",
      path: ["roles"],
      message: "running databases require exactly one owner role",
    });
}

// ---------- The desired page (GET /node/v1/desired) ----------

/** `?after=<id>&limit=<n>` pages through the node's databases; `?ids=<id>,<id>` pulls those. */
export const NodeDesiredQuery = z
  .strictObject({
    after: DatabaseId.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(NODE_DESIRED_PAGE_LIMIT_MAX)
      .default(NODE_DESIRED_PAGE_LIMIT_MAX),
    ids: z
      .string()
      .regex(
        new RegExp(
          `^${DATABASE_ID_PATTERN.source.slice(1, -1)}(?:,${DATABASE_ID_PATTERN.source.slice(1, -1)}){0,${NODE_DESIRED_PAGE_LIMIT_MAX - 1}}$`,
        ),
      )
      .optional(),
  })
  .refine((query) => query.after === undefined || query.ids === undefined, {
    message: "A targeted pull names its databases and no cursor",
  });
export type NodeDesiredQuery = z.infer<typeof NodeDesiredQuery>;

/**
 * What the node runs. The agent downloads the four binaries, each under its own file name, into
 * the release's directory `/var/lib/pgcf/bin/<id>/`, checks their sha256, switches the `current`
 * link and restarts the services. Everything else, cloudflared included, is a Debian package: it
 * changes only in a maintenance cycle, through the package lock.
 */
export const NodeRelease = z.strictObject({
  id: FleetReleaseId,
  /**
   * The image's identity, which a node never fetches: the release key signs it with the rest of
   * the release (`signedReleaseManifest`), and the agent builds that text from its page alone.
   */
  image: ImageIdentity,
  binaries: FleetReleaseBinaries,
  /** What the node installs. What it is expected to report back stays with the API. */
  os: FleetReleaseOs.omit({
    packages_sha256: true,
    kernel_release: true,
    host_files_sha256: true,
    host_files: true,
  }).extend({ host_files: NodeHostFiles }),
});
export type NodeRelease = z.infer<typeof NodeRelease>;

/** The rules Cloudflare sets for the decisions a node takes alone (plan 4.3, 4.6, 4.7, 7.5). */
export const NodePolicy = z.strictObject({
  admission: z.strictObject({
    /** D3: admit against measured MemAvailable, or against full reservations. */
    memory_rule: z.enum(["measured", "reserved"]),
    memory_floor_mib: z.number().int().min(0).max(1_048_576),
    /** The database slice's memory limit, and the budget of the `reserved` rule. */
    awake_budget_mib: z.number().int().min(256).max(1_048_576),
    /** Added to each awake database's memory under the `reserved` rule. */
    reservation_overhead_mib: z.number().int().min(0).max(1024),
    start_concurrency: z.number().int().min(1).max(64),
    /** A wake waits this long for room, below the gateway's 25 s wake bound, then gets 57P03. */
    queue_wait_ms: z.number().int().min(0).max(20_000),
    retry_after_seconds: z.number().int().min(1).max(300),
    /**
     * After a wake the database runs without the CPU quota of its class for this long, counted
     * from the release of the writer, so that its first requests, its start-up and the reading of
     * its buffer list are not throttled (plan 4.4). Its weight and its memory, IO and task limits
     * stay. 0 applies the quota at once. A restarted agent applies it at once to what it finds.
     * Optional for its first release (plan 9.3, "Changing the page"): a policy and a page without
     * it mean 0, the quota with the wake as before, so that an agent that does not know it reads
     * the page and an agent that does reads a page without it.
     */
    cpu_boost_ms: z.number().int().min(0).max(60_000).default(0),
  }),
  /** D2: put idle-but-awake databases to sleep early, only while a wake waits. */
  early_sleep: z.strictObject({
    enabled: z.boolean(),
    min_idle_seconds: z.number().int().min(0).max(3600),
  }),
  storage: z.strictObject({
    /** Free pool data below this refuses starts with 57P03 "storage". */
    reserve_bytes: Bytes,
    metadata_no_room_percent: z.number().int().min(1).max(100),
    sample_max_age_seconds: z.number().int().min(1).max(60),
  }),
  backup: z.strictObject({
    wal_uploads: z.number().int().min(1).max(16),
    base_backups: z.number().int().min(1).max(8),
    /** `MemoryMax` of one barman job by kind; a base backup counts for a restore too (plan 7.5). */
    memory_mib: z.strictObject({
      wal_upload: z.number().int().min(32).max(4096),
      wal_fetch: z.number().int().min(32).max(4096),
      base_backup: z.number().int().min(32).max(4096),
    }),
  }),
  /**
   * The write limits of a database unit (plan 4.3): those of a 256 MiB database. A database of m
   * MiB gets m / 256 times as much. They bound how fast one tenant can fill the pool.
   */
  io: z.strictObject({
    write_bytes_per_second: Positive,
    write_iops: z.number().int().min(1).max(10_000_000),
  }),
});
export type NodePolicy = z.infer<typeof NodePolicy>;

export const WAL_SEGMENT_PATTERN = /^[0-9A-F]{24}$/;
const WalSegment = z.string().regex(WAL_SEGMENT_PATTERN);

/** The fsynced record of a proven sleep (plan 7.9); a database is cold and safe only with it. */
export const ProvenSleepRecord = z.strictObject({
  system_identifier: z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/)
    .refine((value) => BigInt(value) <= 0xffff_ffff_ffff_ffffn),
  timeline: z.number().int().min(1).max(0xffff_ffff),
  checkpoint_lsn: z.string().regex(/^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/),
  last_archived_segment: WalSegment,
  proven_at: Timestamp,
});
export type ProvenSleepRecord = z.infer<typeof ProvenSleepRecord>;

const BACKUP_ID = /^[0-9]{8}T[0-9]{6}$/;
/** The archive a restore reads: a backup of another database and, for a PITR, a target time. */
export const RestoreSource = z.strictObject({
  database_id: DatabaseId,
  path: ArchivePath,
  backup_id: z.string().regex(BACKUP_ID),
  target_time: Timestamp.optional(),
  credential: ArchiveCredentialReference,
});
export type RestoreSource = z.infer<typeof RestoreSource>;
/**
 * The archive a move reads: this database's previous storage generation, to the end of its WAL,
 * never to a point in time. `end` is the record that proved the source's sleep; it is the only
 * statement of where the committed WAL ends, so the target can check its replay against it.
 */
export const MoveSource = RestoreSource.omit({ target_time: true }).extend({
  end: ProvenSleepRecord,
});
export type MoveSource = z.infer<typeof MoveSource>;
/**
 * How the node builds the storage generation: `create` (initdb, only onto an empty archive path),
 * `restore` (into a new database) or `move` (this database's previous storage generation, to the
 * end of its WAL). Absent once the generation was ready: a missing volume is then an error and
 * never a fresh build.
 *
 * A move target restores `source.backup_id` and replays the WAL of `end.timeline` until every
 * segment through `end.last_archived_segment` was fetched and replayed. Recovery may end only
 * after that, where the archive holds nothing more: the agent answers a fetch `missing` for none
 * of those segments and fails the recovery instead (see `ArchiveReply`). The shutdown checkpoint
 * lies in the next segment, which is never archived and holds no client commit (plan 7.9 step 8),
 * so `end.checkpoint_lsn` is not a replay target. The target reports `ready` only after it
 * promoted a database with `end.system_identifier` on a timeline above `end.timeline`; otherwise
 * it reports the error `no_recovery_point` and the source's storage generation stays unretired.
 */
export const DatabaseOrigin = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("create") }),
  z.strictObject({ kind: z.literal("restore"), source: RestoreSource }),
  z.strictObject({ kind: z.literal("move"), source: MoveSource }),
]);
export type DatabaseOrigin = z.infer<typeof DatabaseOrigin>;

export const NodeDesiredDatabase = z
  .strictObject({
    id: DatabaseId,
    /**
     * D1's generation of the database; every change and every wake claim advances it. A wake claim
     * is committed after the wake was answered, so the node may run and report generation N + 1
     * while the page still says N (`observationVerdict`). The agent never lowers the generation of
     * a database it knows: an entry below it is stale and ignored (orders still apply), an entry
     * at it with another operation wins and is applied again, and its table entry for the gateway
     * republished.
     */
    generation: Positive,
    /** The operation of that generation. */
    operation: OperationId,
    /** `running` wakes on connect and sleeps when idle; `suspended` stays asleep until resume. */
    desired_state: z.enum(["running", "suspended", "deleted"]),
    /** The admission route revision the gateway admits routes of. */
    route_revision: Positive,
    /** The generation of its storage and archive; each restore and move starts a new one. */
    storage_generation: Positive,
    pg_major: z.literal(18),
    /** The effective resources: the class's, or the database's own override. */
    resources: z.strictObject({
      memory_mib: z.number().int().min(256).max(1_048_576).multipleOf(256),
      cpu_millicores: z.number().int().min(100).max(256_000),
      storage_gib: z.number().int().min(1).max(65_536),
    }),
    settings: z.strictObject({
      max_connections: z.number().int().min(10).max(10_000),
      archive_timeout_seconds: z.number().int().min(30).max(3600),
    }),
    /** The effective idle time; null is always warm. */
    sleep_after_seconds: z.number().int().min(60).max(2_592_000).nullable(),
    roles: z.array(z.union([DesiredRole, DesiredRoleRemoval])).max(ROLE_LIMIT),
    archive: z.strictObject({
      path: ArchivePath,
      credential: ArchiveCredentialReference,
    }),
    origin: DatabaseOrigin.optional(),
  })
  .superRefine((db, ctx) => {
    const archive = parseArchivePath(db.archive.path);
    if (
      archive &&
      (archive.database !== db.id ||
        archive.generation !== db.storage_generation)
    )
      ctx.addIssue({
        code: "custom",
        path: ["archive", "path"],
        message: "The archive is this database's own storage generation",
      });
    if (db.origin && db.origin.kind !== "create") {
      const { source } = db.origin,
        from = parseArchivePath(source.path);
      if (
        !from ||
        from.database !== source.database_id ||
        (db.origin.kind === "restore"
          ? source.database_id === db.id
          : source.database_id !== db.id ||
            from.generation >= db.storage_generation)
      )
        ctx.addIssue({
          code: "custom",
          path: ["origin"],
          message:
            "A restore reads another database; a move reads this database's earlier generation to its end",
        });
    }
    refineRoles(db.roles, db.desired_state !== "deleted", ctx);
  });
export type NodeDesiredDatabase = z.infer<typeof NodeDesiredDatabase>;

/**
 * Explicit orders; nothing else stops or removes what runs. Each is open on every page until its
 * result is reported. `wake`: start the database now through admission, as a connection's wake
 * would, which is what a resume asks for; `generation` is the wake's claim, and a refusal fails
 * the order. `move`: the source of a move proves the sleep of its storage generation and holds
 * its wakes with 57P03 until the order ends; the target is a database whose `origin` is a move.
 * `superseded`: never start or archive this storage generation or an older one again, and remove
 * the volume only with `remove_volume`. `fence`: the node was declared lost; start and archive
 * nothing. `maintenance`: hold new wakes, prove the sleep of every database, install the
 * release's packages, reboot if needed, check.
 *
 * `fence` and `superseded` outlive their result. The agent writes them to disk (fsync) before it
 * acts on them, never lifts one because it left the page or because its result was reported, and
 * checks them before any recovery start at boot. A fence ends only with a reinstall, which is a
 * new install with a new key; a superseded generation never ends. The wakes that a hold or a
 * state refuses are named in `WAKE_REASONS`: `moving`, `maintenance`, `fenced`, `superseded`.
 */
export const NodeOrder = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("wake"),
    operation: OperationId,
    database: DatabaseId,
    generation: Positive,
  }),
  z.strictObject({
    type: z.literal("move"),
    operation: OperationId,
    database: DatabaseId,
    storage_generation: Positive,
  }),
  z.strictObject({
    type: z.literal("superseded"),
    operation: OperationId,
    database: DatabaseId,
    storage_generation: Positive,
    remove_volume: z.boolean(),
  }),
  z.strictObject({ type: z.literal("fence"), operation: OperationId }),
  z.strictObject({ type: z.literal("maintenance"), operation: OperationId }),
]);
export type NodeOrder = z.infer<typeof NodeOrder>;
/** The types of order a node reads: a page with another is refused whole (plan 9.3). */
export const NODE_ORDER_TYPES = NodeOrder.options.map(
  (order) => order.shape.type.value,
);

// ---------- Probes on request (POST /v1/nodes/{id}/diagnostics) ----------

/**
 * What an administrator may ask a node to read (SEC-09). The node has no shell, and the agent is
 * the only thing that can look at it: each probe is a fixed command or a read of fixed files that
 * the agent builds itself, and a request names the probe and three integers, never a command, a
 * path or a unit. `journal`: the lines of the agent, the gateway, cloudflared, networkd, PID 1 and
 * the kernel, as the boot report has them; `kernel`: the kernel's lines; `boots`: the boots the
 * journal holds; `failed_units`: `systemctl --failed`; `sockets`: the socket units; `listeners`:
 * the listening TCP, UDP and Unix sockets; `pressure`: the kernel's pressure, memory and load
 * figures; `pool`: the thin pool's fill. `boot` is 0 for this boot and -1 for the one before,
 * `since_seconds` and `lines` bound the journal's reading. A probe that does not read the journal
 * ignores them.
 */
export const NODE_PROBES = [
  "journal",
  "kernel",
  "boots",
  "failed_units",
  "sockets",
  "listeners",
  "pressure",
  "pool",
] as const;
export const NodeProbe = z.enum(NODE_PROBES);
export type NodeProbe = z.infer<typeof NodeProbe>;
export const NODE_PROBE_BOOTS = [0, -1] as const;
export const NODE_PROBE_SINCE_SECONDS_MIN = 60;
export const NODE_PROBE_SINCE_SECONDS_MAX = 86_400;
export const NODE_PROBE_LINES_MAX = 2000;
/** A desired page lists at most this many open requests, the oldest first. */
export const NODE_PROBE_REQUESTS_MAX = 8;
/** A request that no result answered is expired after this long, and leaves the desired page. */
export const NODE_PROBE_EXPIRY_SECONDS = 600;
/** The JSON body of a result: the agent cuts its output until it fits. */
export const NODE_PROBE_RESULT_MAX_BYTES = 1024 * 1024;
const ProbeBoot = z.union([z.literal(0), z.literal(-1)]);
const ProbeSinceSeconds = z
  .number()
  .int()
  .min(NODE_PROBE_SINCE_SECONDS_MIN)
  .max(NODE_PROBE_SINCE_SECONDS_MAX);
const ProbeLines = z.number().int().min(1).max(NODE_PROBE_LINES_MAX);

/** `POST /v1/nodes/{id}/diagnostics`: what to read. The values left out are these defaults. */
export const NodeProbeRequest = z.strictObject({
  probe: NodeProbe,
  boot: ProbeBoot.default(0),
  since_seconds: ProbeSinceSeconds.default(3600),
  lines: ProbeLines.default(200),
});
export type NodeProbeRequest = z.infer<typeof NodeProbeRequest>;
export const NodeProbeAccepted = z.strictObject({ diagnostic_id: z.uuid() });
export type NodeProbeAccepted = z.infer<typeof NodeProbeAccepted>;

/** A request on the desired page: open, not expired, and not yet answered. */
export const NodeDiagnosticRequest = z.strictObject({
  id: z.uuid(),
  probe: NodeProbe,
  boot: ProbeBoot,
  since_seconds: ProbeSinceSeconds,
  lines: ProbeLines,
});
export type NodeDiagnosticRequest = z.infer<typeof NodeDiagnosticRequest>;

/**
 * One page of the node's desired state. A database the pages do not name is never stopped or
 * deleted for that; only an order or a desired state does that. The page of a fenced node (it
 * has a `fence` order) holds no database, no release and only `fence` and `superseded` orders.
 */
export const NodeDesiredPage = z
  .strictObject({
    node: NodeIdentity,
    /** Null until a release is assigned: the node keeps what runs. */
    release: NodeRelease.nullable(),
    policy: NodePolicy,
    /**
     * The revision of the node's credentials (Tunnel token, route keyring and the operator
     * shell's state). The agent reads `NodeCredentials` when this is above the revision it
     * applied, and reports the applied revision in every sample; the API makes a new route key
     * active only after every node of the region reports a revision that holds it.
     */
    credentials_revision: Positive,
    /** Every open order, on every page. */
    orders: z.array(NodeOrder).max(NODE_ORDER_LIMIT),
    /**
     * The probes an administrator asked for that the node has not answered, at most
     * `NODE_PROBE_REQUESTS_MAX`, oldest first; left out when there are none. They are on the first
     * page of a full pull only, not on a pull of named databases (which a wake's pull is, and
     * which stays as fast as it was) or on a later page. The agent runs each once and posts the
     * result to `/node/v1/diagnostics`. A fenced node's page has none.
     */
    diagnostics: z
      .array(NodeDiagnosticRequest)
      .max(NODE_PROBE_REQUESTS_MAX)
      .optional(),
    databases: z.array(NodeDesiredDatabase).max(NODE_DESIRED_PAGE_LIMIT_MAX),
    next: DatabaseId.nullable(),
  })
  .superRefine((page, ctx) => {
    const ids = new Map<string, number>();
    page.databases.forEach((db, index) => {
      if (ids.has(db.id))
        ctx.addIssue({
          code: "custom",
          path: ["databases", index],
          message: "A page names each database once",
        });
      ids.set(db.id, db.storage_generation);
      if (parseArchivePath(db.archive.path)?.region !== page.node.region_id)
        ctx.addIssue({
          code: "custom",
          path: ["databases", index, "archive", "path"],
          message: "The archive is in the node's region",
        });
    });
    if (
      page.orders.some((order) => order.type === "fence") &&
      (page.databases.length > 0 ||
        page.release !== null ||
        page.next !== null ||
        page.orders.some(
          (order) => order.type !== "fence" && order.type !== "superseded",
        ))
    )
      ctx.addIssue({
        code: "custom",
        path: ["orders"],
        message:
          "A fenced node's page holds no database and no release, and only fence and superseded orders",
      });
    const operations = new Set<string>();
    page.orders.forEach((order, index) => {
      if (operations.has(order.operation))
        ctx.addIssue({
          code: "custom",
          path: ["orders", index],
          message: "Each order has its own operation",
        });
      operations.add(order.operation);
      if (order.type !== "superseded") return;
      const served = ids.get(order.database);
      if (served !== undefined && served <= order.storage_generation)
        ctx.addIssue({
          code: "custom",
          path: ["orders", index],
          message:
            "An order never retires a storage generation the page serves",
        });
    });
  });
export type NodeDesiredPage = z.infer<typeof NodeDesiredPage>;

// ---------- Observations (POST /node/v1/observations) ----------

/**
 * `building`: a create, restore or move runs; `ready`: PostgreSQL runs and the storage generation
 * has a DONE base backup; `asleep`: a proven sleep; `unproven`: stopped without a matching record,
 * recovery pending; `error`: see `error`; `deleted`: the volume is gone.
 */
export const NODE_DATABASE_STATES = [
  "building",
  "ready",
  "asleep",
  "unproven",
  "error",
  "deleted",
] as const;
export const NODE_DATABASE_ERRORS = [
  "storage_full",
  "prefix_not_empty",
  "volume_missing",
  "identity_mismatch",
  "no_recovery_point",
  "archive_unusable",
  "build_failed",
  "start_failed",
] as const;

export const NodeDatabaseObservation = z
  .strictObject({
    id: DatabaseId,
    /**
     * The desired generation and operation this observation answers, or the wake claim the node
     * released that the page does not name yet (`observationVerdict`).
     */
    generation: Positive,
    operation: OperationId,
    storage_generation: Positive,
    state: z.enum(NODE_DATABASE_STATES),
    /**
     * The invocation ID of the PostgreSQL unit while the database is `ready`. The route names
     * it (`UnitWriter.instance`, route token v6), so Cloudflare must learn it from the node.
     * Required exactly while ready, and with the `backup` a ready database names, a breaking
     * change for an agent built before them: its whole report is refused until it sends both.
     */
    instance: z.uuid().optional(),
    error: z.enum(NODE_DATABASE_ERRORS).optional(),
    proven_sleep: ProvenSleepRecord.nullable(),
    /**
     * A sleep this generation asked for was refused; the database stays awake and wakeable. The
     * refusal is final for that generation: the node does not retry the proof, and the database
     * suspends only when a new generation asks again.
     */
    refusal: z.enum(["power_busy", "power_archive"]).optional(),
    /**
     * The newest DONE base backup of this storage generation. A ready database has one: the
     * agent reports ready only when its first base backup is DONE (plan 5.10, 7.8).
     */
    backup: z
      .strictObject({
        backup_id: z.string().regex(BACKUP_ID),
        timeline: z.number().int().min(1).max(0xffff_ffff),
        completed_at: Timestamp,
      })
      .nullable(),
    archive: z.strictObject({
      last_segment: WalSegment.nullable(),
      /** Segments waiting for archive (`.ready`); null when unknown, never zero. */
      ready_files: Count.nullable(),
      failing_since: Timestamp.nullable(),
    }),
    /** The fate of the roles the page asked to remove; sent only with a ready database. */
    roles: z
      .strictObject({
        removed: z.array(RoleName).max(ROLE_LIMIT),
        blocked: z.array(RoleName).max(ROLE_LIMIT),
      })
      .optional(),
    message: z.string().max(TEXT_MAX_LENGTH).optional(),
  })
  .superRefine((db, ctx) => {
    if ((db.state === "ready") !== (db.instance !== undefined))
      ctx.addIssue({
        code: "custom",
        path: ["instance"],
        message:
          "A ready database names the unit's instance, and no other does",
      });
    if (db.state === "ready" && db.backup === null)
      ctx.addIssue({
        code: "custom",
        path: ["backup"],
        message:
          "A ready database has a DONE base backup of its storage generation",
      });
    if ((db.state === "asleep") !== (db.proven_sleep !== null))
      ctx.addIssue({
        code: "custom",
        path: ["proven_sleep"],
        message: "A database is asleep exactly with its proven-sleep record",
      });
    if ((db.state === "error") !== (db.error !== undefined))
      ctx.addIssue({
        code: "custom",
        path: ["error"],
        message: "An error state names its error",
      });
    if (db.refusal !== undefined && db.state !== "ready")
      ctx.addIssue({
        code: "custom",
        path: ["refusal"],
        message: "A refused sleep leaves the database ready",
      });
    if (
      db.roles &&
      (db.state !== "ready" ||
        new Set([...db.roles.removed, ...db.roles.blocked]).size !==
          db.roles.removed.length + db.roles.blocked.length)
    )
      ctx.addIssue({
        code: "custom",
        path: ["roles"],
        message:
          "Role removals are reported by a ready observation and name each role once",
      });
  });
export type NodeDatabaseObservation = z.infer<typeof NodeDatabaseObservation>;

/** A generation of one database and the operation that made it. */
export interface GenerationRef {
  generation: number;
  operation: string;
}
export const OBSERVATION_VERDICTS = ["accept", "stale", "conflict"] as const;
export type ObservationVerdict = (typeof OBSERVATION_VERDICTS)[number];
/**
 * Whether the API takes an observation of a database. `desired` is D1's current generation,
 * `claim` the wake ticket the DatabaseActor issued whose claim D1 has not committed yet (null
 * when none): the node releases a wake before D1 commits its claim, so it may report generation
 * N + 1 while D1 still says N. The observation is accepted when it names the desired generation
 * and operation, or exactly that claim. An older generation is `stale` and ignored. Anything else
 * is a `conflict` and is recorded and never applied: the page wins, so the agent applies the
 * desired entry (a concurrent suspend or resize that won the D1 claim) and republishes its table
 * entry for the gateway.
 */
export function observationVerdict(
  desired: GenerationRef,
  claim: GenerationRef | null,
  observed: GenerationRef,
): ObservationVerdict {
  const same = (a: GenerationRef, b: GenerationRef) =>
    a.generation === b.generation && a.operation === b.operation;
  if (observed.generation < desired.generation) return "stale";
  if (observed.generation === desired.generation)
    return same(desired, observed) ? "accept" : "conflict";
  return claim !== null &&
    claim.generation === desired.generation + 1 &&
    same(claim, observed)
    ? "accept"
    : "conflict";
}

/**
 * How an order ended. A failed wake order names a `WAKE_REASONS` entry; every other failure names
 * a short lowercase class.
 */
export const NodeOrderResult = z
  .strictObject({
    operation: OperationId,
    status: z.enum(["done", "failed"]),
    reason: z
      .string()
      .regex(/^[a-z0-9_]{1,64}$/)
      .optional(),
  })
  .refine(
    (result) => (result.status === "failed") === (result.reason !== undefined),
    {
      path: ["reason"],
      message: "Exactly a failure names its reason",
    },
  );
export type NodeOrderResult = z.infer<typeof NodeOrderResult>;

/**
 * The events a report carries, and the fields of one. The agent keeps the first
 * `NODE_REPORT_EVENT_FIELDS_MAX` fields of a log line by key order and drops the others without a
 * word, so the bound has to hold the widest line it sends: the `wake_detail` of a wake on the
 * slot path has 13 fields (the 9 of the detail since the page cache's reading was deleted, and
 * `slot_from`, `slot_wait_us`, `bind_us` and `order_us`).
 */
export const NODE_REPORT_EVENTS_MAX = 64;
export const NODE_REPORT_EVENT_FIELDS_MAX = 16;
/**
 * One line of the agent's own log (plan 9.9): an event's name, and fields that are numbers or
 * short tokens. The shape rules out whitespace, path separators, non-ASCII, nested values and
 * long text. It does not rule out a token that is an address, a host name or a secret: the agent
 * refuses the address forms it knows and its call sites emit only class codes and IDs. The API
 * logs each event as a `node_event` line of Workers Logs and keeps nothing.
 */
export const NodeReportEvent = z.strictObject({
  at: Timestamp,
  event: z.string().regex(/^[a-z0-9_]{1,48}$/),
  database_id: DatabaseId.optional(),
  fields: z
    .record(
      z.string().regex(/^[a-z0-9_]{1,32}$/),
      z.union([z.number(), z.string().regex(/^[a-z0-9_.:-]{1,64}$/)]),
    )
    .refine(
      (fields) => Object.keys(fields).length <= NODE_REPORT_EVENT_FIELDS_MAX,
      {
        message: `An event carries at most ${NODE_REPORT_EVENT_FIELDS_MAX} fields`,
      },
    ),
});
export type NodeReportEvent = z.infer<typeof NodeReportEvent>;

export const NodeObservationReport = z
  .strictObject({
    observed_at: Timestamp,
    databases: z
      .array(NodeDatabaseObservation)
      .max(NODE_DESIRED_PAGE_LIMIT_MAX),
    orders: z.array(NodeOrderResult).max(NODE_ORDER_LIMIT),
    events: z.array(NodeReportEvent).max(NODE_REPORT_EVENTS_MAX).optional(),
  })
  .refine(
    (report) =>
      new Set(report.databases.map((db) => db.id)).size ===
        report.databases.length &&
      new Set(report.orders.map((order) => order.operation)).size ===
        report.orders.length,
    { message: "A report names each database and order once" },
  );
export type NodeObservationReport = z.infer<typeof NodeObservationReport>;

/**
 * The answer to a report: the verdict on each database of it (`observationVerdict`), where the
 * report named it. The node holds a database's observation as taken by the API only on `accept`;
 * on `stale` and `conflict` the page wins and the node reports again from the page it pulls next.
 * A fenced node's report is read for its orders alone, and its answer names no database.
 */
export const NodeObservationAnswer = z.strictObject({
  databases: z
    .array(
      z.strictObject({
        id: DatabaseId,
        verdict: z.enum(OBSERVATION_VERDICTS),
      }),
    )
    .max(NODE_DESIRED_PAGE_LIMIT_MAX),
  /** How many results of the report's orders the API took. */
  orders: z.number().int().nonnegative(),
});
export type NodeObservationAnswer = z.infer<typeof NodeObservationAnswer>;

// ---------- Samples (link) and volumes (POST /node/v1/volumes) ----------

/**
 * The node's snapshot, sent over the link every 15 s. Cloudflare derives the active RAM of plan
 * 4.8 from it: (MemTotal - MemAvailable) / MemTotal, or under the `reserved` rule
 * `awake_memory_mib` over the awake budget; and the CPU load as busy / cores.
 */
export const NodeSample = z
  .strictObject({
    observed_at: Timestamp,
    /** MemTotal and MemAvailable. */
    memory: z.strictObject({
      total_bytes: Positive,
      available_bytes: Bytes,
    }),
    /** Busy CPU averaged over the interval since the previous sample. */
    cpu: z.strictObject({
      cores: z.number().int().min(1).max(1024),
      busy_millicores: Count,
    }),
    /** The thin pool; null when unavailable, never zero. */
    pool: z
      .strictObject({
        observed_at: Timestamp,
        data_total_bytes: Positive,
        data_used_bytes: Bytes,
        metadata_total_bytes: Positive,
        metadata_used_bytes: Bytes,
        /** The sum of every volume's nominal size, for the logical cap. */
        nominal_bytes: Bytes,
      })
      .nullable(),
    /** The room rule of plan 4.6 holds now. */
    room: z.boolean(),
    /** Every thin volume of the node, and those mounted (they hold kernel memory). */
    volumes: z.strictObject({ total: Count, mounted: Count }),
    /**
     * The WAL segments waiting for archive on the node (`.ready` files) and the age of the oldest;
     * null when unknown, never zero, and the age is null when nothing waits.
     */
    archive: z.strictObject({
      ready_files: Count.nullable(),
      oldest_ready_seconds: Count.nullable(),
    }),
    /** Every database whose unit is active or starting. */
    awake: z.array(DatabaseId).max(NODE_AWAKE_LIMIT),
    /** The memory sizes of the awake databases added up: their reservations. */
    awake_memory_mib: Count,
    /** How many of the awake databases are not ready yet. */
    starting: Count,
    /** Wakes waiting for room. */
    queued: Count,
    /** The `NodeCredentials` revision the node applied; null before its first read. */
    credentials_revision: Positive.nullable(),
  })
  .superRefine((sample, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (sample.memory.available_bytes > sample.memory.total_bytes)
      issue("Available memory cannot exceed the total");
    if (sample.cpu.busy_millicores > sample.cpu.cores * 1000)
      issue("Busy CPU cannot exceed the cores");
    if (
      sample.pool &&
      (sample.pool.data_used_bytes > sample.pool.data_total_bytes ||
        sample.pool.metadata_used_bytes > sample.pool.metadata_total_bytes ||
        sample.pool.observed_at > sample.observed_at)
    )
      issue("Pool use cannot exceed the pool or postdate the sample");
    if (sample.volumes.mounted > sample.volumes.total)
      issue("Mounted volumes cannot exceed the volumes");
    if (
      sample.archive.oldest_ready_seconds !== null &&
      !((sample.archive.ready_files ?? 0) > 0)
    )
      issue("Only waiting segments have an age");
    if (new Set(sample.awake).size !== sample.awake.length)
      issue("The awake set names each database once");
    if (sample.starting > sample.awake.length)
      issue("Starting databases are awake databases");
  });
export type NodeSample = z.infer<typeof NodeSample>;

export const NodeVolume = z
  .strictObject({
    database: DatabaseId,
    storage_generation: Positive,
    mounted: z.boolean(),
    /** Nominal size of the thin volume. */
    size_bytes: Positive,
    /** Pool chunks the volume holds. */
    pool_used_bytes: Bytes,
    /** The filesystem's space and inodes, while mounted. */
    filesystem: z
      .strictObject({
        total_bytes: Positive,
        used_bytes: Bytes,
        inodes_total: Positive,
        inodes_used: Count,
      })
      .nullable(),
  })
  .refine((volume) => volume.mounted === (volume.filesystem !== null), {
    path: ["filesystem"],
    message: "A mounted volume reports its filesystem",
  });
export type NodeVolume = z.infer<typeof NodeVolume>;

/** Every thin volume of the node, sampled every 60 s, orphans included. */
export const NodeVolumeReport = z
  .strictObject({
    observed_at: Timestamp,
    volumes: z.array(NodeVolume).max(NODE_VOLUME_LIMIT),
  })
  .refine(
    (report) =>
      new Set(
        report.volumes.map((v) => `${v.database}/${v.storage_generation}`),
      ).size === report.volumes.length,
    { message: "A report names each volume once" },
  );
export type NodeVolumeReport = z.infer<typeof NodeVolumeReport>;

// ---------- Usage (POST /node/v1/usage) ----------

/**
 * What the node meters of one database in one interval: the milliseconds its unit was active, and
 * the deltas of the gateway's counters (`GatewayLocalActivityReport`) over the interval. A metric
 * the node cannot know, such as a counter lost to a gateway restart, is null and never zero; the
 * API names the gap from the null. An interval is positive and stays within one UTC hour, so the
 * API rolls rows up by hour. The agent keeps its rows unchanged until the API answered them.
 */
export const NodeUsageRow = z
  .strictObject({
    database: DatabaseId,
    interval_start: Timestamp,
    interval_end: Timestamp,
    awake_ms: Count.nullable(),
    ingress_bytes: Count.nullable(),
    egress_bytes: Count.nullable(),
    connections: Count.nullable(),
    connection_ms: Count.nullable(),
  })
  .superRefine((row, ctx) => {
    const start = Date.parse(row.interval_start),
      end = Date.parse(row.interval_end);
    if (
      end <= start ||
      Math.floor(start / USAGE_HOUR_MS) !==
        Math.floor((end - 1) / USAGE_HOUR_MS)
    )
      ctx.addIssue({
        code: "custom",
        path: ["interval_end"],
        message: "An interval is positive and stays within one UTC hour",
      });
    if (row.awake_ms !== null && row.awake_ms > end - start)
      ctx.addIssue({
        code: "custom",
        path: ["awake_ms"],
        message: "A database cannot be awake longer than the interval",
      });
  });
export type NodeUsageRow = z.infer<typeof NodeUsageRow>;
/**
 * POST /node/v1/usage. A row is identified by its database, `interval_start` and `interval_end`:
 * the API keeps the row it already holds and ignores a repeat, so a retried post counts once. Rows
 * of one database never overlap, because only one node serves a database at a time.
 */
export const NodeUsageReport = z
  .strictObject({
    rows: z.array(NodeUsageRow).min(1).max(NODE_USAGE_BATCH_MAX),
  })
  .refine(
    (report) =>
      new Set(
        report.rows.map(
          (row) => `${row.database}/${row.interval_start}/${row.interval_end}`,
        ),
      ).size === report.rows.length,
    { path: ["rows"], message: "A report names each interval once" },
  );
export type NodeUsageReport = z.infer<typeof NodeUsageReport>;

// ---------- Events (POST /node/v1/events) ----------

/** Every PostgreSQL start the agent admits (plan 4.6). */
export const ADMISSION_STARTS = [
  "wake",
  "create",
  "restore",
  "move",
  "recovery",
  "resize",
  "check",
] as const;
/**
 * Every event has an id. The agent keeps an event's id across retries of its post; the API
 * deduplicates by (node uid, id), so an event whose post was retried is counted once.
 */
const EventId = z.uuid();
const Duration = z.number().int().min(0).max(600_000);
const Phases = z.strictObject(
  Object.fromEntries(WAKE_PHASES.map((phase) => [phase, Duration.optional()])),
);

export const NodeEvent = z.discriminatedUnion("type", [
  z
    .strictObject({
      type: z.literal("admission"),
      id: EventId,
      at: Timestamp,
      database: DatabaseId,
      generation: Positive,
      /** Null for a start the node took alone: a recovery or a health check. */
      operation: OperationId.nullable(),
      start: z.enum(ADMISSION_STARTS),
      decision: z.enum(["admitted", "refused"]),
      /**
       * Exactly a refusal names its reason, and exactly the refusal of awake capacity the retry
       * hint its client got (`refusalRetryHint`).
       */
      reason: z.enum(ADMISSION_REFUSALS).optional(),
      retry_after_seconds: z.number().int().min(1).max(300).optional(),
      waited_ms: Duration,
      memory_mib: Count,
    })
    .superRefine((event, ctx) => {
      if ((event.decision === "refused") !== (event.reason !== undefined))
        ctx.addIssue({
          code: "custom",
          path: ["reason"],
          message: "Exactly a refusal names its reason",
        });
      if (
        (event.reason !== undefined && refusalRetryHint(event.reason)) !==
        (event.retry_after_seconds !== undefined)
      )
        ctx.addIssue({
          code: "custom",
          path: ["retry_after_seconds"],
          message: "Exactly the refusal of awake capacity carries a retry hint",
        });
    }),
  /** An idle-but-awake database put to sleep early for a waiting wake (D2). */
  z.strictObject({
    type: z.literal("early_sleep"),
    id: EventId,
    at: Timestamp,
    database: DatabaseId,
    generation: Positive,
    for_database: DatabaseId,
  }),
  z
    .strictObject({
      type: z.literal("wake"),
      id: EventId,
      at: Timestamp,
      database: DatabaseId,
      generation: Positive,
      operation: OperationId,
      outcome: z.enum(WAKE_OUTCOMES),
      reason: z.enum(WAKE_REASONS).optional(),
      /** How a `desired_stale` ticket is stale: nothing secret, one of `WAKE_STALE`. */
      stale: z.enum(WAKE_STALE).optional(),
      phases_ms: Phases,
    })
    .refine(
      (event) => (event.outcome === "refused") === (event.reason !== undefined),
      { path: ["reason"], message: "Exactly a refusal names its reason" },
    )
    .refine(
      (event) => event.stale === undefined || event.reason === "desired_stale",
      { path: ["stale"], message: "Only a stale ticket says how it is stale" },
    ),
]);
export type NodeEvent = z.infer<typeof NodeEvent>;
export const NodeEventReport = z
  .strictObject({
    events: z.array(NodeEvent).min(1).max(NODE_EVENT_BATCH_MAX),
  })
  .refine(
    (report) =>
      new Set(report.events.map((event) => event.id)).size ===
      report.events.length,
    { path: ["events"], message: "A report names each event once" },
  );
export type NodeEventReport = z.infer<typeof NodeEventReport>;

// ---------- Boot reports (POST /node/v1/diagnostics) ----------

export const NODE_BOOT_REPORT_ENTRIES_MAX = 1000;
export const NODE_BOOT_REPORT_MESSAGE_MAX_BYTES = 2048;
/** The JSON body of a report: the agent drops the oldest entries until it fits. */
export const NODE_BOOT_REPORT_MAX_BYTES = 1024 * 1024;
const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;
/**
 * The most a stored boot report or probe result may take as the `INSERT` statement that a dump of
 * the control database writes for its row (single quotes doubled, as a dump writes them). D1
 * refuses a statement above 100,000 bytes (`SQLITE_TOOBIG`), so a row above that can be exported
 * but never imported again, and no backup of the database could be restored. A node may send
 * `NODE_BOOT_REPORT_MAX_BYTES` or `NODE_PROBE_RESULT_MAX_BYTES`; the API stores the newest part
 * that fits this bound and marks the cut (`CutMark`). The node is not told: its send succeeded.
 */
export const NODE_DIAGNOSTIC_ROW_MAX_BYTES = 64 * 1024;
/**
 * What the API adds to a report or result it cut to `NODE_DIAGNOSTIC_ROW_MAX_BYTES`, and a node
 * never sends: `truncated` is true and `dropped_entries` is how many of the oldest entries went (0
 * when only the end of a text was cut). Both are there or neither.
 */
const CutMark = {
  truncated: z.literal(true).optional(),
  dropped_entries: Count.optional(),
};
const hasWholeMark = (body: { truncated?: true; dropped_entries?: number }) =>
  (body.truncated === undefined) === (body.dropped_entries === undefined);
const WHOLE_MARK = {
  message: "truncated and dropped_entries are both there or neither",
};

/**
 * One line of the previous boot's journal, reduced to what explains a stop: when, which unit and
 * program said it, through which transport (`journal`, `stdout`, `kernel`, `syslog`, `audit`), at
 * which syslog priority (0 emergency to 7 debug), and the text. `unit` is null for the kernel's
 * lines. The agent never reports a line of a database's unit or of a backup job, whose output
 * can hold the tenant's SQL, and it reports an event line of its own log with the fields an
 * observation event may carry.
 */
export const NodeJournalEntry = z.strictObject({
  at: Timestamp,
  unit: z.string().min(1).max(255).nullable(),
  identifier: z.string().min(1).max(255).nullable(),
  transport: z.string().regex(/^[a-z]{1,16}$/),
  priority: z.number().int().min(0).max(7),
  message: z
    .string()
    .max(NODE_BOOT_REPORT_MESSAGE_MAX_BYTES)
    .refine(
      (message) => utf8Bytes(message) <= NODE_BOOT_REPORT_MESSAGE_MAX_BYTES,
      {
        message: `A message is at most ${NODE_BOOT_REPORT_MESSAGE_MAX_BYTES} bytes`,
      },
    ),
});
export type NodeJournalEntry = z.infer<typeof NodeJournalEntry>;
const bootReport = {
  boot_id: z.uuid(),
  previous_boot_id: z.uuid().nullable(),
  kernel_release: KernelRelease,
  entries: z.array(NodeJournalEntry).max(NODE_BOOT_REPORT_ENTRIES_MAX),
};
/**
 * POST /node/v1/diagnostics: sent once after a boot, when the boot ID differs from the one the
 * agent stored when it last reported; the API keeps one report per boot ID of a node, and answers
 * a second send of it with the stored report's `id` and `expected_reboot`. `kernel_release` is the kernel of `boot_id`. `previous_boot_id`
 * is the boot the `entries` are from (the `_BOOT_ID` of its lines; the stored ID where the journal
 * names none), which is not the boot the agent stored when a report of a boot between them was lost;
 * null when the agent had stored none (it was just installed or updated). `entries` are the tail of
 * the previous boot's journal from the agent, the gateway, cloudflared,
 * networkd, the operator shell's sshd, PID 1 and the kernel, oldest first; they are empty when the node has no journal of the
 * previous boot. The API stores at most `NODE_DIAGNOSTIC_ROW_MAX_BYTES` of a report: its newest
 * entries, marked in the copy that `NodeDiagnostic.report` returns.
 */
export const NodeBootReport = z
  .strictObject(bootReport)
  .refine(
    (report) => utf8Bytes(JSON.stringify(report)) <= NODE_BOOT_REPORT_MAX_BYTES,
    { message: "A boot report is at most 1 MiB" },
  );
export type NodeBootReport = z.infer<typeof NodeBootReport>;

/**
 * What the API says of a stored report. `expected_reboot` is true when a maintenance order of the
 * node was open when its last sample of the previous boot arrived, or closed after it; false
 * when none was (the API then raises `node_unexpected_reboot`); null when the agent knew no
 * earlier boot (`previous_boot_id` null), so that no reboot is claimed.
 */
export const NodeDiagnosticSummary = z.strictObject({
  id: z.uuid(),
  node_id: NodeId,
  kind: z.literal("boot"),
  boot_id: z.uuid(),
  previous_boot_id: z.uuid().nullable(),
  received_at: Timestamp,
  expected_reboot: z.boolean().nullable(),
});
export type NodeDiagnosticSummary = z.infer<typeof NodeDiagnosticSummary>;
export const NodeDiagnostic = NodeDiagnosticSummary.extend({
  /** The report as stored: whole, or cut to `NODE_DIAGNOSTIC_ROW_MAX_BYTES` and marked. */
  report: z
    .strictObject({ ...bootReport, ...CutMark })
    .refine(hasWholeMark, WHOLE_MARK),
});
export type NodeDiagnostic = z.infer<typeof NodeDiagnostic>;

const probeResult = {
  kind: z.literal("probe"),
  diagnostic_id: z.uuid(),
  probe: NodeProbe,
  status: z.enum(["ok", "failed"]),
  entries: z.array(NodeJournalEntry).max(NODE_PROBE_LINES_MAX),
  text: z.string(),
};
/**
 * POST /node/v1/diagnostics with `kind` "probe": the answer to one request on the desired page.
 * `status` is "failed" when the command ended with a status other than 0 or could not be run, and
 * `text` then holds that status and what the command printed. `journal` and `kernel` answer with
 * `entries`, reduced as a boot report's are (at most `lines`, oldest first, and none of a
 * database's unit or of a backup job); every other probe answers with `text`, with the lines that
 * name a database's unit or a backup job left out. The side a probe does not answer with is
 * empty. The body is at most 1 MiB: the agent drops the oldest entries, or the end of the text,
 * until it fits. The API stores at most `NODE_DIAGNOSTIC_ROW_MAX_BYTES` of it, cut the same way and
 * marked in the copy that `NodeProbeDiagnostic.body` returns.
 */
export const NodeProbeResult = z
  .strictObject(probeResult)
  .refine(
    (result) =>
      utf8Bytes(JSON.stringify(result)) <= NODE_PROBE_RESULT_MAX_BYTES,
    { message: "A probe result is at most 1 MiB" },
  );
export type NodeProbeResult = z.infer<typeof NodeProbeResult>;

export const NODE_PROBE_STATUSES = [
  "requested",
  "received",
  "expired",
] as const;
/**
 * What the API says of a request: `requested` until a result arrives, `received` once it has
 * (`body` is the result), and `expired` when `NODE_PROBE_EXPIRY_SECONDS` passed without one.
 * `requested_by` is the key that asked.
 */
export const NodeProbeDiagnostic = z.strictObject({
  id: z.uuid(),
  node_id: NodeId,
  kind: z.literal("probe"),
  probe: NodeProbe,
  boot: ProbeBoot,
  since_seconds: ProbeSinceSeconds,
  lines: ProbeLines,
  requested_by: ApiKeyId,
  requested_at: Timestamp,
  status: z.enum(NODE_PROBE_STATUSES),
  received_at: Timestamp.nullable(),
  /** The result as stored: whole, or cut to `NODE_DIAGNOSTIC_ROW_MAX_BYTES` and marked. */
  body: z
    .strictObject({ ...probeResult, ...CutMark })
    .refine(hasWholeMark, WHOLE_MARK)
    .nullable(),
});
export type NodeProbeDiagnostic = z.infer<typeof NodeProbeDiagnostic>;

// ---------- Link messages (GET /node/v1/link WebSocket) ----------

/**
 * The boot and the operating system a node reports in its hello: the kernel's boot ID and the
 * time of the boot (a reboot is a new ID), `uname -r`, `packagesSha256` of the packages dpkg
 * reports as installed, and `hostFilesSha256` of the host files the node holds, read from its
 * disk, which is the release's only once systemd has been told of every file. The API compares the last
 * three with the release of the node's region.
 */
export const NodeOs = z.strictObject({
  boot_id: z.uuid(),
  booted_at: Timestamp,
  kernel_release: KernelRelease,
  packages_sha256: Sha256,
  host_files_sha256: Sha256,
});
export type NodeOs = z.infer<typeof NodeOs>;

export const AgentLinkMessage = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("hello"),
    protocol: z.literal(NODE_PROTOCOL_VERSION),
    agent_version: z.string().min(1).max(64),
    release_id: FleetReleaseId.nullable(),
    os: NodeOs,
  }),
  z.strictObject({ type: z.literal("sample"), sample: NodeSample }),
]);
export type AgentLinkMessage = z.infer<typeof AgentLinkMessage>;

export const ServerLinkMessage = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("welcome"),
    protocol: z.literal(NODE_PROTOCOL_VERSION),
  }),
  /**
   * Pull the desired page now; with `ids`, only those databases changed. It is also how the
   * NodeActor tells a node that was declared lost: the page then holds the fence.
   */
  z.strictObject({
    type: z.literal("desired"),
    ids: z.array(DatabaseId).min(1).max(NODE_DESIRED_PAGE_LIMIT_MAX).optional(),
  }),
]);
export type ServerLinkMessage = z.infer<typeof ServerLinkMessage>;
