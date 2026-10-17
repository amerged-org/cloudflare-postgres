// SPDX-License-Identifier: Apache-2.0
/**
 * The contract between a node's agent and Cloudflare (ULTRA plan 4.6-4.9, 5.3, 5.6, 7.3, 7.9-7.11,
 * 8, 9.2-9.5). A node enrolls once with the installer's one-time token and an Ed25519 key it
 * generated, then signs every request with that key. It pulls its desired page (its databases,
 * release, policy and orders), reads its credentials, keeps the link to its NodeActor with a
 * sample every 15 s, and posts observations, volume reports and events. The Rust node agent reads
 * the JSON Schemas and vectors in `native/node.generated.json` and `node-vectors.generated.json`.
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
import { FleetReleaseId } from "./releases.ts";
import { WAKE_OUTCOMES, WAKE_PHASES, WAKE_REASONS } from "./node-local.ts";

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const Count = z.number().int().nonnegative().max(MAX_SAFE);
const Positive = z.number().int().min(1).max(MAX_SAFE);
const Bytes = Count;
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
/** The pattern carries the scheme into the JSON Schema, which drops the URL check. */
const Https = HttpsUrl.regex(/^https:\/\//);

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
} as const;
/** The installer's checkpoints go here with its one-time progress token (plan 9.2). */
export const INSTALLER_PROGRESS_PATH = "/node/v1/installer/progress";
export const NODE_SAMPLE_INTERVAL_MS = 15_000;
export const NODE_VOLUME_REPORT_INTERVAL_MS = 60_000;
/** A node whose link stays silent this long is stale; staleness never declares it lost. */
export const NODE_STALE_MS = 180_000;
export const NODE_LINK_MESSAGE_MAX_BYTES = 64 * 1024;
export const NODE_DESIRED_PAGE_LIMIT_MAX = 200;
export const NODE_ORDER_LIMIT = 1000;
export const NODE_AWAKE_LIMIT = 2000;
export const NODE_VOLUME_LIMIT = 10_000;
export const NODE_EVENT_BATCH_MAX = 500;

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
/** A token lives this long, is bound to one image version and is burnt by its enrollment. */
export const ENROLLMENT_TOKEN_LIFETIME_SECONDS = 1800;
export const EnrollmentToken = z.string().regex(ENROLLMENT_TOKEN_PATTERN);
export const IMAGE_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
export const ImageVersion = z.string().regex(IMAGE_VERSION_PATTERN);

/** `/var/lib/pgcf/enrollment/seed.json`, written by the installer and deleted after enrollment. */
export const NODE_ENROLLMENT_SEED_PATH = "/var/lib/pgcf/enrollment/seed.json";
export const NodeEnrollmentSeed = z.strictObject({
  node_id: NodeId,
  region: RegionId,
  api_url: Https,
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
 * installer's checkpoints for this token arrived, and for the image version the token names.
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

/** GET /node/v1/credentials: what the gateway and the Tunnel need, after enrollment. */
export const NodeCredentials = z.strictObject({
  tunnel_token: z.string().regex(/^[A-Za-z0-9+/=_-]{32,4096}$/),
  /** The node's route keyring for the gateway (`PGCF_ROUTE_KEY`). */
  route_keyring: RegionRouteKeyring,
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

const PinnedFile = z.strictObject({
  url: Https,
  sha256: Sha256,
  size_bytes: Positive,
});
/**
 * What the node runs. The agent downloads the four binaries, each under its own file name, into
 * the release's directory `/var/lib/pgcf/bin/<id>/`, checks their sha256, switches the `current`
 * link and restarts the services. Everything else, cloudflared included, is a Debian package: it
 * changes only in a maintenance cycle, through the package lock.
 */
export const NodeRelease = z.strictObject({
  id: FleetReleaseId,
  binaries: z.strictObject({
    "pgcf-agent": PinnedFile,
    "pgcf-native-gateway": PinnedFile,
    "pgcf-archive": PinnedFile,
    "pgcf-wal-fetch": PinnedFile,
  }),
  os: z.strictObject({
    image_version: ImageVersion,
    debian_snapshot: z.string().regex(/^[0-9]{8}T[0-9]{6}Z$/),
    /** Every package with its version and sha256, installed exactly in the maintenance cycle. */
    package_lock: PinnedFile,
  }),
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
  }),
});
export type NodePolicy = z.infer<typeof NodePolicy>;

const BACKUP_ID = /^[0-9]{8}T[0-9]{6}$/;
/** The archive a storage generation is built from: a backup and, for a PITR, a target time. */
export const RestoreSource = z.strictObject({
  database_id: DatabaseId,
  path: ArchivePath,
  backup_id: z.string().regex(BACKUP_ID),
  target_time: Timestamp.optional(),
  credential: ArchiveCredentialReference,
});
export type RestoreSource = z.infer<typeof RestoreSource>;
/**
 * How the node builds the storage generation: `create` (initdb, only onto an empty archive path),
 * `restore` (into a new database) or `move` (this database's previous storage generation, to the
 * end of its WAL). Absent once the generation was ready: a missing volume is then an error and
 * never a fresh build.
 */
export const DatabaseOrigin = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("create") }),
  z.strictObject({ kind: z.literal("restore"), source: RestoreSource }),
  z.strictObject({ kind: z.literal("move"), source: RestoreSource }),
]);
export type DatabaseOrigin = z.infer<typeof DatabaseOrigin>;

