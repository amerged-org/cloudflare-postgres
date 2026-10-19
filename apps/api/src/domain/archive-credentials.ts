// SPDX-License-Identifier: Apache-2.0
import {
  ARCHIVE_CREDENTIAL_ID_PATTERN,
  ArchiveCredential,
  parseArchivePath,
  randomString,
  type ArchiveCredentialReference,
} from "@pgcf/contracts";
import { ApiError } from "../api-error.ts";
import { R2_ACTIONS, signR2Credential } from "../crypto/r2-credentials.ts";
import type { ApiContext } from "../env.ts";

/**
 * The temporary R2 credentials of the nodes (ULTRA plan 7.3). A row of `archive_credentials` says
 * which node may read which scope until when; the desired page names it by its reference and the
 * node reads the secret from `GET /node/v1/archive-credentials/<id>`, where it is signed from the
 * Worker's parent key. Nothing of the secret is stored, and a credential cannot be revoked once
 * read: it can only expire, which is why a lost node's rows stop being delivered at once.
 */
export const ARCHIVE_CREDENTIAL_LIFETIME_SECONDS = 7 * 86_400;
/** Renewed once a third of the lifetime has passed, so an outage has days of margin. */
const RENEW_AFTER_MS = (ARCHIVE_CREDENTIAL_LIFETIME_SECONDS * 1000) / 3;
/** A row stays a day after it expired, so a late read is told "expired" and not "unknown". */
const PURGE_AFTER_MS = 86_400_000;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export type ArchiveAccess = "read_write" | "read_only";
export interface ArchiveCredentialScope {
  nodeId: string;
  archivePath: string;
  access: ArchiveAccess;
}
export interface ArchiveCredentialEnvironment {
  DB: D1Database;
  /** The one archive bucket of the installation; a credential names no other. */
  ARCHIVE_BUCKET_NAME: string;
  R2_PARENT_ACCESS_KEY_ID?: string;
  R2_PARENT_SECRET_ACCESS_KEY?: string;
}

const refused = () => new Error("archive_credential_refused");
const unavailable = () => new Error("archive_credentials_unavailable");
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * A live node and a database of its region; a read-write credential also needs the node to serve
 * exactly this archive path, or to be the target of a move that restores onto exactly this path,
 * so a node that was moved away from a storage generation can never obtain the right to write
 * to it, and a target loses the right when the move ends without it.
 */
const stagedSql = `EXISTS(SELECT 1 FROM database_moves m WHERE m.database_id=d.id AND m.status='restoring'
    AND m.target_node_id=n.id AND m.target_archive_path=?)`;
const guardSql = `n.id=? AND n.region_id=? AND n.lost_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM node_losses l WHERE l.node_id=n.id)
  AND (?='read_only' OR (d.node_id=n.id AND d.archive_path=?) OR ${stagedSql})`;
function guardBindings(scope: ArchiveCredentialScope, region: string) {
  return [
    scope.nodeId,
    region,
    scope.access,
    scope.archivePath,
    scope.archivePath,
  ];
}
function parsedScope(scope: ArchiveCredentialScope) {
  const path = parseArchivePath(scope.archivePath);
  if (!path) throw refused();
  return path;
}

/** Inserts a credential row in the caller's batch, or nothing when the guard does not hold. */
export function archiveCredentialStatement(
  db: D1Database,
  scope: ArchiveCredentialScope,
  id: string,
  issuedAt: number,
): D1PreparedStatement {
  const path = parsedScope(scope);
  return db
    .prepare(
      `INSERT INTO archive_credentials(id,node_id,database_id,archive_path,access,issued_at,expires_at)
      SELECT ?,n.id,d.id,?,?,?,? FROM nodes n JOIN databases d ON d.id=? WHERE ${guardSql}`,
    )
    .bind(
      id,
      scope.archivePath,
      scope.access,
      iso(issuedAt),
      iso(issuedAt + ARCHIVE_CREDENTIAL_LIFETIME_SECONDS * 1000),
      path.database,
      ...guardBindings(scope, path.region),
    );
}
export const newArchiveCredentialId = () =>
  `crd_${randomString(ID_ALPHABET, 20)}`;

/**
 * The credential a desired page names for a scope: the newest one that is younger than a third of
 * its lifetime, else a new one. Throws `archive_credential_refused` for a node that is lost or
 * fenced, a path that is not an archive path, or a write the node is not entitled to.
 */
