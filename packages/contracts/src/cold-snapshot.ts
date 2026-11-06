// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { DatabaseId, NodeId, OperationId, RegionId } from "./ids.ts";
import { ProvenSleepRecord } from "./postgres-storage.ts";

/** Version one is a bounded, uncompressed clean-shutdown PGDATA snapshot, not a Barman archive. */
export const COLD_SNAPSHOT_VERSION = 1;
export const COLD_SNAPSHOT_CHUNK_BYTES = 4 * 1024 * 1024;
export const COLD_SNAPSHOT_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
export const COLD_SNAPSHOT_FILES_MAX = 16_384;
export const COLD_SNAPSHOT_DIRECTORIES_MAX = 4_096;
export const COLD_SNAPSHOT_CHUNKS_MAX = 16_384;
export const COLD_SNAPSHOT_TOTAL_MAX_BYTES =
  COLD_SNAPSHOT_CHUNK_BYTES * COLD_SNAPSHOT_CHUNKS_MAX;
export const COLD_SNAPSHOT_API_PREFIX = "/node/v1/cold-snapshots/";
export const COLD_SNAPSHOT_CAPABILITY = "cold_storage_v2";
const Positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const ColdSnapshotSha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const ColdSnapshotRelativePath = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/)
  .refine(
    (path) => path.split("/").every((part) => part !== "." && part !== ".."),
    "Snapshot paths never traverse directories",
  );
export const ColdSnapshotPrefix = z
  .string()
  .regex(
    /^cold-snapshots\/[a-z][a-z0-9-]{1,30}[a-z0-9]\/[a-z][a-z0-9]{19}\/g[1-9][0-9]{0,15}-op_[a-z0-9]{20}\/$/,
  );
export function coldSnapshotPrefix(
  region: string,
  database: string,
  generation: number,
  operation: string,
): string {
  RegionId.parse(region);
  DatabaseId.parse(database);
  Positive.parse(generation);
  OperationId.parse(operation);
  return `cold-snapshots/${region}/${database}/g${generation}-${operation}/`;
}

export const ColdSnapshotCaptureRequest = z.strictObject({
  operation: OperationId,
  database_id: DatabaseId,
  source_node_id: NodeId,
  source_generation: Positive,
  source_storage_generation: Positive,
  end: ProvenSleepRecord,
});
export type ColdSnapshotCaptureRequest = z.infer<
  typeof ColdSnapshotCaptureRequest
>;

export const ColdSnapshotSource = z.strictObject({
  database_id: DatabaseId,
  snapshot_operation: OperationId,
  source_generation: Positive,
  source_storage_generation: Positive,
  manifest_sha256: ColdSnapshotSha256,
  manifest_bytes: z
    .number()
    .int()
    .positive()
    .max(COLD_SNAPSHOT_MANIFEST_MAX_BYTES),
  end: ProvenSleepRecord,
});
export type ColdSnapshotSource = z.infer<typeof ColdSnapshotSource>;

export const ColdSnapshotFile = z.strictObject({
  path: ColdSnapshotRelativePath,
  offset: z.number().int().nonnegative().max(COLD_SNAPSHOT_TOTAL_MAX_BYTES),
  size_bytes: z.number().int().nonnegative().max(COLD_SNAPSHOT_TOTAL_MAX_BYTES),
  sha256: ColdSnapshotSha256,
});
export const ColdSnapshotChunk = z.strictObject({
  index: z
    .number()
    .int()
    .nonnegative()
    .max(COLD_SNAPSHOT_CHUNKS_MAX - 1),
  size_bytes: z.number().int().positive().max(COLD_SNAPSHOT_CHUNK_BYTES),
  sha256: ColdSnapshotSha256,
});
export const ColdSnapshotManifest = z
  .strictObject({
    version: z.literal(COLD_SNAPSHOT_VERSION),
    operation: OperationId,
    database_id: DatabaseId,
    source_generation: Positive,
    source_storage_generation: Positive,
    pg_major: z.literal(18),
    end: ProvenSleepRecord,
    total_bytes: z.number().int().positive().max(COLD_SNAPSHOT_TOTAL_MAX_BYTES),
    directories: z
      .array(ColdSnapshotRelativePath)
      .max(COLD_SNAPSHOT_DIRECTORIES_MAX),
    files: z.array(ColdSnapshotFile).min(2).max(COLD_SNAPSHOT_FILES_MAX),
    chunks: z.array(ColdSnapshotChunk).min(1).max(COLD_SNAPSHOT_CHUNKS_MAX),
  })
  .superRefine((manifest, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: "custom", message });
    const directories = new Set(manifest.directories);
    if (directories.size !== manifest.directories.length)
      issue("Snapshot directories are unique");
    if (!directories.has("pg_wal"))
      issue("The complete snapshot declares its WAL directory");
    manifest.directories.forEach((directory, index) => {
      if (index > 0 && manifest.directories[index - 1]! >= directory)
        issue("Snapshot directories are in deterministic path order");
    });
    const parent = (path: string) => path.slice(0, path.lastIndexOf("/"));
    const hasParent = (path: string) =>
      !path.includes("/") || directories.has(parent(path));
    for (const directory of manifest.directories)
      if (!hasParent(directory)) issue("Every directory parent is declared");
    const paths = new Set<string>();
    let offset = 0;
    for (const [index, file] of manifest.files.entries()) {
      if (index > 0 && manifest.files[index - 1]!.path >= file.path)
        issue("Snapshot files are in deterministic path order");
      if (paths.has(file.path) || directories.has(file.path))
        issue("Snapshot file paths are unique and cannot also be directories");
      if (!hasParent(file.path)) issue("Every file parent is declared");
      if (file.offset !== offset)
        issue("Packed files are contiguous, without holes or overlaps");
      paths.add(file.path);
      offset += file.size_bytes;
    }
    if (offset !== manifest.total_bytes)
      issue("File lengths account for every packed byte");
    if (!paths.has("PG_VERSION") || !paths.has("global/pg_control"))
      issue("A snapshot includes PostgreSQL version and control files");
    if (manifest.end.timeline > 1) {
      const history = `pg_wal/${manifest.end.timeline.toString(16).toUpperCase().padStart(8, "0")}.history`;
      if (
        !manifest.files.some(
          (file) => file.path === history && file.size_bytes > 0,
        )
      )
        issue(
          "A later timeline includes its nonempty current timeline history file",
        );
    }
    for (const forbidden of [
      "postmaster.pid",
      "recovery.signal",
      "standby.signal",
      "backup_label",
      "tablespace_map",
    ]) {
      if (paths.has(forbidden) || directories.has(forbidden))
        issue(
          "A snapshot is a clean shutdown, never an online backup or recovery image",
        );
    }
    let bytes = 0;
    manifest.chunks.forEach((chunk, index) => {
      if (chunk.index !== index)
        issue("Chunk indexes are ordered and contiguous from zero");
      if (
        index < manifest.chunks.length - 1 &&
        chunk.size_bytes !== COLD_SNAPSHOT_CHUNK_BYTES
      )
        issue("Only the final packed chunk may be short");
      bytes += chunk.size_bytes;
    });
    if (bytes !== manifest.total_bytes)
      issue("Chunk lengths account for every packed byte");
  });
export type ColdSnapshotManifest = z.infer<typeof ColdSnapshotManifest>;
