// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runCron } from "../../src/cron.ts";
import { armCronWatchdog } from "../../src/cron-watchdog.ts";
import { ApiError } from "../../src/app.ts";
import {
  CRON_STEPS,
  cronErrorCode,
  cronErrorMessage,
} from "../../src/domain/cron-health.ts";
import { configureNodeRegionPolicy } from "../../src/domain/node-state.ts";
import { recordNodeMemoryObservation } from "../../src/domain/memory-capacity.ts";
import { infrastructureAlertStatus } from "../../src/domain/infrastructure-alerts.ts";
import { configureInfrastructureBackups } from "../../src/domain/infrastructure-backups.ts";
import type { Env } from "../../src/env.ts";
import { cleanupFixtures, fixture } from "./fixtures.ts";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM cron_heartbeat").run();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await env.DB.prepare("DELETE FROM cron_heartbeat").run();
  await env.DB.prepare("DELETE FROM infrastructure_backup_runs").run();
  await env.DB.prepare(
    "UPDATE infrastructure_backup_config SET enabled=0,d1_account_id=NULL,d1_database_id=NULL,d1_region_id=NULL,notification_recipient=NULL,notification_sender=NULL,enabled_at=NULL,updated_at=NULL,revision=0 WHERE singleton=1",
  ).run();
  await env.DB.prepare("DELETE FROM infrastructure_alerts").run();
  await cleanupFixtures();
});

/** A database whose statements starting with any prefix throw, as a step's own query would on a D1 fault. */
function failing(...prefixes: string[]): Env {
  const db = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          if (prefixes.some((prefix) => sql.startsWith(prefix)))
            throw new Error("injected_step_failure");
          return target.prepare(sql);
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...env, DB: db };
}
const heartbeat = () =>
  env.DB.prepare("SELECT * FROM cron_heartbeat WHERE singleton=1").first<{
    started_at: string;
    completed_at: string | null;
    failing_steps_json: string;
  }>();
const admissionRecovery =
  "SELECT kind,scope_id,mutation_id FROM admission_scope_fences";
const retainedArchives = "SELECT a.*,r.backup_bucket FROM retained_archives a";

it("records a heartbeat of every run and lists the steps it attempted", async () => {
  const at = Date.now(),
    result = await runCron(env, at);
  expect(result.step_failures).toEqual([]);
  const row = await heartbeat();
  expect(row).toMatchObject({
    started_at: new Date(at).toISOString(),
    failing_steps_json: "{}",
  });
  expect(Date.parse(row!.completed_at!)).toBeGreaterThanOrEqual(at);
  expect(new Set(CRON_STEPS).size).toBe(CRON_STEPS.length);
  // An alert event lists at most 20 failing steps and a heartbeat row at most 4 KB of counters.
  expect(CRON_STEPS.length).toBeLessThanOrEqual(20);
  // Alerting needs only D1 and a bounded send, so it leads; the dispatch's Workflow calls follow.
  expect(CRON_STEPS.slice(0, 3)).toEqual([
    "health_alerts",
    "capacity_alerts",
    "infrastructure_backup_dispatch",
  ]);
});

it("logs, counts and reports a failing step while alerting and backup dispatch still run", async () => {
  const f = await fixture(),
    at = Date.now(),
    created: string[] = [];
  const binding: Env = {
    ...failing(admissionRecovery, retainedArchives),
    INFRASTRUCTURE_BACKUP_CF_TOKEN: "private-test-export-token",
    INFRASTRUCTURE_BACKUP: {
      async get() {
        throw new Error("instance.not_found");
      },
      async create(options: { id: string }) {
        created.push(options.id);
      },
    } as unknown as Workflow<{ run_id: string }>,
  };
  await configureInfrastructureBackups(
    binding,
    {
      enabled: true,
      d1_account_id: "a".repeat(32),
      d1_database_id: crypto.randomUUID(),
      d1_region_id: f.region,
      notification_recipient: null,
      notification_sender: null,
    },
    at - 3_600_000,
  );
  await env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
    .bind(new Date(at - 600_000).toISOString(), f.node)
    .run();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const result = await runCron(binding, at);
  expect(result.step_failures).toEqual([
    { step: "admission_recovery", error_code: "injected_step_failure" },
    { step: "retained_archives", error_code: "injected_step_failure" },
  ]);
  // Later steps ran: the stale node was alarmed and the due daily backup was dispatched.
  expect(await infrastructureAlertStatus(env.DB, f.region)).toContainEqual(
    expect.objectContaining({ kind: "regional_node_stale", active: true }),
  );
  expect(created).toHaveLength(1);
  const lines = logged.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.includes("cron_step_failed"));
  // The log line also carries the message, redacted; the heartbeat and alerts carry the code only.
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    {
      event: "cron_step_failed",
      step: "admission_recovery",
      error_code: "injected_step_failure",
      message: "injected_step_failure",
    },
    {
      event: "cron_step_failed",
      step: "retained_archives",
      error_code: "injected_step_failure",
      message: "injected_step_failure",
    },
  ]);
  expect(JSON.parse((await heartbeat())!.failing_steps_json)).toEqual({
    admission_recovery: {
      consecutive_failures: 1,
      error_code: "injected_step_failure",
    },
    retained_archives: {
      consecutive_failures: 1,
      error_code: "injected_step_failure",
    },
  });
});

