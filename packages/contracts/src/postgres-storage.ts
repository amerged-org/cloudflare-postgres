// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Timestamp } from "./timestamp.ts";

export const WAL_SEGMENT_PATTERN = /^[0-9A-F]{24}$/;
/** The fsynced record of a proven sleep; a snapshot additionally includes the clean shutdown WAL. */
export const ProvenSleepRecord = z.strictObject({
  system_identifier: z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/)
    .refine((value) => BigInt(value) <= 0xffff_ffff_ffff_ffffn),
  timeline: z.number().int().min(1).max(0xffff_ffff),
  checkpoint_lsn: z.string().regex(/^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/),
  last_archived_segment: z.string().regex(WAL_SEGMENT_PATTERN),
  proven_at: Timestamp,
});
export type ProvenSleepRecord = z.infer<typeof ProvenSleepRecord>;
