// SPDX-License-Identifier: Apache-2.0
import { parseArchivePath } from "@pgcf/contracts";
import { ApiError } from "../api-error.ts";
import type { Env } from "../env.ts";
import { expireReplacementArchives } from "./database-replacements.ts";
import { purgeArchiveCredentials } from "./archive-credentials.ts";
import { validatedArchivePrefix } from "./archive.ts";
import { archiveBucket } from "./archive-bucket.ts";
import { deleteUnpinnedArchiveKeys } from "./archive-retention-claims.ts";
import { retireColdSnapshots } from "./cold-snapshot-retention.ts";
import { BACKUP_DATA, keysOf, walRangeArchived } from "./archive-chain.ts";
import {
  parseBackupInfo,
  readRestoreCatalog,
  type RestoreBackup,
} from "./restore-catalog.ts";

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
 * The anchor comes from the restore catalog. An archive beyond the catalog's bounds (more than 64
 * base backups, or more than 16,000 objects) is not left to grow: its anchor is then found without
 * reading it whole, from the newest few backups that ended before the window, and is accepted when
 * its data and its own range of WAL are archived. The catalog's further rule, that WAL of a later
 * timeline needs a backup of its own, is not applied there: the window needs nothing older than
 * the anchor either way. Old WAL is listed from the start and only as far as one run deletes.
 *
 * A superseded storage generation (a move left it behind) is deleted whole once the window has
 * passed since the move ended.
 */
const BASE = /^base\/([0-9]{8}T[0-9]{6})\//;
// A segment, the label of a base backup that began in it, or its `.partial` copy, each with the
// compression suffix the archive client adds.
const WAL =
  /^wals\/[0-9A-F]{16}\/([0-9A-F]{24})(?:\.[0-9A-F]{8}\.backup|\.partial)?(?:\.[a-z0-9]+)?$/;
const DELETE_BATCH = 1000;
/** A database is looked at again after this long without a new backup. */
const RECHECK_MS = 6 * 3600_000;
const DEFAULT_DELETES_PER_DATABASE = 2000;

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

/** The base backups to look at, newest first, when the archive is too large for the catalog. */
const ANCHOR_READS = 8;
/** The begin time a backup id names, on the node's clock. */
const idMs = (id: string) =>
  Date.UTC(
    +id.slice(0, 4),
    +id.slice(4, 6) - 1,
    +id.slice(6, 8),
    +id.slice(9, 11),
    +id.slice(11, 13),
    +id.slice(13, 15),
  );

/**
 * The newest base backup that ended at or before `cutoff` of an archive the catalog cannot read:
 * DONE, with its data and its own range of WAL archived. Only the newest few are looked at; if
 * none of them is usable, the archive is left alone.
 */
async function boundedAnchor(
  bucket: R2Bucket,
  prefix: string,
  cutoff: number,
): Promise<RestoreBackup | null> {
  const described: string[] = [],
    withData = new Set<string>();
  for await (const key of keysOf(bucket, `${prefix}base/`)) {
    const base = BASE.exec(key.slice(prefix.length));
    if (!base) continue;
    if (key.endsWith("/backup.info")) described.push(base[1]!);
    else if (BACKUP_DATA.test(key)) withData.add(base[1]!);
  }
  let reads = 0;
  for (const id of described.sort().reverse()) {
    // A backup that began a day after the cutoff did not end before it, whatever the node's clock.
    if (idMs(id) > cutoff + 86_400_000) continue;
    if (reads++ === ANCHOR_READS) break;
    const info = await bucket.get(`${prefix}base/${id}/backup.info`);
    const backup =
      info && info.size <= 65536
        ? parseBackupInfo(await info.text(), id)
        : null;
    if (
      backup &&
      Date.parse(backup.end) <= cutoff &&
      withData.has(id) &&
      (await walRangeArchived(bucket, prefix, {
        first: backup.beginWal,
        last: backup.endWal,
        segmentBytes: backup.segmentBytes,
      }))
    )
      return backup;
  }
  return null;
}

async function findAnchor(
  bucket: R2Bucket,
  prefix: string,
  cutoff: number,
): Promise<RestoreBackup | null> {
  try {
    return (
      (await readRestoreCatalog(bucket, prefix)).backups.find(
        (backup) => Date.parse(backup.end) <= cutoff,
      ) ?? null
    );
  } catch (error) {
    if (!(
      error instanceof ApiError && error.details?.reason === "archive_unusable"
    ))
      throw error;
    return boundedAnchor(bucket, prefix, cutoff);
  }
}

/**
 * Applies the window that starts at `cutoff` (milliseconds) to the archive under `prefix`
 * (`<region>/<database>/g<generation>-<operation>/database/`), deleting at most `maxDeletes`
 * objects.
 */
