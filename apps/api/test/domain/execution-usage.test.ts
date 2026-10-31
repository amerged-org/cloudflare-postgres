// SPDX-License-Identifier: Apache-2.0
// What a database's webhooks and schedules did, counted by its TriggerActor and read back through
// GET /v1/execution-usage. The actor, D1 and the alarm are real; the receiver and the Edge are
// replaced by a spy on fetch and a Fetcher.
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  ExecutionUsageResponse,
  type ExecutionMetrics,
} from "@pgcf/contracts/execution-usage";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runWebhookEvents } from "../../src/domain/webhook-events.ts";
import { cleanupFixtures, fixture, request, served } from "./fixtures.ts";

const HOUR = 3_600_000;
type Fixture = Awaited<ReturnType<typeof fixture>>;
const actor = (id: string) =>
  env.TRIGGER_ACTOR.get(env.TRIGGER_ACTOR.idFromName(id));
const hourStart = (ms: number) => Math.floor(ms / HOUR) * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response(null, { status: 204 }),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.prepare(
    "UPDATE webhook_cursors SET cursor=(SELECT CAST(COALESCE(MAX(id),0) AS TEXT) FROM lifecycle_events) WHERE name='lifecycle'",
  ).run();
  await cleanupFixtures();
});

/** Moves everything the actor has counted so far into the hour `hours` ago, and lets it flush. */
async function ageAndFlush(id: string, hours: number) {
  await runInDurableObject(actor(id), (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE counters SET hour_ms = hour_ms - ?",
      hours * HOUR,
    );
  });
  await runDurableObjectAlarm(actor(id));
}
const usage = async (
  f: Fixture,
  scope: string,
  from: number,
  to: number,
  granularity = "hour",
  key = f.integrator,
) => {
  const response = await request(
    `/v1/execution-usage?${scope}&from=${encodeURIComponent(iso(from))}&to=${encodeURIComponent(iso(to))}&granularity=${granularity}`,
    key,
  );
  return {
    status: response.status,
    body:
      response.status === 200
        ? ExecutionUsageResponse.parse(await response.json())
        : null,
  };
};
const withBase = (partial: Partial<ExecutionMetrics>) => ({
  schedule_runs_succeeded: 0,
  schedule_runs_failed: 0,
  schedule_runs_timed_out: 0,
  schedule_runs_outcome_unknown: 0,
  schedule_runs_rejected: 0,
  schedule_runs_skipped: 0,
  events_emitted: 0,
  event_bytes: 0,
  webhook_attempts: 0,
  webhook_deliveries_delivered: 0,
  webhook_deliveries_dead_lettered: 0,
  ...partial,
});

it("counts an event, its attempts and its delivery, and reports the closed hour", async () => {
  const f = await fixture();
  const { id } = await served(f);
  await request("/v1/webhooks", f.integrator, "POST", {
    url: "https://hooks.example.com/x",
    event_types: ["database.slept"],
  });
  await env.DB.prepare(
    "INSERT INTO lifecycle_events(database_id,kind,node_id,size_class_id,generation,occurred_at) SELECT id,'hibernated',node_id,size_class_id,generation,? FROM databases WHERE id=?",
  )
    .bind(iso(Date.now()), id)
    .run();
  await runWebhookEvents(env);
  await runDurableObjectAlarm(actor(id));
  await ageAndFlush(id, 4);

  const hour = hourStart(Date.now()) - 4 * HOUR;
  const byDatabase = await usage(
    f,
    `database_id=${id}`,
    hour - HOUR,
    hour + 2 * HOUR,
  );
  expect(byDatabase.status).toBe(200);
  const [row] = byDatabase.body!.data;
  expect(row).toMatchObject({
    database_id: id,
    project_id: f.project,
    start: iso(hour),
    end: iso(hour + HOUR),
    final: true,
  });
  expect(row!.metrics).toEqual(
    withBase({
      events_emitted: 1,
      event_bytes: row!.metrics.event_bytes,
      webhook_attempts: 1,
      webhook_deliveries_delivered: 1,
    }),
  );
  expect(row!.metrics.event_bytes).toBeGreaterThan(20);
  expect(byDatabase.body!.next_cursor).toBeNull();

  const byProject = await usage(
    f,
    `project_id=${f.project}`,
    hour,
    hour + HOUR,
  );
  expect(byProject.body!.data).toHaveLength(1);
  const daily = await usage(
    f,
    `project_id=${f.project}`,
    Math.floor(hour / (24 * HOUR)) * 24 * HOUR,
    Math.floor(hour / (24 * HOUR)) * 24 * HOUR + 24 * HOUR,
    "day",
  );
  expect(daily.body!.data[0]!.metrics.events_emitted).toBe(1);
  expect(
    (await usage(f, `database_id=${id}`, hour + HOUR, hour + 3 * HOUR)).body!
      .data,
  ).toEqual([]);
});

it("does not call an hour final before two hours have passed and writes an hour once", async () => {
  const f = await fixture();
  const { id } = await served(f);
  await request("/v1/webhooks", f.integrator, "POST", {
    url: "https://hooks.example.com/x",
    event_types: ["database.woke"],
  });
  await env.DB.prepare(
    "INSERT INTO lifecycle_events(database_id,kind,node_id,size_class_id,generation,occurred_at) SELECT id,'woke',node_id,size_class_id,generation,? FROM databases WHERE id=?",
  )
    .bind(iso(Date.now()), id)
    .run();
  await runWebhookEvents(env);
  await ageAndFlush(id, 1);
  const hour = hourStart(Date.now()) - HOUR;
  const row = (await usage(f, `database_id=${id}`, hour, hour + HOUR)).body!
    .data[0]!;
  expect(row.final).toBe(false);
  const written = await env.DB.prepare(
    "SELECT count(*) AS n FROM execution_usage WHERE database_id=?",
  )
    .bind(id)
    .first<{ n: number }>();
  await runDurableObjectAlarm(actor(id));
  const again = await env.DB.prepare(
    "SELECT count(*) AS n FROM execution_usage WHERE database_id=?",
  )
    .bind(id)
    .first<{ n: number }>();
  expect(again!.n).toBe(written!.n);
  expect(row.metrics.events_emitted).toBe(1);
});