export async function ensureArchiveCredential(
  db: D1Database,
  scope: ArchiveCredentialScope,
  now: number,
): Promise<ArchiveCredentialReference> {
  const path = parsedScope(scope);
  const allowed = await db
    .prepare(
      `SELECT 1 ok FROM nodes n JOIN databases d ON d.id=? WHERE ${guardSql}`,
    )
    .bind(path.database, ...guardBindings(scope, path.region))
    .first();
  if (!allowed) throw refused();
  const fresh = await db
    .prepare(
      `SELECT id,expires_at FROM archive_credentials WHERE node_id=? AND archive_path=? AND access=? AND issued_at>? AND expires_at>?
      ORDER BY issued_at DESC,id DESC LIMIT 1`,
    )
    .bind(
      scope.nodeId,
      scope.archivePath,
      scope.access,
      iso(now - RENEW_AFTER_MS),
      iso(now),
    )
    .first<ArchiveCredentialReference>();
  if (fresh) return fresh;
  const id = newArchiveCredentialId();
  const inserted = await archiveCredentialStatement(db, scope, id, now).run();
  if (inserted.meta.changes !== 1) throw refused();
  return {
    id,
    expires_at: iso(now + ARCHIVE_CREDENTIAL_LIFETIME_SECONDS * 1000),
  };
}

/**
 * The credentials a desired page names for a set of scopes of one node, keyed `<access>|<path>`:
 * for each the newest one younger than a third of its lifetime, else a new one, issued in one
 * batch. A scope the node may not hold a credential for (see `ensureArchiveCredential`) has no
 * entry, so that a page of hundreds of databases costs two statements and not two per database.
 */
export async function ensureArchiveCredentials(
  db: D1Database,
  nodeId: string,
  scopes: readonly Pick<ArchiveCredentialScope, "archivePath" | "access">[],
  now: number,
): Promise<Map<string, ArchiveCredentialReference>> {
  const wanted = new Map<
    string,
    Pick<ArchiveCredentialScope, "archivePath" | "access">
  >();
  for (const scope of scopes)
    wanted.set(`${scope.access}|${scope.archivePath}`, scope);
  const found = new Map<string, ArchiveCredentialReference>();
  if (wanted.size === 0) return found;
  const fresh = await db
    .prepare(
      `SELECT id,archive_path,access,expires_at FROM archive_credentials
      WHERE node_id=? AND archive_path IN(SELECT value FROM json_each(?)) AND issued_at>? AND expires_at>?
      ORDER BY issued_at DESC,id DESC`,
    )
    .bind(
      nodeId,
      JSON.stringify([
        ...new Set([...wanted.values()].map((s) => s.archivePath)),
      ]),
      iso(now - RENEW_AFTER_MS),
      iso(now),
    )
    .all<{
      id: string;
      archive_path: string;
      access: ArchiveAccess;
      expires_at: string;
    }>();
  for (const row of fresh.results) {
    const key = `${row.access}|${row.archive_path}`;
    if (wanted.has(key) && !found.has(key))
      found.set(key, { id: row.id, expires_at: row.expires_at });
  }
  const missing: { key: string; id: string; statement: D1PreparedStatement }[] =
    [];
  for (const [key, scope] of wanted) {
    if (found.has(key)) continue;
    const id = newArchiveCredentialId();
    try {
      missing.push({
        key,
        id,
        statement: archiveCredentialStatement(
          db,
          { nodeId, ...scope },
          id,
          now,
        ),
      });
    } catch {
      // A path that is no archive path has no credential.
    }
  }
  for (let i = 0; i < missing.length; i += 90) {
    const chunk = missing.slice(i, i + 90),
      results = await db.batch(chunk.map((value) => value.statement));
    chunk.forEach((value, index) => {
      if (results[index]!.meta.changes === 1)
        found.set(value.key, {
          id: value.id,
          expires_at: iso(now + ARCHIVE_CREDENTIAL_LIFETIME_SECONDS * 1000),
        });
    });
  }
  return found;
}

interface DeliveryRow {
  id: string;
  node_id: string;
  archive_path: string;
  access: ArchiveAccess;
  expires_at: string;
  backup_endpoint_url: string;
  database_node_id: string | null;
  database_archive_path: string;
  lost: number;
  /** The node is the target of a move that restores onto this path now. */
  staged: number;
}

