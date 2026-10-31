// SPDX-License-Identifier: Apache-2.0
// Schedules in the Workers runtime: the routes, the TriggerActor that holds them and fires them
// from its alarm, and the rules of a run. D1 and the Durable Objects are real; the Edge, which would
// wake a database and run the statements, is a Fetcher that answers as the Edge does.
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { Schedule, ScheduleRun } from "@pgcf/contracts/schedules";
import { afterEach, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.ts";
import {
  cleanupFixtures,
  fixture,
  refusal,
  request,
  served,
} from "./fixtures.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const sqlError = (code: string, status = 400) =>
  new Response(JSON.stringify({ message: "x", code, severity: "ERROR" }), {
    status,
  });
let edge: ReturnType<
  typeof vi.fn<(input: string, init: RequestInit) => Promise<Response>>
>;

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
});

const actor = (databaseId: string) =>
  env.TRIGGER_ACTOR.get(env.TRIGGER_ACTOR.idFromName(databaseId));
/** The actor sees an Edge that answers with `answer`, and a database host. */
async function withEdge(
  databaseId: string,
  answer: () => Response | Promise<Response>,
) {
  edge = vi.fn(async () => answer());
  await runInDurableObject(actor(databaseId), (instance) => {
    Reflect.set(instance, "env", {
      ...env,
      DB_ENDPOINT_HOST: "db.example.com",
      EDGE: { fetch: edge } as unknown as Fetcher,
    } satisfies Env);
  });
}
const put = (
  f: Fixture,
  id: string,
  name: string,
  body: Record<string, unknown>,
  key = f.integrator,
) =>
  request(`/v1/databases/${id}/schedules/${name}`, key, "PUT", {
    every_seconds: 3600,
    statements: ["select 1"],
    role: "app",
    ...body,
  });
const runs = async (f: Fixture, id: string, name: string) =>
  (
    (await (
      await request(`/v1/databases/${id}/schedules/${name}/runs`, f.integrator)
    ).json()) as {
      data: unknown[];
    }
  ).data.map((row) => ScheduleRun.parse(row));
/** Runs the schedule once by hand and waits until the run is recorded. */
async function runByHand(f: Fixture, id: string, name: string) {
  const before = (await runs(f, id, name)).length;
  expect(
    (
      await request(
        `/v1/databases/${id}/schedules/${name}/run`,
        f.integrator,
        "POST",
      )
    ).status,
  ).toBe(202);
  await runDurableObjectAlarm(actor(id));
  await vi.waitFor(async () =>
    expect((await runs(f, id, name)).length).toBe(before + 1),
  );
  return (await runs(f, id, name))[0]!;
}
const stored = (id: string, name: string) =>
  runInDurableObject(actor(id), (instance) => instance.getSchedule(name));
const sql = <T>(
  id: string,
  fn: (exec: (q: string, ...b: unknown[]) => T[]) => void,
) =>
  runInDurableObject(actor(id), (_instance, state) =>
    fn(
      (q, ...b) =>
        state.storage.sql.exec(q, ...(b as never[])).toArray() as T[],
    ),
  );

it("creates, replaces, reads and deletes a schedule and keeps it inside its project", async () => {
  const f = await fixture();
  const { id } = await served(f);
  const created = await put(f, id, "nightly", {
    cron: "30 3 * * *",
    every_seconds: undefined,
  });
  expect(created.status).toBe(201);
  const schedule = Schedule.parse(await created.json());
  expect(schedule).toMatchObject({
    name: "nightly",
    cron: "30 3 * * *",
    every_seconds: null,
    role: "app",
    timeout_ms: 60_000,
    enabled: true,
  });
  const next = new Date(schedule.next_run_at!);
  expect(next.getTime()).toBeGreaterThan(Date.now());
  expect([next.getUTCHours(), next.getUTCMinutes()]).toEqual([3, 30]);

  expect(
    (
      await put(f, id, "nightly", {
        cron: "0 4 * * *",
        every_seconds: undefined,
      })
    ).status,
  ).toBe(200);
  const read = Schedule.parse(
    await (
      await request(`/v1/databases/${id}/schedules/nightly`, f.integrator)
    ).json(),
  );
  expect(read.cron).toBe("0 4 * * *");
  const listed = (await (
    await request(`/v1/databases/${id}/schedules`, f.integrator)
  ).json()) as { data: unknown[] };
  expect(listed.data).toHaveLength(1);

  expect(
    (await request(`/v1/databases/${id}/schedules/nightly`, f.otherKey)).status,
  ).toBe(404);
  expect((await put(f, id, "nightly", {}, f.otherKey)).status).toBe(404);
  expect(
    (
      await request(
        `/v1/databases/${id}/schedules/nightly`,
        f.integrator,
        "DELETE",
      )
    ).status,
  ).toBe(204);
  expect(
    (await request(`/v1/databases/${id}/schedules/nightly`, f.integrator))
      .status,
  ).toBe(404);
});

