// SPDX-License-Identifier: Apache-2.0
import {
  ENROLLMENT_TOKEN_LIFETIME_SECONDS,
  ENROLLMENT_TOKEN_PATTERN,
  INSTALLER_CHECKPOINTS,
  ImageVersion,
  InstallerProgress,
  NodeEnrollmentRequest,
  NodeEnrollmentResponse,
  hashApiKey,
  newSecret,
  timingSafeEqual,
} from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { ApiContext, Env } from "../env.ts";

/**
 * Where an enrollment may come from (plan 8): the public IPv4 the provider reports for the
 * instance, or an address in its IPv6 prefix, because a VPS with both reaches Cloudflare over
 * either.
 */
export type InstallSource =
  { readonly v4: string } | { readonly v6: string; readonly prefix: number };

const PROGRESS_TOKEN_PREFIX = "pgcf_pt_";
/** The checkpoints that must have arrived before the node may enroll: the whole install. */
const REQUIRED_CHECKPOINTS = INSTALLER_CHECKPOINTS.filter(
  (checkpoint) => checkpoint !== "failed",
);

function ipv4Bytes(text: string): Uint8Array | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) =>
    /^(0|[1-9][0-9]{0,2})$/.test(part) ? Number(part) : NaN,
  );
  return bytes.every((value) => value <= 255) ? Uint8Array.from(bytes) : null;
}
function ipv6Bytes(text: string): Uint8Array | null {
  if (!/^[0-9a-fA-F:]{2,39}$/.test(text)) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const head = groups(halves[0]!),
    tail = halves.length === 2 ? groups(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [
    ...head,
    ...Array<string>(missing > 0 ? missing : 0).fill("0"),
    ...tail,
  ];
  if (
    all.length !== 8 ||
    !all.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group))
  )
    return null;
  const bytes = new Uint8Array(16);
  all.forEach((group, index) => {
    const value = parseInt(group, 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  });
  return bytes;
}
function samePrefix(a: Uint8Array, b: Uint8Array, bits: number): boolean {
  for (let bit = 0; bit < bits; bit += 8) {
    const mask = bits - bit >= 8 ? 0xff : (0xff << (8 - (bits - bit))) & 0xff;
    if ((a[bit / 8]! & mask) !== (b[bit / 8]! & mask)) return false;
  }
  return true;
}
/** Whether `address` is one the provider reports for the instance. */
export function sourceAllowed(
  address: string | undefined,
  sources: readonly InstallSource[],
): boolean {
  if (address === undefined) return false;
  const v4 = ipv4Bytes(address),
    v6 = v4 === null ? ipv6Bytes(address) : null;
  return sources.some((source) => {
    if ("v4" in source)
      return (
        v4 !== null &&
        samePrefix(v4, ipv4Bytes(source.v4) ?? new Uint8Array(), 32)
      );
    const prefix = ipv6Bytes(source.v6);
    return (
      v6 !== null && prefix !== null && samePrefix(v6, prefix, source.prefix)
    );
  });
}
/** The sources of a provider's network configuration (`ipConfig` of a Contabo instance). */
export function installSources(config: {
  v4: { ip: string };
  v6?: { ip: string; netmaskCidr: number } | undefined;
}): InstallSource[] {
  const sources: InstallSource[] = [];
  if (ipv4Bytes(config.v4.ip) !== null) sources.push({ v4: config.v4.ip });
  if (config.v6 && ipv6Bytes(config.v6.ip) !== null)
    sources.push({ v6: config.v6.ip, prefix: config.v6.netmaskCidr });
  return sources;
}

export interface IssuedInstall {
  enrollment_token: string;
  progress_token: string;
  expires_at: string;
}
/**
 * Issues the two one-time tokens of a node's install (plan 9.2): the progress token that reports
 * the installer's checkpoints, and the enrollment token the first boot exchanges for the node's
 * identity. Only their HMACs are stored. A node that did not enroll yet can be issued new tokens.
 */
