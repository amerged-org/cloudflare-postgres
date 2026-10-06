// SPDX-License-Identifier: Apache-2.0
import {
  archiveDestinationPath,
  newDatabaseId,
  newOperationId,
} from "@pgcf/contracts";
import { fixture } from "./fixtures.ts";
export function recoveryFixture() {
  const f = fixture(),
    source = newDatabaseId(),
    op = newOperationId();
  f.db.creation = null;
  f.db.storage_generation = 2;
  f.db.archive.destination_path = archiveDestinationPath(
    f.ctx.backup.bucket,
    "eu-test",
    f.db.id,
    2,
    op,
  );
  f.db.recovery = {
    operation_id: op,
    source_database_id: source,
    source_archive_path: archiveDestinationPath(
      f.ctx.backup.bucket,
      "eu-test",
      source,
      1,
      newOperationId(),
    ),
    source_storage_generation: 1,
    backup_id: "20261001T000000",
    target_time: "2026-10-01T00:03:00.000Z",
    status: "pending",
    ever_ready: false,
  };
  return f;
}

export function crossRegionRecoveryFixture() {
  const f = recoveryFixture();
  const source = {
    region_id: "eu-test",
    bucket: f.ctx.backup.bucket,
    endpoint_url: f.ctx.backup.endpointUrl,
    region: "auto" as const,
  };
  Object.assign(f.db.recovery!, { source_archive: source });
  f.ctx.backup = {
    ...f.ctx.backup,
    bucket: "pgcf-backups-target",
    endpointUrl: "https://target.r2.cloudflarestorage.com",
    credentials: {
      accessKeyId: "target-write-key",
      secretAccessKey: "target-write-secret",
    },
  };
  f.db.archive.destination_path = archiveDestinationPath(
    f.ctx.backup.bucket,
    "us-test",
    f.db.id,
    2,
    f.db.recovery!.operation_id,
  );
  const ctx = Object.assign(f.ctx, {
    recoverySource: {
      bucket: source.bucket,
      endpointUrl: source.endpoint_url,
      region: "auto" as const,
      credentials: {
        accessKeyId: "source-read-key",
        secretAccessKey: "source-read-secret",
      },
    },
  });
  return { ...f, ctx, source };
}