it("refuses a schedule that cannot run", async () => {
  const f = await fixture();
  const { id } = await served(f);
  for (const body of [
    { cron: "* * * * *" },
    { every_seconds: undefined },
    { every_seconds: 30 },
    { every_seconds: undefined, cron: "61 * * * *" },
    { every_seconds: undefined, cron: "@daily" },
    { role: "nobody" },
    { statements: [] },
    { statements: ["select 1", " "] },
    { timeout_ms: 500 },
  ])
    expect((await put(f, id, "bad", body)).status, JSON.stringify(body)).toBe(
      400,
    );
  expect((await put(f, id, "Bad-Name", {})).status).toBe(400);
});

it("holds at most twenty schedules per database", async () => {
  const f = await fixture();
  const { id } = await served(f);
  for (let i = 0; i < 20; i += 1)
    expect((await put(f, id, `job${i}`, {})).status).toBe(201);
  expect(await refusal(await put(f, id, "job20", {}))).toMatchObject({
    status: 409,
    code: "conflict",
  });
  expect((await put(f, id, "job3", { every_seconds: 7200 })).status).toBe(200);
});

it("runs the statements as the role through the Edge, in one transaction with a timeout", async () => {
  const f = await fixture();
  const { id } = await served(f);
  await withEdge(id, () => new Response('{"rows":[]}', { status: 200 }));
  await put(f, id, "report", {
    statements: ["insert into t values (1)", "select 2"],
    timeout_ms: 30_000,
  });
  const run = await runByHand(f, id, "report");
  expect(run).toMatchObject({
    outcome: "succeeded",
    sqlstate: null,
    manual: true,
    attempts: 1,
  });

  expect(edge).toHaveBeenCalledOnce();
  const [url, init] = edge.mock.calls[0]!;
  expect(url).toBe("https://db.example.com/sql");
  const headers = new Headers(init.headers);
  expect(headers.get("Neon-Connection-String")).toMatch(
    new RegExp(`^postgres://app:[^@]+@db\\.example\\.com/${id}$`),
  );
  expect(headers.get("Neon-Raw-Text-Output")).toBe("true");
  expect(
    JSON.parse(init.body as string).queries.map(
      (q: { query: string }) => q.query,
    ),
  ).toEqual([
    "SET LOCAL statement_timeout = 30000",
    "insert into t values (1)",
    "select 2",
  ]);
});

it("records each kind of answer and sends nothing twice", async () => {
  const f = await fixture();
  const { id } = await served(f);
  await put(f, id, "job", {});
  const cases: [() => Response | Promise<Response>, string, string | null][] = [
    [() => sqlError("42P01"), "failed", "42P01"],
    [() => sqlError("57014"), "timed_out", "57014"],
    [() => sqlError("08007"), "outcome_unknown", "08007"],
    [() => sqlError("28P01"), "rejected", "28P01"],
    [() => new Response("gateway", { status: 502 }), "outcome_unknown", null],
    [
      () => {
        throw new Error("network");
      },
      "outcome_unknown",
      null,
    ],
  ];
  for (const [answer, outcome, sqlstate] of cases) {
    await withEdge(id, answer);
    const run = await runByHand(f, id, "job");
    expect(run, outcome).toMatchObject({ outcome, sqlstate });
    expect(edge).toHaveBeenCalledOnce();
  }
});

