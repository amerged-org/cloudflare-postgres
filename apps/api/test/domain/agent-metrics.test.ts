// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanupFixtures,
  fixture,
  request,
  observation,
  observedBody,
} from "./fixtures.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
});
async function ready(matureReady = true) {
  const f = await fixture();
  const id = DatabaseWithOperation.parse(await (await f.create()).json())
    .database.id;
  const mature = new Date(Date.now() - 180_000).toISOString();
  await env.DB.prepare("UPDATE databases SET created_at=? WHERE id=?")
    .bind(mature, id)
    .run();
  await request("/agent/v1/observations", f.agent, "POST", {
    ...observedBody([observation(id, 1)]),
    observed_at: matureReady ? mature : new Date().toISOString(),
  });
  await env.DB.prepare(
    "UPDATE size_classes SET sleep_after_seconds=60 WHERE id=?",
  )
    .bind(f.size)
    .run();
  return { ...f, id };
}

function activity(
  f: Awaited<ReturnType<typeof ready>>,
  connections = 4,
  busy = 0,
  pending = 0,
) {
  const now = new Date().toISOString(),
    last = new Date(Date.now() - 120_000).toISOString(),
    started = new Date(Date.now() - 180_000).toISOString();
  const pods = [crypto.randomUUID(), crypto.randomUUID()];
  const reports = pods.map((pod) => ({
    region: f.region,
    database: f.id,
    revision: 1,
    pod,
    processEpoch: crypto.randomUUID(),
    epoch: crypto.randomUUID(),
    startedAt: started,
    counterStartedAt: started,
    observedAt: now,
    history: "complete",
    countersSince: started,
    ingressBytes: 1,
    egressBytes: 1,
    totalConnections: connections,
    connectionMilliseconds: 0,
    connections,
    authenticatedConnections: connections,
    busyConnections: busy,
    pendingDials: pending,
    lastActivityAt: last,
  }));
  return {
    databases: [
      {
        id: f.id,
        revision: 1,
        observed_at: now,
        last_activity_at: last,
        connections: connections * 2,
        busy_connections: busy * 2,
        pending_dials: pending * 2,
        expected_gateway_pods: pods,
        reports,
      },
    ],
  };
}
const sendActivity = (
  f: Awaited<ReturnType<typeof ready>>,
  body: unknown,
  key = f.agent,
) => request("/agent/v1/activity", key, "POST", body);
const sendUsage = (
  f: Awaited<ReturnType<typeof ready>>,
  samples: unknown[],
  key = f.agent,
) => request("/agent/v1/usage", key, "POST", { samples });
function storageSample(id: string) {
  return {
    database_id: id,
    source: "agent",
    producer_id: crypto.randomUUID(),
    sequence: 1,
    observed_at: new Date().toISOString(),
    storage_used_bytes: null,
    storage_allocated_bytes: null,
  };
}
async function generation(id: string) {
  return env.DB.prepare("SELECT generation FROM databases WHERE id=?")
    .bind(id)
    .first("generation");
}
async function activityRows(id: string) {
  return runInDurableObject(
    env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id)),
    (_instance, state) =>
      state.storage.sql.exec("SELECT * FROM database_activity").toArray(),
  );
}

