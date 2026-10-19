// SPDX-License-Identifier: Apache-2.0
import { ARCHIVE_DESTINATION_PATTERN, BackupCatalog } from "@pgcf/contracts";
import { ApiError } from "../api-error.ts";
import type { ApiContext } from "../env.ts";
import { databaseForRequest } from "./rows.ts";
import type { DatabaseRow } from "./rows.ts";
import { regionArchive } from "./archive-bindings.ts";
import { readRestoreCatalog } from "./restore-catalog.ts";
import { retainedArchiveRestorable } from "./retained-archives.ts";

export function validatedArchivePrefix(
  row: Pick<
    DatabaseRow,
    "id" | "region_id" | "archive_path" | "storage_generation"
  >,
  region: { backup_bucket: string } | null,
  boundBucket: string,
): string {
  const path = ARCHIVE_DESTINATION_PATTERN.exec(row.archive_path);
  if (
    !region ||
    !path ||
    path[1] !== region.backup_bucket ||
    path[2] !== row.region_id ||
    path[3] !== row.id ||
    Number(path[4]) !== (row.storage_generation ?? 1) ||
    boundBucket !== region.backup_bucket
  )
    throw new ApiError(
      "internal",
      "The region archive bucket is not bound to this installation",
    );
  return `${row.region_id}/${row.id}/${row.archive_path.slice(row.archive_path.lastIndexOf("/") + 1)}/database/`;
}

export async function archiveSummary(
  c: ApiContext,
  id: string,
): Promise<Response> {
  const row = await databaseForRequest(c, id, true);
  const region = await c.env.DB.prepare(
    "SELECT backup_bucket FROM regions WHERE id=?",
  )
    .bind(row.region_id)
    .first<{ backup_bucket: string }>();
  const selected = regionArchive(c.env, {
    id: row.region_id,
    backup_bucket: region?.backup_bucket ?? "",
  });
  const prefix = validatedArchivePrefix(row, region, selected.bucketName);
  let baseBackups = 0,
    walCount = 0,
    bytes = 0;
  let cursor: string | undefined;
  do {
    const listing = await selected.bucket.list({
      prefix,
      delimiter: "/",
      ...(cursor ? { cursor } : {}),
    });
    for (const object of listing.objects) bytes += object.size;
    for (const child of listing.delimitedPrefixes) {
      let childCursor: string | undefined;
      do {
        const contents = await selected.bucket.list({
          prefix: child,
          ...(childCursor ? { cursor: childCursor } : {}),
        });
        for (const object of contents.objects) {
          bytes += object.size;
          if (
            object.key.includes("/base/") &&
            object.key.endsWith("/backup.info")
          )
            baseBackups++;
          if (
            object.key.includes("/wals/") &&
            /^[0-9A-F]{24}(?:\.(?:gz|bz2|lz4|zst))?$/.test(
              object.key.slice(object.key.lastIndexOf("/") + 1),
            )
          )
            walCount++;
        }
        childCursor = contents.truncated ? contents.cursor : undefined;
      } while (childCursor !== undefined);
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor !== undefined);
  return c.json({
    database_id: row.id,
    base_backup_count: baseBackups,
    wal_count: walCount,
    bytes,
  });
}

/**
 * The window a restore can reach and the base backups it can start from, read from the very catalog
 * the restore path reads. An archive that is unknown, empty, unreadable as a whole or past its
 * retention has no window: both times are null, never a guess.
 */
export async function backupCatalog(
  c: ApiContext,
  id: string,
): Promise<Response> {
  const row = await databaseForRequest(c, id, true);
  const unknown = BackupCatalog.parse({
    database_id: row.id,
    earliest_restorable_time: null,
    latest_restorable_time: null,
    base_backups: [],
  });
  if (row.deleted_at !== null) {
    const retained = await c.env.DB.prepare(
      "SELECT expires_at,cleanup_claim,archive_path,storage_generation FROM retained_archives WHERE source_database_id=? AND project_id=? AND region_id=?",
    )
      .bind(row.id, row.project_id, row.region_id)
      .first<{
        expires_at: string;
        cleanup_claim: string | null;
        archive_path: string;
        storage_generation: number;
      }>();
    if (!retainedArchiveRestorable(retained, row, new Date().toISOString()))
      return c.json(unknown);
  }
  const region = await c.env.DB.prepare(
    "SELECT backup_bucket FROM regions WHERE id=?",
  )
    .bind(row.region_id)
    .first<{ backup_bucket: string }>();
  const selected = regionArchive(c.env, {
    id: row.region_id,
    backup_bucket: region?.backup_bucket ?? "",
  });
  const prefix = validatedArchivePrefix(row, region, selected.bucketName);
  let catalog;
  try {
    catalog = await readRestoreCatalog(selected.bucket, prefix);
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.details?.reason === "archive_unusable"
    )
      return c.json(unknown);
    throw error;
  }
  const oldest = catalog.backups.at(-1);
  if (oldest === undefined) return c.json(unknown);
  return c.json(
    BackupCatalog.parse({
      database_id: row.id,
      earliest_restorable_time: oldest.end,
      // The last archived segment bounds the end; it can not lie before the first backup.
      latest_restorable_time:
        catalog.newestWalAt !== null && catalog.newestWalAt > oldest.end
          ? catalog.newestWalAt
          : oldest.end,
      base_backups: catalog.backups.map((backup) => ({
        id: backup.id,
        started_at: backup.begin,
        completed_at: backup.end,
      })),
    }),
  );
}