it("does not wake a suspended database", async () => {
  const f = await fixture();
  const { id } = await served(f);
  await withEdge(id, () => new Response(null, { status: 200 }));
  await put(f, id, "job", {});
  await env.DB.prepare(
    "UPDATE databases SET desired_state='suspended' WHERE id=?",
  )
    .bind(id)
    .run();
  expect(await runByHand(f, id, "job")).toMatchObject({
    outcome: "skipped_suspended",
  });
  expect(edge).not.toHaveBeenCalled();
});

it("tries a refused occurrence again within its allowance and then gives it up", async () => {
  const f = await fixture();
  const { id } = await served(f);
  await withEdge(id, () => sqlError("57P03"));
  await put(f, id, "job", { every_seconds: 3600 });
  const due = Date.now() - 1_000;
  await sql(id, (exec) => {
    exec(
      "UPDATE schedules SET occurrence_ms=?1, fire_ms=?1, deadline_ms=?2",
      due,
      due + 600_000,
    );
  });
  await runDurableObjectAlarm(actor(id));
  await vi.waitFor(async () =>
    expect((await stored(id, "job"))!.inflight_ms).toBeNull(),
  );
  expect(edge).toHaveBeenCalledOnce();
  const retrying = (await stored(id, "job"))!;
  expect(retrying.fire_ms!).toBeGreaterThan(Date.now() + 20_000);
  expect(retrying.attempts).toBe(1);
  expect(await runs(f, id, "job")).toEqual([]);

  // The allowance is used up: the occurrence is recorded as skipped and the schedule moves on.
  await sql(id, (exec) => {
    exec(
      "UPDATE schedules SET fire_ms=?1, deadline_ms=?1, attempts=4",
      Date.now() - 1,
    );
  });
  await runDurableObjectAlarm(actor(id));
  await vi.waitFor(async () =>
    expect((await runs(f, id, "job")).length).toBe(1),
  );
  expect((await runs(f, id, "job"))[0]).toMatchObject({
    outcome: "skipped_capacity",
    sqlstate: "57P03",
  });
  expect((await stored(id, "job"))!.fire_ms!).toBeGreaterThan(Date.now());
});

it("skips an occurrence that could not start in time and does not make it up", async () => {
  const f = await fixture();
  const { id } = await served(f);
  await withEdge(id, () => new Response(null, { status: 200 }));
  await put(f, id, "job", { every_seconds: 3600 });
  const old = Date.now() - 3 * 3_600_000;
  await sql(id, (exec) => {
    exec(
      "UPDATE schedules SET occurrence_ms=?1, fire_ms=?1, deadline_ms=?1",
      old,
    );
  });
  await runDurableObjectAlarm(actor(id));
  await vi.waitFor(async () =>
    expect((await runs(f, id, "job")).length).toBeGreaterThan(0),
  );
  expect((await runs(f, id, "job"))[0]).toMatchObject({
    outcome: "skipped_missed",
    manual: false,
  });
  expect(edge).not.toHaveBeenCalled();
  expect((await stored(id, "job"))!.fire_ms!).toBeGreaterThan(Date.now());
});

it("never sends again a run whose claim was lost with the object", async () => {
  const f = await fixture();
  const { id } = await served(f);
  await withEdge(id, () => new Response(null, { status: 200 }));
  await put(f, id, "job", { every_seconds: 3600 });
  await sql(id, (exec) => {
    exec(
      "UPDATE schedules SET inflight_ms=?1, occurrence_ms=?1, attempts=1",
      Date.now() - 25 * 60_000,
    );
  });
  await runDurableObjectAlarm(actor(id));
  await vi.waitFor(async () =>
    expect((await runs(f, id, "job")).length).toBe(1),
  );
  expect((await runs(f, id, "job"))[0]).toMatchObject({
    outcome: "outcome_unknown",
  });
  expect(edge).not.toHaveBeenCalled();
  const after = (await stored(id, "job"))!;
  expect(after.inflight_ms).toBeNull();
  expect(after.fire_ms!).toBeGreaterThan(Date.now());
});

