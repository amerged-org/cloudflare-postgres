// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env.ts";
import {
  authorizeBackupOperator,
  completeBackupArtifact,
  configureInfrastructureBackups,
  exportControlD1,
  finishInfrastructureBackup,
  initializeInfrastructureBackup,
  prepareInfrastructureBackupInput,
  infrastructureBackupHealth,
  infrastructureBackupKey,
  infrastructureBackupStatus,
  readInfrastructureBackupConfig,
  recordPreparedBackups,
  runInfrastructureBackupCron,
} from "../../src/domain/infrastructure-backups.ts";
import {
  runInfrastructureHealthAlerts,
  infrastructureAlertStatus,
} from "../../src/domain/infrastructure-alerts.ts";
import { uploadInfrastructureArtifact } from "../../src/workflows/infrastructure-backup.ts";
import {
  storeRegionJoinBundle,
  joinBundleReference,
} from "../../src/crypto/bootstrap-credentials.ts";
import { newDatabaseId, newNodeId, newOperationId } from "@pgcf/contracts";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";
afterEach(async () => {
  await env.DB.prepare(
    "DELETE FROM fleet_patch_operations WHERE release_id LIKE 'daily-backup-test-%'",
  ).run();
  await env.DB.prepare("DELETE FROM infrastructure_backup_runs").run();
  await env.DB.prepare(
    "UPDATE infrastructure_backup_config SET enabled=0,d1_account_id=NULL,d1_database_id=NULL,d1_region_id=NULL,notification_recipient=NULL,notification_sender=NULL,enabled_at=NULL,updated_at=NULL,revision=0 WHERE singleton=1",
  ).run();
  await env.DB.prepare(
    "DELETE FROM fleet_node_release_observations WHERE node_id IN(SELECT node_id FROM fleet_node_releases WHERE release_id LIKE 'daily-backup-test-%')",
  ).run();
  await env.DB.prepare(
    "DELETE FROM fleet_node_releases WHERE release_id LIKE 'daily-backup-test-%'",
  ).run();
  await env.DB.prepare(
    "DELETE FROM fleet_releases WHERE id LIKE 'daily-backup-test-%'",
  ).run();
  await cleanupFixtures();
});
function config(region: string) {
  return {
    enabled: true,
    d1_account_id: "a".repeat(32),
    d1_database_id: crypto.randomUUID(),
    d1_region_id: region,
    notification_recipient: null,
    notification_sender: null,
  };
}
function enabled(): Env {
  return {
    ...env,
    INFRASTRUCTURE_BACKUP_CF_TOKEN: "private-test-export-token",
  };
}
/** Records each created Workflow id; other ids keep the local binding's missing-instance result. */
function recordingWorkflow(created: string[]): Env {
  return {
    ...enabled(),
    INFRASTRUCTURE_BACKUP: {
      async get(id: string) {
        if (!created.includes(id)) return env.INFRASTRUCTURE_BACKUP.get(id);
        return {
          async status() {
            return { status: "queued" };
          },
        };
      },
      async create(options: { id: string }) {
        created.push(options.id);
      },
    } as unknown as Workflow<{ run_id: string }>,
  };
}
it("defaults off with no recipient; admin API cannot be configured by an integrator", async () => {
  const f = await fixture();
  expect(await readInfrastructureBackupConfig(env.DB)).toMatchObject({
    enabled: false,
    notification_recipient: null,
    notification_sender: null,
  });
  expect(
    (await request("/v1/infrastructure-backups/config", f.integrator)).status,
  ).toBe(403);
  expect(
    (await request("/v1/infrastructure-backups/config", f.admin)).status,
  ).toBe(200);
  await runInfrastructureBackupCron(env);
  expect(await infrastructureBackupStatus(env.DB)).toBeNull();
  await expect(
    configureInfrastructureBackups(
      { ...env, INFRASTRUCTURE_BACKUP_CF_TOKEN: undefined },
      config(f.region),
    ),
  ).rejects.toThrow("D1 export secret");
});
it("uses actual local Workflow missing-instance semantics and one persisted daily id across create ambiguity", async () => {
  const f = await fixture(),
    at = Date.now();
  await expect(
    env.INFRASTRUCTURE_BACKUP.get(crypto.randomUUID()),
  ).rejects.toThrow("instance.not_found");
  const created: string[] = [];
  const binding = {
    ...enabled(),
    INFRASTRUCTURE_BACKUP: {
      async get(id: string) {
        if (created.includes(id))
          return {
            async status() {
              return { status: "queued" };
            },
          };
        return env.INFRASTRUCTURE_BACKUP.get(id);
      },
      async create(options: { id: string }) {
        created.push(options.id);
        throw new Error("response-lost-after-create");
      },
    } as unknown as Workflow<{ run_id: string }>,
  };
  await configureInfrastructureBackups(binding, config(f.region), at);
  await runInfrastructureBackupCron(binding, at);
  await runInfrastructureBackupCron(binding, at + 60000);
  expect(created).toHaveLength(1);
  expect(await infrastructureBackupStatus(env.DB)).toMatchObject({
    id: created[0],
    day: new Date(at).toISOString().slice(0, 10),
    status: "pending",
  });
});
it("retries a failed UTC day ninety minutes after the failed attempt ended, at most three attempts", async () => {
  const f = await fixture(),
    created: string[] = [],
    binding = recordingWorkflow(created),
    start = Date.parse("2026-10-12T00:01:00.000Z"),
    minute = 60000,
    hour = 60 * minute,
    delay = 90 * minute;
  await configureInfrastructureBackups(binding, config(f.region), start);
  const attempts = async () =>
    (
      await env.DB.prepare(
        "SELECT id,attempt,status FROM infrastructure_backup_runs WHERE day='2026-10-12' ORDER BY attempt",
      ).all<{ id: string; attempt: number; status: string }>()
    ).results;
  await runInfrastructureBackupCron(binding, start);
  // The two-hour deadline fails attempt 1 at 02:01; its retry waits ninety minutes, not ten.
  await runInfrastructureBackupCron(binding, start + 2 * hour);
  await runInfrastructureBackupCron(binding, start + 2 * hour + 10 * minute);
  await runInfrastructureBackupCron(binding, start + 2 * hour + delay - 1);
  expect(await attempts()).toEqual([
    { id: created[0], attempt: 1, status: "failed" },
  ]);
  await runInfrastructureBackupCron(binding, start + 2 * hour + delay);
  expect(await attempts()).toEqual([
    { id: created[0], attempt: 1, status: "failed" },
    { id: created[1], attempt: 2, status: "pending" },
  ]);
  // Attempt 2's deadline is 05:31; its retry is the third and last attempt of the day.
  await runInfrastructureBackupCron(binding, start + 4 * hour + delay);
  await runInfrastructureBackupCron(binding, start + 4 * hour + 2 * delay - 1);
  expect(created).toHaveLength(2);
  await runInfrastructureBackupCron(binding, start + 4 * hour + 2 * delay);
  expect(created).toHaveLength(3);
  await runInfrastructureBackupCron(binding, start + 6 * hour + 2 * delay);
  // The third failure ends the day's retries.
  await runInfrastructureBackupCron(binding, start + 23 * hour);
  expect((await attempts()).map((run) => [run.attempt, run.status])).toEqual([
    [1, "failed"],
    [2, "failed"],
    [3, "failed"],
  ]);
  expect(created).toHaveLength(3);
  expect(
    await infrastructureBackupHealth(binding, start + 23 * hour),
  ).toContainEqual(
    expect.objectContaining({
      kind: "d1",
      region_id: f.region,
      status: "failing",
      last_failed_at: "2026-10-12T09:01:00.000Z",
      error_code: "infrastructure_backup_deadline",
    }),
  );
  // The next UTC day starts a fresh first attempt.
  await runInfrastructureBackupCron(
    binding,
    Date.parse("2026-10-13T00:00:00.000Z"),
  );
  expect(await infrastructureBackupStatus(env.DB)).toMatchObject({
    id: created[3],
    day: "2026-10-13",
    attempt: 1,
    status: "pending",
  });
});
const minute = 60000;
async function patchOperation(
  f: { node: string; region: string },
  values: { stage: string; state: string; updated: number; deadline: number },
) {
  const release = `daily-backup-test-${crypto.randomUUID()}`,
    operation = newOperationId(),
    stamp = (ms: number) => new Date(ms).toISOString();
  await env.DB.prepare(
    "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES(?,'{}',?,?)",
  )
    .bind(release, "d".repeat(64), stamp(values.updated))
    .run();
  await env.DB.prepare(
    `INSERT INTO fleet_patch_operations(operation_id,node_id,region_id,node_uid,cluster_uid,release_id,spec_sha256,assignment_revision,region_revision,material_revision,address,cluster_nodes_json,revision,stage,state,created_at,updated_at,deadline_at)
    SELECT ?,n.id,n.region_id,n.node_uid,?,?,?,1,1,1,'192.0.2.9','[]',1,?,?,?,?,? FROM nodes n WHERE n.id=?`,
  )
    .bind(
      operation,
      crypto.randomUUID(),
      release,
      "d".repeat(64),
      values.stage,
      values.state,
      stamp(values.updated - 10 * minute),
      stamp(values.updated),
      stamp(values.deadline),
      f.node,
    )
    .run();
  return operation;
}
/** A thin start that holds its volume's reserve: granted at the time and not yet ready. */
async function thinStartAdmission(
  f: { project: string; region: string; node: string; size: string },
  grantedAt: number,
) {
  const database = newDatabaseId(),
    operation = newOperationId(),
    at = new Date(grantedAt).toISOString(),
    uid = (await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
      .bind(f.node)
      .first<string>("node_uid"))!;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO databases(id,project_id,region_id,node_id,name,size_class_id,desired_state,archive_path,storage_profile_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'running',?,?,?,?)",
    ).bind(
      database,
      f.project,
      f.region,
      f.node,
      `thin-start-${database}`,
      f.size,
      `s3://thin-start/${database}/g1`,
      JSON.stringify({ node_uid: uid, startup_reserve_bytes: 2 ** 30 }),
      at,
      at,
    ),
    env.DB.prepare(
      "INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at) VALUES(?,'database.wake','running',?,?,1,?,?)",
    ).bind(operation, f.project, database, at, at),
    // The class stores 5 GiB, which exceeds the 1 GiB startup reserve.
    env.DB.prepare(
      "INSERT INTO database_start_admissions(operation_id,database_id,generation,node_id,node_uid,budget_bytes,granted_at,grant_sample_observed_at,storage_budget_bytes) VALUES(?,?,1,?,?,?,?,?,?)",
    ).bind(operation, database, f.node, uid, 2 ** 30, at, at, 5 * 2 ** 30),
  ]);
  return operation;
}
const makeReady = (operation: string, at: number) =>
  env.DB.prepare(
    "UPDATE database_start_admissions SET ready_at=?,ready_sample_observed_at=? WHERE operation_id=?",
  )
    .bind(new Date(at).toISOString(), new Date(at).toISOString(), operation)
    .run();
