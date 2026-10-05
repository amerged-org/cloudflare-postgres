// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { BucketName, RegionId } from "@pgcf/contracts";
import { ApiError } from "../app.ts";
export interface ArchiveEnvironment {
  ARCHIVE: R2Bucket;
  ARCHIVE_BUCKET_NAME: string;
  ARCHIVE_BINDINGS?: string;
  ARCHIVE_EU?: R2Bucket;
  ARCHIVE_US?: R2Bucket;
}
const mapping = z.record(
  RegionId,
  z.strictObject({
    binding: z.string().regex(/^ARCHIVE(?:_[A-Z0-9_]+)?$/),
    bucket: BucketName,
  }),
);
export function regionArchive(
  env: ArchiveEnvironment,
  region: { id: string; backup_bucket: string },
): { bucket: R2Bucket; bucketName: string } {
  try {
    let binding = "ARCHIVE",
      bucketName = env.ARCHIVE_BUCKET_NAME;
    if (env.ARCHIVE_BINDINGS !== undefined && env.ARCHIVE_BINDINGS !== "") {
      const config = mapping.parse(JSON.parse(env.ARCHIVE_BINDINGS));
      const entry = config[region.id];
      if (!entry) throw new Error();
      binding = entry.binding;
      bucketName = entry.bucket;
    }
    const bucket =
      binding === "ARCHIVE"
        ? env.ARCHIVE
        : (env as unknown as Record<string, unknown>)[binding];
    if (
      bucketName !== region.backup_bucket ||
      !bucket ||
      typeof bucket !== "object" ||
      typeof (bucket as R2Bucket).list !== "function" ||
      typeof (bucket as R2Bucket).get !== "function" ||
      typeof (bucket as R2Bucket).delete !== "function"
    )
      throw new Error();
    return { bucket: bucket as R2Bucket, bucketName };
  } catch {
    throw new ApiError(
      "internal",
      "The region archive bucket is not bound to this installation",
    );
  }
}
