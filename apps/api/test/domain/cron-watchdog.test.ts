// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { INFRA_ALERT_ACTIONS, InfraAlert } from "@pgcf/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ALERT_PHASE_TIMEOUT_MS,
  CRON_WATCHDOG_INTERVAL_MS,
  CronWatchdog,
  evaluateAlerts,
} from "../../src/cron-watchdog.ts";
import { runCron } from "../../src/cron.ts";
import {
  infrastructureAlertStatus,
  runCronWatchdog,
} from "../../src/domain/infrastructure-alerts.ts";
import { configureNodeRegionPolicy } from "../../src/domain/node-state.ts";
import type { Env } from "../../src/env.ts";
import { cleanupFixtures, fixture } from "./fixtures.ts";

const stub = () =>
  env.CRON_WATCHDOG.get(env.CRON_WATCHDOG.idFromName("control"));
async function reset() {
  await runInDurableObject(stub(), async (_instance, state) => {
    await state.storage.deleteAlarm();
  });
  await env.DB.prepare("DELETE FROM cron_heartbeat").run();
  await env.DB.prepare("DELETE FROM infrastructure_alerts").run();
}
beforeEach(reset);
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
  await cleanupFixtures();
});

const ago = (now: number, ms: number) => new Date(now - ms).toISOString();
const MINUTE = 60_000;
function heartbeat(
  now: number,
  completedAgo: number,
  failing: Record<string, number> = {},
) {
  return env.DB.prepare(
    "INSERT INTO cron_heartbeat(singleton,started_at,completed_at,failing_steps_json) VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET started_at=excluded.started_at,completed_at=excluded.completed_at,failing_steps_json=excluded.failing_steps_json",
  )
    .bind(
      ago(now, completedAgo + 20_000),
      ago(now, completedAgo),
      JSON.stringify(
        Object.fromEntries(
          Object.entries(failing).map(([step, consecutive_failures]) => [
            step,
            { consecutive_failures, error_code: "usage_cron_statement_budget" },
          ]),
        ),
      ),
    )
    .run();
}
function receiver() {
  const events: { event: InfraAlert; key: string | null }[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    events.push({
      event: InfraAlert.parse(JSON.parse(init!.body as string)),
      key: new Headers(init!.headers).get("Idempotency-Key"),
    });
    return new Response(null, { status: 204 });
  };
  const binding: Env = {
    ...env,
    INFRASTRUCTURE_ALERT_WEBHOOK_URL: "https://receiver.invalid/events",
    INFRASTRUCTURE_ALERT_WEBHOOK_TOKEN: "test-alert-receiver-token",
  };
  return { events, fetcher, env: binding };
}
const episodes = async (region: string) =>
  new Map(
    (await infrastructureAlertStatus(env.DB, region)).map((value) => [
      value.kind,
      value,
    ]),
  );

it("is armed by the cron, keeps one alarm, and each alarm schedules the next before it judges", async () => {
  await runCron(env);
  const armed = await runInDurableObject(stub(), (_i, state) =>
    state.storage.getAlarm(),
  );
  expect(armed).not.toBeNull();
  await stub().arm();
  expect(
    await runInDurableObject(stub(), (_i, state) => state.storage.getAlarm()),
  ).toBe(armed);
  const before = Date.now();
  expect(await runDurableObjectAlarm(stub())).toBe(true);
  const next = await runInDurableObject(stub(), (_i, state) =>
    state.storage.getAlarm(),
  );
  expect(next).toBeGreaterThanOrEqual(
    before + CRON_WATCHDOG_INTERVAL_MS - 1000,
  );
  const row = await env.DB.prepare(
    "SELECT watchdog_checked_at FROM cron_heartbeat WHERE singleton=1",
  ).first<{ watchdog_checked_at: string | null }>();
  expect(Date.parse(row!.watchdog_checked_at!)).toBeGreaterThanOrEqual(before);
});

