// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { archiveBucket } from "../../src/domain/archive-bucket.ts";
import { validatedArchivePrefix } from "../../src/domain/archive.ts";
import {
  archiveDestinationPath,
  newDatabaseId,
  newOperationId,
} from "@pgcf/contracts";
it("serves every region from the one bound archive bucket and refuses an installation that does not bind it", () => {
  const selected = archiveBucket(env);
  expect(selected.bucket).toBe(env.ARCHIVE);
  expect(selected.bucketName).toBe(env.ARCHIVE_BUCKET_NAME);
  expect(() => archiveBucket({ ...env, ARCHIVE_BUCKET_NAME: "" })).toThrow(
    "The archive bucket is not bound to this installation",
  );
  expect(() =>
    archiveBucket({ ...env, ARCHIVE_BUCKET_NAME: "Not A Bucket" }),
  ).toThrow("The archive bucket is not bound to this installation");
  expect(() =>
    archiveBucket({ ...env, ARCHIVE: undefined as unknown as R2Bucket }),
  ).toThrow("The archive bucket is not bound to this installation");
});
it("refuses an archive that differs from physical generation even at a later configuration revision", () => {
  const id = newDatabaseId(),
    bucket = env.ARCHIVE_BUCKET_NAME;
  const row = {
    id,
    region_id: "eu-test",
    archive_path: archiveDestinationPath(
      bucket,
      "eu-test",
      id,
      1,
      newOperationId(),
    ),
    storage_generation: 2,
    generation: 9,
  };
  expect(() => validatedArchivePrefix(row, bucket)).toThrow();
  expect(
    validatedArchivePrefix({ ...row, storage_generation: 1 }, bucket),
  ).toContain(`/${id}/g1-`);
});
it("refuses an archive path that names another bucket than the bound one, in any region", () => {
  const id = newDatabaseId(),
    operation = newOperationId(),
    row = (region: string, bucket: string) => ({
      id,
      region_id: region,
      archive_path: archiveDestinationPath(bucket, region, id, 1, operation),
      storage_generation: 1,
    });
  for (const region of ["eu-test", "us-test"]) {
    expect(
      validatedArchivePrefix(
        row(region, env.ARCHIVE_BUCKET_NAME),
        env.ARCHIVE_BUCKET_NAME,
      ),
    ).toBe(`${region}/${id}/g1-${operation}/database/`);
    expect(() =>
      validatedArchivePrefix(
        row(region, "an-older-bucket"),
        env.ARCHIVE_BUCKET_NAME,
      ),
    ).toThrow("The archive bucket is not bound to this installation");
  }
});
