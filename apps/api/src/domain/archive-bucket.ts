// SPDX-License-Identifier: Apache-2.0
import { BucketName } from "@pgcf/contracts";
import { ApiError } from "../api-error.ts";

/**
 * The one R2 bucket every region archives into: the `ARCHIVE` binding, named by the variable
 * `ARCHIVE_BUCKET_NAME`, which the archive paths in D1 (`s3://<bucket>/<region>/...`) and the
 * temporary credentials of the nodes name as well. A region has no bucket and no endpoint of its
 * own: the S3 endpoint of the bucket is the variable `ARCHIVE_ENDPOINT_URL`, the same for every
 * region.
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

export interface ArchiveEndpoint {
  /** The S3 endpoint of the one archive bucket, as the variable gives it. */
  url: string;
  /** The Cloudflare account that holds the bucket: the first label of the endpoint's host. */
  accountId: string;
}

/**
 * The S3 endpoint of the one archive bucket, which the nodes' temporary credentials name, and the
 * Cloudflare account it belongs to, which is also the account of the nodes' Tunnels. Null while
 * the variable is missing or is not an `https` URL whose host starts with a 32-character account
 * id (`https://<account>.eu.r2.cloudflarestorage.com` for an EU-jurisdiction bucket), so a Worker
 * without it signs nothing and makes no Tunnel.
 */
export function archiveEndpoint(env: {
  ARCHIVE_ENDPOINT_URL?: string;
}): ArchiveEndpoint | null {
  const url = env.ARCHIVE_ENDPOINT_URL ?? "";
  try {
    const accountId = /^([0-9a-f]{32})\./.exec(new URL(url).host)?.[1];
    return new URL(url).protocol === "https:" && accountId !== undefined
      ? { url, accountId }
      : null;
  } catch {
    return null;
  }
}
