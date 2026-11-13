// SPDX-License-Identifier: Apache-2.0
import { ApiError } from "../api-error.ts";

/**
 * The Worker's digest of a base backup, recorded when a node first reports it done. A node writes the
 * descriptor (`backup.info`) and the data of every backup, so a node that rewrote either after the
 * digest was recorded no longer matches it, and recovery and retention refuse the archive. The digest
 * covers each object under the backup's prefix by its key, size and R2 etag. A backup the Worker never
 * recorded is not trusted at all.
 */
export interface ArchivedObject {
  key: string;
  size: number;
  etag: string;
}

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** The digest of one backup's objects, independent of the order the listing returns them in. */
export async function backupDigest(
  objects: readonly ArchivedObject[],
): Promise<string> {
  const lines = objects
    .map((object) => `${object.key}\n${object.size}\n${object.etag}`)
    .sort();
  return hex(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(lines.join("\n")),
    ),
  );
}

/**
 * Records the digest of a reported backup, once: a backup already recorded keeps the digest it has. A
 * backup whose listing is incomplete or whose descriptor is absent is not recorded, so it stays untrusted.
 */
export async function recordBackupDigest(
  bucket: R2Bucket,
  db: D1Database,
  archivePath: string,
  prefix: string,
  backupId: string,
  now: number,
): Promise<boolean> {
  const listed = await bucket.list({
    prefix: `${prefix}base/${backupId}/`,
    limit: 1000,
  });
  if (listed.truncated || listed.delimitedPrefixes.length) return false;
  if (
    !listed.objects.some(
      (o) => o.key === `${prefix}base/${backupId}/backup.info`,
    )
  )
    return false;
  const digest = await backupDigest(
    listed.objects.map((o) => ({ key: o.key, size: o.size, etag: o.etag })),
  );
  await db
    .prepare(
      "INSERT OR IGNORE INTO archive_backup_digests(archive_path,backup_id,digest,recorded_at) VALUES(?,?,?,?)",
    )
    .bind(archivePath, backupId, digest, new Date(now).toISOString())
    .run();
  return true;
}

/** Refuses a backup whose objects no longer match the digest recorded for it. */
export async function verifyBackupDigest(
  bucket: R2Bucket,
  prefix: string,
  backupId: string,
  recorded: string,
): Promise<void> {
  const listed: ArchivedObject[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: `${prefix}base/${backupId}/`,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    listed.push(
      ...page.objects.map((o) => ({ key: o.key, size: o.size, etag: o.etag })),
    );
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  if ((await backupDigest(listed)) !== recorded) throw digestMismatch();
}

/** The digests recorded for one archive, by backup id. */
export async function recordedDigests(
  db: D1Database,
  archivePath: string,
): Promise<Map<string, string>> {
  const rows = await db
    .prepare(
      "SELECT backup_id,digest FROM archive_backup_digests WHERE archive_path=?",
    )
    .bind(archivePath)
    .all<{ backup_id: string; digest: string }>();
  return new Map(rows.results.map((row) => [row.backup_id, row.digest]));
}

/** Refuses an archive whose recorded backup no longer matches what the Worker recorded. */
export const digestMismatch = () =>
  new ApiError("conflict", "A recorded backup of this archive changed", {
    reason: "archive_digest_mismatch",
  });
