// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  COLD_SNAPSHOT_CHUNK_BYTES,
  COLD_SNAPSHOT_TOTAL_MAX_BYTES,
  ColdSnapshotManifest,
  ColdSnapshotRelativePath,
  ColdSnapshotSource,
  coldSnapshotPrefix,
} from "../src/cold-snapshot.ts";

const end = {
  system_identifier: "7428512345678901234",
  timeline: 1,
  checkpoint_lsn: "0/3000028",
  last_archived_segment: "000000010000000000000002",
  proven_at: "2026-10-20T10:00:00.000Z",
};
const operation = `op_${"a".repeat(20)}`;
const database = "a".repeat(20);
const manifest = () => ({
  version: 1,
  operation,
  database_id: database,
  source_generation: 4,
  source_storage_generation: 2,
  pg_major: 18,
  end,
  total_bytes: 8195,
  directories: ["global", "pg_wal"],
  files: [
    { path: "PG_VERSION", offset: 0, size_bytes: 3, sha256: "a".repeat(64) },
    {
      path: "global/pg_control",
      offset: 3,
      size_bytes: 8192,
      sha256: "b".repeat(64),
    },
  ],
  chunks: [{ index: 0, size_bytes: 8195, sha256: "c".repeat(64) }],
});

describe("complete clean-shutdown snapshot manifest", () => {
  it("binds every packed byte to files and transport chunks while keeping empty files", () => {
    const value = manifest();
    value.files.push({
      path: "pg_wal/empty",
      offset: 8195,
      size_bytes: 0,
      sha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
    expect(ColdSnapshotManifest.parse(value)).toEqual(value);
    value.files[1]!.size_bytes++;
    expect(ColdSnapshotManifest.safeParse(value).success).toBe(false);
  });

  it("packs across file boundaries without making a request for every small file", () => {
    const value = manifest();
    value.files.push({
      path: "pg_wal/000000010000000000000003",
      offset: 8195,
      size_bytes: COLD_SNAPSHOT_CHUNK_BYTES,
      sha256: "d".repeat(64),
    });
    value.total_bytes += COLD_SNAPSHOT_CHUNK_BYTES;
    value.chunks = [
      {
        index: 0,
        size_bytes: COLD_SNAPSHOT_CHUNK_BYTES,
        sha256: "c".repeat(64),
      },
      { index: 1, size_bytes: 8195, sha256: "d".repeat(64) },
    ];
    expect(ColdSnapshotManifest.safeParse(value).success).toBe(true);
    value.chunks[0]!.size_bytes--;
    value.chunks[1]!.size_bytes++;
    expect(ColdSnapshotManifest.safeParse(value).success).toBe(false);
  });

  it("rejects a missing chunk, overlapping files and a changed total", () => {
    const missing = manifest();
    missing.chunks[0]!.index = 1;
    expect(ColdSnapshotManifest.safeParse(missing).success).toBe(false);
    const overlap = manifest();
    overlap.files[1]!.offset = 2;
    expect(ColdSnapshotManifest.safeParse(overlap).success).toBe(false);
    const extra = manifest();
    extra.total_bytes++;
    expect(ColdSnapshotManifest.safeParse(extra).success).toBe(false);
  });

  it("requires complete parent directories and unique deterministic paths", () => {
    const noParent = manifest();
    noParent.directories = ["pg_wal"];
    expect(ColdSnapshotManifest.safeParse(noParent).success).toBe(false);
    const reordered = manifest();
    reordered.directories.reverse();
    expect(ColdSnapshotManifest.safeParse(reordered).success).toBe(false);
    const duplicate = manifest();
    duplicate.directories.push("pg_wal");
    expect(ColdSnapshotManifest.safeParse(duplicate).success).toBe(false);
    const conflict = manifest();
    conflict.directories.unshift("PG_VERSION");
    expect(ColdSnapshotManifest.safeParse(conflict).success).toBe(false);
  });

  it("rejects an online backup, recovery signal or missing control/version file", () => {
    for (const path of [
      "postmaster.pid",
      "recovery.signal",
      "standby.signal",
      "backup_label",
      "tablespace_map",
    ]) {
      const value = manifest();
      value.files.push({
        path,
        offset: 8195,
        size_bytes: 0,
        sha256: "a".repeat(64),
      });
      expect(ColdSnapshotManifest.safeParse(value).success, path).toBe(false);
    }
    const noControl = manifest();
    noControl.files[1]!.path = "global/another";
    expect(ColdSnapshotManifest.safeParse(noControl).success).toBe(false);
    const noWal = manifest();
    noWal.directories = ["global"];
    expect(ColdSnapshotManifest.safeParse(noWal).success).toBe(false);
  });

  it("bounds the first format and rejects unsafe filesystem paths", () => {
    for (const path of [
      "",
      "/PG_VERSION",
      "../PG_VERSION",
      "base/../global",
      "base/./1",
      "base//1",
      "base\\1",
      "base/1\0",
    ]) {
      expect(ColdSnapshotRelativePath.safeParse(path).success, path).toBe(
        false,
      );
    }
    const large = manifest();
    large.total_bytes = COLD_SNAPSHOT_TOTAL_MAX_BYTES + 1;
    expect(ColdSnapshotManifest.safeParse(large).success).toBe(false);
  });

  it("keeps snapshots outside the normal Barman credential namespace", () => {
    expect(coldSnapshotPrefix("eu-a", database, 2, operation)).toBe(
      `cold-snapshots/eu-a/${database}/g2-${operation}/`,
    );
    expect(() =>
      coldSnapshotPrefix("../eu-a", database, 2, operation),
    ).toThrow();
    expect(
      ColdSnapshotSource.safeParse({
        database_id: database,
        snapshot_operation: operation,
        source_generation: 4,
        source_storage_generation: 2,
        manifest_sha256: "a".repeat(64),
        manifest_bytes: 1000,
        end,
      }).success,
    ).toBe(true);
    expect(
      ColdSnapshotSource.safeParse({
        database_id: database,
        path: "s3://old/barman",
        backup_id: "20261020T100000",
        end,
      }).success,
    ).toBe(false);
  });

  it("requires the complete current timeline history when the source has been promoted", () => {
    const value = manifest();
    value.end = {
      ...end,
      timeline: 2,
      last_archived_segment: "000000020000000000000002",
    };
    expect(ColdSnapshotManifest.safeParse(value).success).toBe(false);
    value.files.push({
      path: "pg_wal/00000002.history",
      offset: value.total_bytes,
      size_bytes: 16,
      sha256: "d".repeat(64),
    });
    value.total_bytes += 16;
    value.chunks[0]!.size_bytes += 16;
    expect(ColdSnapshotManifest.safeParse(value).success).toBe(true);
    value.files.at(-1)!.size_bytes = 0;
    value.total_bytes -= 16;
    value.chunks[0]!.size_bytes -= 16;
    expect(ColdSnapshotManifest.safeParse(value).success).toBe(false);
  });
});
