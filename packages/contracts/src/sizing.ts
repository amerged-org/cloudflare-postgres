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
  "memory_mib" | "cpu_millicores" | "cpu_request_millicores" | "storage_gib"
>;

/** Scheduling CPU for PostgreSQL; legacy classes request their full hard limit. */
export function postgresCpuRequestMillicores(
  size: Pick<SizeResources, "cpu_millicores" | "cpu_request_millicores">,
): number {
  return size.cpu_request_millicores ?? size.cpu_millicores;
}

/** Memory a placed database reserves on its node: PostgreSQL plus the sidecar request. */
export function databaseMemoryReservationMib(
  size: Pick<SizeResources, "memory_mib">,
): number {
  return size.memory_mib + SIDECAR.requestMemoryMib;
}

export function databaseCpuReservationMillicores(
  size: Pick<SizeResources, "cpu_millicores" | "cpu_request_millicores">,
): number {
  return postgresCpuRequestMillicores(size) + SIDECAR.requestCpuMillicores;
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

/** Quotas allow independent PostgreSQL scheduling requests and hard limits. */
export function resourceQuotaFor(
  size: SizeResources,
  overhead: { cpu_millicores: number; memory_mib: number } = {
    cpu_millicores: 0,
    memory_mib: 0,
  },
): ResourceQuotaMath {
  if (
    ![overhead.cpu_millicores, overhead.memory_mib].every(
      (v) => Number.isSafeInteger(v) && v >= 0,
    )
  )
    throw new TypeError("invalid assigned runtime overhead");
  return {
    requestsCpuMillicores:
      QUOTA_SLOTS *
      (databaseCpuReservationMillicores(size) + overhead.cpu_millicores),
    limitsCpuMillicores:
      QUOTA_SLOTS *
      (size.cpu_millicores +
        SIDECAR.limitCpuMillicores +
        overhead.cpu_millicores),
    requestsMemoryMib:
      QUOTA_SLOTS *
      (size.memory_mib + SIDECAR.requestMemoryMib + overhead.memory_mib),
    limitsMemoryMib:
      QUOTA_SLOTS *
      (size.memory_mib + SIDECAR.limitMemoryMib + overhead.memory_mib),
    // One local LVM volume per database; volumes are hard-sized.
    requestsStorageGib: size.storage_gib,
    persistentVolumeClaims: 1,
    pods: QUOTA_SLOTS,
  };
}

export const mib = (value: number): string => `${value}Mi`;
export const gib = (value: number): string => `${value}Gi`;
export const millicores = (value: number): string => `${value}m`;

/** Size-class tuning; explicit startup memory bounds shared buffers. */
export function postgresParameters(
  size: Pick<
    DesiredSize,
    | "memory_mib"
    | "memory_request_mib"
    | "max_connections"
    | "archive_timeout_seconds"
  >,
): Record<string, string> {
  return {
    shared_buffers: `${Math.max(
      1,
      Math.floor((size.memory_request_mib ?? size.memory_mib) / 4),
    )}MB`,
    effective_cache_size: `${Math.floor(size.memory_mib / 2)}MB`,
    max_connections: String(size.max_connections),
    archive_timeout: `${size.archive_timeout_seconds}s`,
  };
}