it("runs one run at a time and keeps only the last fifty", async () => {
  const f = await fixture();
  const { id } = await served(f);
  await withEdge(id, () => new Response(null, { status: 200 }));
  await put(f, id, "job", {});
  const first = await request(
    `/v1/databases/${id}/schedules/job/run`,
    f.integrator,
    "POST",
  );
  expect(first.status).toBe(202);
  expect(
    await refusal(
      await request(
        `/v1/databases/${id}/schedules/job/run`,
        f.integrator,
        "POST",
      ),
    ),
  ).toMatchObject({
    status: 409,
  });
  await runDurableObjectAlarm(actor(id));
  await vi.waitFor(async () =>
    expect((await runs(f, id, "job")).length).toBe(1),
  );
  await sql(id, (exec) => {
    for (let i = 0; i < 60; i += 1)
      exec(
        "INSERT INTO runs(schedule,scheduled_ms,finished_ms,outcome,attempts,manual) VALUES('job',?,?,'succeeded',1,0)",
        i,
        i,
      );
  });
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
  await vi.waitFor(async () =>
    expect((await stored(id, "job"))!.inflight_ms).toBeNull(),
  );
  const total = await runInDurableObject(
    actor(id),
    (_instance, state) =>
      state.storage.sql
        .exec<{ n: number }>(
          "SELECT count(*) AS n FROM runs WHERE schedule='job'",
        )
        .one().n,
  );
  expect(total).toBe(50);
});

it("lets an administrator read schedules but neither create nor run them", async () => {
  const f = await fixture();
  const { id } = await served(f);
  await put(f, id, "job", {});
  expect((await put(f, id, "other", {}, f.admin)).status).toBe(403);
  expect(
    (await request(`/v1/databases/${id}/schedules/job/run`, f.admin, "POST"))
      .status,
  ).toBe(403);
  expect(
    (await request(`/v1/databases/${id}/schedules/job`, f.admin)).status,
  ).toBe(200);
  expect((await request(`/v1/databases/${id}/schedules`, f.admin)).status).toBe(
    200,
  );
});

it("refuses a manual run of a disabled schedule instead of queueing one that never starts", async () => {
  const f = await fixture();
  const { id } = await served(f);
  await put(f, id, "job", { enabled: false });
  expect(
    await refusal(
      await request(
        `/v1/databases/${id}/schedules/job/run`,
        f.integrator,
        "POST",
      ),
    ),
  ).toMatchObject({
    status: 409,
    code: "conflict",
  });
  expect((await stored(id, "job"))!.manual_pending).toBe(0);
});

it("ends a run whose credential cannot be opened as rejected, once, without spinning", async () => {
  const f = await fixture();
  const { id } = await served(f);
  await withEdge(id, () => new Response(null, { status: 200 }));
  await put(f, id, "job", {});
  await env.DB.prepare(
    "UPDATE roles SET password_ciphertext='AAAA' WHERE database_id=? AND name='app'",
  )
    .bind(id)
    .run();
  const run = await runByHand(f, id, "job");
  expect(run).toMatchObject({
    outcome: "rejected",
    sqlstate: "credential_unreadable",
    manual: true,
  });
  expect(edge).not.toHaveBeenCalled();
  const row = (await stored(id, "job"))!;
  expect(row).toMatchObject({
    manual_pending: 0,
    inflight_ms: null,
    attempts: 1,
  });
});