it("keeps its counts when D1 refuses them and writes them later", async () => {
  const f = await fixture();
  const { id } = await served(f);
  await request("/v1/webhooks", f.integrator, "POST", {
    url: "https://hooks.example.com/x",
    event_types: ["*"],
  });
  await env.DB.prepare(
    "INSERT INTO lifecycle_events(database_id,kind,node_id,size_class_id,generation,occurred_at) SELECT id,'ready',node_id,size_class_id,generation,? FROM databases WHERE id=?",
  )
    .bind(iso(Date.now()), id)
    .run();
  await runWebhookEvents(env);
  await runInDurableObject(actor(id), (instance, state) => {
    state.storage.sql.exec(
      "UPDATE counters SET hour_ms = hour_ms - ?",
      4 * HOUR,
    );
    Reflect.set(instance, "env", {
      ...env,
      DB: {
        prepare: env.DB.prepare.bind(env.DB),
        batch: async () => {
          throw new Error("D1 down");
        },
      },
    });
  });
  await runDurableObjectAlarm(actor(id));
  const kept = await runInDurableObject(
    actor(id),
    (_instance, state) =>
      state.storage.sql
        .exec<{ n: number }>("SELECT count(*) AS n FROM counters")
        .one().n,
  );
  expect(kept).toBeGreaterThan(0);
  expect(
    (await env.DB.prepare(
      "SELECT count(*) AS n FROM execution_usage WHERE database_id=?",
    )
      .bind(id)
      .first<{ n: number }>())!.n,
  ).toBe(0);

  await runInDurableObject(actor(id), (instance) => {
    Reflect.set(instance, "env", env);
    Reflect.set(instance, "flushRetryAt", 0);
  });
  await runDurableObjectAlarm(actor(id));
  expect(
    (await env.DB.prepare(
      "SELECT count(*) AS n FROM execution_usage WHERE database_id=?",
    )
      .bind(id)
      .first<{ n: number }>())!.n,
  ).toBeGreaterThan(0);
});

it("counts the runs of a schedule by outcome", async () => {
  const f = await fixture();
  const { id } = await served(f);
  await runInDurableObject(actor(id), (instance) => {
    Reflect.set(instance, "env", {
      ...env,
      DB_ENDPOINT_HOST: "db.example.com",
      EDGE: {
        fetch: async () => new Response(null, { status: 200 }),
      } as unknown as Fetcher,
    });
  });
  expect(
    (
      await request(`/v1/databases/${id}/schedules/job`, f.integrator, "PUT", {
        every_seconds: 3600,
        statements: ["select 1"],
        role: "app",
      })
    ).status,
  ).toBe(201);
  for (let i = 0; i < 2; i += 1) {
    expect(
      (
        await request(
          `/v1/databases/${id}/schedules/job/run`,
          f.integrator,
          "POST",
        )
      ).status,
    ).toBe(202);
    await runDurableObjectAlarm(actor(id));
    await vi.waitFor(async () => {
      const runs = await runInDurableObject(actor(id), (instance) =>
        instance.listRuns("job", 10),
      );
      expect(runs.length).toBe(i + 1);
    });
  }
  await env.DB.prepare(
    "UPDATE databases SET desired_state='suspended' WHERE id=?",
  )
    .bind(id)
    .run();
  expect(
    (
      await request(
        `/v1/databases/${id}/schedules/job/run`,
        f.integrator,
        "POST",
      )
    ).status,
  ).toBe(202);
  await runDurableObjectAlarm(actor(id));
  await vi.waitFor(async () => {
    expect(
      (
        await runInDurableObject(actor(id), (instance) =>
          instance.listRuns("job", 10),
        )
      ).length,
    ).toBe(3);
  });
  await ageAndFlush(id, 4);
  const hour = hourStart(Date.now()) - 4 * HOUR;
  const row = (await usage(f, `database_id=${id}`, hour, hour + HOUR)).body!
    .data[0]!;
  expect(row.metrics).toMatchObject(
    withBase({ schedule_runs_succeeded: 2, schedule_runs_skipped: 1 }),
  );
});

it("keeps usage inside its project and checks the query", async () => {
  const f = await fixture();
  const { id } = await served(f);
  const hour = hourStart(Date.now()) - 3 * HOUR;
  expect(
    (await usage(f, `database_id=${id}`, hour, hour + HOUR, "hour", f.otherKey))
      .status,
  ).toBe(404);
  expect(
    (await usage(f, `project_id=${f.other}`, hour, hour + HOUR)).status,
  ).toBe(404);
  expect(
    (
      await usage(
        f,
        `project_id=${f.project}&database_id=${id}`,
        hour,
        hour + HOUR,
      )
    ).status,
  ).toBe(400);
  expect(
    (await usage(f, `project_id=${f.project}`, hour + 1_000, hour + HOUR))
      .status,
  ).toBe(400);
  expect(
    (await usage(f, `project_id=${f.project}`, hour, hour + 32 * 24 * HOUR))
      .status,
  ).toBe(400);
});
