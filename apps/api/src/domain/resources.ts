// SPDX-License-Identifier: Apache-2.0
//
// The resources of one database (ULTRA plan 3.5): memory, CPU and storage come from its size
// class, and an admin key may give the database its own. The effective value is its own, else its
// class's (the D1 view `database_resources` says the same in SQL).
import {
  DATABASE_CPU_MIN_MILLICORES,
  DATABASE_MEMORY_DEFAULT_MAXIMUM_MIB,
  DATABASE_MEMORY_STEP_MIB,
  DATABASE_STORAGE_MIN_GIB,
  type DatabaseEffectiveResources,
  type DatabaseResources,
  type DatabaseResourcesCreate,
} from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { DatabaseRow, SizeRow } from "./rows.ts";

/** The database's own values; null takes the size class's. */
export type ResourceOverrides = DatabaseResources;
type Resources = DatabaseEffectiveResources;

export const NO_OVERRIDES: ResourceOverrides = {
  memory_mib: null,
  cpu_millicores: null,
  storage_gib: null,
};

/** The database's own values as stored. */
export function ownResources(
  row: Pick<
    DatabaseRow,
    "own_memory_mib" | "own_cpu_millicores" | "own_storage_gib"
  >,
): ResourceOverrides {
  return {
    memory_mib: row.own_memory_mib ?? null,
    cpu_millicores: row.own_cpu_millicores ?? null,
    storage_gib: row.own_storage_gib ?? null,
  };
}
export function overridesOfCreate(
  resources: DatabaseResourcesCreate | undefined,
): ResourceOverrides {
  return {
    memory_mib: resources?.memory_mib ?? null,
    cpu_millicores: resources?.cpu_millicores ?? null,
    storage_gib: resources?.storage_gib ?? null,
  };
}
export const sameOverrides = (a: ResourceOverrides, b: ResourceOverrides) =>
  a.memory_mib === b.memory_mib &&
  a.cpu_millicores === b.cpu_millicores &&
  a.storage_gib === b.storage_gib;

/** A database's own value, else its size class's. */
export function effectiveResources(
  size: Pick<SizeRow, "memory_mib" | "cpu_millicores" | "storage_gib">,
  own: ResourceOverrides,
): Resources {
  return {
    memory_mib: own.memory_mib ?? size.memory_mib,
    cpu_millicores: own.cpu_millicores ?? size.cpu_millicores,
    storage_gib: own.storage_gib ?? size.storage_gib,
  };
}
export const sameResources = (a: Resources, b: Resources) =>
  a.memory_mib === b.memory_mib &&
  a.cpu_millicores === b.cpu_millicores &&
  a.storage_gib === b.storage_gib;

/**
 * The resource snapshot a lifecycle event keeps for usage (plan 3.4: effective limits times awake
 * seconds). Its `reserved_*` figures are the limits too: nothing is added to them any more.
 */
export function usageSnapshot(resources: Resources) {
  return {
    memory_mib: resources.memory_mib,
    cpu_millicores: resources.cpu_millicores,
    reserved_memory_mib: resources.memory_mib,
    reserved_cpu_millicores: resources.cpu_millicores,
    storage_allocated_bytes: resources.storage_gib * 2 ** 30,
  };
}

/**
 * `usageSnapshot` in SQL, for the database `d` and its row `r` of the view `database_resources`:
 * the events that follow `created` keep the very figures it does.
 */
export const USAGE_SNAPSHOT_SQL = `json_object('memory_mib',r.memory_mib,'cpu_millicores',r.cpu_millicores,
  'reserved_memory_mib',r.memory_mib,'reserved_cpu_millicores',r.cpu_millicores,
  'storage_allocated_bytes',CASE WHEN d.storage_profile_json IS NULL THEN r.storage_gib*1073741824 ELSE NULL END)`;

