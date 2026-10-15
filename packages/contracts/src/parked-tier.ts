// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** Idle sleeps keep the database's own instance Pod and stop only PostgreSQL (CNPG fencing). */
export const PARKED_TIER_LIMITS = {
  min_ttl_seconds: 60,
  /** Below the instance manager's 3,600 s startup-probe kill of a restarted fenced container. */
  max_ttl_seconds: 3300,
  max_per_node: 64,
} as const;
export const ParkedTierPolicy = z.strictObject({
  enabled: z.boolean(),
  ttl_seconds: z
    .number()
    .int()
    .min(PARKED_TIER_LIMITS.min_ttl_seconds)
    .max(PARKED_TIER_LIMITS.max_ttl_seconds),
  max_per_node: z.number().int().min(0).max(PARKED_TIER_LIMITS.max_per_node),
  /** Requests a parked instance Pod is resized to; limits never change. */
  postgres_cpu_millicores: z.number().int().min(1).max(2000),
  postgres_memory_mib: z.number().int().min(16).max(4096),
  sidecar_cpu_millicores: z.number().int().min(1).max(2000),
  sidecar_memory_mib: z.number().int().min(16).max(4096),
});
export type ParkedTierPolicy = z.infer<typeof ParkedTierPolicy>;
/** The Pod a hibernated observation still holds: its effective scheduling request after the resize. */
export const ParkedObservation = z.strictObject({
  pod_uid: z.uuid(),
  cpu_millicores: Count,
  memory_mib: Count,
});
export type ParkedObservation = z.infer<typeof ParkedObservation>;