const deferrals = async () =>
  (
    await env.DB.prepare(
      "SELECT day,reason,first_at,last_at,checks FROM infrastructure_backup_deferrals ORDER BY day,reason",
    ).all()
  ).results;
describe("a due attempt held back by a fleet patch or a starting thin database", () => {
  afterEach(async () => {
    await env.DB.prepare("DELETE FROM infrastructure_backup_deferrals").run();
  });
  it("starts the first attempt of the day as attempt 1 once no patch ran for fifteen minutes", async () => {
    const f = await fixture(),
      created: string[] = [],
      binding = recordingWorkflow(created),
      start = Date.parse("2026-10-14T00:00:30.000Z");
    await configureInfrastructureBackups(
      binding,
      config(f.region),
      start - 60 * minute,
    );
    const operation = await patchOperation(f, {
      stage: "platform",
      state: "dispatched",
      updated: start - 30000,
      deadline: start + 40 * minute,
    });
    await runInfrastructureBackupCron(binding, start);
    await runInfrastructureBackupCron(binding, start + minute);
    // The patch holds the attempt back: no run exists, so no attempt number is taken.
    expect(created).toEqual([]);
    expect(await infrastructureBackupStatus(env.DB)).toBeNull();
    expect(await deferrals()).toEqual([
      {
        day: "2026-10-14",
        reason: "deferred_by_patch",
        first_at: "2026-10-14T00:00:30.000Z",
        last_at: "2026-10-14T00:01:30.000Z",
        checks: 2,
      },
    ]);
    expect(
      await (await request("/v1/infrastructure-backups", f.admin)).json(),
    ).toMatchObject({
      latest: null,
      deferral: {
        day: "2026-10-14",
        reason: "deferred_by_patch",
        first_at: "2026-10-14T00:00:30.000Z",
        last_at: "2026-10-14T00:01:30.000Z",
        checks: 2,
      },
    });
    // The patch completes at 00:10:30. A patch that changed in the last fifteen minutes still holds.
    const done = start + 10 * minute;
    await env.DB.prepare(
      "UPDATE fleet_patch_operations SET stage='complete',state='confirmed',updated_at=? WHERE operation_id=?",
    )
      .bind(new Date(done).toISOString(), operation)
      .run();
    await runInfrastructureBackupCron(binding, done + 15 * minute - 1);
    expect(created).toEqual([]);
    await runInfrastructureBackupCron(binding, done + 15 * minute);
    expect(created).toHaveLength(1);
    expect(await infrastructureBackupStatus(env.DB)).toMatchObject({
      id: created[0],
      day: "2026-10-14",
      attempt: 1,
      status: "pending",
    });
  });
  it("holds a due retry back behind a patch without using one of the day's three attempts", async () => {
    const f = await fixture(),
      created: string[] = [],
      binding = recordingWorkflow(created),
      start = Date.parse("2026-10-14T00:01:00.000Z"),
      fail = (id: string, at: number) =>
        env.DB.prepare(
          "UPDATE infrastructure_backup_runs SET status='failed',completed_at=?,error_code='infrastructure_backup_operator_portforward_timeout' WHERE id=?",
        )
          .bind(new Date(at).toISOString(), id)
          .run();
    await configureInfrastructureBackups(
      binding,
      config(f.region),
      start - 60 * minute,
    );
    await runInfrastructureBackupCron(binding, start);
    expect(created).toHaveLength(1);
    await fail(created[0]!, start + 5 * minute);
    // The retry falls due at 01:36 while a patch is running.
    const patch = await patchOperation(f, {
      stage: "regional",
      state: "dispatched",
      updated: start + 90 * minute,
      deadline: start + 150 * minute,
    });
    await runInfrastructureBackupCron(binding, start + 95 * minute);
    expect(created).toHaveLength(1);
    expect((await deferrals()).map((row) => [row.reason, row.checks])).toEqual([
      ["deferred_by_patch", 1],
    ]);
    await env.DB.prepare(
      "UPDATE fleet_patch_operations SET stage='complete',state='confirmed',updated_at=? WHERE operation_id=?",
    )
      .bind(new Date(start + 100 * minute).toISOString(), patch)
      .run();
    await runInfrastructureBackupCron(binding, start + 115 * minute);
    expect(created).toHaveLength(2);
    // The wait took no attempt: attempts 2 and 3 are both still available.
    await fail(created[1]!, start + 120 * minute);
    await runInfrastructureBackupCron(binding, start + 210 * minute);
    expect(created).toHaveLength(3);
    expect(
      (
        await env.DB.prepare(
          "SELECT attempt,status FROM infrastructure_backup_runs ORDER BY attempt",
        ).all()
      ).results,
    ).toEqual([
      { attempt: 1, status: "failed" },
      { attempt: 2, status: "failed" },
      { attempt: 3, status: "pending" },
    ]);
  });
  it("is not held back by a halted patch, a patch past its deadline or a patch of a lost node that stopped changing", async () => {
    const f = await fixture(),
      created: string[] = [],
      binding = recordingWorkflow(created),
      start = Date.parse("2026-10-14T00:00:30.000Z"),
      quiet = start - 180 * minute;
    await configureInfrastructureBackups(
      binding,
      config(f.region),
      start - 60 * minute,
    );
    const next = async (expected: number) => {
      await runInfrastructureBackupCron(binding, start);
      expect(created).toHaveLength(expected);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM infrastructure_backup_runs"),
        env.DB.prepare("DELETE FROM fleet_patch_operations"),
      ]);
    };
    // No operation changed inside the settle window in any of these cases.
    await patchOperation(f, {
      stage: "platform",
      state: "halted",
      updated: quiet,
      deadline: start + 30 * minute,
    });
    await next(1);
    await patchOperation(f, {
      stage: "flux",
      state: "dispatched",
      updated: quiet,
      deadline: start - minute,
    });
    await next(2);
    await patchOperation(f, {
      stage: "flux",
      state: "dispatched",
      updated: quiet,
      deadline: start + 30 * minute,
    });
    await env.DB.prepare(
      "UPDATE nodes SET lost_at=?,lost_reason='test loss',ready=0,schedulable=0 WHERE id=?",
    )
      .bind(new Date(start).toISOString(), f.node)
      .run();
    await next(3);
    expect(await deferrals()).toEqual([]);
  });
  it("holds an attempt back while a thin start granted in the last fifteen minutes is not ready", async () => {
    const f = await fixture(),
      created: string[] = [],
      binding = recordingWorkflow(created),
      start = Date.parse("2026-10-14T00:00:30.000Z");
    await configureInfrastructureBackups(
      binding,
      config(f.region),
      start - 60 * minute,
    );
    const admission = await thinStartAdmission(f, start - 2 * minute);
    await runInfrastructureBackupCron(binding, start);
    expect(created).toEqual([]);
    expect(await deferrals()).toEqual([
      {
        day: "2026-10-14",
        reason: "deferred_by_thin_start",
        first_at: "2026-10-14T00:00:30.000Z",
        last_at: "2026-10-14T00:00:30.000Z",
        checks: 1,
      },
    ]);
    // Once the start is ready the attempt follows.
    await makeReady(admission, start + minute);
    await runInfrastructureBackupCron(binding, start + minute);
    expect(created).toHaveLength(1);
    // A start granted sixteen minutes ago that never became ready no longer counts as in flight.
    await env.DB.prepare("DELETE FROM infrastructure_backup_runs").run();
    await thinStartAdmission(f, start - 14 * minute);
    await runInfrastructureBackupCron(binding, start + 2 * minute);
    expect(created).toHaveLength(2);
  });
  it("asks the provider to export only after a thin start in flight is ready, and not forever", async () => {
    const f = await fixture(),
      at = Date.now(),
      run = crypto.randomUUID(),
      binding = enabled(),
      c = await configureInfrastructureBackups(binding, config(f.region), at);
    await env.DB.prepare(
      "INSERT INTO infrastructure_backup_runs(id,day,attempt,config_revision,status,created_at,expires_at) VALUES(?,?,1,?,'running',?,?)",
    )
      .bind(
        run,
        new Date(at).toISOString().slice(0, 10),
        c.revision,
        new Date(at).toISOString(),
        new Date(at + 3600000).toISOString(),
      )
      .run();
    const url = "https://export.example.com/control.sql",
      order: string[] = [],
      requested = async () => {
        order.push("export");
        return Response.json({
          success: true,
          result: { status: "complete", result: { signed_url: url } },
        });
      },
      admission = await thinStartAdmission(f, at - minute);
    setTimeout(() => {
      order.push("ready");
      void makeReady(admission, Date.now());
    }, 60);
    expect(
      await exportControlD1(binding, run, requested, {
        pollMs: 10,
        limitMs: 5000,
      }),
    ).toBe(url);
    expect(order).toEqual(["ready", "export"]);
    // A start that stays unready does not hold the export beyond the limit.
    await thinStartAdmission(f, at - minute);
    order.length = 0;
    expect(
      await exportControlD1(binding, run, requested, {
        pollMs: 10,
        limitMs: 50,
      }),
    ).toBe(url);
    expect(order).toEqual(["export"]);
    // A check that cannot read the admissions never fails the capture.
    order.length = 0;
    const unreadable = {
      ...binding,
      DB: new Proxy(binding.DB, {
        get(target, key) {
          if (key === "prepare")
            return (query: string) => {
              if (query.includes("database_start_admissions"))
                throw new Error("admissions_unreadable");
              return target.prepare(query);
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    };
    expect(
      await exportControlD1(unreadable, run, requested, {
        pollMs: 10,
        limitMs: 5000,
      }),
    ).toBe(url);
    expect(order).toEqual(["export"]);
  });
  it("holds an attempt back and keeps the Cron running when the wait cannot be recorded", async () => {
    const f = await fixture(),
      created: string[] = [],
      binding = recordingWorkflow(created),
      start = Date.parse("2026-10-14T00:00:30.000Z");
    await configureInfrastructureBackups(
      binding,
      config(f.region),
      start - 60 * minute,
    );
    await patchOperation(f, {
      stage: "flux",
      state: "dispatched",
      updated: start - 30000,
      deadline: start + 40 * minute,
    });
    const unrecorded = {
      ...binding,
      DB: new Proxy(binding.DB, {
        get(target, key) {
          if (key === "prepare")
            return (query: string) => {
              if (query.includes("infrastructure_backup_deferrals"))
                throw new Error("deferral_unrecorded");
              return target.prepare(query);
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    };
    await runInfrastructureBackupCron(unrecorded, start);
    expect(created).toEqual([]);
    expect(await infrastructureBackupStatus(env.DB)).toBeNull();
    expect(await deferrals()).toEqual([]);
  });
});
it("dispatches a previous day's pending attempt and starts no other while a run of any day is pending or running", async () => {
  const f = await fixture(),
    created: string[] = [],
    binding = recordingWorkflow(created),
    previous = crypto.randomUUID(),
    c = await configureInfrastructureBackups(
      binding,
      config(f.region),
      Date.parse("2026-10-11T00:00:00.000Z"),
    );
  // The previous day's last retry was queued at 23:59 and its Workflow was never created.
  await env.DB.prepare(
    "INSERT INTO infrastructure_backup_runs(id,day,attempt,config_revision,status,created_at,expires_at) VALUES(?,'2026-10-11',3,?,'pending','2026-10-11T23:59:00.000Z','2026-10-12T01:59:00.000Z')",
  )
    .bind(previous, c.revision)
    .run();
  await runInfrastructureBackupCron(
    binding,
    Date.parse("2026-10-12T00:00:00.000Z"),
  );
  expect(created).toEqual([previous]);
  await env.DB.prepare(
    "UPDATE infrastructure_backup_runs SET status='running' WHERE id=?",
  )
    .bind(previous)
    .run();
  await runInfrastructureBackupCron(
    binding,
    Date.parse("2026-10-12T01:58:00.000Z"),
  );
  expect(created).toEqual([previous]);
  expect(await infrastructureBackupStatus(env.DB)).toMatchObject({
    id: previous,
    status: "running",
  });
  // Its deadline ends it; the new day's first attempt then starts without a retry delay.
  await runInfrastructureBackupCron(
    binding,
    Date.parse("2026-10-12T01:59:00.000Z"),
  );
  expect(await infrastructureBackupStatus(env.DB, previous)).toMatchObject({
    status: "failed",
    error_code: "infrastructure_backup_deadline",
  });
  expect(await infrastructureBackupStatus(env.DB)).toMatchObject({
    id: created[1],
    day: "2026-10-12",
    attempt: 1,
    status: "pending",
  });
});
it("clears a failed day's health and alert once a retry completes and reports that attempt as latest", async () => {
  const f = await fixture(),
    created: string[] = [],
    binding = recordingWorkflow(created),
    at = Date.now(),
    day = new Date(at).toISOString().slice(0, 10),
    c = await configureInfrastructureBackups(
      binding,
      config(f.region),
      at - 3 * 3600000,
    );
  // The failed attempt ended 100 minutes ago, so its retry is due.
  await env.DB.prepare(
    "INSERT INTO infrastructure_backup_runs(id,day,attempt,config_revision,status,created_at,completed_at,expires_at,error_code) VALUES(?,?,1,?,'failed',?,?,?,'infrastructure_backup_execution_failed')",
  )
    .bind(
      crypto.randomUUID(),
      day,
      c.revision,
      new Date(at - 7200000).toISOString(),
      new Date(at - 6000000).toISOString(),
      new Date(at + 5400000).toISOString(),
    )
    .run();
  const failure = async (now: number) => {
    await runInfrastructureHealthAlerts(env, now);
    return {
      health: (await infrastructureBackupHealth(env, now)).find(
        (value) => value.region_id === f.region,
      )?.status,
      alert: (await infrastructureAlertStatus(env.DB, f.region)).find(
        (value) => value.kind === "infrastructure_backup_failed",
      )?.active,
    };
  };
  expect(await failure(at)).toEqual({ health: "failing", alert: true });
  await runInfrastructureBackupCron(binding, at);
  // The failure stays one active episode while the retry captures.
  expect(await failure(at)).toEqual({ health: "failing", alert: true });
  const retry = created[0]!;
  expect(await initializeInfrastructureBackup(binding, retry)).toHaveLength(1);
  await recordPreparedBackups(binding, retry, [
    {
      run_id: retry,
      id: "d1-control",
      kind: "d1",
      day,
      region_id: f.region,
      source_id: c.d1_database_id,
      node_id: null,
      node_uid: null,
      cluster_uid: null,
      material_revision: null,
      kid: "v1",
      plaintext_sha256: "a".repeat(64),
      plaintext_bytes: 42,
      encrypted_sha256: "b".repeat(64),
      encrypted_bytes: 80,
    },
  ]);
  await completeBackupArtifact(binding, retry, "d1-control");
  await finishInfrastructureBackup(binding, retry);
  expect(await failure(Date.now())).toEqual({ health: "ok", alert: false });
  expect(
    await (await request("/v1/infrastructure-backups", f.admin)).json(),
  ).toMatchObject({
    latest: { id: retry, day, attempt: 2, status: "complete" },
    health: expect.arrayContaining([
      expect.objectContaining({
        kind: "d1",
        region_id: f.region,
        status: "ok",
      }),
    ]),
    // No attempt was ever held back.
    deferral: null,
  });
});
it("keeps each region's failed episode while a retry completes part of the backup and clears it once an attempt completes", async () => {
  const f = await fixture(),
    at = Date.now(),
    day = new Date(at).toISOString().slice(0, 10),
    minutes = (offset: number) => new Date(at + offset * 60000).toISOString(),
    cluster = crypto.randomUUID(),
    member = newNodeId(),
    memberUid = crypto.randomUUID(),
    etcd = `etcd-${f.foreign}`,
    c = await configureInfrastructureBackups(
      enabled(),
      config(f.region),
      at - 2 * 3600000,
    );
  // Region A holds the D1 export; region B has a current cluster with a live member.
  await storeRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.foreign, 1),
    {
      version: 1,
      cluster_name: "backup-retry-test",
      cluster_endpoint: "https://192.0.2.42:6443",
      kube_system_uid: cluster,
      talos_version: "1.14.1",
      kubernetes_version: "1.36.5",
      talos_machine_secrets_yaml: "cluster: private-test-material\n",
      talos_admin_config: "context: private-test-material\n",
      kubeconfig: "apiVersion: v1\ncontext: private-test-material\n",
    },
  );
  await env.DB.prepare(
    "INSERT INTO nodes(id,region_id,k8s_node_name,node_uid,ready,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at) VALUES(?,?,'member',?,1,4096,2000,30,128,100,?,?,?)",
  )
    .bind(member, f.foreign, memberUid, minutes(0), minutes(0), minutes(0))
    .run();
  const attempt = (id: string, number: number, start: number) =>
    env.DB.batch([
      env.DB.prepare(
        "INSERT INTO infrastructure_backup_runs(id,day,attempt,config_revision,status,created_at,expires_at) VALUES(?,?,?,?,'running',?,?)",
      ).bind(id, day, number, c.revision, minutes(start), minutes(start + 120)),
      env.DB.prepare(
        "INSERT INTO infrastructure_backup_artifacts(run_id,id,kind,day,region_id,source_id,status,object_key) VALUES(?,'d1-control','d1',?,?,?,'prepared',?)",
      ).bind(id, day, f.region, c.d1_database_id, `test/${id}/d1`),
      env.DB.prepare(
        "INSERT INTO infrastructure_backup_artifacts(run_id,id,kind,day,region_id,source_id,node_id,node_uid,cluster_uid,material_revision,status,object_key) VALUES(?,?,'etcd',?,?,?,?,?,?,1,'prepared',?)",
      ).bind(
        id,
        etcd,
        day,
        f.foreign,
        cluster,
        member,
        memberUid,
        cluster,
        `test/${id}/etcd`,
      ),
    ]);
  // Active infrastructure_backup_failed event id of region A and region B.
  const episodes = async () => {
    await runInfrastructureHealthAlerts(env, at);
    return Promise.all(
      [f.region, f.foreign].map(async (region) => {
        const alert = (await infrastructureAlertStatus(env.DB, region)).find(
          (value) => value.kind === "infrastructure_backup_failed",
        );
        return alert?.active ? alert.event_id : null;
      }),
    );
  };
  await env.DB.prepare(
    "INSERT INTO infrastructure_backup_runs(id,day,attempt,config_revision,status,created_at,completed_at,expires_at,error_code) VALUES(?,?,1,?,'failed',?,?,?,'infrastructure_backup_execution_failed')",
  )
    .bind(
      crypto.randomUUID(),
      day,
      c.revision,
      minutes(-110),
      minutes(-100),
      minutes(10),
    )
    .run();
  const failing = await episodes();
  expect(failing).toEqual([expect.any(String), expect.any(String)]);
  // Attempt 2 completes region A's export, then fails on region B's snapshot.
  const second = crypto.randomUUID();
  await attempt(second, 2, -90);
  await env.DB.prepare(
    "UPDATE infrastructure_backup_artifacts SET status='complete',completed_at=? WHERE run_id=? AND id='d1-control'",
  )
    .bind(minutes(-80), second)
    .run();
  expect(await episodes()).toEqual(failing);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE infrastructure_backup_artifacts SET status='failed',error_code='infrastructure_backup_snapshot_source_unavailable' WHERE run_id=? AND status!='complete'",
    ).bind(second),
    env.DB.prepare(
      "UPDATE infrastructure_backup_runs SET status='failed',completed_at=?,error_code='infrastructure_backup_snapshot_source_unavailable' WHERE id=?",
    ).bind(minutes(-70), second),
  ]);
  expect(await episodes()).toEqual(failing);
  // Attempt 3's receipts clear both episodes only once the attempt itself completes.
  const third = crypto.randomUUID();
  await attempt(third, 3, -60);
  await completeBackupArtifact(env, third, "d1-control");
  await completeBackupArtifact(env, third, etcd);
  expect(await episodes()).toEqual(failing);
  await finishInfrastructureBackup(env, third);
  expect(await episodes()).toEqual([null, null]);
});
it("polls a real D1 export's at_bookmark and stops on the provider's error without restarting", async () => {
  const f = await fixture(),
    at = Date.now(),
    run = crypto.randomUUID(),
    binding = enabled(),
    c = await configureInfrastructureBackups(binding, config(f.region), at);
  await env.DB.prepare(
    "INSERT INTO infrastructure_backup_runs(id,day,attempt,config_revision,status,created_at,expires_at) VALUES(?,?,1,?,'running',?,?)",
  )
    .bind(
      run,
      new Date(at).toISOString().slice(0, 10),
      c.revision,
      new Date(at).toISOString(),
      new Date(at + 3600000).toISOString(),
    )
    .run();
  const bodies: Record<string, unknown>[] = [];
  const exportURL = "https://export.example.com/control.sql";
  expect(
    await exportControlD1(binding, run, async (input, init) => {
      bodies.push(JSON.parse(init!.body as string));
      expect(new Request(input, init).redirect).toBe("manual");
      expect(init!.redirect).toBe("manual");
      expect(init!.signal).toBeInstanceOf(AbortSignal);
      return Response.json({
        success: true,
        result:
          bodies.length === 1
            ? { success: true, status: "active", at_bookmark: "same-export" }
            : {
                success: true,
                status: "complete",
                at_bookmark: "same-export",
                result: { filename: "control.sql", signed_url: exportURL },
              },
      });
    }),
  ).toBe(exportURL);
  expect(bodies).toEqual([
    {
      output_format: "polling",
      dump_options: { no_schema: false, no_data: false, tables: [] },
    },
    {
      output_format: "polling",
      dump_options: { no_schema: false, no_data: false, tables: [] },
      current_bookmark: "same-export",
    },
  ]);
  let failedCalls = 0;
  await expect(
    exportControlD1(binding, run, async () => {
      failedCalls++;
      return Response.json({
        success: true,
        result: {
          status: "error",
          at_bookmark: "failed-export",
          error: "private-provider-error",
        },
      });
    }),
  ).rejects.toThrow("infrastructure_backup_d1_export_failed");
  expect(failedCalls).toBe(1);
  let redirects = 0;
  await expect(
    exportControlD1(binding, run, async () => {
      redirects++;
      return new Response("not-json", {
        status: 302,
        headers: { location: "https://untrusted.example.test/export" },
      });
    }),
  ).rejects.toThrow("infrastructure_backup_d1_export_failed");
  expect(redirects).toBe(1);
});
it("polls the same export while D1 queries are locked and rechecks authority after completion", async () => {
  const f = await fixture(),
    at = Date.now(),
    run = crypto.randomUUID(),
    binding = enabled();
  const c = await configureInfrastructureBackups(binding, config(f.region), at);
  await env.DB.prepare(
    "INSERT INTO infrastructure_backup_runs(id,day,attempt,config_revision,status,created_at,expires_at) VALUES(?,?,1,?,'running',?,?)",
  )
    .bind(
      run,
      new Date(at).toISOString().slice(0, 10),
      c.revision,
      new Date(at).toISOString(),
      new Date(at + 3600000).toISOString(),
    )
    .run();
  let locked = false,
    calls = 0;
  const guarded = {
    ...binding,
    DB: new Proxy(binding.DB, {
      get(target, key) {
        if (key === "prepare")
          return (query: string) => {
            if (locked) throw Error("documented_d1_export_lock");
            return target.prepare(query);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
  const url = "https://export.example.com/control.sql";
  expect(
    await exportControlD1(guarded, run, async (_input, init) => {
      calls++;
      if (calls === 1) {
        locked = true;
        return Response.json({
          success: true,
          result: { status: "active", at_bookmark: "one-export" },
        });
      }
      expect(JSON.parse(init!.body as string).current_bookmark).toBe(
        "one-export",
      );
      locked = false;
      return Response.json({
        success: true,
        result: { status: "complete", result: { signed_url: url } },
      });
    }),
  ).toBe(url);
  expect(calls).toBe(2);
  await expect(
    exportControlD1(binding, run, async () => {
      await env.DB.prepare(
        "UPDATE infrastructure_backup_config SET enabled=0,revision=revision+1 WHERE singleton=1",
      ).run();
      return Response.json({
        success: true,
        result: { status: "complete", result: { signed_url: url } },
      });
    }),
  ).rejects.toThrow();
});
it("first failed run is failing without an older success; stale grace expires and optional email is generic and deduplicated", async () => {
  const f = await fixture(),
    at = Date.now(),
    run = crypto.randomUUID(),
    c = await configureInfrastructureBackups(
      enabled(),
      {
        ...config(f.region),
        notification_recipient: "operator@example.com",
        notification_sender: "alerts@example.com",
      },
      at - 3600000,
    );
  await env.DB.prepare(
    "INSERT INTO infrastructure_backup_runs(id,day,attempt,config_revision,status,created_at,expires_at) VALUES(?,?,1,?,'running',?,?)",
  )
    .bind(
      run,
      new Date(at).toISOString().slice(0, 10),
      c.revision,
      new Date(at - 1000).toISOString(),
      new Date(at + 3600000).toISOString(),
    )
    .run();
  await finishInfrastructureBackup(
    env,
    run,
    new Error("infrastructure_backup_snapshot_source_unavailable"),
  );
  expect(await infrastructureBackupHealth(env, Date.now())).toContainEqual(
    expect.objectContaining({
      kind: "d1",
      region_id: f.region,
      status: "failing",
    }),
  );
  const sent: {
    url: string;
    body: Record<string, unknown>;
    key: string | null;
  }[] = [];
  const transport: typeof fetch = async (input, init) => {
    sent.push({
      url: String(input),
      body: JSON.parse(init!.body as string),
      key: new Headers(init!.headers).get("Idempotency-Key"),
    });
    return new Response(null, { status: 202 });
  };
  await runInfrastructureHealthAlerts(
    { ...env, RESEND_API_KEY: "test-private-resend-key" },
    Date.now(),
    transport,
  );
  await runInfrastructureHealthAlerts(
    { ...env, RESEND_API_KEY: "test-private-resend-key" },
    Date.now() + 60001,
    transport,
  );
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    url: "https://api.resend.com/emails",
    body: { to: ["operator@example.com"], from: "alerts@example.com" },
  });
  expect(sent[0]!.key).toBe(
    (await infrastructureAlertStatus(env.DB, f.region)).find(
      (a) => a.kind === "infrastructure_backup_failed",
    )!.event_id,
  );
  await env.DB.prepare("DELETE FROM infrastructure_backup_runs").run();
  expect(
    await infrastructureBackupHealth(env, at + 37 * 3600000),
  ).toContainEqual(expect.objectContaining({ status: "stale" }));
});
it("retains lost/stale node episodes using existing heartbeat freshness, without recipient defaults", async () => {
  const f = await fixture(),
    at = Date.now();
  await env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
    .bind(new Date(at - 200000).toISOString(), f.node)
    .run();
  let sent = 0;
  await runInfrastructureHealthAlerts(
    { ...env, RESEND_API_KEY: "test-secret" },
    at,
    async () => {
      sent++;
      return new Response(null, { status: 202 });
    },
  );
  expect(sent).toBe(0);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toContainEqual(
    expect.objectContaining({
      kind: "regional_node_stale",
      active: true,
      delivered_at: null,
    }),
  );
  await env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
    .bind(new Date(at + 1).toISOString(), f.node)
    .run();
  await runInfrastructureHealthAlerts(env, at + 1);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toContainEqual(
    expect.objectContaining({ kind: "regional_node_stale", active: false }),
  );
});
it("derived backup encryption retains the selected key version without changing credential material", async () => {
  const first = await infrastructureBackupKey(env.CREDENTIAL_KEYS),
    second = await infrastructureBackupKey(env.CREDENTIAL_KEYS);
  expect(first).toEqual(second);
  expect(first.kid).toBe("v1");
  expect(first.key).not.toBe(JSON.parse(env.CREDENTIAL_KEYS).keys.v1);
});
it("prepared artifact receipts accept full D1 rows by their exact bound identity and reject cross-run callbacks", async () => {
  const f = await fixture(),
    at = Date.now(),
    run = crypto.randomUUID(),
    c = await configureInfrastructureBackups(enabled(), config(f.region), at);
  const day = new Date(at).toISOString().slice(0, 10);
  await env.DB.prepare(
    "INSERT INTO infrastructure_backup_runs(id,day,attempt,config_revision,status,created_at,expires_at) VALUES(?,?,1,?,'running',?,?)",
  )
    .bind(
      run,
      day,
      c.revision,
      new Date(at).toISOString(),
      new Date(at + 3600000).toISOString(),
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO infrastructure_backup_artifacts(run_id,id,kind,day,region_id,source_id,status,object_key) VALUES(?,'d1-control','d1',?,?,?,'pending',?)",
  )
    .bind(run, day, f.region, c.d1_database_id, `test/${run}`)
    .run();
  const metadata = {
    run_id: run,
    id: "d1-control",
    kind: "d1",
    day,
    region_id: f.region,
    source_id: c.d1_database_id,
    node_id: null,
    node_uid: null,
    cluster_uid: null,
    material_revision: null,
    kid: "v1",
    plaintext_sha256: "a".repeat(64),
    plaintext_bytes: 42,
    encrypted_sha256: "b".repeat(64),
    encrypted_bytes: 80,
  };
  await expect(
    recordPreparedBackups(env, run, [
      { ...metadata, run_id: crypto.randomUUID() },
    ]),
  ).rejects.toThrow("artifact_identity_changed");
  await recordPreparedBackups(env, run, [metadata]);
  expect(await infrastructureBackupStatus(env.DB, run)).toMatchObject({
    artifacts: [{ status: "prepared", plaintext_bytes: 42 }],
  });
  await expect(
    authorizeBackupOperator(env, run, "d1-control", "Bearer invalid"),
  ).rejects.toThrow("capability");
});
it("R2 multipart writes bounded parts and preserves a committed unique object after uncertain completion", async () => {
  const key = `test-infra-${crypto.randomUUID()}`,
    bytes = new Uint8Array(17 * 1024 * 1024 + 7);
  bytes.fill(37);
  const chunks = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 10 * 1024 * 1024));
      controller.enqueue(bytes.subarray(10 * 1024 * 1024));
      controller.close();
    },
  });
  let completions = 0,
    aborts = 0;
  const partSizes: number[] = [];
  const uncertainBucket = {
    async createMultipartUpload(
      objectKey: string,
      options: R2MultipartOptions,
    ) {
      const actual = await env.ARCHIVE.createMultipartUpload(
        objectKey,
        options,
      );
      return {
        async uploadPart(part: number, body: Uint8Array) {
          partSizes.push(body.length);
          return actual.uploadPart(part, body);
        },
        async complete(parts: R2UploadedPart[]) {
          completions++;
          await actual.complete(parts);
          throw new Error("completion_response_lost");
        },
        async abort() {
          aborts++;
          await actual.abort();
        },
      };
    },
    head: (objectKey: string) => env.ARCHIVE.head(objectKey),
  } as unknown as R2Bucket;
  await uploadInfrastructureArtifact(uncertainBucket, key, chunks, {
    run_id: "test-run",
  });
  expect(partSizes).toEqual([
    8 * 1024 * 1024,
    8 * 1024 * 1024,
    1024 * 1024 + 7,
  ]);
  expect(completions).toBe(1);
  expect(aborts).toBe(0);
  const object = await env.ARCHIVE.get(key);
  expect(object!.size).toBe(bytes.length);
  const actual = new Uint8Array(await object!.arrayBuffer());
  expect(actual.length).toBe(bytes.length);
  expect(actual[0]).toBe(37);
  expect(actual.at(-1)).toBe(37);
  await env.ARCHIVE.delete(key);
});

