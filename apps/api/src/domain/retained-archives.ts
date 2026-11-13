// SPDX-License-Identifier: Apache-2.0
import type { Env } from "../env.ts";
import { validatedArchivePrefix } from "./archive.ts";
import { archiveBucket } from "./archive-bucket.ts";
import { deleteUnpinnedArchiveKeys } from "./archive-retention-claims.ts";
import { fencedAtSql } from "./restore-catalog.ts";
interface ExpiredArchive {
  source_database_id: string;
  region_id: string;
  archive_path: string;
  storage_generation: number;
  deleted_at: string;
  expires_at: string;
  cleanup_claim: string | null;
}
/**
 * Whether the archive of a deleted database can still be restored from: inside its recovery
 * retention, not being cleaned up, and the one the database record names.
 */
export function retainedArchiveRestorable(
  retained: {
    expires_at: string;
    cleanup_claim: string | null;
    archive_path: string;
    storage_generation: number;
  } | null,
  source: { archive_path: string; storage_generation?: number },
  now: string,
): boolean {
  return (
    retained !== null &&
    retained.expires_at > now &&
    retained.cleanup_claim === null &&
    retained.archive_path === source.archive_path &&
    retained.storage_generation === (source.storage_generation ?? 1)
  );
}
// A database is gone once it is deleted, or once its node is fenced: a deleted database on a lost
// node is never reported by that node, so its archive would otherwise never be purged.
const gone = `(d.observed_state='deleted' OR ${fencedAtSql("d.node_id")} IS NOT NULL)`;
const idle = `NOT EXISTS(SELECT 1 FROM database_restores x JOIN operations o ON o.id=x.operation_id WHERE x.source_database_id=a.source_database_id AND x.verified_at IS NULL AND o.status IN('pending','running'))
  AND NOT EXISTS(SELECT 1 FROM archive_pins pin WHERE pin.archive_path=a.archive_path AND pin.released_at IS NULL)`;
/**
 * How long after its expiry an archive of a database deleted on a lost node may still be there before
 * its delete operation says so. The purge removes it in the next runs; the operation is closed once it is gone.
 */
const PURGE_GRACE_MS = 3_600_000;

export async function cleanupRetainedArchives(
  env: Env,
  now = Date.now(),
): Promise<{ purged: number; objects: number }> {
  const timestamp = new Date(now).toISOString();
  // A delete on a lost node is never reported by the node, so its operation waits for this purge. One
  // whose archive is still there past the grace is shown as failed, so an operator sees the purge is stuck.
  await env.DB.prepare(
    `UPDATE operations SET status='failed',error_code='archive_purge_incomplete',
      error_message='The archive of this database, deleted on a lost node, is still not purged an hour after it expired',updated_at=?,completed_at=?
    WHERE kind='database.delete' AND status IN('pending','running')
      AND database_id IN(SELECT a.source_database_id FROM retained_archives a WHERE a.expires_at<?)
      AND EXISTS(SELECT 1 FROM databases d WHERE d.id=operations.database_id AND d.desired_state='deleted' AND ${gone})`,
  )
    .bind(timestamp, timestamp, new Date(now - PURGE_GRACE_MS).toISOString())
    .run();
  // An archive that names another bucket is out of this Worker's reach: its objects cannot be
  // listed or deleted here, so it is never selected, which would otherwise fill the batch of two
  // and fail every run before the archives after it.
  const named = `s3://${archiveBucket(env).bucketName}/`;
  const rows = await env.DB.prepare(
    `SELECT a.* FROM retained_archives a JOIN databases d ON d.id=a.source_database_id
   WHERE a.expires_at<=? AND substr(a.archive_path,1,length(?))=? AND d.desired_state='deleted' AND ${gone} AND d.deleted_at=a.deleted_at AND d.archive_path=a.archive_path AND d.storage_generation=a.storage_generation AND ${idle} ORDER BY a.expires_at,a.source_database_id LIMIT 2`,
  )
    .bind(timestamp, named, named)
    .all<ExpiredArchive>();
  let purged = 0,
    objects = 0;
  for (const row of rows.results) {
    const claim = row.cleanup_claim ?? crypto.randomUUID();
    const claimed = await env.DB.prepare(
      `UPDATE retained_archives AS a SET cleanup_claim=? WHERE source_database_id=? AND expires_at<=? AND cleanup_claim IS ? AND ${idle}
    AND EXISTS(SELECT 1 FROM databases d WHERE d.id=a.source_database_id AND d.desired_state='deleted' AND ${gone} AND d.deleted_at=a.deleted_at AND d.archive_path=a.archive_path AND d.storage_generation=a.storage_generation)`,
    )
      .bind(claim, row.source_database_id, timestamp, row.cleanup_claim)
      .run();
    if (claimed.meta.changes !== 1) continue;
    const selected = archiveBucket(env);
    const prefix = validatedArchivePrefix(
      {
        id: row.source_database_id,
        region_id: row.region_id,
        archive_path: row.archive_path,
        storage_generation: row.storage_generation,
      },
      selected.bucketName,
    );
    const deletion = await deleteUnpinnedArchiveKeys(
      env,
      selected.bucket,
      row.archive_path,
      prefix,
      async () => {
        const listed = await selected.bucket.list({ prefix, limit: 128 });
        if (listed.objects.length > 128 || listed.delimitedPrefixes.length)
          throw new Error("archive_cleanup_listing_invalid");
        if (listed.truncated && listed.objects.length === 0)
          throw new Error("archive_cleanup_listing_incomplete");
        return { keys: listed.objects.map((o) => o.key), value: true };
      },
      now,
    );
    if (!deletion) continue;
    if (deletion.keys.length) {
      objects += deletion.keys.length;
      continue;
    }
    const result = await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM retained_archives AS a WHERE source_database_id=? AND cleanup_claim=? AND archive_path=? AND storage_generation=? AND expires_at<=? AND ${idle}
      AND EXISTS(SELECT 1 FROM databases d WHERE d.id=a.source_database_id AND d.desired_state='deleted' AND ${gone} AND d.deleted_at=a.deleted_at AND d.archive_path=a.archive_path AND d.storage_generation=a.storage_generation)`,
      ).bind(
        row.source_database_id,
        claim,
        row.archive_path,
        row.storage_generation,
        timestamp,
      ),
      env.DB.prepare(
        `DELETE FROM roles WHERE database_id=? AND changes()=1 AND EXISTS(SELECT 1 FROM databases d WHERE d.id=roles.database_id AND d.desired_state='deleted' AND ${gone})`,
      ).bind(row.source_database_id),
      // Once no archive of the database is retained, its delete is complete, whatever the node reported.
      env.DB.prepare(
        `UPDATE operations SET status='succeeded',completed_at=?,updated_at=?,error_code=NULL,error_message=NULL
        WHERE kind='database.delete' AND database_id=? AND (status IN('pending','running') OR (status='failed' AND error_code='archive_purge_incomplete'))
          AND NOT EXISTS(SELECT 1 FROM retained_archives a WHERE a.source_database_id=?)`,
      ).bind(
        timestamp,
        timestamp,
        row.source_database_id,
        row.source_database_id,
      ),
    ]);
    purged += result[0]!.meta.changes;
  }
  return { purged, objects };
}
