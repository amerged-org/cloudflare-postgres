// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/** ISO-8601 UTC timestamp exactly as Date#toISOString renders it. */
export const Timestamp = z.iso
  .datetime({ precision: 3 })
  .meta({ id: "Timestamp" });
export type Timestamp = z.infer<typeof Timestamp>;

/**
 * The instant, in milliseconds since the epoch, from which PostgreSQL refuses the credential of a
 * role whose `valid_until` is given. The region hands the expiry to PostgreSQL as a Kubernetes
 * time, which holds whole seconds, and cuts the fraction: a role is refused from the start of the
 * second its expiry falls in. Everything that decides whether a role may log in uses this instant.
 */
export function roleExpiryInstant(validUntil: string): number {
  return Math.floor(Date.parse(validUntil) / 1000) * 1000;
}
