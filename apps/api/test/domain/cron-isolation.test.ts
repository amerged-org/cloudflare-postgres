// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runCron } from "../../src/cron.ts";
import { armCronWatchdog } from "../../src/cron-watchdog.ts";
import { ApiError } from "../../src/api-error.ts";
import {
  CRON_STEPS,
  cronErrorCode,
  cronErrorMessage,
} from "../../src/domain/cron-health.ts";
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
/** A database whose statements starting with `prefix` never answer, as a lost D1 request does. */
function hanging(prefix: string): Env {
  const db = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          if (!sql.startsWith(prefix)) return target.prepare(sql);
          const never = () => new Promise<never>(() => {});
          return {
            bind: () => ({ all: never, first: never, run: never }),
            all: never,
            first: never,
            run: never,
          } as unknown as D1PreparedStatement;
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
const retainedArchives = "SELECT a.* FROM retained_archives a";

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
  // The alerts are no step: the CronWatchdog alarm evaluates them every minute. The daily
  // backup's Workflow calls lead the steps that call out.
  expect(CRON_STEPS[0]).toBe("infrastructure_backup_dispatch");
  expect(CRON_STEPS).not.toContain("health_alerts");
  expect(CRON_STEPS).not.toContain("capacity_alerts");
  // Every step reports the time it took, in the order they ran.
  expect(Object.keys(result.step_ms)).toEqual([...CRON_STEPS]);
  for (const ms of Object.values(result.step_ms))
    expect(Number.isInteger(ms)).toBe(true);
});

it("leaves the alerts to the watchdog's alarm: a stale node is not alarmed by a run", async () => {
  const f = await fixture(),
    at = Date.now();
  await env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
    .bind(new Date(at - 600_000).toISOString(), f.node)
    .run();
  const statements: string[] = [];
  const spied: Env = {
    ...env,
    DB: new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            statements.push(sql);
            return target.prepare(sql);
          };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
  await runCron(spied, at);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toEqual([]);
  expect(statements.some((sql) => sql.includes("infrastructure_alerts"))).toBe(
    false,
  );
});

it("logs, counts and reports a failing step while the steps around it still run", async () => {
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
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const result = await runCron(binding, at);
  expect(result.step_failures).toEqual([
    { step: "admission_recovery", error_code: "injected_step_failure" },
    { step: "retained_archives", error_code: "injected_step_failure" },
  ]);
  // Later steps ran: the due daily backup was dispatched.
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
      ms: expect.any(Number),
    },
    {
      event: "cron_step_failed",
      step: "retained_archives",
      error_code: "injected_step_failure",
      message: "injected_step_failure",
      ms: expect.any(Number),
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

it("abandons a step that never answers and runs the steps after it, counting it as failed", async () => {
  const f = await fixture(),
    at = Date.now();
  expect(
    (await f.create("database", f.integrator, crypto.randomUUID())).status,
  ).toBe(202);
  // A day-old idempotency key: its purge follows the power timeouts, which never answer.
  await env.DB.prepare("UPDATE idempotency_keys SET created_at=?")
    .bind(new Date(at - 25 * 3_600_000).toISOString())
    .run();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const began = Date.now();
  const result = await runCron(
    hanging("SELECT database_id cursor FROM power_timeout_cursor"),
    at,
    150,
  );
  expect(Date.now() - began).toBeLessThan(10_000);
  expect(result.step_failures).toEqual([
    { step: "power_timeouts", error_code: "step_timeout" },
  ]);
  expect(result.step_ms.power_timeouts).toBeGreaterThanOrEqual(150);
  expect(result.purged).toBeGreaterThan(0);
  const row = await heartbeat();
  expect(row!.completed_at).not.toBeNull();
  expect(JSON.parse(row!.failing_steps_json)).toEqual({
    power_timeouts: { consecutive_failures: 1, error_code: "step_timeout" },
  });
  expect(
    logged.mock.calls.some(
      ([line]) =>
        String(line).includes("cron_step_failed") &&
        String(line).includes("power_timeouts") &&
        String(line).includes("step_timeout"),
    ),
  ).toBe(true);
});

it("never lets a heartbeat write fault stop the steps", async () => {
  const f = await fixture(),
    at = Date.now();
  expect(
    (await f.create("database", f.integrator, crypto.randomUUID())).status,
  ).toBe(202);
  await env.DB.prepare("UPDATE idempotency_keys SET created_at=?")
    .bind(new Date(at - 25 * 3_600_000).toISOString())
    .run();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const result = await runCron(failing("INSERT INTO cron_heartbeat"), at);
  expect(result.step_failures).toEqual([]);
  // The steps ran: the old idempotency key was purged.
  expect(result.purged).toBeGreaterThan(0);
  expect(
    logged.mock.calls.some(([line]) =>
      String(line).includes("cron_heartbeat_failed"),
    ),
  ).toBe(true);
});

it("abandons an unresponsive initial heartbeat and still attempts every step", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const result = await runCron(
    hanging("INSERT INTO cron_heartbeat"),
    Date.now(),
    150,
  );
  expect(Object.keys(result.step_ms)).toEqual([...CRON_STEPS]);
  expect(result.step_failures).toEqual([]);
  expect(await heartbeat()).toBeNull();
  expect(
    logged.mock.calls.map(([line]) => JSON.parse(String(line))),
  ).toContainEqual({
    event: "cron_heartbeat_failed",
    phase: "start",
    error_code: "cron_heartbeat_timeout",
  });
});

it("returns after all steps when the completion heartbeat never answers", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const result = await runCron(
    hanging("UPDATE cron_heartbeat SET completed_at"),
    Date.now(),
    150,
  );
  expect(Object.keys(result.step_ms)).toEqual([...CRON_STEPS]);
  expect(result.step_failures).toEqual([]);
  expect((await heartbeat())?.completed_at).toBeNull();
  expect(
    logged.mock.calls.map(([line]) => JSON.parse(String(line))),
  ).toContainEqual({
    event: "cron_heartbeat_failed",
    phase: "finish",
    error_code: "cron_heartbeat_timeout",
  });
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