/**
 * The credential for a node that asks for one it was issued, signed now with the Worker's parent
 * key; null for anything else (unknown, another node's, expired, a lost or fenced node's, a
 * write right for a storage generation the node does not serve and does not restore). Throws
 * `archive_credentials_unavailable` when the Worker has no parent key or the path names another
 * bucket than the installation's one. The caller never logs the result.
 */
export async function deliverArchiveCredential(
  env: ArchiveCredentialEnvironment,
  nodeId: string,
  id: string,
  now: number,
): Promise<ArchiveCredential | null> {
  const row = await env.DB.prepare(
    `SELECT c.id,c.node_id,c.archive_path,c.access,c.expires_at,r.backup_endpoint_url,
      d.node_id database_node_id,d.archive_path database_archive_path,
      CASE WHEN n.lost_at IS NOT NULL OR EXISTS(SELECT 1 FROM node_losses l WHERE l.node_id=n.id) THEN 1 ELSE 0 END lost,
      CASE WHEN EXISTS(SELECT 1 FROM database_moves m WHERE m.database_id=c.database_id AND m.status='restoring'
        AND m.target_node_id=c.node_id AND m.target_archive_path=c.archive_path) THEN 1 ELSE 0 END staged
      FROM archive_credentials c JOIN nodes n ON n.id=c.node_id JOIN regions r ON r.id=n.region_id
      JOIN databases d ON d.id=c.database_id WHERE c.id=? AND c.node_id=?`,
  )
    .bind(id, nodeId)
    .first<DeliveryRow>();
  if (
    !row ||
    now >= Date.parse(row.expires_at) ||
    row.lost === 1 ||
    (row.access === "read_write" &&
      row.staged === 0 &&
      (row.database_node_id !== row.node_id ||
        row.database_archive_path !== row.archive_path))
  )
    return null;
  const parent = {
    accessKeyId: env.R2_PARENT_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.R2_PARENT_SECRET_ACCESS_KEY ?? "",
  };
  const path = parseArchivePath(row.archive_path);
  let account: string | undefined;
  try {
    account = /^([0-9a-f]{32})\./.exec(
      new URL(row.backup_endpoint_url).host,
    )?.[1];
  } catch {
    account = undefined;
  }
  if (
    parent.accessKeyId === "" ||
    parent.secretAccessKey === "" ||
    !path ||
    path.bucket !== env.ARCHIVE_BUCKET_NAME ||
    account === undefined
  )
    throw unavailable();
  const issuedAt = Math.floor(now / 1000);
  const signed = await signR2Credential(parent, {
    accountId: account,
    endpoint: row.backup_endpoint_url,
    bucket: path.bucket,
    prefix: `${path.region}/${path.database}/g${path.generation}-${path.operation}/`,
    actions: R2_ACTIONS[row.access],
    issuedAt,
    expiresAt: Math.floor(Date.parse(row.expires_at) / 1000),
  }).catch(() => {
    throw unavailable();
  });
  return ArchiveCredential.parse({
    id: row.id,
    path: row.archive_path,
    access: row.access,
    endpoint_url: row.backup_endpoint_url,
    access_key_id: signed.accessKeyId,
    secret_access_key: signed.secretAccessKey,
    session_token: signed.sessionToken,
    expires_at: row.expires_at,
  });
}

/**
 * `GET /node/v1/archive-credentials/{id}` for the node that signed the request. The router of the
 * node API verifies the signature and passes the node it belongs to; a credential that is not
 * this node's, has expired or is withheld from a lost node is plainly not found. The secret is in
 * the body only and the response is never cached.
 */
export async function archiveCredentialResponse(
  c: ApiContext,
  nodeId: string,
): Promise<Response> {
  const id = c.req.param("id") ?? "";
  const credential = ARCHIVE_CREDENTIAL_ID_PATTERN.test(id)
    ? await deliverArchiveCredential(c.env, nodeId, id, Date.now())
    : null;
  if (!credential) throw new ApiError("not_found", "Credential not found");
  return c.json(credential, 200, { "Cache-Control": "no-store" });
}

/** Deletes up to `limit` rows that expired more than a day ago; returns how many went. */
export async function purgeArchiveCredentials(
  db: D1Database,
  now: number,
  limit = 100,
): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM archive_credentials WHERE id IN
      (SELECT id FROM archive_credentials WHERE expires_at<? ORDER BY expires_at LIMIT ?)`,
    )
    .bind(iso(now - PURGE_AFTER_MS), limit)
    .run();
  return result.meta.changes;
}
