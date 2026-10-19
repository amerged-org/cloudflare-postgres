// SPDX-License-Identifier: Apache-2.0
import { BucketName } from "@pgcf/contracts";
import { ApiError } from "../api-error.ts";

/**
 * The one R2 bucket every region archives into: the `ARCHIVE` binding, named by the variable
 * `ARCHIVE_BUCKET_NAME`, which the archive paths in D1 (`s3://<bucket>/<region>/...`) and the
 * temporary credentials of the nodes name as well. A region has no bucket of its own.
 */
export interface ArchiveEnvironment {
  ARCHIVE: R2Bucket;
  ARCHIVE_BUCKET_NAME: string;
}

export function archiveBucket(env: ArchiveEnvironment): {
  bucket: R2Bucket;
  bucketName: string;
} {
  const bucket: unknown = env.ARCHIVE;
  if (
    !BucketName.safeParse(env.ARCHIVE_BUCKET_NAME).success ||
    !bucket ||
    typeof bucket !== "object" ||
    typeof (bucket as R2Bucket).list !== "function" ||
    typeof (bucket as R2Bucket).get !== "function" ||
    typeof (bucket as R2Bucket).delete !== "function"
  )
    throw new ApiError(
      "internal",
      "The archive bucket is not bound to this installation",
    );
  return { bucket: bucket as R2Bucket, bucketName: env.ARCHIVE_BUCKET_NAME };
}