it("requires actual region agent credentials and rejects admin/integrator keys on both ingestion routes", async () => {
  const f = await ready(),
    body = activity(f),
    sample = storageSample(f.id);
  expect((await sendActivity(f, body, f.admin)).status).toBe(401);
  expect((await sendActivity(f, body, f.integrator)).status).toBe(401);
  expect((await sendUsage(f, [sample], f.admin)).status).toBe(401);
  expect((await sendUsage(f, [sample], f.integrator)).status).toBe(401);
  expect(await generation(f.id)).toBe(1);
  expect(await activityRows(f.id)).toEqual([]);
});
it("measured idle-open sockets may start one idle intent; ten repeated reports cannot create another", async () => {
  const f = await ready(),
    body = activity(f);
  const response = await sendActivity(f, body);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ accepted: 1, idle_intents: 1 });
  expect(await generation(f.id)).toBe(2);
  for (let n = 0; n < 10; n++)
    expect((await sendActivity(f, body)).status).toBe(409);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM operations WHERE database_id=? AND kind='database.hibernate'",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(1);
});
it("busy work and pending dials map conservatively instead of blocking every idle-open socket", async () => {
  const f = await ready();
  expect(await (await sendActivity(f, activity(f, 4, 1, 2))).json()).toEqual({
    accepted: 1,
    idle_intents: 0,
  });
  expect((await activityRows(f.id))[0]).toMatchObject({
    active_connections: 6,
  });
  expect(await generation(f.id)).toBe(1);
});
it("a missing or duplicate respondent cannot write activity or start idle", async () => {
  const f = await ready(),
    missing = activity(f);
  missing.databases[0]!.reports.pop();
  expect((await sendActivity(f, missing)).status).toBe(400);
  const duplicate = activity(f);
  duplicate.databases[0]!.reports[1] = duplicate.databases[0]!.reports[0]!;
  expect((await sendActivity(f, duplicate)).status).toBe(400);
  expect(await activityRows(f.id)).toEqual([]);
  expect(await generation(f.id)).toBe(1);
});
it("stale, future and wrong-revision pod reports cannot start idle", async () => {
  const f = await ready(),
    stale = activity(f);
  stale.databases[0]!.reports[0]!.observedAt = new Date(
    Date.now() - 31_000,
  ).toISOString();
  expect((await sendActivity(f, stale)).status).toBe(400);
  const future = activity(f);
  future.databases[0]!.reports[0]!.observedAt = new Date(
    Date.now() + 60_000,
  ).toISOString();
  expect((await sendActivity(f, future)).status).toBe(400);
  const mismatched = activity(f);
  mismatched.databases[0]!.reports[0]!.revision = 2;
  expect((await sendActivity(f, mismatched)).status).toBe(400);
  expect(await activityRows(f.id)).toEqual([]);
});
it("unavailable history or absent last activity cannot become invented idle evidence", async () => {
  const f = await ready(),
    partial = activity(f);
  partial.databases[0]!.reports[0]!.history = "partial";
  expect((await sendActivity(f, partial)).status).toBe(400);
  const absent = activity(f) as unknown as {
    databases: { reports: { lastActivityAt: string | null }[] }[];
  };
  absent.databases[0]!.reports[0]!.lastActivityAt = null;
  expect((await sendActivity(f, absent)).status).toBe(400);
  expect(await generation(f.id)).toBe(1);
});
it("aggregate counts and newest last activity must match actual whole-inventory reports", async () => {
  const f = await ready(),
    wrong = activity(f);
  wrong.databases[0]!.busy_connections = 0;
  wrong.databases[0]!.reports[0]!.busyConnections = 1;
  expect((await sendActivity(f, wrong)).status).toBe(400);
  const latest = activity(f);
  latest.databases[0]!.reports[1]!.lastActivityAt =
    latest.databases[0]!.observed_at;
  expect((await sendActivity(f, latest)).status).toBe(400);
  expect(await activityRows(f.id)).toEqual([]);
});
it("foreign, deleted and stale target revisions are refused before Actor measurement", async () => {
  const f = await ready();
  expect((await sendActivity(f, activity(f), f.foreignAgent)).status).toBe(404);
  const stale = activity(f);
  stale.databases[0]!.revision = 2;
  for (const report of stale.databases[0]!.reports) report.revision = 2;
  expect((await sendActivity(f, stale)).status).toBe(409);
  await request(`/v1/databases/${f.id}`, f.integrator, "DELETE");
  expect((await sendActivity(f, activity(f))).status).toBe(404);
  expect((await sendUsage(f, [storageSample(f.id)])).status).toBe(404);
});
it("records exact nullable usage and retains duplicate/conflicting identity semantics", async () => {
  const f = await ready(),
    sample = storageSample(f.id);
  expect(await (await sendUsage(f, [sample])).json()).toEqual({
    recorded: 1,
    duplicates: 0,
  });
  expect(await (await sendUsage(f, [sample])).json()).toEqual({
    recorded: 0,
    duplicates: 1,
  });
  expect(
    (await sendUsage(f, [{ ...sample, storage_used_bytes: 42 }])).status,
  ).toBe(409);
  const row = await env.DB.prepare(
    "SELECT payload FROM usage_samples WHERE database_id=?",
  )
    .bind(f.id)
    .first<string>("payload");
  expect(JSON.parse(row!)).toEqual(sample);
});
it("agent may relay each measured variant but cannot supply principal or mismatched source fields", async () => {
  const f = await ready(),
    sample = storageSample(f.id),
    hour = Math.floor(Date.now() / 3600000) * 3600000 - 3600000,
    producer = crypto.randomUUID();
  const backup = {
    database_id: f.id,
    source: "backup",
    producer_id: crypto.randomUUID(),
    sequence: 1,
    observed_at: new Date().toISOString(),
    backup_bytes: null,
  };
  const gateway = {
    database_id: f.id,
    source: "gateway",
    producer_id: producer,
    sequence: 1,
    observed_at: new Date().toISOString(),
    interval_start: new Date(hour + 1000).toISOString(),
    interval_end: new Date(hour + 2000).toISOString(),
    expected_producers: [producer],
    ingress_bytes: null,
    egress_bytes: null,
    connections: null,
    connection_seconds: null,
  };
  expect(await (await sendUsage(f, [sample, backup, gateway])).json()).toEqual({
    recorded: 3,
    duplicates: 0,
  });
  expect(
    (
      await request("/agent/v1/usage", f.agent, "POST", {
        samples: [sample],
        principal: { region_id: f.foreign, source: "agent" },
      })
    ).status,
  ).toBe(400);
  expect((await sendUsage(f, [{ ...sample, source: "gateway" }])).status).toBe(
    400,
  );
  expect(
    (await sendUsage(f, [{ ...sample, region_id: f.foreign }])).status,
  ).toBe(400);
  expect((await sendUsage(f, [sample], f.foreignAgent)).status).toBe(404);
});
it("finalized usage hours remain closed to new measurements", async () => {
  const f = await ready(),
    sample = storageSample(f.id),
    hour = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
  await env.DB.prepare(
    "INSERT INTO usage_hourly(database_id,hour,metrics,gaps,final,computed_at) VALUES(?,?,'{}','[]',1,?)",
  )
    .bind(f.id, hour, new Date().toISOString())
    .run();
  expect((await sendUsage(f, [sample])).status).toBe(409);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM usage_samples WHERE database_id=?",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(0);
});
it("both batch caps and the existing global body bound apply", async () => {
  const f = await ready(),
    item = activity(f).databases[0]!;
  expect(
    (
      await sendActivity(f, {
        databases: Array.from({ length: 26 }, () => item),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await sendUsage(
        f,
        Array.from({ length: 26 }, () => storageSample(f.id)),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await request("/agent/v1/usage", f.agent, "POST", {
        samples: [storageSample(f.id)],
        padding: "x".repeat(65537),
      })
    ).status,
  ).toBe(400);
});

it("actual current-process absence uses its measured window without inventing last client activity", async () => {
  const f = await ready(),
    body = activity(f, 0);
  for (const report of body.databases[0]!.reports) {
    report.history = "current_process_absence";
    (report as { lastActivityAt: string | null }).lastActivityAt = null;
    report.ingressBytes = 0;
    report.egressBytes = 0;
  }
  body.databases[0]!.last_activity_at =
    body.databases[0]!.reports[0]!.counterStartedAt;
  expect(await (await sendActivity(f, body)).json()).toEqual({
    accepted: 1,
    idle_intents: 1,
  });
});
it("a fresh process restart or new ready boundary delays the full configured idle window", async () => {
  const f = await ready(),
    body = activity(f, 0),
    now = new Date().toISOString();
  for (const report of body.databases[0]!.reports) {
    report.history = "current_process_absence";
    (report as { lastActivityAt: string | null }).lastActivityAt = null;
    report.ingressBytes = 0;
    report.egressBytes = 0;
    report.startedAt = now;
    report.counterStartedAt = now;
    report.countersSince = now;
    report.observedAt = now;
  }
  body.databases[0]!.observed_at = now;
  body.databases[0]!.last_activity_at = now;
  expect(await (await sendActivity(f, body)).json()).toEqual({
    accepted: 1,
    idle_intents: 0,
  });
  expect(await generation(f.id)).toBe(1);
  const g = await ready(false),
    old = activity(g, 0);
  for (const report of old.databases[0]!.reports) {
    report.history = "current_process_absence";
    (report as { lastActivityAt: string | null }).lastActivityAt = null;
    report.ingressBytes = 0;
    report.egressBytes = 0;
  }
  old.databases[0]!.last_activity_at =
    old.databases[0]!.reports[0]!.counterStartedAt;
  const readyAt = await env.DB.prepare(
    "SELECT occurred_at FROM lifecycle_events WHERE database_id=? AND kind='ready'",
  )
    .bind(g.id)
    .first<string>("occurred_at");
  expect(await (await sendActivity(g, old)).json()).toEqual({
    accepted: 1,
    idle_intents: 0,
  });
  expect((await activityRows(g.id))[0]).toMatchObject({
    last_activity_at: readyAt,
  });
});

it("a deleted project cannot publish either measurement type", async () => {
  const f = await ready(),
    body = activity(f),
    sample = storageSample(f.id);
  await env.DB.prepare("UPDATE projects SET deleted_at=? WHERE id=?")
    .bind(new Date().toISOString(), f.project)
    .run();
  expect((await sendActivity(f, body)).status).toBe(404);
  expect((await sendUsage(f, [sample])).status).toBe(404);
  expect(await activityRows(f.id)).toEqual([]);
});
it("usage preflight and the existing recorder keep D1 work bounded for repeated target IDs", async () => {
  const f = await ready(),
    samples = [storageSample(f.id), storageSample(f.id)];
  const prepare = vi.spyOn(Object.getPrototypeOf(env.DB), "prepare");
  expect(await (await sendUsage(f, samples)).json()).toEqual({
    recorded: 2,
    duplicates: 0,
  });
  expect(prepare.mock.calls.length).toBeLessThanOrEqual(8);
});
