// SPDX-License-Identifier: Apache-2.0
// The parked sleep tier: an idle sleep that keeps the database's own instance Pod with PostgreSQL
// stopped. The controller reports the Pod on its hibernated observation (`power.parked`); the API
// stores that report as `databases.parked_json` and uses it for CPU accounting and for how the host
// guard sees the Pod. Nothing here changes a public state: the database stays hibernated.
import { z } from "zod";

/** A report older than this is no longer the controller's word (the host guard's own bound). */
export const PARKED_FRESH_MS = 180_000;

const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** The stored shape. Anything else, including a newer `v`, is read as no hint at all. */
export const ParkedRecord = z.strictObject({
  v: z.literal(1),
  pod_uid: z.uuid(),
  /** Database generation of the controller's latest report. */
  generation: z.number().int().positive(),
  /** The Pod's effective scheduling request after its in-place resize, overhead included. */
  cpu_millicores: Count,
  memory_mib: Count,
  /** First report of this Pod as parked; a repeated report keeps it. */
  parked_at: z.iso.datetime(),
  /** API receive time of the latest report. */
  observed_at: z.iso.datetime(),
});
export type ParkedRecord = z.infer<typeof ParkedRecord>;

export function readParkedRecord(
  raw: string | null | undefined,
): ParkedRecord | undefined {
  if (raw === null || raw === undefined) return undefined;
  try {
    const parsed = ParkedRecord.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Fresh enough to vouch for the Pod now: reported within the bound and not from the future. */
export function parkedRecordFresh(record: ParkedRecord, now: number): boolean {
  const observed = Date.parse(record.observed_at);
  return observed <= now + 5000 && now - observed <= PARKED_FRESH_MS;
}

/** The record an accepted parked report writes; the first report of a Pod fixes `parked_at`. */
export function nextParkedRecord(input: {
  pod_uid: string;
  cpu_millicores: number;
  memory_mib: number;
  generation: number;
  previous: ParkedRecord | undefined;
  now: string;
}): ParkedRecord {
  return {
    v: 1,
    pod_uid: input.pod_uid,
    generation: input.generation,
    cpu_millicores: input.cpu_millicores,
    memory_mib: input.memory_mib,
    parked_at:
      input.previous?.pod_uid === input.pod_uid
        ? input.previous.parked_at
        : input.now,
    observed_at: input.now,
  };
}
