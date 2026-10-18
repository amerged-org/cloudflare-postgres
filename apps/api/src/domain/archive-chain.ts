// SPDX-License-Identifier: Apache-2.0

/**
 * Reading a database's R2 archive for the lifecycle (ULTRA plan 7.7, 9.5): its keys in order, and
 * whether a run of WAL segments is archived without a gap. Both stay bounded by what they are
 * asked for, unlike the restore catalog, which reads an archive whole.
 */
const LIST_PAGES = 50;

/** The keys under `prefix` in order, a page at a time; an archive too long to list is an error. */
export async function* keysOf(
  bucket: R2Bucket,
  prefix: string,
): AsyncGenerator<string> {
  let cursor: string | undefined;
  for (let page = 0; page < LIST_PAGES; page++) {
    const result = await bucket.list({
      prefix,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const object of result.objects) yield object.key;
    if (!result.truncated) return;
    cursor = result.cursor;
  }
  throw new Error("retention_listing_incomplete");
}

/** The data of a base backup: its tar files, compressed or not. */
export const BACKUP_DATA = /\.tar(?:\.(?:gz|bz2|lz4|zst))?$/;

const hex8 = (n: number) => n.toString(16).toUpperCase().padStart(8, "0");
const SEGMENT = /^([0-9A-F]{24})(?:\.(?:gz|bz2|lz4|zst))?$/;

/**
 * Whether every WAL segment from `first` to `last` (24 hexadecimal characters each, on one
 * timeline) is archived under `prefix` (`<archive>/database/`). A segment counts only as itself,
 * not as the label of a base backup or a `.partial` copy.
 */
export async function walRangeArchived(
  bucket: R2Bucket,
  prefix: string,
  range: { first: string; last: string; segmentBytes: number },
): Promise<boolean> {
  const timeline = range.first.slice(0, 8),
    perLog = 2 ** 32 / range.segmentBytes;
  if (timeline !== range.last.slice(0, 8)) return false;
  const index = (name: string) =>
    parseInt(name.slice(8, 16), 16) * perLog + parseInt(name.slice(16), 16);
  const first = index(range.first),
    last = index(range.last);
  for (let log = Math.floor(first / perLog); log * perLog <= last; log++) {
    const present = new Set<string>();
    for await (const key of keysOf(
      bucket,
      `${prefix}wals/${timeline}${hex8(log)}/`,
    )) {
      const segment = SEGMENT.exec(key.slice(key.lastIndexOf("/") + 1));
      if (segment) present.add(segment[1]!);
    }
    for (
      let n = Math.max(first, log * perLog);
      n <= Math.min(last, (log + 1) * perLog - 1);
      n++
    )
      if (!present.has(`${timeline}${hex8(log)}${hex8(n % perLog)}`))
        return false;
  }
  return true;
}
