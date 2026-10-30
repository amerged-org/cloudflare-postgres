// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import { DatabaseId, ErrorBody, listEnvelope } from "@pgcf/contracts";
import {
  Schedule,
  ScheduleName,
  ScheduleRun,
  ScheduleRunAccepted,
  ScheduleUpsert,
} from "@pgcf/contracts/schedules";
import type { ApiApp } from "../app.ts";
import {
  deleteSchedule,
  getSchedule,
  listScheduleRuns,
  listSchedules,
  putSchedule,
  runScheduleNow,
} from "../domain/schedules.ts";
import type { ApiContext } from "../env.ts";

const json = (schema: z.ZodType) => ({ "application/json": { schema } });
const errors = (...codes: readonly (readonly [number, string])[]) =>
  Object.fromEntries(
    codes.map(([code, description]) => [
      code,
      { description, content: json(ErrorBody) },
    ]),
  );
const E400 = [400, "Invalid request"] as const;
const E401 = [401, "Invalid credentials"] as const;
const E403 = [403, "Insufficient scope"] as const;
const E404 = [404, "Resource not found"] as const;
const E409 = [409, "Conflict"] as const;
const E500 = [500, "Internal server error"] as const;
const security = [{ bearerAuth: [] }];
const tags = ["Schedules"];
const params = z.object({ id: DatabaseId, name: ScheduleName });
const RunsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

function register(
  app: ApiApp,
  route: RouteConfig,
  handler: (c: ApiContext) => Promise<Response>,
): void {
  app.openapi(createRoute(route), handler);
}

export function registerSchedules(app: ApiApp): void {
  register(
    app,
    {
      method: "put",
      path: "/v1/databases/{id}/schedules/{name}",
      security,
      tags,
      description:
        "Creates or replaces a schedule: SQL statements that run as one transaction, as `role`, at the times of a UTC five-field `cron` expression or every `every_seconds` (at least 60) from now. A run is an ordinary request to `/sql`, so it wakes a sleeping database like a connection does; a suspended or deleted database is not woken and its runs are recorded as skipped. Each run starts a little after its time (a fixed offset per database, up to a quarter of the interval and at most a minute) so that databases do not wake together. A run that the node refuses for capacity is tried again until half the interval has passed (at most ten minutes), then recorded as `skipped_capacity`. A run whose answer is lost is recorded as `outcome_unknown` and is never sent again; the next occurrence is a new run, so write idempotent statements. A run that could not start in time is `skipped_missed` and is not made up. A database holds at most 20 schedules; `timeout_ms` (default 60000, at most 900000) is the statement timeout.",
      request: {
        params,
        body: { required: true, content: json(ScheduleUpsert) },
      },
      responses: {
        200: { description: "Schedule replaced", content: json(Schedule) },
        201: { description: "Schedule created", content: json(Schedule) },
        ...errors(E400, E401, E403, E404, E409, E500),
      },
    },
    async (c) =>
      putSchedule(
        c,
        DatabaseId.parse(c.req.param("id")),
        ScheduleName.parse(c.req.param("name")),
        ScheduleUpsert.parse(await c.req.json()),
      ),
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/databases/{id}/schedules",
      security,
      tags,
      request: { params: z.object({ id: DatabaseId }) },
      responses: {
        200: {
          description: "The database's schedules",
          content: json(listEnvelope(Schedule)),
        },
        ...errors(E400, E401, E404, E500),
      },
    },
    async (c) => listSchedules(c, DatabaseId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/databases/{id}/schedules/{name}",
      security,
      tags,
      request: { params },
      responses: {
        200: { description: "The schedule", content: json(Schedule) },
        ...errors(E400, E401, E404, E500),
      },
    },
    async (c) =>
      getSchedule(
        c,
        DatabaseId.parse(c.req.param("id")),
        ScheduleName.parse(c.req.param("name")),
      ),
  );
  register(
    app,
    {
      method: "delete",
      path: "/v1/databases/{id}/schedules/{name}",
      security,
      tags,
      description:
        "Deletes the schedule and its run history. A run that is going is not stopped.",
      request: { params },
      responses: {
        204: { description: "Deleted" },
        ...errors(E400, E401, E403, E404, E409, E500),
      },
    },
    async (c) =>
      deleteSchedule(
        c,
        DatabaseId.parse(c.req.param("id")),
        ScheduleName.parse(c.req.param("name")),
      ),
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/databases/{id}/schedules/{name}/runs",
      security,
      tags,
      description:
        "The last runs of the schedule, newest first (the last 50 are kept).",
      request: { params, query: RunsQuery },
      responses: {
        200: {
          description: "Runs",
          content: json(listEnvelope(ScheduleRun)),
        },
        ...errors(E400, E401, E404, E500),
      },
    },
    async (c) =>
      listScheduleRuns(
        c,
        DatabaseId.parse(c.req.param("id")),
        ScheduleName.parse(c.req.param("name")),
        RunsQuery.parse(c.req.query()).limit,
      ),
  );
  register(
    app,
    {
      method: "post",
      path: "/v1/databases/{id}/schedules/{name}/run",
      security,
      tags,
      description:
        "Queues one run now, besides the regular ones. It starts within moments and is recorded in the runs with `manual: true`.",
      request: { params },
      responses: {
        202: { description: "Queued", content: json(ScheduleRunAccepted) },
        ...errors(E400, E401, E403, E404, E409, E500),
      },
    },
    async (c) =>
      runScheduleNow(
        c,
        DatabaseId.parse(c.req.param("id")),
        ScheduleName.parse(c.req.param("name")),
      ),
  );
}
