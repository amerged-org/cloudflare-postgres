// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { PostgresActivity } from "../../../regional/src/gateway/activity.ts";
import { runInDurableObject } from "cloudflare:test";
import { DatabaseWithOperation } from "@pgcf/contracts";
import {
  signGatewayActivity,
  verifyGatewayActivity,
  gatewayActivityReportSchema,
} from "@pgcf/contracts/gateway-activity";
import { afterEach, expect, it, vi } from "vitest";
import { runUsageCron } from "../../src/domain/usage-cron.ts";
import { countStatements } from "./d1-statements.ts";
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
    authenticatedConnections: connections - pending,
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

it("a recovered observation window delays idle despite older gateway activity", async () => {
  const f = await ready(),
    measured = activity(f),
    floor = new Date(Date.now() - 15_000).toISOString();
  const body = {
    databases: measured.databases.map((value) => ({
      ...value,
      idle_observed_since: floor,
      last_activity_at: floor,
    })),
  };
  const response = await sendActivity(f, body);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ accepted: 1, idle_intents: 0 });
  expect(await generation(f.id)).toBe(1);
  expect(await activityRows(f.id)).toMatchObject([
    { last_activity_at: floor, active_connections: 0 },
  ]);
});
it("authenticated busy work blocks idle while pending transports remain separately reported", async () => {
  const f = await ready();
  expect(await (await sendActivity(f, activity(f, 4, 1, 2))).json()).toEqual({
    accepted: 1,
    idle_intents: 0,
  });
  expect((await activityRows(f.id))[0]).toMatchObject({
    active_connections: 2,
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
    refused: 0,
  });
  expect(await (await sendUsage(f, [sample])).json()).toEqual({
    recorded: 0,
    duplicates: 1,
    refused: 0,
  });
  expect(
    await (await sendUsage(f, [{ ...sample, storage_used_bytes: 42 }])).json(),
  ).toEqual({ recorded: 0, duplicates: 0, refused: 1 });
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
    refused: 0,
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
it("acknowledges the two fragments of a split hour-boundary interval once and a replay as duplicates", async () => {
  const f = await ready(),
    hour = Math.floor(Date.now() / 3600000) * 3600000 - 3600000,
    producer = crypto.randomUUID(),
    iso = (value: number) => new Date(value).toISOString();
  // 1000 bytes counted between 10 s before and 5 s after the boundary: 666 and 334.
  const fragment = (from: number, to: number, egress: number) => ({
    database_id: f.id,
    source: "gateway",
    producer_id: producer,
    sequence: to,
    observed_at: iso(hour + 5000),
    interval_start: iso(from),
    interval_end: iso(to),
    expected_producers: [producer],
    ingress_bytes: 0,
    egress_bytes: egress,
    connections: 0,
    connection_seconds: 0,
  });
  const pair = [
    fragment(hour - 10_000, hour, 666),
    fragment(hour, hour + 5_000, 334),
  ];
  expect(await (await sendUsage(f, pair)).json()).toEqual({
    recorded: 2,
    duplicates: 0,
    refused: 0,
  });
  expect(await (await sendUsage(f, pair)).json()).toEqual({
    recorded: 0,
    duplicates: 2,
    refused: 0,
  });
  const stored = await env.DB.prepare(
    "SELECT json_extract(payload,'$.egress_bytes') egress FROM usage_samples WHERE database_id=? ORDER BY interval_start",
  )
    .bind(f.id)
    .all<{ egress: number }>();
  expect(stored.results.map((row) => row.egress)).toEqual([666, 334]);
});
it("a finalized hour refuses its late measurement without blocking the rest of the batch", async () => {
  const f = await ready(),
    current = storageSample(f.id),
    previous = Math.floor(Date.now() / 3600000) * 3600000 - 3600000,
    late = {
      ...storageSample(f.id),
      observed_at: new Date(previous + 1000).toISOString(),
    };
  await env.DB.prepare(
    "INSERT INTO usage_hourly(database_id,hour,metrics,gaps,final,computed_at) VALUES(?,?,'{}','[]',1,?)",
  )
    .bind(f.id, new Date(previous).toISOString(), new Date().toISOString())
    .run();
  expect(await (await sendUsage(f, [late, current])).json()).toEqual({
    recorded: 1,
    duplicates: 0,
    refused: 1,
  });
  expect(
    await env.DB.prepare(
      "SELECT producer_id FROM usage_samples WHERE database_id=?",
    )
      .bind(f.id)
      .all(),
  ).toMatchObject({ results: [{ producer_id: current.producer_id }] });
});
it("acknowledges a replay of a pruned finalized hour as refused so a producer outbox drains", async () => {
  const f = await ready(),
    now = Date.now(),
    hour = Math.floor(now / 3600000) * 3600000 - 30 * 3600000,
    iso = (value: number) => new Date(value).toISOString(),
    sample = { ...storageSample(f.id), observed_at: iso(hour + 1000) },
    count = async () =>
      (await env.DB.prepare(
        "SELECT count(*) n FROM usage_samples WHERE database_id=?",
      )
        .bind(f.id)
        .first<{ n: number }>())!.n;
  expect(await (await sendUsage(f, [sample])).json()).toEqual({
    recorded: 1,
    duplicates: 0,
    refused: 0,
  });
  await env.DB.batch([
    env.DB.prepare("UPDATE databases SET created_at=? WHERE id=?").bind(
      iso(hour),
      f.id,
    ),
    env.DB.prepare(
      "INSERT INTO usage_hourly(database_id,hour,metrics,gaps,final,computed_at) VALUES(?,?,'{}','[]',1,?)",
    ).bind(f.id, iso(hour), iso(now)),
    env.DB.prepare(
      "INSERT INTO usage_rollup_progress(database_id,next_hour) VALUES(?,?)",
    ).bind(f.id, iso(hour + 3600000)),
  ]);
  expect((await runUsageCron(env.DB, now)).pruned).toBe(1);
  expect(await count()).toBe(0);
  // The producer lost the acknowledgement and replays the sample whose row was pruned meanwhile.
  expect(await (await sendUsage(f, [sample])).json()).toEqual({
    recorded: 0,
    duplicates: 0,
    refused: 1,
  });
  expect(await count()).toBe(0);
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
    refused: 0,
  });
  expect(prepare.mock.calls.length).toBeLessThanOrEqual(8);
});