it("binds one fresh control snapshot source, skips a region without live members and revokes its daily capability on a changed Node UID", async () => {
  const f = await fixture(),
    binding = enabled(),
    now = Date.now(),
    run = crypto.randomUUID(),
    configured = await configureInfrastructureBackups(
      binding,
      config(f.region),
      now,
    ),
    cluster = crypto.randomUUID(),
    release = "daily-backup-test-" + crypto.randomUUID();
  const uid = await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
      .bind(f.node)
      .first<string>("node_uid"),
    agent = await env.DB.prepare(
      "SELECT agent_key_hash FROM regions WHERE id=?",
    )
      .bind(f.region)
      .first<string>("agent_key_hash");
  await storeRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 1),
    {
      version: 1,
      cluster_name: "daily-backup-test",
      cluster_endpoint: "https://192.0.2.40:6443",
      kube_system_uid: cluster,
      talos_version: "1.14.1",
      kubernetes_version: "1.36.5",
      talos_machine_secrets_yaml: "cluster: private-test-material\n",
      talos_admin_config: "context: private-test-material\n",
      kubeconfig: "apiVersion: v1\ncontext: private-test-material\n",
    },
  );
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE regions SET bootstrap_material_revision=1 WHERE id=?",
    ).bind(f.region),
    env.DB.prepare(
      "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES(?,?,?,?)",
    ).bind(
      release,
      JSON.stringify({
        components: [
          {
            name: "image/cilium/cilium",
            reference: "quay.io/cilium/cilium:v1.20.2@sha256:" + "a".repeat(64),
            sha256: "a".repeat(64),
          },
        ],
      }),
      "c".repeat(64),
      new Date(now).toISOString(),
    ),
    env.DB.prepare(
      "INSERT INTO fleet_node_releases(node_id,node_uid,release_id,role,revision,updated_at) VALUES(?,?,?,'control_relay',1,?)",
    ).bind(f.node, uid, release, new Date(now).toISOString()),
    env.DB.prepare(
      "INSERT INTO fleet_node_release_observations(node_id,node_uid,assignment_revision,agent_key_hash,facts_json,observed_at,received_at) VALUES(?,?,1,?,?,?,?)",
    ).bind(
      f.node,
      uid,
      agent,
      JSON.stringify({
        kubernetes_control_plane: true,
        components: [
          { name: "image/cilium/cilium", runtime_image_sha256: "a".repeat(64) },
        ],
      }),
      new Date(now).toISOString(),
      new Date(now).toISOString(),
    ),
    env.DB.prepare(
      "INSERT INTO infrastructure_backup_runs(id,day,attempt,config_revision,status,created_at,expires_at) VALUES(?,?,1,?,'pending',?,?)",
    ).bind(
      run,
      new Date(now).toISOString().slice(0, 10),
      configured.revision,
      new Date(now).toISOString(),
      new Date(now + 3600000).toISOString(),
    ),
  ]);
  // A cluster whose only physical member is lost has no snapshot source.
  const retired = newNodeId();
  await storeRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.foreign, 1),
    {
      version: 1,
      cluster_name: "daily-backup-retired",
      cluster_endpoint: "https://192.0.2.41:6443",
      kube_system_uid: crypto.randomUUID(),
      talos_version: "1.14.1",
      kubernetes_version: "1.36.5",
      talos_machine_secrets_yaml: "cluster: private-test-material\n",
      talos_admin_config: "context: private-test-material\n",
      kubeconfig: "apiVersion: v1\ncontext: private-test-material\n",
    },
  );
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE regions SET bootstrap_material_revision=1 WHERE id=?",
    ).bind(f.foreign),
    env.DB.prepare(
      "INSERT INTO nodes(id,region_id,k8s_node_name,node_uid,ready,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at) VALUES(?,?,'retired',?,1,4096,2000,30,128,100,?,?,?)",
    ).bind(
      retired,
      f.foreign,
      crypto.randomUUID(),
      new Date(now).toISOString(),
      new Date(now).toISOString(),
      new Date(now).toISOString(),
    ),
    env.DB.prepare(
      "UPDATE nodes SET lost_at=?,lost_reason='test loss',ready=0,schedulable=0 WHERE id=?",
    ).bind(new Date(now).toISOString(), retired),
  ]);
  const artifacts = await initializeInfrastructureBackup(binding, run);
  expect(artifacts).toHaveLength(2);
  expect(
    (await infrastructureBackupHealth(binding, now)).filter(
      (value) => value.region_id === f.foreign,
    ),
  ).toEqual([]);
  const input = await prepareInfrastructureBackupInput(
      binding,
      run,
      "https://exports.example.test/control.sql",
    ),
    source = input.artifacts.find((value) => value.kind === "etcd")!;
  expect(source.node_id).toBe(f.node);
  expect(source.cluster_uid).toBe(cluster);
  expect(source.source!.cilium_image).toBe(
    "quay.io/cilium/cilium:v1.20.2@sha256:" + "a".repeat(64),
  );
  expect(source.source!.cilium_image_id).toBe(
    "quay.io/cilium/cilium:v1.20.2@sha256:" + "a".repeat(64),
  );
  expect(
    (
      await authorizeBackupOperator(
        binding,
        run,
        source.id,
        `Bearer ${source.source!.operator_token}`,
      )
    ).node_id,
  ).toBe(f.node);
  await env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?")
    .bind(crypto.randomUUID(), f.node)
    .run();
  await expect(
    authorizeBackupOperator(
      binding,
      run,
      source.id,
      `Bearer ${source.source!.operator_token}`,
    ),
  ).rejects.toThrow("authority changed");
  await env.DB.prepare("DELETE FROM fleet_node_releases WHERE node_id=?")
    .bind(f.node)
    .run();
  await env.DB.prepare(
    "DELETE FROM fleet_node_release_observations WHERE node_id=?",
  )
    .bind(f.node)
    .run();
});

