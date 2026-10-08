// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { BucketName, HttpsUrl, Timestamp } from "./api.ts";
import { RegionId } from "./ids.ts";

const ArchiveCredential = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\r\n\0]/.test(value));
/** Supplied credentials must be bucket-scoped Object Read Only keys; permission is proved against R2 during live acceptance. */
export const ArchiveReadCredentials = z.strictObject({
  access_key_id: ArchiveCredential,
  secret_access_key: ArchiveCredential,
});
export const RecoverySourceCredentialsMap = z.record(
  RegionId,
  ArchiveReadCredentials.extend({
    bucket: BucketName,
    endpoint_url: HttpsUrl,
  }),
);
export type RecoverySourceCredentialsMap = z.infer<
  typeof RecoverySourceCredentialsMap
>;
export const RegionArchiveSourceUpdate = z.strictObject({
  expected_revision: z.number().int().min(0).max(2147483646),
  bucket: BucketName,
  endpoint_url: HttpsUrl,
  credentials: ArchiveReadCredentials,
});
export type RegionArchiveSourceUpdate = z.infer<
  typeof RegionArchiveSourceUpdate
>;
export const RegionArchiveSource = z.strictObject({
  target_region_id: RegionId,
  source_region_id: RegionId,
  revision: z.number().int().positive().max(2147483647),
  bucket: BucketName,
  endpoint_url: HttpsUrl,
  required_permission: z.literal("object-read-only"),
  source_matches_configuration: z.boolean(),
  updated_at: Timestamp,
});
