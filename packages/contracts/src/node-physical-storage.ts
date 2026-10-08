// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

const Bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const NodePhysicalStorage = z
  .strictObject({
    volume_group_uuid: z
      .string()
      .regex(/^[A-Za-z0-9]{6}-(?:[A-Za-z0-9]{4}-){5}[A-Za-z0-9]{6}$/),
    total_bytes: Bytes.positive(),
    free_bytes: Bytes,
    thick_allocated_bytes: Bytes,
    /** Absence of a thin pool is different from an empty qualified thin pool. */
    thin_pool: z
      .strictObject({
        name: z.literal("pgcf_thinpool"),
        data_total_bytes: Bytes.positive(),
        data_used_bytes_upper_bound: Bytes,
        metadata_total_bytes: Bytes.positive(),
        metadata_used_bytes_upper_bound: Bytes,
      })
      .nullable(),
  })
  .superRefine((value, context) => {
    if (
      value.free_bytes > value.total_bytes ||
      value.thick_allocated_bytes > value.total_bytes - value.free_bytes
    )
      context.addIssue({
        code: "custom",
        message: "Physical allocation exceeds the volume group",
      });
    const pool = value.thin_pool;
    if (
      pool &&
      (pool.data_used_bytes_upper_bound > pool.data_total_bytes ||
        pool.metadata_used_bytes_upper_bound > pool.metadata_total_bytes ||
        pool.data_total_bytes +
          pool.metadata_total_bytes +
          value.thick_allocated_bytes >
          value.total_bytes - value.free_bytes)
    )
      context.addIssue({
        code: "custom",
        message: "Thin pool capacity exceeds physical allocation",
      });
  });
export type NodePhysicalStorage = z.infer<typeof NodePhysicalStorage>;

/** A bounded fresh scrape; null means unavailable, never zero physical use. Reporting is not qualification. */
export const NodeStorageSample = z.strictObject({
  node_uid: z.uuid(),
  observed_at: z.iso.datetime(),
  physical: NodePhysicalStorage.nullable(),
});
export type NodeStorageSample = z.infer<typeof NodeStorageSample>;
