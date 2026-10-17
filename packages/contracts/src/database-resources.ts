// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/** The steps and floors of a database's resources (ULTRA plan 3.5). */
export const DATABASE_MEMORY_STEP_MIB = 256;
export const DATABASE_CPU_MIN_MILLICORES = 100;
export const DATABASE_STORAGE_MIN_GIB = 1;
/** The memory ceiling of a region that sets no `maximum_database_memory_mib` of its own. */
export const DATABASE_MEMORY_DEFAULT_MAXIMUM_MIB = 4096;

const Memory = z
  .number()
  .int()
  .min(DATABASE_MEMORY_STEP_MIB)
  .max(1_048_576)
  .multipleOf(DATABASE_MEMORY_STEP_MIB)
  .meta({ multipleOf: DATABASE_MEMORY_STEP_MIB });
const Cpu = z.number().int().min(DATABASE_CPU_MIN_MILLICORES).max(256_000);
const Storage = z.number().int().min(DATABASE_STORAGE_MIN_GIB).max(65_536);

/** The resources a database runs with: its own value, else its size class's. */
export const DatabaseEffectiveResources = z
  .strictObject({
    memory_mib: Memory.describe(
      "Hard memory ceiling of the database while awake, in MiB.",
    ),
    cpu_millicores: Cpu.describe("CPU quota of the database while awake."),
    storage_gib: Storage.describe(
      "Nominal size of the database's volume in GiB. It never shrinks.",
    ),
  })
  .meta({ id: "DatabaseEffectiveResources" });
export type DatabaseEffectiveResources = z.infer<
  typeof DatabaseEffectiveResources
>;

/** Body of PUT /v1/databases/{id}/resources: every field is set, null hands it back to the size class. */
export const DatabaseResources = z
  .strictObject({
    memory_mib: Memory.nullable().describe(
      "The database's own memory ceiling in MiB, a multiple of 256 up to the region's per-database maximum; null takes the size class's.",
    ),
    cpu_millicores: Cpu.nullable().describe(
      "The database's own CPU quota, at least 100 and at most the cores of the region's largest node; null takes the size class's.",
    ),
    storage_gib: Storage.nullable().describe(
      "The database's own volume size in GiB, at least its current size; null takes the size class's, which may not be smaller than the current size.",
    ),
  })
  .meta({ id: "DatabaseResources" });
export type DatabaseResources = z.infer<typeof DatabaseResources>;

/** The `resources` of POST /v1/databases: each field left out takes the size class's value. */
export const DatabaseResourcesCreate = z
  .strictObject({
    memory_mib: Memory.optional(),
    cpu_millicores: Cpu.optional(),
    storage_gib: Storage.optional(),
  })
  .meta({ id: "DatabaseResourcesCreate" });
export type DatabaseResourcesCreate = z.infer<typeof DatabaseResourcesCreate>;