it("does not reuse a same-region success after the configured D1 database or sealed cluster identity changes", async () => {
  const f = await fixture(),
    now = Date.now(),
    binding = enabled(),
    run = crypto.randomUUID(),
    selected = await configureInfrastructureBackups(
      binding,
      config(f.region),
      now,
    ),
    oldCluster = crypto.randomUUID(),
    newCluster = crypto.randomUUID(),
    nodeUid = await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
      .bind(f.node)
      .first<string>("node_uid");
  const bundle = (uid: string) => ({
    version: 1 as const,
    cluster_name: "backup-health-test",
    cluster_endpoint: "https://192.0.2.40:6443",
    kube_system_uid: uid,
    talos_version: "1.14.1",
    kubernetes_version: "1.36.5",
    talos_machine_secrets_yaml: "cluster: private-test-material\n",
    talos_admin_config: "context: private-test-material\n",
    kubeconfig: "apiVersion: v1\ncontext: private-test-material\n",
  });
  await storeRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 1),
    bundle(oldCluster),
  );
  const at = new Date(now).toISOString(),
    day = at.slice(0, 10);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE regions SET bootstrap_material_revision=1 WHERE id=?",
    ).bind(f.region),
    env.DB.prepare(
      "INSERT INTO infrastructure_backup_runs(id,day,attempt,config_revision,status,created_at,completed_at,expires_at) VALUES(?,?,1,?,'complete',?,?,?)",
    ).bind(
      run,
      day,
      selected.revision,
      at,
      at,
      new Date(now + 3600000).toISOString(),
    ),
    env.DB.prepare(
      "INSERT INTO infrastructure_backup_artifacts(run_id,id,kind,day,region_id,source_id,status,completed_at,object_key) VALUES(?,'d1-control','d1',?,?,?,'complete',?,?)",
    ).bind(run, day, f.region, selected.d1_database_id, at, `test/${run}/d1`),
    env.DB.prepare(
      "INSERT INTO infrastructure_backup_artifacts(run_id,id,kind,day,region_id,source_id,node_id,node_uid,cluster_uid,material_revision,status,completed_at,object_key) VALUES(?,'etcd-control','etcd',?,?,?,?,?,?,1,'complete',?,?)",
    ).bind(
      run,
      day,
      f.region,
      oldCluster,
      f.node,
      nodeUid,
      oldCluster,
      at,
      `test/${run}/etcd`,
    ),
  ]);
  expect(
    (await infrastructureBackupHealth(env, now))
      .filter((value) => value.region_id === f.region)
      .map((value) => value.status),
  ).toEqual(["ok", "ok"]);
  await configureInfrastructureBackups(
    binding,
    {
      enabled: true,
      d1_account_id: selected.d1_account_id,
      d1_database_id: crypto.randomUUID(),
      d1_region_id: selected.d1_region_id,
      notification_recipient: null,
      notification_sender: null,
    },
    now + 1,
  );
  const d1AfterReconfiguration = (
    await infrastructureBackupHealth(env, now + 2)
  ).find(
    (value) => value.kind === "d1" && value.region_id === f.region,
  )?.status;
  await storeRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 2),
    bundle(newCluster),
  );
  await env.DB.prepare(
    "UPDATE regions SET bootstrap_material_revision=2 WHERE id=?",
  )
    .bind(f.region)
    .run();
  const fresh = await infrastructureBackupHealth(env, now + 3);
  expect([
    d1AfterReconfiguration,
    fresh.find((value) => value.kind === "etcd" && value.region_id === f.region)
      ?.status,
  ]).toEqual(["unknown", "unknown"]);
  expect(fresh.every((value) => value.last_completed_at === null)).toBe(true);
});