it("raises a stalled cron from its own alarm in every region, once, and clears it when runs complete again", async () => {
  const f = await fixture(),
    now = Date.now(),
    hook = receiver();
  await heartbeat(now, 8 * MINUTE);
  // The alarm alone, with no cron run, arms the episode in each region.
  await runInDurableObject(stub(), async (_i, state) => {
    await state.storage.setAlarm(Date.now() + 10_000);
  });
  expect(await runDurableObjectAlarm(stub())).toBe(true);
  for (const region of [f.region, f.foreign])
    expect((await episodes(region)).get("control_cron_stalled")).toMatchObject({
      active: true,
    });
  await runCronWatchdog(hook.env, now, hook.fetcher);
  await runCronWatchdog(hook.env, now + 61_000, hook.fetcher);
  const mine = hook.events.filter(
    (value) => value.event.region_id === f.region,
  );
  expect(mine).toHaveLength(1);
  expect(mine[0]!.event).toMatchObject({
    kind: "control_cron_stalled",
    action: INFRA_ALERT_ACTIONS.control_cron_stalled,
    cron: { failing_steps: [] },
  });
  expect(mine[0]!.key).toBe(
    `${mine[0]!.event.event_id}:${mine[0]!.event.occurred_at}`,
  );
  expect(Date.parse(mine[0]!.event.cron!.last_completed_at!)).toBeLessThan(
    now - 5 * MINUTE,
  );
  await heartbeat(now, 30_000);
  await runCronWatchdog(hook.env, now + 90_000, hook.fetcher);
  expect((await episodes(f.region)).get("control_cron_stalled")).toMatchObject({
    active: false,
  });
});

it("raises a failing step only after five consecutive failed runs and names it", async () => {
  const f = await fixture(),
    now = Date.now(),
    hook = receiver();
  await heartbeat(now, 30_000, { usage: 4 });
  await runCronWatchdog(hook.env, now, hook.fetcher);
  expect(
    (await episodes(f.region)).get("control_cron_step_failing"),
  ).toBeUndefined();
  await heartbeat(now, 30_000, { usage: 5, retained_archives: 1 });
  await runCronWatchdog(hook.env, now + 1000, hook.fetcher);
  const mine = hook.events.filter(
    (value) => value.event.region_id === f.region,
  );
  expect(mine).toHaveLength(1);
  expect(mine[0]!.event).toMatchObject({
    kind: "control_cron_step_failing",
    action: INFRA_ALERT_ACTIONS.control_cron_step_failing,
  });
  expect(mine[0]!.event.cron!.failing_steps).toEqual([
    {
      step: "usage",
      consecutive_failures: 5,
      error_code: "usage_cron_statement_budget",
    },
    {
      step: "retained_archives",
      consecutive_failures: 1,
      error_code: "usage_cron_statement_budget",
    },
  ]);
  // A stalled cron says nothing new about its steps: the episode stays, and the stall is raised too.
  await heartbeat(now, 9 * MINUTE, { usage: 5 });
  await runCronWatchdog(hook.env, now + 2000, hook.fetcher);
  const after = await episodes(f.region);
  expect(after.get("control_cron_step_failing")).toMatchObject({
    active: true,
  });
  expect(after.get("control_cron_stalled")).toMatchObject({ active: true });
  await heartbeat(now, 10_000, {});
  await runCronWatchdog(hook.env, now + 3000, hook.fetcher);
  const cleared = await episodes(f.region);
  expect(cleared.get("control_cron_step_failing")).toMatchObject({
    active: false,
  });
  expect(cleared.get("control_cron_stalled")).toMatchObject({ active: false });
});

it("names a failing step in the event id: another step is another error, the same step the same one again", async () => {
  const f = await fixture(),
    now = Date.now(),
    hook = receiver();
  const episode = async () =>
    (await episodes(f.region)).get("control_cron_step_failing")!;
  const fail = async (failing: Record<string, number>, at: number) => {
    await heartbeat(now, 30_000, failing);
    await runCronWatchdog(hook.env, now + at, hook.fetcher);
  };
  // A step that failed only once is no part of the error: five failures in a row make it one.
  await fail({ usage: 5, retained_archives: 1 }, 0);
  const first = await episode();
  await fail({}, 1000);
  await fail({ node_hints: 5 }, 2000);
  const other = await episode();
  await fail({}, 3000);
  await fail({ usage: 5 }, 4000);
  const again = await episode();
  expect(other.event_id).not.toBe(first.event_id);
  expect(again.event_id).toBe(first.event_id);
  expect(again.occurred_at).not.toBe(first.occurred_at);
  // Each episode was sent once under its own key, and the third repeats the first one's event_id.
  const sent = hook.events
    .filter(
      (value) =>
        value.event.region_id === f.region &&
        value.event.kind === "control_cron_step_failing",
    )
    .map((value) => value.key);
  expect(sent).toEqual([
    `${first.event_id}:${first.occurred_at}`,
    `${other.event_id}:${other.occurred_at}`,
    `${again.event_id}:${again.occurred_at}`,
  ]);
});

