// SPDX-License-Identifier: Apache-2.0
import type { DesiredSize } from "./agent.ts";

/** Barman Cloud plugin sidecar resources (per database instance). */
export const SIDECAR = {
  requestCpuMillicores: 100,
  requestMemoryMib: 128,
  limitCpuMillicores: 500,
  limitMemoryMib: 512,
} as const;

/**
 * Pod slots per database namespace: the instance plus one concurrent pod
 * (initdb or a replacement instance) must fit the quota.
 */
export const QUOTA_SLOTS = 2;

export type SizeResources = Pick<
  DesiredSize,
  "memory_mib" | "cpu_millicores" | "storage_gib"
>;

/** Memory a placed database reserves on its node: PostgreSQL plus the sidecar request. */
export function databaseMemoryReservationMib(
  size: Pick<SizeResources, "memory_mib">,
): number {
  return size.memory_mib + SIDECAR.requestMemoryMib;
}

export function databaseCpuReservationMillicores(
  size: Pick<SizeResources, "cpu_millicores">,
): number {
  return size.cpu_millicores + SIDECAR.requestCpuMillicores;
}

export interface ResourceQuotaMath {
  requestsCpuMillicores: number;
  limitsCpuMillicores: number;
  requestsMemoryMib: number;
  limitsMemoryMib: number;
  requestsStorageGib: number;
  persistentVolumeClaims: number;
  pods: number;
}

/** PostgreSQL runs with requests = limits; the sidecar request and limit differ. */
export function resourceQuotaFor(size: SizeResources): ResourceQuotaMath {
  return {
    requestsCpuMillicores:
      QUOTA_SLOTS * (size.cpu_millicores + SIDECAR.requestCpuMillicores),
    limitsCpuMillicores:
      QUOTA_SLOTS * (size.cpu_millicores + SIDECAR.limitCpuMillicores),
    requestsMemoryMib:
      QUOTA_SLOTS * (size.memory_mib + SIDECAR.requestMemoryMib),
    limitsMemoryMib: QUOTA_SLOTS * (size.memory_mib + SIDECAR.limitMemoryMib),
    // One local LVM volume per database; volumes are hard-sized.
    requestsStorageGib: size.storage_gib,
    persistentVolumeClaims: 1,
    pods: QUOTA_SLOTS,
  };
}

export const mib = (value: number): string => `${value}Mi`;
export const gib = (value: number): string => `${value}Gi`;
export const millicores = (value: number): string => `${value}m`;

/** CNPG `postgresql.parameters` derived from the size class. */
export function postgresParameters(
  size: Pick<
    DesiredSize,
    "memory_mib" | "max_connections" | "archive_timeout_seconds"
  >,
): Record<string, string> {
  return {
    shared_buffers: `${Math.floor(size.memory_mib / 4)}MB`,
    effective_cache_size: `${Math.floor(size.memory_mib / 2)}MB`,
    max_connections: String(size.max_connections),
    archive_timeout: `${size.archive_timeout_seconds}s`,
  };
}