export const NodeDesiredDatabase = z
  .strictObject({
    id: DatabaseId,
    /** D1's generation of the database; every change and every wake claim advances it. */
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
            from.generation >= db.storage_generation ||
            source.target_time !== undefined)
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

/**
 * One page of the node's desired state. A database the pages do not name is never stopped or
 * deleted for that; only an order or a desired state does that.
 */
export const NodeDesiredPage = z
  .strictObject({
    node: NodeIdentity,
    /** Null until a release is assigned: the node keeps what runs. */
    release: NodeRelease.nullable(),
    policy: NodePolicy,
    /** Every open order, on every page. */
    orders: z.array(NodeOrder).max(NODE_ORDER_LIMIT),
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
    /** The desired generation and operation this observation answers. */
    generation: Positive,
    operation: OperationId,
    storage_generation: Positive,
    state: z.enum(NODE_DATABASE_STATES),
    error: z.enum(NODE_DATABASE_ERRORS).optional(),
    proven_sleep: ProvenSleepRecord.nullable(),
    /** A sleep this generation asked for was refused; the database stays awake and wakeable. */
    refusal: z.enum(["power_busy", "power_archive"]).optional(),
    /** The newest DONE base backup of this storage generation. */
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

export const NodeObservationReport = z
  .strictObject({
    observed_at: Timestamp,
    databases: z
      .array(NodeDatabaseObservation)
      .max(NODE_DESIRED_PAGE_LIMIT_MAX),
    orders: z.array(NodeOrderResult).max(NODE_ORDER_LIMIT),
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
/** `no_room`: the room rule failed; `no_headroom`: the wait for awake capacity expired. */
export const ADMISSION_REFUSALS = ["no_room", "no_headroom"] as const;
/** The detail of the 57P03 that answers each refusal (plan 4.6). */
export const ADMISSION_REFUSAL_DETAILS = {
  no_room: "storage",
  no_headroom: "node at awake capacity",
} as const satisfies Record<(typeof ADMISSION_REFUSALS)[number], string>;

const Duration = z.number().int().min(0).max(600_000);
const Phases = z.strictObject(
  Object.fromEntries(WAKE_PHASES.map((phase) => [phase, Duration.optional()])),
);

export const NodeEvent = z.discriminatedUnion("type", [
  z
    .strictObject({
      type: z.literal("admission"),
      at: Timestamp,
      database: DatabaseId,
      generation: Positive,
      /** Null for a start the node took alone: a recovery or a health check. */
      operation: OperationId.nullable(),
      start: z.enum(ADMISSION_STARTS),
      decision: z.enum(["admitted", "refused"]),
      /** Exactly a refusal names its reason and the retry hint its client got. */
      reason: z.enum(ADMISSION_REFUSALS).optional(),
      retry_after_seconds: z.number().int().min(1).max(300).optional(),
      waited_ms: Duration,
      memory_mib: Count,
    })
    .superRefine((event, ctx) => {
      const refused = event.decision === "refused";
      for (const field of ["reason", "retry_after_seconds"] as const)
        if (refused !== (event[field] !== undefined))
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: "Exactly a refusal names its reason and its retry hint",
          });
    }),
  /** An idle-but-awake database put to sleep early for a waiting wake (D2). */
  z.strictObject({
    type: z.literal("early_sleep"),
    at: Timestamp,
    database: DatabaseId,
    generation: Positive,
    for_database: DatabaseId,
  }),
  z
    .strictObject({
      type: z.literal("wake"),
      at: Timestamp,
      database: DatabaseId,
      generation: Positive,
      operation: OperationId,
      outcome: z.enum(WAKE_OUTCOMES),
      reason: z.enum(WAKE_REASONS).optional(),
      phases_ms: Phases,
    })
    .refine(
      (event) => (event.outcome === "refused") === (event.reason !== undefined),
      { path: ["reason"], message: "Exactly a refusal names its reason" },
    ),
]);
export type NodeEvent = z.infer<typeof NodeEvent>;
export const NodeEventReport = z.strictObject({
  events: z.array(NodeEvent).min(1).max(NODE_EVENT_BATCH_MAX),
});
export type NodeEventReport = z.infer<typeof NodeEventReport>;

// ---------- Link messages (GET /node/v1/link WebSocket) ----------

export const AgentLinkMessage = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("hello"),
    protocol: z.literal(NODE_PROTOCOL_VERSION),
    agent_version: z.string().min(1).max(64),
    release_id: FleetReleaseId.nullable(),
  }),
  z.strictObject({ type: z.literal("sample"), sample: NodeSample }),
]);
export type AgentLinkMessage = z.infer<typeof AgentLinkMessage>;

export const ServerLinkMessage = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("welcome"),
    protocol: z.literal(NODE_PROTOCOL_VERSION),
  }),
  /** Pull the desired page now; with `ids`, only those databases changed. */
  z.strictObject({
    type: z.literal("desired"),
    ids: z.array(DatabaseId).min(1).max(NODE_DESIRED_PAGE_LIMIT_MAX).optional(),
  }),
]);
export type ServerLinkMessage = z.infer<typeof ServerLinkMessage>;
