// SPDX-License-Identifier: Apache-2.0
import {
  AgentActivityRequest,
  AgentUsageRequest,
  GATEWAY_ACTIVITY_FRESH_MS,
  GATEWAY_ACTIVITY_FUTURE_MS,
} from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { agentRegion } from "./agent-auth.ts";
import { recordUsageSample } from "./usage.ts";

interface MeasurementTarget {
  id: string;
  generation: number;
  created_at: string;
  ready_at: string | null;
}
async function liveTargets(
  c: ApiContext,
  region: string,
  ids: string[],
): Promise<Map<string, MeasurementTarget>> {
  const unique = [...new Set(ids)];
  const rows = await c.env.DB.batch<MeasurementTarget>(
    unique.map((id) =>
      c.env.DB.prepare(
        `SELECT d.id,d.generation,d.created_at,(SELECT MAX(occurred_at) FROM lifecycle_events WHERE database_id=d.id AND kind IN('ready','woke')) ready_at
     FROM databases d JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL
     WHERE d.id=? AND d.region_id=? AND d.deleted_at IS NULL AND d.desired_state<>'deleted'`,
      ).bind(id, region),
    ),
  );
  const targets = new Map<string, MeasurementTarget>();
  for (let index = 0; index < unique.length; index++) {
    const row = rows[index]!.results[0];
    if (!row) throw new ApiError("not_found", "Measured database not found");
    targets.set(row.id, row);
  }
  return targets;
}

export async function ingestAgentActivity(c: ApiContext, raw: unknown) {
  const region = await agentRegion(c);
  const parsed = AgentActivityRequest.safeParse(raw);
  if (!parsed.success)
    throw new ApiError("invalid_request", "Invalid activity measurements");
  const body = parsed.data,
    now = Date.now();
  const targets = await liveTargets(
    c,
    region.id,
    body.databases.map((db) => db.id),
  );
  for (const activity of body.databases)
    if (targets.get(activity.id)!.generation !== activity.revision)
      throw new ApiError("conflict", "Activity configuration changed");
  // Validate every respondent before recording any measurement in this batch.
  for (const activity of body.databases)
    for (const report of activity.reports) {
      if (
        report.region !== region.id ||
        Date.parse(report.observedAt) < now - GATEWAY_ACTIVITY_FRESH_MS ||
        Date.parse(report.observedAt) > now + GATEWAY_ACTIVITY_FUTURE_MS ||
        report.countersSince === null ||
        !["complete", "current_process_absence"].includes(report.history) ||
        (report.history === "complete" && report.lastActivityAt === null) ||
        (report.history === "current_process_absence" &&
          (report.lastActivityAt !== null ||
            report.authenticatedConnections !== 0 ||
            report.busyConnections !== 0 ||
            report.ingressBytes !== 0 ||
            report.egressBytes !== 0 ||
            report.totalConnections !== 0 ||
            report.connectionMilliseconds !== 0))
      )
        throw new ApiError(
          "invalid_request",
          "Incomplete or unavailable activity measurements",
        );
    }
  let accepted = 0,
    idle_intents = 0;
  for (const activity of body.databases) {
    const target = targets.get(activity.id)!;
    const boundary = [
      activity.last_activity_at,
      target.created_at,
      target.ready_at,
    ]
      .filter((time): time is string => time !== null)
      .sort()
      .at(-1)!;
    // A database cannot be idle before its own creation/readiness, even when a gateway process is older.
    if (boundary > activity.observed_at) continue;
    const actor = c.env.DATABASE_ACTOR.get(
      c.env.DATABASE_ACTOR.idFromName(activity.id),
    );
    const recorded = await actor.recordActivity(activity.id, {
      revision: activity.revision,
      observed_at: activity.observed_at,
      last_activity_at: boundary,
      // Idle activity is authenticated work; physical quiescence retains its separate transport barrier.
      active_connections: activity.busy_connections,
    });
    if (!recorded) continue;
    accepted++;
    if ((await actor.requestIdle(activity.id, activity.revision)).ok)
      idle_intents++;
  }
  return c.json({ accepted, idle_intents }, 200);
}

export async function ingestAgentUsage(c: ApiContext, raw: unknown) {
  const region = await agentRegion(c);
  const parsed = AgentUsageRequest.safeParse(raw);
  if (!parsed.success)
    throw new ApiError("invalid_request", "Invalid usage measurements");
  await liveTargets(
    c,
    region.id,
    parsed.data.samples.map((sample) => sample.database_id),
  );
  let recorded = 0,
    duplicates = 0;
  for (const sample of parsed.data.samples) {
    const result = await recordUsageSample(
      c.env.DB,
      { region_id: region.id, source: sample.source },
      sample,
    );
    if (result === "recorded") recorded++;
    else duplicates++;
  }
  return c.json({ recorded, duplicates }, 200);
}