it("records a failure before the request was sent and leaves the regular times alone", async () => {
  const f = await fixture();
  const { id } = await served(f);
  await put(f, id, "job", { every_seconds: 3600 });
  const down = {
    prepare: () => {
      throw new Error("D1 down");
    },
    batch: async () => {
      throw new Error("D1 down");
    },
  };
  await runInDurableObject(actor(id), (instance) => {
    Reflect.set(instance, "env", {
      ...env,
      DB: down,
      DB_ENDPOINT_HOST: "db.example.com",
    });
  });
  const regular = (await stored(id, "job"))!;

  // A manual run is recorded as failed to start and does not touch the regular occurrence.
  const manual = await runByHand(f, id, "job");
  expect(manual).toMatchObject({
    outcome: "rejected",
    sqlstate: "unavailable",
    manual: true,
  });
  const after = (await stored(id, "job"))!;
  expect(after).toMatchObject({
    fire_ms: regular.fire_ms,
    occurrence_ms: regular.occurrence_ms,
    manual_pending: 0,
  });

  // A regular occurrence is tried again while it has its allowance, and given up when it has none.
  const due = Date.now() - 1_000;
  await sql(id, (exec) => {
    exec(
      "UPDATE schedules SET occurrence_ms=?1, fire_ms=?1, deadline_ms=?2",
      due,
      due + 600_000,
    );
  });
  await runDurableObjectAlarm(actor(id));
  await vi.waitFor(async () =>
    expect((await stored(id, "job"))!.inflight_ms).toBeNull(),
  );
  const retrying = (await stored(id, "job"))!;
  expect(retrying.fire_ms!).toBeGreaterThan(Date.now() + 30_000);
  expect((await runs(f, id, "job")).filter((run) => !run.manual)).toEqual([]);
  await sql(id, (exec) => {
    exec("UPDATE schedules SET fire_ms=?1, deadline_ms=?1", Date.now() - 1);
  });
  await runDurableObjectAlarm(actor(id));
  await vi.waitFor(async () =>
    expect(
      (await runs(f, id, "job")).filter((run) => !run.manual),
    ).toHaveLength(1),
  );
  expect((await runs(f, id, "job")).find((run) => !run.manual)).toMatchObject({
    outcome: "skipped_missed",
    sqlstate: "unavailable",
  });
  expect((await stored(id, "job"))!.fire_ms!).toBeGreaterThan(Date.now());
});

it("moves what is there when a run ends, not the schedule it started from", async () => {
  const f = await fixture();
  const { id } = await served(f);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await withEdge(id, async () => {
    await held;
    return new Response(null, { status: 200 });
  });
  await put(f, id, "job", { every_seconds: 3600 });
  expect(
    (
      await request(
        `/v1/databases/${id}/schedules/job/run`,
        f.integrator,
        "POST",
      )
    ).status,
  ).toBe(202);
  const alarm = runDurableObjectAlarm(actor(id));
  await vi.waitFor(async () =>
    expect((await stored(id, "job"))!.inflight_ms).not.toBeNull(),
  );

  // Replaced while the run goes: the end of the run keeps the new times.
  expect((await put(f, id, "job", { every_seconds: 7200 })).status).toBe(200);
  const replaced = (await stored(id, "job"))!;
  release();
  await alarm;
  const after = (await stored(id, "job"))!;
  expect(after).toMatchObject({
    every_seconds: 7200,
    inflight_ms: null,
    occurrence_ms: replaced.occurrence_ms,
  });

  // Deleted while a run goes: nothing of it comes back.
  let again: () => void = () => undefined;
  const heldAgain = new Promise<void>((resolve) => {
    again = resolve;
  });
  await withEdge(id, async () => {
    await heldAgain;
    return new Response(null, { status: 200 });
  });
  expect(
    (
      await request(
        `/v1/databases/${id}/schedules/job/run`,
        f.integrator,
        "POST",
      )
    ).status,
  ).toBe(202);
  const second = runDurableObjectAlarm(actor(id));
  await vi.waitFor(async () =>
    expect((await stored(id, "job"))!.inflight_ms).not.toBeNull(),
  );
  expect(
    (await request(`/v1/databases/${id}/schedules/job`, f.integrator, "DELETE"))
      .status,
  ).toBe(204);
  again();
  await second;
  expect(await stored(id, "job")).toBeNull();
  expect(
    await runInDurableObject(
      actor(id),
      (_i, state) =>
        state.storage.sql
          .exec<{ n: number }>("SELECT count(*) AS n FROM runs")
          .one().n,
    ),
  ).toBe(0);
});
