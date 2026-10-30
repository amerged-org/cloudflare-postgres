// SPDX-License-Identifier: Apache-2.0
import {
  SCHEDULE_DEFAULT_TIMEOUT_MS,
  SCHEDULE_MAX_PER_DATABASE,
  type Schedule,
  type ScheduleRun,
  type ScheduleRunAccepted,
  type ScheduleUpsert,
} from "@pgcf/contracts/schedules";
import { ApiError } from "../api-error.ts";
import type { ApiContext } from "../env.ts";
import type {
  ScheduleInput,
  StoredRun,
  StoredSchedule,
} from "../trigger-actor.ts";
import { parseCron } from "./cron-expression.ts";
import { databaseForRequest } from "./rows.ts";

const iso = (ms: number | null): string | null =>
  ms === null ? null : new Date(ms).toISOString();

function scheduleView(row: StoredSchedule): Schedule {
  return {
    name: row.name,
    cron: row.cron,
    every_seconds: row.every_seconds,
    statements: JSON.parse(row.statements) as string[],
    role: row.role,
    timeout_ms: row.timeout_ms,
    enabled: row.enabled === 1,
    next_run_at: row.enabled === 1 ? iso(row.occurrence_ms) : null,
    created_at: new Date(row.created_ms).toISOString(),
  };
}

function runView(row: StoredRun): ScheduleRun {
  return {
    id: row.id,
    schedule: row.schedule,
    scheduled_at: new Date(row.scheduled_ms).toISOString(),
    started_at: iso(row.started_ms),
    finished_at: new Date(row.finished_ms).toISOString(),
    outcome: row.outcome as ScheduleRun["outcome"],
    sqlstate: row.sqlstate,
    attempts: row.attempts,
    manual: row.manual === 1,
  };
}

const actor = (c: ApiContext, databaseId: string) =>
  c.env.TRIGGER_ACTOR.get(c.env.TRIGGER_ACTOR.idFromName(databaseId));

/** A schedule runs as a role of the database, so the role has to exist now. */
async function assertLiveRole(
  c: ApiContext,
  databaseId: string,
  role: string,
): Promise<void> {
  const found = await c.env.DB.prepare(
    "SELECT 1 FROM roles WHERE database_id = ? AND name = ? AND deleted_at IS NULL",
  )
    .bind(databaseId, role)
    .first();
  if (!found) throw new ApiError("invalid_request", "The role does not exist");
}

export async function putSchedule(
  c: ApiContext,
  databaseId: string,
  name: string,
  body: ScheduleUpsert,
): Promise<Response> {
  const database = await databaseForRequest(c, databaseId);
  if (database.deleted_at !== null)
    throw new ApiError("conflict", "The database is deleted");
  if (body.cron !== undefined) {
    const parsed = parseCron(body.cron);
    if (!parsed.ok)
      throw new ApiError("invalid_request", `Invalid cron: ${parsed.reason}`);
  }
  await assertLiveRole(c, databaseId, body.role);
  const input: ScheduleInput = {
    cron: body.cron ?? null,
    every_seconds: body.every_seconds ?? null,
    statements: body.statements,
    role: body.role,
    timeout_ms: body.timeout_ms ?? SCHEDULE_DEFAULT_TIMEOUT_MS,
    enabled: body.enabled ?? true,
  };
  const result = await actor(c, databaseId).putSchedule(
    databaseId,
    database.project_id,
    name,
    input,
    SCHEDULE_MAX_PER_DATABASE,
  );
  if (result === "limit")
    throw new ApiError(
      "conflict",
      `A database holds at most ${SCHEDULE_MAX_PER_DATABASE} schedules`,
    );
  const stored = await actor(c, databaseId).getSchedule(name);
  return c.json(scheduleView(stored!), result === "created" ? 201 : 200);
}

export async function getSchedule(
  c: ApiContext,
  databaseId: string,
  name: string,
): Promise<Response> {
  await databaseForRequest(c, databaseId, true);
  const stored = await actor(c, databaseId).getSchedule(name);
  if (!stored) throw new ApiError("not_found", "Schedule not found");
  return c.json(scheduleView(stored), 200);
}

export async function listSchedules(
  c: ApiContext,
  databaseId: string,
): Promise<Response> {
  await databaseForRequest(c, databaseId, true);
  const rows = await actor(c, databaseId).listSchedules();
  return c.json({ data: rows.map(scheduleView), next_cursor: null }, 200);
}

export async function deleteSchedule(
  c: ApiContext,
  databaseId: string,
  name: string,
): Promise<Response> {
  await databaseForRequest(c, databaseId, true);
  if (!(await actor(c, databaseId).deleteSchedule(name)))
    throw new ApiError("not_found", "Schedule not found");
  return c.body(null, 204);
}

export async function listScheduleRuns(
  c: ApiContext,
  databaseId: string,
  name: string,
  limit: number,
): Promise<Response> {
  await databaseForRequest(c, databaseId, true);
  const target = actor(c, databaseId);
  if (!(await target.getSchedule(name)))
    throw new ApiError("not_found", "Schedule not found");
  const rows = await target.listRuns(name, limit);
  return c.json({ data: rows.map(runView), next_cursor: null }, 200);
}

/** One run now, besides the regular ones; the run itself is recorded when it ends. */
export async function runScheduleNow(
  c: ApiContext,
  databaseId: string,
  name: string,
): Promise<Response> {
  const database = await databaseForRequest(c, databaseId);
  if (database.deleted_at !== null)
    throw new ApiError("conflict", "The database is deleted");
  const outcome = await actor(c, databaseId).runNow(name);
  if (outcome === "not_found")
    throw new ApiError("not_found", "Schedule not found");
  if (outcome === "busy")
    throw new ApiError(
      "conflict",
      "A run of the schedule is already queued or going",
    );
  return c.json(
    { schedule: name, state: "queued" } satisfies ScheduleRunAccepted,
    202,
  );
}