it("signed gateway scope with zero authenticated activity stays known despite an open pre-auth transport", async () => {
  const f = await ready(),
    body = activity(f, 1, 0, 1);
  const keyring = {
    active: "fixture",
    keys: new Map([["fixture", crypto.getRandomValues(new Uint8Array(32))]]),
  };
  for (const report of body.databases[0]!.reports) {
    const token = await signGatewayActivity({
      keyring,
      region: f.region,
      database: f.id,
      revision: 1,
      pod: report.pod,
    });
    const checked = await verifyGatewayActivity(token, {
      keys: keyring.keys,
      region: f.region,
      pod: report.pod,
    });
    expect(checked.ok).toBe(true);
    if (!checked.ok) throw new Error("fixture_scope_invalid");
    expect(checked.claims.database).toBe(f.id);
    expect(checked.claims.revision).toBe(1);
    Object.assign(report, {
      history: "current_process_absence",
      lastActivityAt: null,
      authenticatedConnections: 0,
      ingressBytes: 0,
      egressBytes: 0,
      totalConnections: 0,
      connectionMilliseconds: 0,
    });
    expect(gatewayActivityReportSchema.safeParse(report).success).toBe(true);
  }
  body.databases[0]!.last_activity_at =
    body.databases[0]!.reports[0]!.counterStartedAt;
  const response = await sendActivity(f, body);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ accepted: 1, idle_intents: 1 });
  expect((await activityRows(f.id))[0]).toMatchObject({
    active_connections: 0,
  });
});

it("pre-auth pending dials do not become idle-active after earlier authenticated activity", async () => {
  const f = await ready(),
    body = activity(f, 1, 0, 1);
  for (const report of body.databases[0]!.reports)
    report.authenticatedConnections = 0;
  const response = await sendActivity(f, body);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ accepted: 1, idle_intents: 1 });
  expect((await activityRows(f.id))[0]).toMatchObject({
    active_connections: 0,
  });
});

it("an authenticated held transaction remains idle-active despite an old client-activity timestamp", async () => {
  const f = await ready(),
    observer = new PostgresActivity();
  const frame = (tag: string, body: Buffer) => {
    const bytes = Buffer.alloc(5 + body.length);
    bytes[0] = tag.charCodeAt(0);
    bytes.writeUInt32BE(4 + body.length, 1);
    body.copy(bytes, 5);
    return bytes;
  };
  observer.observeBackend(
    Buffer.concat([frame("R", Buffer.alloc(4)), frame("Z", Buffer.from("I"))]),
  );
  observer.observeFrontend(frame("Q", Buffer.from("SELECT 1\0")));
  observer.observeBackend(frame("Z", Buffer.from("T")));
  expect(observer.authenticated).toBe(true);
  expect(observer.busy).toBe(true);
  const response = await sendActivity(f, activity(f, 1, observer.busy ? 1 : 0));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ accepted: 1, idle_intents: 0 });
  expect((await activityRows(f.id))[0]).toMatchObject({
    active_connections: 2,
  });
  expect(await generation(f.id)).toBe(1);
});

// A usage request costs two round trips whatever its size: one that reads the databases and the
// hour counts, one that inserts every sample. Nothing is read per sample.
async function liveDatabase(
  f: Awaited<ReturnType<typeof ready>>,
  name: string,
) {
  return DatabaseWithOperation.parse(await (await f.create(name)).json())
    .database.id;
}
const inserts = (sql: string[]) =>
  sql.filter((text) => text.startsWith("INSERT OR IGNORE INTO usage_samples"));
const uniqueSamples = (id: string, count: number, from = 1) =>
  Array.from({ length: count }, (_, index) => ({
    ...storageSample(id),
    sequence: from + index,
  }));