export async function retainBackups(
  bucket: R2Bucket,
  prefix: string,
  cutoff: number,
  maxDeletes = DEFAULT_DELETES_PER_DATABASE,
): Promise<RetentionResult> {
  const plan = await retentionPlan(bucket, prefix, cutoff, maxDeletes);
  await deleteKeys(bucket, plan.descriptors);
  await deleteKeys(bucket, plan.data);
  return plan.result;
}

async function retentionPlan(
  bucket: R2Bucket,
  prefix: string,
  cutoff: number,
  maxDeletes = DEFAULT_DELETES_PER_DATABASE,
): Promise<{ descriptors: string[]; data: string[]; result: RetentionResult }> {
  const anchor = await findAnchor(bucket, prefix, cutoff);
  if (!anchor)
    return {
      descriptors: [],
      data: [],
      result: { backups: 0, objects: 0, complete: true },
    };
  const descriptors: string[] = [],
    data: string[] = [];
  for await (const key of keysOf(bucket, `${prefix}base/`)) {
    const base = BASE.exec(key.slice(prefix.length));
    if (base && base[1]! < anchor.id)
      (key.endsWith("/backup.info") ? descriptors : data).push(key);
  }
  descriptors.sort();
  data.sort();
  const firstDescriptors = descriptors.slice(0, maxDeletes),
    baseData = data.slice(0, Math.max(0, maxDeletes - firstDescriptors.length));
  let more =
    firstDescriptors.length < descriptors.length ||
    baseData.length < data.length;
  // The segments before the anchor's first one, which come first in the listing.
  const room = maxDeletes - firstDescriptors.length - baseData.length,
    old: string[] = [];
  if (!more)
    for await (const key of keysOf(bucket, `${prefix}wals/`)) {
      const name = WAL.exec(key.slice(prefix.length))?.[1];
      if (name === undefined) continue;
      if (name >= anchor.beginWal) break;
      if (old.length === room) {
        more = true;
        break;
      }
      old.push(key);
    }
  return {
    descriptors: firstDescriptors,
    data: [...baseData, ...old],
    result: {
      backups: firstDescriptors.length,
      objects: firstDescriptors.length + baseData.length + old.length,
      complete: !more,
    },
  };
}

