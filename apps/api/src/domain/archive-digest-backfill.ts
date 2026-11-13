// SPDX-License-Identifier: Apache-2.0
import type { Env } from "../env.ts";
import { validatedArchivePrefix } from "./archive.ts";
import { archiveBucket } from "./archive-bucket.ts";
import { recordBackupDigest } from "./archive-digests.ts";
import { fencedAtSql, parseBackupInfo } from "./restore-catalog.ts";

/** Archives one minute's pass works on, and descriptors it reads for each of them. */
const ARCHIVES_PER_RUN = 5;
const DESCRIPTORS_PER_ARCHIVE = 64;
const LISTING_PAGES = 16;
const DESCRIPTOR_LIMIT = 65536;

interface Candidate {
  id: string;
  region_id: string;
  archive_path: string;
  storage_generation: number;
  /** The fence of a retained archive's node: objects uploaded after it are not the node's. */
  fenced_at: string | null;
}

/**
 * Records the digests of the backups an archive kept from before digests were recorded, so that they
 * stay restorable once the archive is enforced. Candidates are the archives of databases on nodes that
 * are neither lost nor fenced, and the retained archives, whether or not some of their backups are
 * already recorded. An archive is
 * marked done once every backup in it has been looked at, and a marked archive is never looked at again:
 * later backups of a live archive are recorded by the nodes' reports. Each run is bounded.
 */
export async function backfillBackupDigests(
  env: Env,
  now: number,
): Promise<{ archives: number; backups: number }> {
  const selected = archiveBucket(env);
  const named = `s3://${selected.bucketName}/`;
  const candidates = (
    await env.DB.prepare(
      `SELECT c.* FROM (
        SELECT d.id,d.region_id,d.archive_path,d.storage_generation,NULL AS fenced_at
        FROM databases d
        WHERE d.node_id IS NOT NULL AND d.deleted_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM node_losses l WHERE l.node_id=d.node_id)
        UNION ALL
        SELECT a.source_database_id,a.region_id,a.archive_path,a.storage_generation,${fencedAtSql("d.node_id")}
        FROM retained_archives a JOIN databases d ON d.id=a.source_database_id
      ) c
      WHERE substr(c.archive_path,1,length(?))=?
        AND NOT EXISTS(SELECT 1 FROM archive_digest_backfill b WHERE b.archive_path=c.archive_path)
      ORDER BY c.archive_path LIMIT ?`,
    )
      .bind(named, named, ARCHIVES_PER_RUN)
      .all<Candidate>()
  ).results;
  let archives = 0,
    backups = 0;
  for (const row of candidates) {
    try {
      const prefix = validatedArchivePrefix(row, selected.bucketName);
      const pass = await backfillArchive(
        env,
        selected.bucket,
        prefix,
        row,
        now,
      );
      backups += pass.recorded;
      if (!pass.complete) continue;
      archives++;
      await env.DB.prepare(
        "INSERT OR IGNORE INTO archive_digest_backfill(archive_path,done_at) VALUES(?,?)",
      )
        .bind(row.archive_path, new Date(now).toISOString())
        .run();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "backup_digest_backfill_failed",
          database_id: row.id,
          error_code:
            error instanceof Error &&
            /^[a-z][a-z0-9_]{2,63}$/.test(error.message)
              ? error.message
              : "backfill_failed",
        }),
      );
    }
  }
  return { archives, backups };
}

/** One pass over an archive's backups: complete when every backup has been looked at. */
async function backfillArchive(
  env: Env,
  bucket: R2Bucket,
  prefix: string,
  row: Candidate,
  now: number,
): Promise<{ complete: boolean; recorded: number }> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page === LISTING_PAGES) throw new Error("backup_listing_exceeds_bound");
    const listed = await bucket.list({
      prefix: `${prefix}base/`,
      delimiter: "/",
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const child of listed.delimitedPrefixes) {
      const id = /^base\/([0-9]{8}T[0-9]{6})\/$/.exec(
        child.slice(prefix.length),
      )?.[1];
      if (id !== undefined) ids.push(id);
    }
    if (!listed.truncated) break;
    if (!listed.cursor) throw new Error("backup_listing_incomplete");
    cursor = listed.cursor;
  }
  // Nothing to look at: no backup of the archive, so no digest to read back.
  if (ids.length === 0) return { complete: true, recorded: 0 };
  const have = new Set(
    (
      await env.DB.prepare(
        "SELECT backup_id FROM archive_backup_digests WHERE archive_path=?",
      )
        .bind(row.archive_path)
        .all<{ backup_id: string }>()
    ).results.map((recorded) => recorded.backup_id),
  );
  let reads = 0,
    recorded = 0;
  for (const id of ids) {
    if (have.has(id)) continue;
    if (reads === DESCRIPTORS_PER_ARCHIVE) return { complete: false, recorded };
    reads++;
    const info = await bucket.get(`${prefix}base/${id}/backup.info`);
    if (!info || info.size > DESCRIPTOR_LIMIT) continue;
    // Only a descriptor that reads as DONE is a backup; anything else is left unrecorded.
    if (parseBackupInfo(await info.text(), id) === null) continue;
    if (
      await recordBackupDigest(
        bucket,
        env.DB,
        row.archive_path,
        prefix,
        id,
        now,
        row.fenced_at ?? undefined,
      )
    )
      recorded++;
  }
  return { complete: true, recorded };
}
