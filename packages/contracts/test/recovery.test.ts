// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import {
  DatabaseRestore,
  DesiredDatabase,
  archiveDestinationPath,
  newDatabaseId,
  newOperationId,
  newRolePassword,
} from "../src/index.ts";

const request = {
  mode: "pitr",
  name: "restored",
  target_time: new Date().toISOString(),
};
it("requires a target time exactly for PITR and accepts an optional target region", () => {
  expect(DatabaseRestore.safeParse(request).success).toBe(true);
  expect(
    DatabaseRestore.safeParse({ mode: "full", name: "restored" }).success,
  ).toBe(true);
  expect(
    DatabaseRestore.safeParse({ mode: "pitr", name: "restored" }).success,
  ).toBe(false);
  expect(DatabaseRestore.safeParse({ ...request, mode: "full" }).success).toBe(
    false,
  );
  expect(
    DatabaseRestore.safeParse({ ...request, region_id: "us-test" }).success,
  ).toBe(true);
  expect(
    DatabaseRestore.safeParse({
      ...request,
      endpoint_url: "https://example.com",
    }).success,
  ).toBe(false);
});

it("binds a cross-region source archive independently of the target archive", () => {
  const source = newDatabaseId(),
    target = newDatabaseId(),
    op = newOperationId();
  const value = {
    id: target,
    generation: 1,
    storage_generation: 2,
    desired_state: "running",
    node: "target-node",
    pg_major: 18,
    size: {
      memory_mib: 512,
      cpu_millicores: 500,
      storage_gib: 5,
      max_connections: 50,
      archive_timeout_seconds: 60,
      backup_retention_days: 7,
    },
    roles: [
      { name: "app", owner: true, password: newRolePassword(), revision: 1 },
    ],
    archive: {
      destination_path: archiveDestinationPath(
        "pgcf-backups-target",
        "target-test",
        target,
        2,
        op,
      ),
      server_name: "database",
    },
    recovery: {
      operation_id: op,
      source_database_id: source,
      source_archive_path: archiveDestinationPath(
        "pgcf-backups-source",
        "source-test",
        source,
        1,
        newOperationId(),
      ),
      source_storage_generation: 1,
      backup_id: "20261001T000000",
      status: "pending",
      ever_ready: false,
      source_archive: {
        region_id: "source-test",
        bucket: "pgcf-backups-source",
        endpoint_url: "https://source.r2.cloudflarestorage.com",
        region: "auto",
      },
    },
  };
  expect(DesiredDatabase.safeParse(value).success).toBe(true);
  expect(
    DesiredDatabase.safeParse({
      ...value,
      recovery: { ...value.recovery, source_archive: undefined },
    }).success,
  ).toBe(false);
  expect(
    DesiredDatabase.safeParse({
      ...value,
      recovery: {
        ...value.recovery,
        source_archive: {
          ...value.recovery.source_archive,
          bucket: "pgcf-wrong-source",
        },
      },
    }).success,
  ).toBe(false);
  expect(
    DesiredDatabase.safeParse({
      ...value,
      recovery: {
        ...value.recovery,
        source_archive: {
          ...value.recovery.source_archive,
          region_id: "foreign-test",
        },
      },
    }).success,
  ).toBe(false);
  expect(
    DesiredDatabase.safeParse({
      ...value,
      recovery: {
        ...value.recovery,
        source_archive: {
          ...value.recovery.source_archive,
          endpoint_url: "http://source.r2.cloudflarestorage.com",
        },
      },
    }).success,
  ).toBe(false);
});
it("matches archive storage generation rather than accepting an older config revision", () => {
  const id = newDatabaseId(),
    op = newOperationId();
  const input = {
    id,
    generation: 8,
    storage_generation: 2,
    desired_state: "running",
    node: "test-node",
    pg_major: 18,
    size: {
      memory_mib: 512,
      cpu_millicores: 500,
      storage_gib: 5,
      max_connections: 50,
      archive_timeout_seconds: 60,
      backup_retention_days: 7,
    },
    roles: [
      { name: "app", owner: true, password: newRolePassword(), revision: 1 },
    ],
    archive: {
      destination_path: archiveDestinationPath(
        "pgcf-backups",
        "eu-test",
        id,
        1,
        op,
      ),
      server_name: "database",
    },
  };
  expect(DesiredDatabase.safeParse(input).success).toBe(false);
  expect(
    DesiredDatabase.safeParse({ ...input, storage_generation: 1 }).success,
  ).toBe(true);
});
