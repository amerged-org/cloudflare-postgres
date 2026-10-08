// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { SizeClassUpsert, Timestamp, ObservedState } from "./api.ts";
import { DatabaseId, SizeClassId } from "./ids.ts";

export const ResourceProfileId = SizeClassId;
export const ResourceProfileUpdate = z.strictObject({
  expected_revision: z.number().int().min(0).max(2_147_483_646),
  resources: SizeClassUpsert,
});
export type ResourceProfileUpdate = z.infer<typeof ResourceProfileUpdate>;
export const ResourceProfileRevision = z.strictObject({
  profile_id: ResourceProfileId,
  revision: z.number().int().positive(),
  size_class_id: SizeClassId,
  resources: SizeClassUpsert,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  created_at: Timestamp,
});
export const ResourceProfileAssignment = z.strictObject({
  profile_id: ResourceProfileId,
  profile_revision: z.number().int().positive(),
  expected_generation: z.number().int().positive(),
});
export type ResourceProfileAssignment = z.infer<
  typeof ResourceProfileAssignment
>;
export const ResourceProfileRolloutUpdate = z.strictObject({
  profile_revision: z.number().int().positive(),
  expected_revision: z.number().int().nonnegative(),
});
export type ResourceProfileRolloutUpdate = z.infer<
  typeof ResourceProfileRolloutUpdate
>;
export const ResourceProfileRollout = z.strictObject({
  profile_id: ResourceProfileId,
  profile_revision: z.number().int().positive().nullable(),
  latest_revision: z.number().int().positive(),
  assignments: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  deferred: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
});
export const DatabaseResourceProfile = z.strictObject({
  database_id: DatabaseId,
  profile_id: ResourceProfileId.nullable(),
  profile_revision: z.number().int().positive().nullable(),
  target_profile_revision: z.number().int().positive().nullable(),
  size_class_id: SizeClassId,
  desired_generation: z.number().int().positive(),
  observed_generation: z.number().int().nonnegative(),
  observed_state: ObservedState,
  applied: z.boolean(),
  application_state: z.enum([
    "unassigned",
    "pending",
    "deferred_until_wake",
    "applied",
  ]),
});
