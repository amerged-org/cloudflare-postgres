// SPDX-License-Identifier: Apache-2.0
import { DatabaseId, bytesToHex } from "@pgcf/contracts";
import type { UsageSample } from "@pgcf/contracts/usage";
import { validatedArchivePrefix } from "./archive.ts";
import { regionArchive, type ArchiveEnvironment } from "./archive-bindings.ts";
import { recordUsageSample, type BackupUsageIdentity } from "./usage.ts";
import type { Env } from "../env.ts";

export const BACKUP_LIST_OBJECT_LIMIT = 1000;
export const BACKUP_LIST_PAGE_LIMIT = 16;
export const BACKUP_LIST_TOTAL_OBJECT_LIMIT = 16_000;
export const BACKUP_LIST_KEY_BYTES_LIMIT = 4 * 1024 * 1024;
export const BACKUP_LIST_CURSOR_BYTES_LIMIT = 2048;
export const BACKUP_LIST_DEADLINE_MS = 2000;
interface ArchiveRow {
  id: string;
  region_id: string;
  archive_path: string;
  storage_generation: number;
  deleted_at: string | null;
  backup_bucket: string;
}
export interface BackupMeasurementResult {
  status: "measured" | "unavailable";
  objects: number | null;
  sample?: Extract<UsageSample, { source: "backup" }>;
  recorded?: "recorded" | "duplicate";
}
type BackupEnvironment = Pick<Env,"DB"> & ArchiveEnvironment;
const rowFor = (db: D1Database, id: string) =>
  db
    .prepare(
      "SELECT d.id,d.region_id,d.archive_path,d.storage_generation,d.deleted_at,r.backup_bucket FROM databases d JOIN regions r ON r.id=d.region_id WHERE d.id=?",
    )
    .bind(id)
    .first<ArchiveRow>();
const sameIdentity = (a: ArchiveRow, b: ArchiveRow | null): boolean =>
  b !== null &&
  a.id === b.id &&
  a.region_id === b.region_id &&
  a.archive_path === b.archive_path &&
  a.storage_generation === b.storage_generation &&
  a.deleted_at === b.deleted_at &&
  a.backup_bucket === b.backup_bucket;

export async function measureBackupUsage(
  env: BackupEnvironment,
  databaseId: string,
): Promise<BackupMeasurementResult> {
  DatabaseId.parse(databaseId);
  const row = await rowFor(env.DB, databaseId);
  if (!row) return { status: "unavailable", objects: null };
  let bytes: number | null = null,
    objects: number | null = null;
  try {
    const selected = regionArchive(env,{id:row.region_id,backup_bucket:row.backup_bucket});
    const prefix = validatedArchivePrefix(row,row,selected.bucketName);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const deadline = Date.now() + BACKUP_LIST_DEADLINE_MS;
    const encoder = new TextEncoder();
    const checkDeadline = () => {
      if (expired || Date.now() >= deadline)
        throw new Error("backup_listing_timeout");
    };
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new Error("backup_listing_timeout"));
      }, BACKUP_LIST_DEADLINE_MS);
    });
    const walk = async () => {
      const seen = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let total = 0,
        keyBytes = 0;
      for (let page = 0; page < BACKUP_LIST_PAGE_LIMIT; page++) {
        checkDeadline();
        const listing = await selected.bucket.list({
          prefix,
          limit: BACKUP_LIST_OBJECT_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        });
        checkDeadline();
        if (
          typeof listing.truncated !== "boolean" ||
          !Array.isArray(listing.objects) ||
          listing.objects.length > BACKUP_LIST_OBJECT_LIMIT ||
          (cursor !== undefined && listing.objects.length === 0) ||
          !Array.isArray(listing.delimitedPrefixes) ||
          listing.delimitedPrefixes.length !== 0 ||
          seen.size + listing.objects.length > BACKUP_LIST_TOTAL_OBJECT_LIMIT
        )
          throw new Error("backup_listing_incomplete");
        for (const object of listing.objects) {
          if (
            typeof object.key !== "string" ||
            !object.key.startsWith(prefix) ||
            object.key.length === 0 ||
            object.key.length > 1024 ||
            seen.has(object.key) ||
            !Number.isSafeInteger(object.size) ||
            object.size < 0 ||
            !Number.isSafeInteger(total + object.size)
          )
            throw new Error("backup_listing_invalid");
          const length = encoder.encode(object.key).length;
          keyBytes += length;
          if (length > 1024 || keyBytes > BACKUP_LIST_KEY_BYTES_LIMIT)
            throw new Error("backup_listing_invalid");
          seen.add(object.key);
          total += object.size;
        }
        checkDeadline();
        // A complete walk sums objects seen during this interval, not an atomic R2 snapshot.
        if (!listing.truncated) return { bytes: total, objects: seen.size };
        if (
          typeof listing.cursor !== "string" ||
          listing.cursor.length === 0 ||
          listing.cursor.length > BACKUP_LIST_CURSOR_BYTES_LIMIT ||
          encoder.encode(listing.cursor).length >
            BACKUP_LIST_CURSOR_BYTES_LIMIT ||
          cursors.has(listing.cursor)
        )
          throw new Error("backup_listing_incomplete");
        cursors.add(listing.cursor);
        cursor = listing.cursor;
      }
      throw new Error("backup_listing_incomplete");
    };
    const measured = await Promise.race([walk(), timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    bytes = measured.bytes;
    objects = measured.objects;
  } catch {
    /* Failed, truncated and unbound measurements remain explicitly unknown. */
  }
  if (!sameIdentity(row, await rowFor(env.DB, databaseId)))
    return { status: "unavailable", objects: null };
  const observed = Date.now(),
    identity: BackupUsageIdentity = {
      archive_path: row.archive_path,
      region_id: row.region_id,
      backup_bucket: row.backup_bucket,
      deleted_at: row.deleted_at,
    };
  const digest = bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([row.id, identity, bytes])),
      ),
    ),
  );
  const sample: Extract<UsageSample, { source: "backup" }> = {
    source: "backup",
    database_id: row.id,
    producer_id: `r2_${digest}`,
    sequence: observed,
    observed_at: new Date(observed).toISOString(),
    backup_bytes: bytes,
  };
  try {
    const recorded = await recordUsageSample(
      env.DB,
      { region_id: row.region_id, source: "backup" },
      sample,
      observed,
      identity,
    );
    return {
      status: bytes === null ? "unavailable" : "measured",
      objects,
      sample,
      recorded,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      /usage_cron_statement_budget/.test(error.message)
    )
      throw error;
    return { status: "unavailable", objects: null };
  }
}
