// SPDX-License-Identifier: Apache-2.0
import { ApiError } from "../api-error.ts";

/**
 * The Worker's digest of a base backup, recorded when a node first reports it done (or by the backfill
 * for archives written before digests existed). A node writes the descriptor (`backup.info`) and the
 * data of every backup, so a node that rewrote either after the digest was recorded no longer matches
 * it: that backup is left out of recovery and retention refuses to delete anything from the archive.
 * The digest covers each object under the backup's prefix by its key, size and R2 etag.
 *
 * An archive is enforced only once its backfill is marked done: until then its backups that were never
 * recorded are trusted as they were before digests existed, so that none is dropped before the backfill
 * has looked at the archive. A recorded backup that no longer matches is left out at any time.
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

/** Every object under one backup's prefix, across as many listing pages as the backup needs. */
export async function listBackup(
  bucket: R2Bucket,
  prefix: string,
  backupId: string,
): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: `${prefix}base/${backupId}/`,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    if (page.truncated && !page.cursor)
      throw new Error("backup_listing_incomplete");
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return objects;
}

/**
 * Records the digest of a reported backup, once: a backup already recorded keeps the digest it has. A
 * backup whose descriptor is absent is not recorded, so it stays untrusted. With `fencedAt`, a backup
 * that any of its objects was uploaded to after that instant is not recorded either: a fenced node
 * can no longer write, so such an object is not the node's.
 */
export async function recordBackupDigest(
  bucket: R2Bucket,
  db: D1Database,
  archivePath: string,
  prefix: string,
  backupId: string,
  now: number,
  fencedAt?: string,
): Promise<boolean> {
  const listed = await listBackup(bucket, prefix, backupId);
  if (!listed.some((o) => o.key === `${prefix}base/${backupId}/backup.info`))
    return false;
  if (
    fencedAt !== undefined &&
    listed.some((o) => o.uploaded.getTime() > Date.parse(fencedAt))
  )
    return false;
  const digest = await backupDigest(
    listed.map((o) => ({ key: o.key, size: o.size, etag: o.etag })),
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
  const listed = await listBackup(bucket, prefix, backupId);
  if (
    (await backupDigest(
      listed.map((o) => ({ key: o.key, size: o.size, etag: o.etag })),
    )) !== recorded
  )
    throw digestMismatch();
}

/** The digests recorded for one archive, by backup id, and whether the archive is enforced. */
export interface ArchiveDigests {
  recorded: ReadonlyMap<string, string>;
  /** True once the backfill has marked the archive: a backup that was never recorded is then not trusted. */
  enforced: boolean;
}

export async function recordedDigests(
  db: D1Database,
  archivePath: string,
): Promise<ArchiveDigests> {
  // One statement: a row with no backup id is the backfill's marker.
  const rows = await db
    .prepare(
      `SELECT backup_id,digest FROM archive_backup_digests WHERE archive_path=?1
       UNION ALL SELECT NULL,NULL FROM archive_digest_backfill WHERE archive_path=?1`,
    )
    .bind(archivePath)
    .all<{ backup_id: string | null; digest: string | null }>();
  const recorded = new Map<string, string>();
  let enforced = false;
  for (const row of rows.results) {
    if (row.backup_id === null || row.digest === null) enforced = true;
    else recorded.set(row.backup_id, row.digest);
  }
  return { recorded, enforced };
}

/** Refuses a recovery or a retention pass over a recorded backup that no longer matches what was recorded. */
export const digestMismatch = () =>
  new ApiError("conflict", "A recorded backup of this archive changed", {
    reason: "archive_digest_mismatch",
  });
