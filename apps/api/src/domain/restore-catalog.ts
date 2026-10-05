// SPDX-License-Identifier: Apache-2.0
import { ApiError } from "../app.ts";
const WAL = /^[0-9A-F]{24}$/;
const BACKUP = /^[0-9]{8}T[0-9]{6}$/;
const CATALOG_PAGE_LIMIT = 16,
  CATALOG_OBJECT_LIMIT = 16000;
export interface RestoreBackup {
  id: string;
  begin: string;
  end: string;
  beginWal: string;
  endWal: string;
  segmentBytes: number;
}
export function parseBackupInfo(
  text: string,
  id: string,
): RestoreBackup | null {
  if (text.length > 65536 || !BACKUP.test(id)) return null;
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at < 1) continue;
    const key = line.slice(0, at),
      value = line.slice(at + 1);
    if (fields.has(key)) return null;
    fields.set(key, value);
  }
  const begin = Date.parse(fields.get("begin_time") ?? ""),
    end = Date.parse(fields.get("end_time") ?? "");
  const beginWal = fields.get("begin_wal") ?? "",
    endWal = fields.get("end_wal") ?? "";
  const segmentBytes = Number(fields.get("xlog_segment_size"));
  if (
    fields.get("status") !== "DONE" ||
    (fields.has("backup_id") && fields.get("backup_id") !== id) ||
    !Number.isFinite(begin) ||
    !Number.isFinite(end) ||
    begin > end ||
    !WAL.test(beginWal) ||
    !WAL.test(endWal) ||
    !Number.isSafeInteger(segmentBytes) ||
    segmentBytes < 2 ** 20 ||
    segmentBytes > 2 ** 30 ||
    !Number.isInteger(Math.log2(segmentBytes))
  )
    return null;
  return {
    id,
    begin: new Date(begin).toISOString(),
    end: new Date(end).toISOString(),
    beginWal,
    endWal,
    segmentBytes,
  };
}
function completeWalRange(info: RestoreBackup, names: Set<string>): boolean {
  const timeline = info.beginWal.slice(0, 8);
  if (
    timeline !== info.endWal.slice(0, 8) ||
    parseInt(timeline, 16) === 0 ||
    !names.has(info.beginWal) ||
    !names.has(info.endWal)
  )
    return false;
  // A later timeline requires its own completed base backup in this bounded v1 catalog.
  if ([...names].some((n) => n.slice(0, 8) > timeline)) return false;
  const perLog = BigInt(2 ** 32 / info.segmentBytes);
  const index = (name: string) => {
    const segment = BigInt(`0x${name.slice(16)}`);
    return segment < perLog
      ? BigInt(`0x${name.slice(8, 16)}`) * perLog + segment
      : null;
  };
  let prior = index(info.beginWal);
  if (prior === null) return false;
  for (const name of [...names]
    .filter((n) => n.slice(0, 8) === timeline && n > info.beginWal)
    .sort()) {
    const next = index(name);
    if (next === null || next !== prior + 1n) return false;
    prior = next;
  }
  return true;
}

export async function restoreBackup(
  bucket: R2Bucket,
  prefix: string,
  target?: string,
): Promise<RestoreBackup> {
  const objects = new Map<string, R2Object>(),
    cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < CATALOG_PAGE_LIMIT; page++) {
    const result = await bucket.list({
      prefix,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    if (result.delimitedPrefixes.length || result.objects.length > 1000)
      throw new ApiError("conflict", "Archive listing is incomplete");
    for (const o of result.objects) {
      if (
        !o.key.startsWith(prefix) ||
        objects.has(o.key) ||
        objects.size >= CATALOG_OBJECT_LIMIT
      )
        throw new ApiError("conflict", "Archive listing is invalid");
      objects.set(o.key, o);
    }
    if (!result.truncated) {
      cursor = undefined;
      break;
    }
    if (!result.cursor || cursors.has(result.cursor))
      throw new ApiError("conflict", "Archive listing is incomplete");
    cursors.add(result.cursor);
    cursor = result.cursor;
  }
  if (cursor)
    throw new ApiError(
      "conflict",
      "Archive listing exceeds the bounded recovery catalog",
    );
  const walNames = new Set<string>();
  for (const key of objects.keys()) {
    if (!key.startsWith(`${prefix}wals/`)) continue;
    const name = key
      .slice(key.lastIndexOf("/") + 1)
      .replace(/\.(?:gz|bz2|lz4|zst)$/, "");
    if (WAL.test(name)) {
      if (walNames.has(name))
        throw new ApiError(
          "conflict",
          "Archive contains duplicate WAL segment identities",
        );
      walNames.add(name);
    }
  }
  const backups: RestoreBackup[] = [];
  let metadataCount = 0;
  for (const key of objects.keys()) {
    const match = /^base\/([0-9]{8}T[0-9]{6})\/backup\.info$/.exec(
      key.slice(prefix.length),
    );
    if (!match) continue;
    if (++metadataCount > 64)
      throw new ApiError(
        "conflict",
        "Archive recovery catalog exceeds the backup limit",
      );
    const value = await bucket.get(key);
    if (!value || value.size > 65536) continue;
    const info = parseBackupInfo(await value.text(), match[1]!);
    if (!info) continue;
    const dataPrefix = `${prefix}base/${info.id}/`;
    if (
      ![...objects.keys()].some(
        (k) =>
          k.startsWith(dataPrefix) && /\.tar(?:\.(?:gz|bz2|lz4|zst))?$/.test(k),
      )
    )
      continue;
    if (
      completeWalRange(info, walNames) &&
      (target === undefined || info.end <= target)
    )
      backups.push(info);
  }
  const selected = backups.sort(
    (a, b) => b.end.localeCompare(a.end) || b.id.localeCompare(a.id),
  )[0];
  if (!selected)
    throw new ApiError(
      "conflict",
      "No complete base backup and required WAL are available for the requested recovery",
    );
  return selected;
}