export async function issueNodeInstall(
  env: Env,
  input: {
    node_id: string;
    image_version: string;
    sources: readonly InstallSource[];
    now?: number;
  },
): Promise<IssuedInstall> {
  const imageVersion = ImageVersion.parse(input.image_version);
  const addition = await env.DB.prepare(
    "SELECT status FROM node_additions WHERE node_id=?",
  )
    .bind(input.node_id)
    .first<{ status: string }>();
  if (!addition || ["failed", "cancelled"].includes(addition.status))
    throw new ApiError("not_found", "No node addition is installing this node");
  if (input.sources.length === 0)
    throw new ApiError("invalid_request", "The install needs an address");
  const enrollment = `pgcf_et_${newSecret()}`,
    progress = `${PROGRESS_TOKEN_PREFIX}${newSecret()}`,
    issued = input.now ?? Date.now();
  const expires = new Date(issued + ENROLLMENT_TOKEN_LIFETIME_SECONDS * 1000);
  const result = await env.DB.prepare(
    `INSERT INTO node_installs(node_id,image_version,token_hash,progress_hash,allowed_sources_json,issued_at,expires_at)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(node_id) DO UPDATE SET image_version=excluded.image_version,token_hash=excluded.token_hash,
       progress_hash=excluded.progress_hash,allowed_sources_json=excluded.allowed_sources_json,checkpoints_json='[]',
       progress_closed_at=NULL,issued_at=excluded.issued_at,expires_at=excluded.expires_at
     WHERE node_installs.enrolled_at IS NULL`,
  )
    .bind(
      input.node_id,
      imageVersion,
      await hashApiKey(env.API_KEY_PEPPER, enrollment),
      await hashApiKey(env.API_KEY_PEPPER, progress),
      JSON.stringify(input.sources),
      new Date(issued).toISOString(),
      expires.toISOString(),
    )
    .run();
  if (result.meta.changes !== 1)
    throw new ApiError(
      "conflict",
      "The node is enrolled; a reinstall is a new node",
    );
  return {
    enrollment_token: enrollment,
    progress_token: progress,
    expires_at: expires.toISOString(),
  };
}

interface InstallRow {
  node_id: string;
  image_version: string;
  token_hash: string;
  allowed_sources_json: string;
  checkpoints_json: string;
  progress_closed_at: string | null;
  expires_at: string;
  enrolled_at: string | null;
  enrolled_public_key: string | null;
  enrolled_node_uid: string | null;
}
interface Checkpoint {
  checkpoint: (typeof INSTALLER_CHECKPOINTS)[number];
  detail: string;
  at: string;
}

/** `POST /node/v1/installer/progress`, authenticated by the install's progress token. */
export async function recordInstallerProgress(
  c: ApiContext,
  raw: unknown,
): Promise<Response> {
  const authorization = c.req.header("Authorization"),
    token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token.startsWith(PROGRESS_TOKEN_PREFIX))
    throw new ApiError("unauthorized", "Invalid installer credentials");
  const hash = await hashApiKey(c.env.API_KEY_PEPPER, token);
  const row = await c.env.DB.prepare(
    "SELECT * FROM node_installs WHERE progress_hash=?",
  )
    .bind(hash)
    .first<InstallRow>();
  const now = new Date().toISOString();
  if (
    !row ||
    row.progress_closed_at !== null ||
    row.enrolled_at !== null ||
    row.expires_at <= now
  )
    throw new ApiError("unauthorized", "Invalid installer credentials");
  const progress = InstallerProgress.safeParse(raw);
  if (!progress.success)
    throw new ApiError("invalid_request", "Invalid installer progress");
  const seen = JSON.parse(row.checkpoints_json) as Checkpoint[];
  if (!seen.some((entry) => entry.checkpoint === progress.data.checkpoint)) {
    const closes = ["rebooting", "failed"].includes(progress.data.checkpoint);
    const result = await c.env.DB.prepare(
      "UPDATE node_installs SET checkpoints_json=?,progress_closed_at=? WHERE node_id=? AND checkpoints_json=? AND progress_closed_at IS NULL",
    )
      .bind(
        JSON.stringify([...seen, { ...progress.data, at: now }]),
        closes ? now : null,
        row.node_id,
        row.checkpoints_json,
      )
      .run();
    // Another report of the same install won the race: the installer reports in order, and a
    // repeat of its own report is answered above.
    if (result.meta.changes !== 1)
      throw new ApiError("conflict", "Installer progress changed");
    console.log(
      JSON.stringify({
        event: "node_install_checkpoint",
        node_id: row.node_id,
        checkpoint: progress.data.checkpoint,
        detail: progress.data.detail,
      }),
    );
  }
  return c.json({ accepted: true as const });
}

interface AdditionRow {
  region_id: string;
  intent_json: string;
  provider_instance_id: string | null;
  status: string;
}
async function identityOf(
  env: Env,
  nodeId: string,
): Promise<NodeEnrollmentResponse | null> {
  const row = await env.DB.prepare(
    "SELECT id,node_uid uid,k8s_node_name hostname,region_id FROM nodes WHERE id=? AND node_uid IS NOT NULL",
  )
    .bind(nodeId)
    .first();
  return row === null ? null : NodeEnrollmentResponse.parse(row);
}

