// SPDX-License-Identifier: Apache-2.0
import { hashApiKey, parseAgentKey, timingSafeEqual } from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { IsolateCache } from "./isolate-cache.ts";
import type { RegionRow } from "./rows.ts";

/**
 * Every agent request is authenticated against its region's row, and one node's host guard, thin
 * sampler and reclaim poll alone make several of them per second. The row is kept in the isolate's
 * memory for this long.
 *
 * Staleness bound: an agent key that is rotated or revoked in D1 stops authenticating in every
 * isolate within `AGENT_REGION_CACHE_MS` of the change, because no entry outlives it. That is half
 * of the 10 s the design allows; the other half covers a request that authenticated just before
 * its entry ended and is still running (the longest is the reclaim poll's 3.5 s hold). Nothing in
 * this Worker rotates or revokes an agent key (the runbook has no API for it in v1), so no isolate
 * has a change of its own to drop an entry for. A route that gains one drops the region's entry
 * from `regions` after its write commits, which makes the change immediate where it was made.
 *
 * What is held is the four columns this function has always returned and nothing else of the
 * region: no custody or signing material. The hash only verifies a presented key; it cannot make
 * one. A key the cached row does not know is checked against D1 before it is refused, so a
 * replacement key authenticates on its first request in any isolate.
 */
const AGENT_REGION_CACHE_MS = 5_000;
const regions = new IsolateCache<Readonly<RegionRow>>(
  AGENT_REGION_CACHE_MS,
  64,
);

export async function agentRegion(c: ApiContext): Promise<RegionRow> {
  const authorization = c.req.header("Authorization");
  const key = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  const parsed = parseAgentKey(key);
  if (!parsed) throw new ApiError("unauthorized", "Invalid agent credentials");
  const hash = await hashApiKey(c.env.API_KEY_PEPPER, key);
  let row = regions.get(parsed.regionId);
  if (!row || !timingSafeEqual(row.agent_key_hash, hash)) {
    const read = await c.env.DB.prepare(
      "SELECT id,backup_bucket,backup_endpoint_url,agent_key_hash FROM regions WHERE id=?",
    )
      .bind(parsed.regionId)
      .first<RegionRow>();
    row = read ? Object.freeze({ ...read }) : undefined;
    if (row) regions.set(parsed.regionId, row);
    else regions.delete(parsed.regionId);
  }
  if (!row || !timingSafeEqual(row.agent_key_hash, hash))
    throw new ApiError("unauthorized", "Invalid agent credentials");
  return row;
}