interface DueRow {
  id: string;
  region_id: string;
  archive_path: string;
  storage_generation: number;
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
 * last checked more than six hours ago. A database that is deleted is left to the expiry of its retained archive,
 * and one that a restore is still reading is left alone: a newer backup could become the anchor and
 * delete the one the restore downloads. A run that stopped at the delete limit is not recorded as a
 * check, so the next minute finishes it.
 */
export async function enforceBackupRetention(
  env: Env,
  now: number,
  limit = 2,
): Promise<RetentionRun> {
  const at = new Date(now).toISOString();
  const due = (
    await env.DB.prepare(
      `SELECT d.id,d.region_id,d.archive_path,d.storage_generation,s.backup_retention_days
      FROM databases d JOIN size_classes s ON s.id=d.size_class_id
      LEFT JOIN backup_retention_runs c ON c.database_id=d.id AND c.archive_path=d.archive_path
      LEFT JOIN database_recovery_points p ON p.database_id=d.id AND p.storage_generation=d.storage_generation
      WHERE d.node_id IS NOT NULL AND d.deleted_at IS NULL AND d.desired_state<>'deleted'
      AND NOT EXISTS(SELECT 1 FROM archive_pins pin WHERE pin.archive_path=d.archive_path AND pin.released_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM database_replacements rp WHERE rp.database_id=d.id AND rp.phase IN('proving','restoring','rolling_back'))
      AND NOT EXISTS(SELECT 1 FROM database_restores x JOIN operations o ON o.id=x.operation_id
        WHERE x.source_database_id=d.id AND x.verified_at IS NULL AND o.status IN('pending','running'))
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
      const selected = archiveBucket(env),
        prefix = validatedArchivePrefix(row, selected.bucketName);
      const deletion = await deleteUnpinnedArchiveKeys(
        env,
        selected.bucket,
        row.archive_path,
        prefix,
        async () => {
          const plan = await retentionPlan(
            selected.bucket,
            prefix,
            now - row.backup_retention_days * 86_400_000,
          );
          return {
            keys: [...plan.descriptors, ...plan.data],
            value: plan.result,
          };
        },
        now,
      );
      if (!deletion) continue;
      const result = deletion.value ?? {
        backups: deletion.keys.filter((key) => key.endsWith("/backup.info"))
          .length,
        objects: deletion.keys.length,
        complete: false,
      };
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
 * Deletes, a bounded pass at a time, the archive of each storage generation a move left behind:
 * the source's once the move is done, and the one a failed move's target staged. Each goes once the
 * recovery window of the database's size class has passed since the move ended. The archive the
 * database is on now is never deleted, whatever a move row says.
 */
export async function expireSupersededArchives(
  env: Env,
  now: number,
  limit = DELETE_BATCH,
): Promise<{ archives: number; objects: number }> {
  const at = new Date(now).toISOString();
  // An archive that names another bucket is out of this Worker's reach and is never selected: two
  // of them would otherwise fill the batch of two and starve the archives after them.
  const named = `s3://${archiveBucket(env).bucketName}/`;
  const due = (status: string, path: string, deleted: string, side: string) =>
    `SELECT m.operation,m.region_id,m.${path} archive_path,d.archive_path current_path,m.completed_at,'${side}' side
    FROM database_moves m JOIN databases d ON d.id=m.database_id JOIN size_classes s ON s.id=d.size_class_id
    WHERE m.status='${status}' AND m.${deleted} IS NULL AND m.${path} IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ',m.completed_at,'+'||s.backup_retention_days||' days')<=?
    AND substr(m.${path},1,length(?))=? AND m.${path}<>d.archive_path
    AND NOT EXISTS(SELECT 1 FROM archive_pins pin WHERE pin.archive_path=m.${path} AND pin.released_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM database_restores reader JOIN operations op ON op.id=reader.operation_id
      WHERE reader.source_archive_path=m.${path} AND reader.verified_at IS NULL AND op.status IN('pending','running'))`;
  const rows = (
    await env.DB.prepare(
      `${due("done", "source_archive_path", "source_archive_deleted_at", "source")}
      UNION ALL ${due("failed", "target_archive_path", "target_archive_deleted_at", "target")}
      UNION ALL SELECT p.operation,p.region_id,p.source_archive_path archive_path,d.archive_path current_path,p.completed_at,'replacement' side
      FROM database_replacements p JOIN databases d ON d.id=p.database_id
      WHERE p.phase IN('succeeded','failed') AND p.retained_until<=?
        AND ((p.source_archive_deleted_at IS NULL AND p.source_archive_path<>d.archive_path)
          OR (p.phase='failed' AND p.target_archive_deleted_at IS NULL AND p.target_archive_path<>d.archive_path)
          OR (p.rollback_archive_deleted_at IS NULL AND p.rollback_archive_path<>d.archive_path))
      ORDER BY completed_at,operation LIMIT 2`,
    )
      .bind(at, named, named, at, named, named, at)
      .all<{
        operation: string;
        region_id: string;
        archive_path: string;
        current_path: string;
        side: "source" | "target" | "replacement";
      }>()
  ).results;
  const result = { archives: 0, objects: 0 };
  let replacementsChecked = false;
  for (const row of rows) {
    if (row.side === "replacement") {
      if (!replacementsChecked) {
        const expired = await expireReplacementArchives(env, now, limit);
        result.archives += expired.archives;
        result.objects += expired.objects;
        replacementsChecked = true;
      }
      continue;
    }
    const selected = archiveBucket(env);
    const path = parseArchivePath(row.archive_path);
    if (!path || path.bucket !== selected.bucketName) continue;
    const prefix = `${path.region}/${path.database}/g${path.generation}-${path.operation}/`;
    const deletion = await deleteUnpinnedArchiveKeys(
      env,
      selected.bucket,
      row.archive_path,
      prefix,
      async () => {
        const listed = await selected.bucket.list({
          prefix,
          limit: Math.min(limit, DELETE_BATCH),
        });
        if (listed.truncated && listed.objects.length === 0)
          throw new Error("archive_cleanup_listing_incomplete");
        return {
          keys: listed.objects.map((object) => object.key),
          value: true,
        };
      },
      now,
    );
    if (!deletion) continue;
    if (deletion.keys.length > 0) {
      result.objects += deletion.keys.length;
      continue;
    }
    const deleted = `${row.side}_archive_deleted_at`;
    await env.DB.prepare(
      `UPDATE database_moves SET ${deleted}=? WHERE operation=? AND ${deleted} IS NULL`,
    )
      .bind(at, row.operation)
      .run();
    result.archives++;
  }
  return result;
}

/** Cold recovery retains normal Barman history independently of the complete snapshot:
 * successful sources, failed targets and a deleted original source each expire only after
 * their retention window. The current archive, pinned paths and live readers remain protected. */
export async function expireColdStorageArchives(
  env: Env,
  now: number,
  limit = DELETE_BATCH,
): Promise<{ archives: number; objects: number }> {
  const at = new Date(now).toISOString(),
    selected = archiveBucket(env);
  const rows = (
    await env.DB.prepare(
      `WITH candidates AS (
      SELECT c.source_archive_path archive_path,strftime('%Y-%m-%dT%H:%M:%fZ',c.completed_at,'+'||s.backup_retention_days||' days') due_at
        FROM database_cold_storage c JOIN databases d ON d.id=c.database_id JOIN size_classes s ON s.id=d.size_class_id
        WHERE c.kind='rehydrate' AND c.phase='succeeded' AND c.source_archive_deleted_at IS NULL
      UNION ALL
      SELECT c.target_archive_path archive_path,strftime('%Y-%m-%dT%H:%M:%fZ',c.completed_at,'+'||s.backup_retention_days||' days') due_at
        FROM database_cold_storage c JOIN databases d ON d.id=c.database_id JOIN size_classes s ON s.id=d.size_class_id
        WHERE c.kind='rehydrate' AND c.phase='failed' AND c.target_archive_deleted_at IS NULL AND c.target_archive_path IS NOT NULL
          AND EXISTS(SELECT 1 FROM lifecycle_orders retired WHERE retired.node_id=c.target_node_id AND retired.database_id=c.database_id
            AND retired.storage_generation=c.target_storage_generation AND retired.type='superseded' AND retired.remove_volume=1
            AND (retired.result_status='done' OR EXISTS(SELECT 1 FROM node_losses loss WHERE loss.node_id=c.target_node_id
              AND loss.tunnel_deleted_at IS NOT NULL AND loss.powered_off_at IS NOT NULL)))
      UNION ALL
      SELECT c.source_archive_path archive_path,c.snapshot_retained_until due_at FROM database_cold_storage c
        WHERE c.kind='archive' AND c.phase='archived' AND c.source_archive_deleted_at IS NULL AND c.snapshot_retained_until IS NOT NULL
    ) SELECT archive_path,MIN(due_at) due_at FROM candidates
      WHERE due_at<=? AND NOT EXISTS(SELECT 1 FROM databases d WHERE d.archive_path=candidates.archive_path)
        AND NOT EXISTS(SELECT 1 FROM archive_pins pin WHERE pin.archive_path=candidates.archive_path AND pin.released_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM database_restores reader JOIN operations op ON op.id=reader.operation_id
          WHERE reader.source_archive_path=candidates.archive_path AND reader.verified_at IS NULL AND op.status IN('pending','running'))
      GROUP BY archive_path ORDER BY due_at,archive_path LIMIT 2`,
    )
      .bind(at)
      .all<{ archive_path: string }>()
  ).results;
  const result = { archives: 0, objects: 0 };
  for (const row of rows) {
    const path = parseArchivePath(row.archive_path);
    if (!path || path.bucket !== selected.bucketName) continue;
    const prefix = `${path.region}/${path.database}/g${path.generation}-${path.operation}/`;
    const deletion = await deleteUnpinnedArchiveKeys(
      env,
      selected.bucket,
      row.archive_path,
      prefix,
      async () => {
        const page = await selected.bucket.list({
          prefix,
          limit: Math.min(limit, DELETE_BATCH),
        });
        if (page.truncated && page.objects.length === 0)
          throw new Error("archive_cleanup_listing_incomplete");
        return { keys: page.objects.map((object) => object.key), value: true };
      },
      now,
    );
    if (!deletion) continue;
    result.objects += deletion.keys.length;
    if (deletion.keys.length !== 0) continue;
    // Several attempts may reference the same generation. Record one physical expiry across
    // every completed reference so a failed activation cannot strand its original source.
    const unused = `NOT EXISTS(SELECT 1 FROM databases WHERE archive_path=?)
      AND NOT EXISTS(SELECT 1 FROM archive_pins WHERE archive_path=? AND released_at IS NULL)`;
    const marked = await env.DB.batch([
      env.DB.prepare(
        `UPDATE database_cold_storage SET source_archive_deleted_at=? WHERE source_archive_path=?
        AND source_archive_deleted_at IS NULL AND phase IN('archived','succeeded','failed','cancelled') AND ${unused}`,
      ).bind(at, row.archive_path, row.archive_path, row.archive_path),
      env.DB.prepare(
        `UPDATE database_cold_storage SET target_archive_deleted_at=? WHERE target_archive_path=?
        AND target_archive_deleted_at IS NULL AND phase='failed' AND ${unused}`,
      ).bind(at, row.archive_path, row.archive_path, row.archive_path),
    ]);
    if (marked.some((entry) => entry.meta.changes > 0)) result.archives++;
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
    async () => (await expireColdStorageArchives(env, now), 0),
    async () => (await retireColdSnapshots(env, now), 0),
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