it("records the samples of many databases with one read batch and one insert batch", async () => {
  const f = await ready();
  const ids = [f.id, await liveDatabase(f, "b"), await liveDatabase(f, "c")];
  const samples = ids.flatMap((id) => uniqueSamples(id, 3));
  // The region's row is cached after its first request, which is not what is measured here.
  expect((await sendUsage(f, [storageSample(f.id)])).status).toBe(200);
  const counted = await countStatements(() => sendUsage(f, samples));
  expect(await counted.result.json()).toEqual({
    recorded: 9,
    duplicates: 0,
    refused: 0,
  });
  expect(counted.statements).toBe(samples.length + 2);
  expect(counted.roundTrips).toBe(2);
  // Far from the hour's limit, no insert counts the hour's samples.
  expect(inserts(counted.sql)).toHaveLength(9);
  expect(inserts(counted.sql).some((text) => text.includes("count(*)"))).toBe(
    false,
  );
});

it("tells a replay, a reused identity and a finalized hour apart in one request", async () => {
  const f = await ready(),
    previous = Math.floor(Date.now() / 3600000) * 3600000 - 3600000,
    [kept, replayed, reused] = uniqueSamples(f.id, 3);
  await sendUsage(f, [replayed!, reused!]);
  await env.DB.prepare(
    "INSERT INTO usage_hourly(database_id,hour,metrics,gaps,final,computed_at) VALUES(?,?,'{}','[]',1,?)",
  )
    .bind(f.id, new Date(previous).toISOString(), new Date().toISOString())
    .run();
  const late = {
    ...storageSample(f.id),
    observed_at: new Date(previous + 1000).toISOString(),
  };
  const counted = await countStatements(() =>
    sendUsage(f, [
      kept!,
      replayed!,
      { ...reused!, storage_used_bytes: 7 },
      late,
    ]),
  );
  expect(await counted.result.json()).toEqual({
    recorded: 1,
    duplicates: 1,
    refused: 2,
  });
  // The three the insert did not take are looked up together, once.
  expect(counted.roundTrips).toBe(3);
  expect(
    (
      await env.DB.prepare(
        "SELECT count(*) n FROM usage_samples WHERE database_id=?",
      )
        .bind(f.id)
        .first<{ n: number }>()
    )?.n,
  ).toBe(3);
});

it("keeps the hour's input limit exact where a request could reach it", async () => {
  const f = await ready(),
    hour = Math.floor(Date.now() / 3600000) * 3600000 - 3600000,
    at = (offset: number) => new Date(hour + offset).toISOString();
  // 9,998 raw samples already stand in the hour.
  await env.DB.prepare(
    `INSERT INTO usage_samples(database_id,source,producer_id,sequence,interval_start,interval_end,observed_at,payload)
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<9998)
    SELECT ?,'agent','bulk',i,?,?,?,'{}' FROM n`,
  )
    .bind(f.id, at(1000), at(1000), at(1000))
    .run();
  const sample = (sequence: number, observedAt = at(2000)) => ({
    ...storageSample(f.id),
    sequence,
    observed_at: observedAt,
  });
  const [first, second, third] = [sample(1), sample(2), sample(3)];
  const counted = await countStatements(() =>
    sendUsage(f, [first, second, third, sample(4, at(3_600_000 + 2000))]),
  );
  // Two fit under the limit and the third is refused; a sample of the next hour is not counted
  // against it.
  expect(await counted.result.json()).toEqual({
    recorded: 3,
    duplicates: 0,
    refused: 1,
  });
  expect(
    inserts(counted.sql).filter((text) => text.includes("count(*)")),
  ).toHaveLength(3);
  // At the limit a replay of a recorded sample is still a replay, not a refusal.
  expect(await (await sendUsage(f, [second])).json()).toEqual({
    recorded: 0,
    duplicates: 1,
    refused: 0,
  });
});

it("refuses the whole request before recording when one database is not live, and ends at an invalid sample", async () => {
  const f = await ready(),
    other = await liveDatabase(f, "other");
  await request(`/v1/databases/${other}`, f.integrator, "DELETE");
  expect(
    (await sendUsage(f, [storageSample(f.id), storageSample(other)])).status,
  ).toBe(404);
  const count = async () =>
    (await env.DB.prepare("SELECT count(*) n FROM usage_samples").first<{
      n: number;
    }>())!.n;
  const before = await count();
  // An observation from the future ends the list: what precedes it is recorded and it is refused.
  const future = {
    ...storageSample(f.id),
    observed_at: new Date(Date.now() + 120_000).toISOString(),
  };
  const [early, late] = [storageSample(f.id), storageSample(f.id)];
  expect((await sendUsage(f, [early, future, late])).status).toBe(400);
  expect(await count()).toBe(before + 1);
  expect(
    await env.DB.prepare(
      "SELECT producer_id FROM usage_samples WHERE database_id=? ORDER BY rowid DESC LIMIT 1",
    )
      .bind(f.id)
      .first<string>("producer_id"),
  ).toBe(early.producer_id);
});