it("isolates the role removal timeout: a failing statement is logged and counted and the steps after it still run", async () => {
  const f = await fixture(),
    at = Date.now();
  expect(
    (await f.create("database", f.integrator, crypto.randomUUID())).status,
  ).toBe(202);
  // A day-old idempotency key: its purge is a step that follows the role removal timeout.
  await env.DB.prepare("UPDATE idempotency_keys SET created_at=?")
    .bind(new Date(at - 25 * 3_600_000).toISOString())
    .run();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const result = await runCron(
    failing("UPDATE role_deletions SET status='failed'"),
    at,
  );
  expect(result.step_failures).toEqual([
    { step: "role_deletion_timeouts", error_code: "injected_step_failure" },
  ]);
  expect(result.purged).toBeGreaterThan(0);
  expect(JSON.parse((await heartbeat())!.failing_steps_json)).toEqual({
    role_deletion_timeouts: {
      consecutive_failures: 1,
      error_code: "injected_step_failure",
    },
  });
  expect(
    logged.mock.calls.some(
      ([line]) =>
        String(line).includes("cron_step_failed") &&
        String(line).includes("role_deletion_timeouts"),
    ),
  ).toBe(true);
  expect(CRON_STEPS.indexOf("role_deletion_timeouts")).toBeLessThan(
    CRON_STEPS.indexOf("idempotency_purge"),
  );
});

it("counts consecutive failed runs per step and forgets a step once it succeeds", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const at = Date.now();
  await runCron(failing(admissionRecovery), at);
  await runCron(failing(admissionRecovery, retainedArchives), at + 60_000);
  await runCron(failing(admissionRecovery), at + 120_000);
  expect(JSON.parse((await heartbeat())!.failing_steps_json)).toEqual({
    admission_recovery: {
      consecutive_failures: 3,
      error_code: "injected_step_failure",
    },
  });
  await runCron(env, at + 180_000);
  expect((await heartbeat())!.failing_steps_json).toBe("{}");
});

it("evaluates a region's alerts even when its capacity decision fails", async () => {
  const f = await fixture(8192, 40),
    at = Date.now(),
    uid = crypto.randomUUID(),
    provider = String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!);
  await env.DB.prepare(
    "UPDATE nodes SET node_uid=?,provider_instance_id=? WHERE id=?",
  )
    .bind(uid, provider, f.node)
    .run();
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 3,
    purchases_enabled: false,
    ram_warning_threshold_ppm: 750000,
    cap_warning_enabled: false,
    placement_mode: "actual_ram",
    maximum_database_memory_mib: 4096,
    postgres_memory_request_mib: 128,
  });
  const capacity = 8 * 1024 ** 3;
  for (let minute = 9; minute >= 0; minute--) {
    const observed_at = new Date(at - minute * 60_000).toISOString();
    await recordNodeMemoryObservation(
      env.DB,
      f.region,
      {
        node_id: f.node,
        node_uid: uid,
        provider_instance_id: provider,
        memory: {
          node_uid: uid,
          observed_at,
          capacity_memory_bytes: capacity,
          working_set_bytes: Math.floor(capacity * 0.8),
          available_bytes: Math.floor(capacity * 0.2),
          memory_pressure: false,
        },
      },
      observed_at,
      at - minute * 60_000,
    );
  }
  vi.spyOn(console, "error").mockImplementation(() => {});
  const result = await runCron(
    failing("SELECT * FROM node_region_policies WHERE region_id=?"),
    at,
  );
  expect(result.step_failures.map((value) => value.step)).toEqual([
    "node_capacity",
  ]);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toContainEqual(
    expect.objectContaining({ kind: "regional_ram_warning", active: true }),
  );
});

