// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/** Resources are canonical integer MiB internally; old whole-GiB API inputs remain valid. */
export const DATABASE_MEMORY_STEP_MIB = 256;
export const DATABASE_CPU_MIN_MILLICORES = 100;
export const DATABASE_STORAGE_STEP_MIB = 4;
export const DATABASE_STORAGE_MAX_MIB = 65_536 * 1024;
export const DATABASE_MEMORY_DEFAULT_MAXIMUM_MIB = 4096;

const Memory = z
  .number()
  .int()
  .min(DATABASE_MEMORY_STEP_MIB)
  .max(1_048_576)
  .multipleOf(DATABASE_MEMORY_STEP_MIB)
  .meta({ multipleOf: DATABASE_MEMORY_STEP_MIB });
const Cpu = z.number().int().min(DATABASE_CPU_MIN_MILLICORES).max(256_000);
export const StorageMiB = z
  .number()
  .int()
  .min(DATABASE_STORAGE_STEP_MIB)
  .max(DATABASE_STORAGE_MAX_MIB)
  .multipleOf(DATABASE_STORAGE_STEP_MIB)
  .meta({ multipleOf: DATABASE_STORAGE_STEP_MIB })
  .describe(
    "Nominal total database volume in MiB, including PostgreSQL/WAL and filesystem overhead; a positive multiple of 4. Volumes never shrink. An operator must qualify a class before offering it.",
  );
export const StorageGiB = z
  .number()
  .int()
  .min(1)
  .max(65_536)
  .describe(
    "Legacy whole-GiB nominal volume size; exactly converted to MiB. Supply either storage_gib or storage_mib, never both.",
  );

type StorageInput = {
  storage_mib?: number | null;
  storage_gib?: number | null;
};
/** Keep absence and inherited null distinct; never round or accept ambiguous units. */
export function normalizeStorage(
  value: StorageInput,
): number | null | undefined {
  if (value.storage_mib !== undefined && value.storage_gib !== undefined)
    throw new TypeError("ambiguous_storage_units");
  if (value.storage_mib !== undefined)
    return value.storage_mib === null
      ? null
      : StorageMiB.parse(value.storage_mib);
  if (value.storage_gib !== undefined)
    return value.storage_gib === null
      ? null
      : StorageGiB.parse(value.storage_gib) * 1024;
  return undefined;
}
/** Existing resources retain their old response shape; fractional GiB is never rounded. */
export function serializeStorage(
  storageMib: number,
): { storage_gib: number } | { storage_mib: number } {
  StorageMiB.parse(storageMib);
  return storageMib % 1024 === 0
    ? { storage_gib: storageMib / 1024 }
    : { storage_mib: storageMib };
}
export function serializeStorageOverride(
  storageMib: number | null,
): { storage_gib: number | null } | { storage_mib: number } {
  return storageMib === null
    ? { storage_gib: null }
    : serializeStorage(storageMib);
}

const Effective = { memory_mib: Memory, cpu_millicores: Cpu };
export const DatabaseEffectiveResources = z
  .union([
    z.strictObject({ ...Effective, storage_gib: StorageGiB }),
    z.strictObject({ ...Effective, storage_mib: StorageMiB }),
  ])
  .meta({ id: "DatabaseEffectiveResources" });
export type DatabaseEffectiveResources = z.infer<
  typeof DatabaseEffectiveResources
>;

const Overrides = {
  memory_mib: Memory.nullable(),
  cpu_millicores: Cpu.nullable(),
};
/** Every field is set; null returns that resource to the class. */
export const DatabaseResources = z
  .union([
    z.strictObject({ ...Overrides, storage_gib: StorageGiB.nullable() }),
    z.strictObject({ ...Overrides, storage_mib: StorageMiB.nullable() }),
  ])
  .meta({ id: "DatabaseResources" });
export type DatabaseResources = z.infer<typeof DatabaseResources>;

const Create = {
  memory_mib: Memory.optional(),
  cpu_millicores: Cpu.optional(),
};
/** Omitted resources inherit the class; both storage fields are refused by the strict union. */
export const DatabaseResourcesCreate = z
  .union([
    z.strictObject({ ...Create, storage_gib: StorageGiB.optional() }),
    z.strictObject({ ...Create, storage_mib: StorageMiB }),
  ])
  .meta({ id: "DatabaseResourcesCreate" });
export type DatabaseResourcesCreate = z.infer<typeof DatabaseResourcesCreate>;
