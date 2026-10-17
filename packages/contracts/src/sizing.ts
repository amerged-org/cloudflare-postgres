// SPDX-License-Identifier: Apache-2.0
import type { DesiredSize } from "./agent.ts";

/** Barman Cloud plugin sidecar resources (per database instance). */
export const SIDECAR = {
  requestCpuMillicores: 100,
  requestMemoryMib: 128,
  limitCpuMillicores: 500,
  limitMemoryMib: 512,
} as const;

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
