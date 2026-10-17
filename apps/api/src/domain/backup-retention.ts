// SPDX-License-Identifier: Apache-2.0
import { parseArchivePath } from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { Env } from "../env.ts";
import { purgeArchiveCredentials } from "./archive-credentials.ts";
import { validatedArchivePrefix } from "./archive.ts";
import { regionArchive } from "./archive-bindings.ts";
import { readRestoreCatalog } from "./restore-catalog.ts";

/**
 * Backup retention in the Worker (ULTRA plan 7.7). A node holds no delete right in R2; the Worker
 * lists a database's archive through its own R2 binding and deletes what lies outside the
 * recovery window of the database's size class.
 *
 * The window needs the newest base backup that ended at or before its start (the anchor) and
 * everything after it: older base backups go, and with them the WAL that only they needed, which
 * is the WAL of older timelines and the WAL of the anchor's timeline before the anchor's first
 * segment. Without an anchor, nothing is old enough to delete. The anchor is the newest of the
 * restorable backups, so the newest DONE backup of a database that slept for weeks is never
 * deleted: it is its own anchor. The descriptor of a backup (`backup.info`) goes before its data,
 * so the catalog never offers a backup whose data is half gone; data left behind by an
 * interrupted run is deleted by the next one, because it lies before the anchor too.
 *
 * A superseded storage generation (a move left it behind) is deleted whole once the window has
 * passed since the move ended.
 */
const BASE = /^base\/([0-9]{8}T[0-9]{6})\//;
const WAL = /^wals\/[0-9A-F]{16}\/([0-9A-F]{24})(?:\.[a-z0-9]+)?$/;
const LIST_PAGES = 50;
const DELETE_BATCH = 1000;
/** A database is looked at again after this long without a new backup. */
const RECHECK_MS = 6 * 3600_000;
const DEFAULT_DELETES_PER_DATABASE = 2000;

async function listKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < LIST_PAGES; page++) {
    const result = await bucket.list({
      prefix,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const object of result.objects) keys.push(object.key);
    if (!result.truncated) return keys;
    cursor = result.cursor;
  }
  throw new Error("retention_listing_incomplete");
}
async function deleteKeys(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += DELETE_BATCH)
    await bucket.delete(keys.slice(i, i + DELETE_BATCH));
}

export interface RetentionResult {
  /** Base backups whose descriptor was deleted. */
  backups: number;
  /** Every object deleted, descriptors included. */
  objects: number;
  /** False when `maxDeletes` stopped the run; the rest is deleted by the next one. */
  complete: boolean;
}

/**
 * Applies the window that starts at `cutoff` (milliseconds) to the archive under `prefix`
 * (`<region>/<database>/g<generation>-<operation>/database/`), deleting at most `maxDeletes`
 * objects. An archive the restore catalog cannot read as a whole is `archive_unusable` and
 * is left alone.
 */
export async function retainBackups(
  bucket: R2Bucket,
  prefix: string,
  cutoff: number,
  maxDeletes = DEFAULT_DELETES_PER_DATABASE,
): Promise<RetentionResult> {
  const catalog = await readRestoreCatalog(bucket, prefix);
  const anchor = catalog.backups.find(
    (backup) => Date.parse(backup.end) <= cutoff,
  );
  if (!anchor) return { backups: 0, objects: 0, complete: true };
  const timeline = anchor.beginWal.slice(0, 8),
    segment = anchor.beginWal.slice(8);
  const descriptors: string[] = [],
    data: string[] = [];
  for (const key of await listKeys(bucket, prefix)) {
    const name = key.slice(prefix.length),
      base = BASE.exec(name);
    if (base) {
      if (base[1]! < anchor.id)
        (name.endsWith("/backup.info") ? descriptors : data).push(key);
      continue;
    }
    const wal = WAL.exec(name)?.[1];
    if (
      wal !== undefined &&
      (wal.slice(0, 8) < timeline ||
        (wal.slice(0, 8) === timeline && wal.slice(8) < segment))
    )
      data.push(key);
  }
  descriptors.sort();
  data.sort();
  const firstDescriptors = descriptors.slice(0, maxDeletes),
    rest = data.slice(0, Math.max(0, maxDeletes - firstDescriptors.length));
  await deleteKeys(bucket, firstDescriptors);
  await deleteKeys(bucket, rest);
  return {
    backups: firstDescriptors.length,
    objects: firstDescriptors.length + rest.length,
    complete:
      firstDescriptors.length === descriptors.length &&
      rest.length === data.length,
  };
}

interface DueRow {
  id: string;
  region_id: string;
  archive_path: string;
  storage_generation: number;
  backup_bucket: string;
  backup_retention_days: number;
}
export interface RetentionRun {
  checked: number;
  backups: number;
  objects: number;
  failed: number;
}

/**
 * Applies the window to up to `limit` databases that are due: never checked first, then those whose
 * newest DONE backup (as the database's node reported it) is newer than their last check, then those
 * last checked more than six hours ago. A database that is deleted is left to the expiry of its retained archive. A run that stopped
 * at the delete limit is not recorded as a check, so the next minute finishes it.
 */