it("judges nothing before the cron has recorded a run", async () => {
  const f = await fixture(),
    hook = receiver();
  await runCronWatchdog(hook.env, Date.now(), hook.fetcher);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toEqual([]);
  expect(hook.events).toEqual([]);
});

it("keeps scheduling its next alarm when an evaluation fails", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  await runInDurableObject(stub(), async (instance, state) => {
    const watchdog = instance as unknown as CronWatchdog & { env: Env };
    const failing = new Proxy(watchdog.env.DB, {
      get(target, key) {
        if (key === "prepare")
          return () => {
            throw new Error("injected_watchdog_failure");
          };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const healthy = watchdog.env;
    watchdog.env = { ...healthy, DB: failing };
    try {
      await watchdog.alarm();
      expect(await state.storage.getAlarm()).not.toBeNull();
    } finally {
      watchdog.env = healthy;
    }
  });
  expect(
    logged.mock.calls.some(([line]) =>
      String(line).includes("injected_watchdog_failure"),
    ),
  ).toBe(true);
});

/** A database whose statements starting with `prefix` never answer, as a D1 request that is lost does. */
function hanging(prefix: string): Env {
  const db = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) =>
          sql.startsWith(prefix)
            ? ({
                bind: () => ({
                  all: () => new Promise(() => {}),
                  run: () => new Promise(() => {}),
                }),
                all: () => new Promise(() => {}),
              } as unknown as D1PreparedStatement)
            : target.prepare(sql);
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...env, DB: db };
}
const staleNode = (node: string, now: number) =>
  env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
    .bind(ago(now, 10 * MINUTE), node)
    .run();
const evaluations = (logged: { mock: { calls: unknown[][] } }) =>
  logged.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.includes('"alert_evaluation"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);

it("evaluates the health and capacity alerts from its own alarm, with no cron run at all", async () => {
  const f = await fixture(),
    now = Date.now();
  await staleNode(f.node, now);
  // A cap of 1 provider-assigned node, which the region holds.
  await env.DB.prepare("UPDATE nodes SET provider_instance_id=? WHERE id=?")
    .bind(String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!), f.node)
    .run();
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 1,
    purchases_enabled: false,
    cap_warning_enabled: true,
    maximum_database_memory_mib: 4096,
  });
  // No heartbeat exists: the cron never ran. The alarm alone raises both episodes.
  expect(
    await env.DB.prepare("SELECT 1 FROM cron_heartbeat").first(),
  ).toBeNull();
  await runInDurableObject(stub(), async (_i, state) => {
    await state.storage.setAlarm(Date.now() + 10_000);
  });
  const logged = vi.spyOn(console, "log").mockImplementation(() => {});
  expect(await runDurableObjectAlarm(stub())).toBe(true);
  const kinds = await episodes(f.region);
  expect(kinds.get("regional_node_stale")).toMatchObject({ active: true });
  expect(kinds.get("regional_node_cap_reached")).toMatchObject({
    active: true,
  });
  expect(evaluations(logged)).toHaveLength(1);
  expect(evaluations(logged)[0]).toMatchObject({
    event: "alert_evaluation",
    failed: [],
    phase_ms: {
      health_alerts: expect.any(Number),
      capacity_alerts: expect.any(Number),
      cron_watchdog: expect.any(Number),
    },
  });
});

