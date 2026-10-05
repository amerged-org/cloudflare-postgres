// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { regionArchive } from "../../src/domain/archive-bindings.ts";
import { validatedArchivePrefix } from "../../src/domain/archive.ts";
import {
  archiveDestinationPath,
  newDatabaseId,
  newOperationId,
} from "@pgcf/contracts";
it("uses the exact configured regional bucket binding and refuses ambiguous or mismatched mappings", () => {
  const region = { id: "us-test", backup_bucket: "pgcf-backups-us" };
  expect(() => regionArchive(env, region)).toThrow();
  const configured = {
    ...env,
    ARCHIVE_US: env.ARCHIVE,
    ARCHIVE_BINDINGS: JSON.stringify({
      [region.id]: { binding: "ARCHIVE_US", bucket: region.backup_bucket },
    }),
  };
  expect(regionArchive(configured, region).bucket).toBe(env.ARCHIVE);
  expect(() =>
    regionArchive(
      {
        ...configured,
        ARCHIVE_BINDINGS: JSON.stringify({
          [region.id]: { binding: "ARCHIVE_US", bucket: "pgcf-backups-eu" },
        }),
      },
      region,
    ),
  ).toThrow();
  expect(() =>
    regionArchive(configured, {
      id: "eu-test",
      backup_bucket: env.ARCHIVE_BUCKET_NAME,
    }),
  ).toThrow();
  expect(
    regionArchive(env, {
      id: "eu-test",
      backup_bucket: env.ARCHIVE_BUCKET_NAME,
    }).bucket,
  ).toBe(env.ARCHIVE);
});
it("refuses an archive that differs from physical generation even at a later configuration revision", () => {
  const id = newDatabaseId(),
    region = { backup_bucket: env.ARCHIVE_BUCKET_NAME };
  const row = {
    id,
    region_id: "eu-test",
    archive_path: archiveDestinationPath(
      region.backup_bucket,
      "eu-test",
      id,
      1,
      newOperationId(),
    ),
    storage_generation: 2,
    generation: 9,
  };
  expect(() =>
    validatedArchivePrefix(row, region, region.backup_bucket),
  ).toThrow();
  expect(
    validatedArchivePrefix(
      { ...row, storage_generation: 1 },
      region,
      region.backup_bucket,
    ),
  ).toContain(`/${id}/g1-`);
});