export async function enforceBackupRetention(
  env: Env,
  now: number,
  limit = 2,
): Promise<RetentionRun> {
  const at = new Date(now).toISOString();
  const due = (
    await env.DB.prepare(
      `SELECT d.id,d.region_id,d.archive_path,d.storage_generation,r.backup_bucket,s.backup_retention_days
      FROM databases d JOIN regions r ON r.id=d.region_id JOIN size_classes s ON s.id=d.size_class_id
      LEFT JOIN backup_retention_runs c ON c.database_id=d.id AND c.archive_path=d.archive_path
      LEFT JOIN database_recovery_points p ON p.database_id=d.id AND p.storage_generation=d.storage_generation
      WHERE d.node_id IS NOT NULL AND d.deleted_at IS NULL AND d.desired_state<>'deleted'
      AND (c.checked_at IS NULL OR c.checked_at<? OR d.backup_last_completed_at>c.checked_at
        OR json_extract(p.backup_json,'$.completed_at')>c.checked_at)
      ORDER BY c.checked_at IS NOT NULL,c.checked_at,d.id LIMIT ?`,
    )
      .bind(new Date(now - RECHECK_MS).toISOString(), limit)
      .all<DueRow>()
  ).results;
  const run: RetentionRun = { checked: 0, backups: 0, objects: 0, failed: 0 };
  for (const row of due) {
    run.checked++;
    try {
      const selected = regionArchive(env, {
        id: row.region_id,
        backup_bucket: row.backup_bucket,
      });
      const result = await retainBackups(
        selected.bucket,
        validatedArchivePrefix(row, row, selected.bucketName),
        now - row.backup_retention_days * 86_400_000,
      ).catch((error) => {
        // An archive that cannot be read as a whole is data, not a fault of this run.
        if (
          error instanceof ApiError &&
          error.details?.reason === "archive_unusable"
        )
          return { backups: 0, objects: 0, complete: true };
        throw error;
      });
      run.backups += result.backups;
      run.objects += result.objects;
      if (result.complete)
        await env.DB.prepare(
          `INSERT INTO backup_retention_runs(database_id,archive_path,checked_at,backups_deleted,objects_deleted) VALUES(?,?,?,?,?)
          ON CONFLICT(database_id) DO UPDATE SET archive_path=excluded.archive_path,checked_at=excluded.checked_at,backups_deleted=excluded.backups_deleted,objects_deleted=excluded.objects_deleted`,
        )
          .bind(row.id, row.archive_path, at, result.backups, result.objects)
          .run();
    } catch (error) {
      run.failed++;
      console.error(
        JSON.stringify({
          event: "backup_retention_failed",
          database_id: row.id,
          error_code:
            error instanceof Error &&
            /^[a-z][a-z0-9_]{2,63}$/.test(error.message)
              ? error.message
              : "retention_failed",
        }),
      );
    }
  }
  return run;
}

/**
 * Deletes, a bounded pass at a time, the archive of each storage generation a finished move left
 * behind once the recovery window of the database's size class has passed since the move ended.
 * The archive the database is on now is never deleted, whatever a move row says.
 */
export async function expireSupersededArchives(
  env: Env,
  now: number,
  limit = DELETE_BATCH,
): Promise<{ archives: number; objects: number }> {
  const at = new Date(now).toISOString();
  const rows = (
    await env.DB.prepare(
      `SELECT m.operation,m.region_id,m.source_archive_path,d.archive_path current_path,r.backup_bucket
      FROM database_moves m JOIN databases d ON d.id=m.database_id JOIN size_classes s ON s.id=d.size_class_id JOIN regions r ON r.id=m.region_id
      WHERE m.status='done' AND m.source_archive_deleted_at IS NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ',m.completed_at,'+'||s.backup_retention_days||' days')<=?
      AND m.source_archive_path<>d.archive_path ORDER BY m.completed_at,m.operation LIMIT 2`,
    )
      .bind(at)
      .all<{
        operation: string;
        region_id: string;
        source_archive_path: string;
        current_path: string;
        backup_bucket: string;
      }>()
  ).results;
  const result = { archives: 0, objects: 0 };
  for (const row of rows) {
    const path = parseArchivePath(row.source_archive_path);
    if (!path || path.bucket !== row.backup_bucket) continue;
    const selected = regionArchive(env, {
      id: row.region_id,
      backup_bucket: row.backup_bucket,
    });
    const prefix = `${path.region}/${path.database}/g${path.generation}-${path.operation}/`;
    const listed = await selected.bucket.list({
      prefix,
      limit: Math.min(limit, DELETE_BATCH),
    });
    if (listed.objects.some((object) => !object.key.startsWith(prefix)))
      throw new Error("archive_cleanup_listing_invalid");
    if (listed.objects.length > 0) {
      await selected.bucket.delete(listed.objects.map((object) => object.key));
      result.objects += listed.objects.length;
      continue;
    }
    await env.DB.prepare(
      "UPDATE database_moves SET source_archive_deleted_at=? WHERE operation=? AND source_archive_deleted_at IS NULL",
    )
      .bind(at, row.operation)
      .run();
    result.archives++;
  }
  return result;
}

/**
 * The minute cron's retention step: the recovery windows, the archives that moves left behind
 * and the credentials that expired. A fault in one part does not stop the others, and the step
 * fails after them so that the heartbeat counts it.
 */
export async function runBackupRetention(env: Env, now: number): Promise<void> {
  let failed = 0;
  for (const part of [
    async () => (await enforceBackupRetention(env, now)).failed,
    async () => (await expireSupersededArchives(env, now), 0),
    async () => (await purgeArchiveCredentials(env.DB, now), 0),
  ]) {
    try {
      failed += await part();
    } catch (error) {
      failed++;
      console.error(
        JSON.stringify({
          event: "backup_retention_part_failed",
          error_code:
            error instanceof Error &&
            /^[a-z][a-z0-9_]{2,63}$/.test(error.message)
              ? error.message
              : "retention_failed",
        }),
      );
    }
  }
  if (failed > 0) throw new Error("backup_retention_failed");
}
