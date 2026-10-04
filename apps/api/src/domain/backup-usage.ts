// SPDX-License-Identifier: Apache-2.0
import { DatabaseId, bytesToHex } from "@pgcf/contracts";
import type { UsageSample } from "@pgcf/contracts/usage";
import { validatedArchivePrefix } from "./archive.ts";
import { recordUsageSample, type BackupUsageIdentity } from "./usage.ts";
import type { Env } from "../env.ts";

export const BACKUP_LIST_OBJECT_LIMIT = 1000;
export const BACKUP_LIST_DEADLINE_MS = 2000;
interface ArchiveRow {
  id: string;
  region_id: string;
  archive_path: string;
  generation: number;
  deleted_at: string | null;
  backup_bucket: string;
}
export interface BackupMeasurementResult {
  status: "measured" | "unavailable";
  objects: number | null;
  sample?: Extract<UsageSample, { source: "backup" }>;
  recorded?: "recorded" | "duplicate";
}
type BackupEnvironment = Pick<Env, "DB" | "ARCHIVE" | "ARCHIVE_BUCKET_NAME">;
const rowFor = (db: D1Database, id: string) =>
  db
    .prepare(
      "SELECT d.id,d.region_id,d.archive_path,d.generation,d.deleted_at,r.backup_bucket FROM databases d JOIN regions r ON r.id=d.region_id WHERE d.id=?",
    )
    .bind(id)
    .first<ArchiveRow>();
const sameIdentity = (a: ArchiveRow, b: ArchiveRow | null): boolean =>
  b !== null &&
  a.id === b.id &&
  a.region_id === b.region_id &&
  a.archive_path === b.archive_path &&
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
    const prefix = validatedArchivePrefix(row, row, env.ARCHIVE_BUCKET_NAME);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listing = await Promise.race([
      env.ARCHIVE.list({ prefix, limit: BACKUP_LIST_OBJECT_LIMIT }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("backup_listing_timeout")),
          BACKUP_LIST_DEADLINE_MS,
        );
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    // One complete list is an exact measurement. Cross-page reads are not a snapshot.
    if (
      listing.truncated !== false ||
      !Array.isArray(listing.objects) ||
      listing.objects.length > BACKUP_LIST_OBJECT_LIMIT ||
      !Array.isArray(listing.delimitedPrefixes) ||
      listing.delimitedPrefixes.length !== 0
    )
      throw new Error("backup_listing_incomplete");
    const seen = new Set<string>();
    let total = 0;
    for (const object of listing.objects) {
      if (
        typeof object.key !== "string" ||
        !object.key.startsWith(prefix) ||
        object.key.length === 0 ||
        new TextEncoder().encode(object.key).length > 1024 ||
        seen.has(object.key) ||
        !Number.isSafeInteger(object.size) ||
        object.size < 0 ||
        !Number.isSafeInteger(total + object.size)
      )
        throw new Error("backup_listing_invalid");
      seen.add(object.key);
      total += object.size;
    }
    bytes = total;
    objects = seen.size;
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