/**
 * `POST /node/v1/enroll` (plan 8, 9.2). The node proves it holds the install's one-time token, that
 * it runs the image version the token names, that the installer's checkpoints arrived and that it
 * comes from the instance's own address. The token is burnt by the first enrollment; the same
 * token with the same key answers the same identity, because the first answer may have been lost,
 * and another key is refused.
 */
export async function enrollNode(
  c: ApiContext,
  raw: unknown,
): Promise<Response> {
  const parsed = NodeEnrollmentRequest.safeParse(raw);
  if (
    !parsed.success ||
    !ENROLLMENT_TOKEN_PATTERN.test(parsed.data.enrollment_token)
  )
    throw new ApiError("invalid_request", "Invalid enrollment");
  const request = parsed.data;
  const hash = await hashApiKey(c.env.API_KEY_PEPPER, request.enrollment_token);
  const row = await c.env.DB.prepare(
    "SELECT * FROM node_installs WHERE node_id=?",
  )
    .bind(request.node_id)
    .first<InstallRow>();
  const refuse = (
    reason: string,
    code: "unauthorized" | "forbidden" | "conflict",
  ) => {
    console.warn(
      JSON.stringify({
        event: "node_enrollment_refused",
        node_id: request.node_id,
        reason,
      }),
    );
    return new ApiError(code, "Enrollment refused");
  };
  // An unknown node and a wrong token are the same refusal.
  if (!row || !timingSafeEqual(row.token_hash, hash))
    throw refuse("token", "unauthorized");
  const now = new Date().toISOString();
  if (row.enrolled_at !== null) {
    if (row.enrolled_public_key !== request.public_key || row.expires_at <= now)
      throw refuse("repeat", "conflict");
    const same = await identityOf(c.env, request.node_id);
    if (same !== null) return c.json(same);
  }
  if (row.expires_at <= now) throw refuse("expired", "unauthorized");
  if (request.image_version !== row.image_version)
    throw refuse("image", "conflict");
  if (
    !sourceAllowed(
      c.req.header("CF-Connecting-IP"),
      JSON.parse(row.allowed_sources_json) as InstallSource[],
    )
  )
    throw refuse("source", "forbidden");
  const reported = new Set(
    (JSON.parse(row.checkpoints_json) as Checkpoint[]).map(
      (entry) => entry.checkpoint,
    ),
  );
  if (
    reported.has("failed") ||
    !REQUIRED_CHECKPOINTS.every((checkpoint) => reported.has(checkpoint))
  )
    throw refuse("checkpoints", "conflict");
  const addition = await c.env.DB.prepare(
    "SELECT region_id,intent_json,provider_instance_id,status FROM node_additions WHERE node_id=?",
  )
    .bind(request.node_id)
    .first<AdditionRow>();
  if (!addition || ["failed", "cancelled"].includes(addition.status))
    throw refuse("addition", "conflict");
  const hostname = (
    JSON.parse(addition.intent_json) as { requested_hostname: string }
  ).requested_hostname;
  const uid = crypto.randomUUID();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE node_installs SET enrolled_at=?,enrolled_public_key=?,enrolled_node_uid=?
       WHERE node_id=? AND token_hash=? AND enrolled_at IS NULL AND expires_at>?`,
    ).bind(now, request.public_key, uid, request.node_id, hash, now),
    c.env.DB.prepare(
      `INSERT INTO nodes(id,region_id,k8s_node_name,provider_instance_id,ready,schedulable,allocatable_memory_mib,
         allocatable_cpu_millicores,created_at,updated_at,node_uid,public_key,enrolled_at)
       SELECT ?,?,?,?,0,0,0,0,?,?,?,?,? WHERE changes()=1
       ON CONFLICT(id) DO UPDATE SET node_uid=excluded.node_uid,public_key=excluded.public_key,
         enrolled_at=excluded.enrolled_at,updated_at=excluded.updated_at WHERE nodes.node_uid IS NULL`,
    ).bind(
      request.node_id,
      addition.region_id,
      hostname,
      addition.provider_instance_id,
      now,
      now,
      uid,
      request.public_key,
      now,
    ),
  ]);
  if (results[0]!.meta.changes !== 1) throw refuse("raced", "conflict");
  const identity = await identityOf(c.env, request.node_id);
  if (identity === null || identity.uid !== uid)
    throw refuse("identity", "conflict");
  return c.json(identity);
}