it("evaluates the alerts at every alarm, whatever the cron is doing, and records each evaluation", async () => {
  const f = await fixture(),
    now = Date.now();
  // The cron started a minute ago and has not finished: a step hangs.
  await env.DB.prepare(
    "INSERT INTO cron_heartbeat(singleton,started_at,completed_at,failing_steps_json) VALUES(1,?,?,'{}')",
  )
    .bind(ago(now, MINUTE), ago(now, 2 * MINUTE))
    .run();
  const logged = vi.spyOn(console, "log").mockImplementation(() => {});
  const checked = async () =>
    Date.parse(
      (await env.DB.prepare(
        "SELECT watchdog_checked_at FROM cron_heartbeat WHERE singleton=1",
      ).first<string>("watchdog_checked_at"))!,
    );
  await runInDurableObject(stub(), async (_i, state) => {
    await state.storage.setAlarm(Date.now() + 10_000);
  });
  expect(await runDurableObjectAlarm(stub())).toBe(true);
  const first = await checked();
  expect(first).toBeGreaterThanOrEqual(now);
  // A node goes quiet between two alarms: the second alarm alone alerts.
  await staleNode(f.node, now);
  expect(await runDurableObjectAlarm(stub())).toBe(true);
  expect(await checked()).toBeGreaterThanOrEqual(first);
  expect((await episodes(f.region)).get("regional_node_stale")).toMatchObject({
    active: true,
  });
  expect(evaluations(logged)).toHaveLength(2);
  // Every alarm schedules the next one, a minute ahead.
  const next = await runInDurableObject(stub(), (_i, state) =>
    state.storage.getAlarm(),
  );
  expect(next).toBeGreaterThanOrEqual(
    Date.now() + CRON_WATCHDOG_INTERVAL_MS - 2000,
  );
});

it("abandons an evaluation phase that never answers, runs the phases after it and says so", async () => {
  const f = await fixture(),
    now = Date.now(),
    started = Date.now();
  await staleNode(f.node, now);
  await heartbeat(now, 8 * MINUTE);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const info = vi.spyOn(console, "log").mockImplementation(() => {});
  // The capacity phase reads the policies first; that read is lost.
  const result = await evaluateAlerts(
    hanging("SELECT region_id FROM node_region_policies ORDER BY region_id"),
    now,
    fetch,
    { phaseTimeoutMs: 100 },
  );
  expect(Date.now() - started).toBeLessThan(ALERT_PHASE_TIMEOUT_MS);
  expect(result.failed).toEqual([
    { phase: "capacity_alerts", error_code: "alert_phase_timeout" },
  ]);
  // The phases around it ran: the stale node and the stalled cron are both alarmed.
  const kinds = await episodes(f.region);
  expect(kinds.get("regional_node_stale")).toMatchObject({ active: true });
  expect(kinds.get("control_cron_stalled")).toMatchObject({ active: true });
  expect(
    logged.mock.calls.some(
      ([line]) =>
        String(line).includes("alert_phase_failed") &&
        String(line).includes("capacity_alerts") &&
        String(line).includes("alert_phase_timeout"),
    ),
  ).toBe(true);
  expect(evaluations(info)[0]).toMatchObject({
    failed: ["capacity_alerts"],
  });
});

it("completes and logs an evaluation when its heartbeat write never answers", async () => {
  const now = Date.now();
  await heartbeat(now, 10_000);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const info = vi.spyOn(console, "log").mockImplementation(() => {});
  const result = await evaluateAlerts(
    hanging("UPDATE cron_heartbeat SET watchdog_checked_at"),
    now,
    fetch,
    { phaseTimeoutMs: 150 },
  );
  expect(result.failed).toEqual([]);
  expect(evaluations(info)).toHaveLength(1);
  expect(
    logged.mock.calls.map(([line]) => JSON.parse(String(line))),
  ).toContainEqual({
    event: "alert_evaluation_unrecorded",
    error_code: "cron_heartbeat_timeout",
  });
  expect(
    await env.DB.prepare(
      "SELECT watchdog_checked_at FROM cron_heartbeat WHERE singleton=1",
    ).first("watchdog_checked_at"),
  ).toBeNull();
});

it("defers notifications beyond the evaluation's delivery budget and sends them at the next one", async () => {
  const f = await fixture(),
    now = Date.now(),
    hook = receiver();
  await staleNode(f.node, now);
  vi.spyOn(console, "error").mockImplementation(() => {});
  // A zero budget attempts nothing, yet the episode is armed and every phase completes.
  const first = await evaluateAlerts(hook.env, now, hook.fetcher, {
    deliveryBudgetMs: 0,
  });
  expect(first.failed).toEqual([]);
  expect(hook.events).toEqual([]);
  expect((await episodes(f.region)).get("regional_node_stale")).toMatchObject({
    active: true,
    delivered_at: null,
    last_attempt_at: null,
  });
  // The next evaluation, with its own budget, sends the same event.
  await evaluateAlerts(hook.env, now + 61_000, hook.fetcher);
  const mine = hook.events.filter(
    (value) => value.event.region_id === f.region,
  );
  expect(mine.map((value) => value.event.kind)).toEqual([
    "regional_node_stale",
  ]);
});