it("never lets a heartbeat write fault stop the steps", async () => {
  const f = await fixture(),
    at = Date.now();
  await env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
    .bind(new Date(at - 600_000).toISOString(), f.node)
    .run();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const result = await runCron(failing("INSERT INTO cron_heartbeat"), at);
  expect(result.step_failures).toEqual([]);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toContainEqual(
    expect.objectContaining({ kind: "regional_node_stale", active: true }),
  );
  expect(
    logged.mock.calls.some(([line]) =>
      String(line).includes("cron_heartbeat_failed"),
    ),
  ).toBe(true);
});

it("defers notifications beyond the run's delivery budget so a slow mail provider cannot hold back later steps", async () => {
  const f = await fixture(),
    at = Date.now(),
    sent: string[] = [],
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    sent.push(String(input));
    return new Response(null, { status: 204 });
  });
  const binding: Env = {
    ...env,
    INFRASTRUCTURE_ALERT_WEBHOOK_URL: "https://receiver.invalid/events",
    INFRASTRUCTURE_ALERT_WEBHOOK_TOKEN: "test-alert-receiver-token",
  };
  await env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
    .bind(new Date(at - 600_000).toISOString(), f.node)
    .run();
  // A zero budget attempts nothing, yet every other step of the run completes.
  const result = await runCron(binding, at, 0);
  expect(result.step_failures).toEqual([]);
  expect(sent).toEqual([]);
  expect((await heartbeat())!.completed_at).not.toBeNull();
  expect(await infrastructureAlertStatus(env.DB, f.region)).toContainEqual(
    expect.objectContaining({
      kind: "regional_node_stale",
      active: true,
      delivered_at: null,
    }),
  );
  expect(
    logged.mock.calls.some(([line]) =>
      String(line).includes("infrastructure_alert_deferred"),
    ),
  ).toBe(true);
  // Nothing was claimed, so the retry interval is not spent on an attempt that never happened.
  expect(
    await env.DB.prepare(
      "SELECT last_attempt_at FROM infrastructure_alerts WHERE region_id=? AND kind='regional_node_stale'",
    )
      .bind(f.region)
      .first<string | null>("last_attempt_at"),
  ).toBeNull();
  // The next minute's run, with its own budget, sends the same event.
  await runCron(binding, at + 61_000);
  expect(sent).toEqual(["https://receiver.invalid/events"]);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toContainEqual(
    expect.objectContaining({ kind: "regional_node_stale", active: true }),
  );
});

it("redacts a thrown message before it reaches a log line", () => {
  const message = cronErrorMessage(
    new Error(
      "fetch https://api.example.invalid/v1/x?token=abc123 failed for key AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nretrying",
    ),
  );
  expect(message).toBe("fetch <url> failed for key <token> retrying");
  expect(cronErrorMessage(new Error("word ".repeat(100)))).toHaveLength(200);
  expect(cronErrorMessage("plain")).toBe("plain");
});

it("does not let an unreachable watchdog hold the run", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const started = Date.now();
  await armCronWatchdog(
    {
      ...env,
      CRON_WATCHDOG: {
        idFromName: () => "control",
        get: () => ({ arm: () => new Promise<void>(() => {}) }),
      } as unknown as Env["CRON_WATCHDOG"],
    },
    50,
  );
  expect(Date.now() - started).toBeLessThan(2000);
  expect(
    logged.mock.calls.some(([line]) =>
      String(line).includes("cron_watchdog_arm_failed"),
    ),
  ).toBe(true);
});

it("reduces a thrown value to a code that carries no message text", () => {
  expect(cronErrorCode(new ApiError("conflict", "Secret region detail"))).toBe(
    "conflict",
  );
  expect(cronErrorCode(new Error("power_timeout_cursor_missing"))).toBe(
    "power_timeout_cursor_missing",
  );
  expect(
    cronErrorCode(new Error("D1_ERROR: no such table: secrets: SQLITE_ERROR")),
  ).toBe("d1_error");
  expect(
    cronErrorCode(new TypeError("fetch https://x.invalid/?token=abc")),
  ).toBe("type_error");
  expect(
    cronErrorCode(new Error("Request to https://api.invalid failed")),
  ).toBe("step_failed");
  expect(cronErrorCode("a string")).toBe("step_failed");
});
