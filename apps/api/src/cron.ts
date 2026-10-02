// SPDX-License-Identifier: Apache-2.0
import { DESIRED_PAGE_LIMIT_MAX } from "@pgcf/contracts";
import type { Env } from "./env.ts";
import { purgeIdempotency } from "./middleware/idempotency.ts";

export async function runCron(
  env: Env,
  now = Date.now(),
): Promise<{ failed: number; purged: number; hinted: number }> {
  const timestamp = new Date(now).toISOString(),
    cutoff = new Date(now - 20 * 60_000).toISOString();
  const result = await env.DB.prepare(
    `UPDATE operations SET status='failed',error_code='operation_timeout',error_message='Regional operation exceeded 20 minutes',updated_at=?,completed_at=? WHERE status IN('pending','running') AND updated_at<?`,
  )
    .bind(timestamp, timestamp, cutoff)
    .run();
  const purged = await purgeIdempotency(env.DB, now);
  const pending = await env.DB.prepare(
    `SELECT DISTINCT d.region_id,d.id FROM databases d WHERE d.generation>d.observed_generation OR EXISTS(SELECT 1 FROM operations o WHERE o.database_id=d.id AND o.status IN('pending','running')) ORDER BY d.region_id,d.id`,
  ).all<{ region_id: string; id: string }>();
  const regions = new Map<string, string[]>();
  for (const db of pending.results) {
    const ids = regions.get(db.region_id) ?? [];
    ids.push(db.id);
    regions.set(db.region_id, ids);
  }
  let hinted = 0;
  for (const [regionId, ids] of regions) {
    const stub = env.REGION_LINK.get(env.REGION_LINK.idFromName(regionId));
    hinted += await stub.notify(
      ids.length > DESIRED_PAGE_LIMIT_MAX ? undefined : ids,
    );
  }
  return { failed: result.meta.changes, purged, hinted };
}