/** The effective values of a database, as the SQL columns `effective_*` that rows.ts selects. */
export function effectiveOf(
  row: Pick<
    DatabaseRow,
    | "effective_memory_mib"
    | "effective_cpu_millicores"
    | "effective_storage_gib"
  >,
): Resources {
  if (
    row.effective_memory_mib == null ||
    row.effective_cpu_millicores == null ||
    row.effective_storage_gib == null
  )
    throw new Error("database_resources_not_selected");
  return {
    memory_mib: row.effective_memory_mib,
    cpu_millicores: row.effective_cpu_millicores,
    storage_gib: row.effective_storage_gib,
  };
}

/** What a region allows one database; its limits come from the region's policy and nodes. */
interface RegionBounds {
  maximum_memory_mib: number;
  /** The cores of the region's largest node, in millicores; null while no node has reported. */
  maximum_cpu_millicores: number | null;
}
export async function regionBounds(
  db: D1Database,
  regionId: string,
): Promise<RegionBounds> {
  const [policy, cores] = await Promise.all([
    db
      .prepare(
        "SELECT maximum_database_memory_mib FROM node_region_policies WHERE region_id=?",
      )
      .bind(regionId)
      .first<{ maximum_database_memory_mib: number | null }>(),
    db
      .prepare(
        `SELECT MAX(json_extract(n.last_sample_json,'$.cpu.cores')) cores
        FROM nodes n WHERE n.region_id=? AND n.lost_at IS NULL`,
      )
      .bind(regionId)
      .first<{ cores: number | null }>(),
  ]);
  return {
    maximum_memory_mib:
      policy?.maximum_database_memory_mib ??
      DATABASE_MEMORY_DEFAULT_MAXIMUM_MIB,
    maximum_cpu_millicores: cores?.cores == null ? null : cores.cores * 1000,
  };
}

const invalid = (message: string) => new ApiError("invalid_request", message);
/**
 * Refuses effective resources outside the region's bounds. The memory is checked in every case,
 * as the size class's memory always was; the CPU only where the database has its own, because a
 * class's CPU waits for a node with enough cores like any other create.
 */
export function assertResourcesAllowed(
  effective: Resources,
  own: ResourceOverrides,
  bounds: RegionBounds,
): void {
  if (
    effective.memory_mib < DATABASE_MEMORY_STEP_MIB ||
    effective.memory_mib % DATABASE_MEMORY_STEP_MIB !== 0
  )
    throw invalid("Memory must be a multiple of 256 MiB");
  if (effective.memory_mib > bounds.maximum_memory_mib)
    throw invalid(
      `Memory exceeds the region's per-database maximum of ${bounds.maximum_memory_mib} MiB`,
    );
  if (own.cpu_millicores !== null) {
    if (effective.cpu_millicores < DATABASE_CPU_MIN_MILLICORES)
      throw invalid(
        `CPU is at least ${DATABASE_CPU_MIN_MILLICORES} millicores`,
      );
    if (
      bounds.maximum_cpu_millicores !== null &&
      effective.cpu_millicores > bounds.maximum_cpu_millicores
    )
      throw invalid(
        `CPU exceeds the ${bounds.maximum_cpu_millicores} millicores of the region's largest node`,
      );
  }
  if (effective.storage_gib < DATABASE_STORAGE_MIN_GIB)
    throw invalid(`Storage is at least ${DATABASE_STORAGE_MIN_GIB} GiB`);
}

/** The SQL columns that `DatabaseRow.effective_*` reads, for a query over `databases` as `alias`. */
export function effectiveResourcesColumnsSql(alias: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(alias))
    throw new Error("invalid_resources_alias");
  const klass = (column: string) =>
    `(SELECT ${column} FROM size_classes WHERE id=${alias}.size_class_id)`;
  return `COALESCE(${alias}.own_memory_mib,${klass("memory_mib")}) effective_memory_mib,
    COALESCE(${alias}.own_cpu_millicores,${klass("cpu_millicores")}) effective_cpu_millicores,
    COALESCE(${alias}.own_storage_gib,${klass("storage_gib")}) effective_storage_gib`;
}
