// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import type { Env } from "../../src/env.ts";
import {
  captureInfrastructureArtifact,
  completeBackupArtifact,
  configureInfrastructureBackups,
  exportControlD1,
  finishInfrastructureBackup,
  initializeInfrastructureBackup,
  infrastructureBackupHealth,
  infrastructureBackupKey,
  infrastructureBackupStatus,
  readInfrastructureBackupConfig,
  readInfrastructureBackupRun,
  recordPreparedBackups,
  runInfrastructureBackupCron,
  uploadInfrastructureArtifact,
  verifyInfrastructureArtifact,
} from "../../src/domain/infrastructure-backups.ts";
import {
  runInfrastructureHealthAlerts,
  infrastructureAlertStatus,
} from "../../src/domain/infrastructure-alerts.ts";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";
afterEach(async () => {
  await env.DB.prepare("DELETE FROM infrastructure_backup_runs").run();
  await env.DB.prepare(
    "UPDATE infrastructure_backup_config SET enabled=0,d1_account_id=NULL,d1_database_id=NULL,d1_region_id=NULL,notification_recipient=NULL,notification_sender=NULL,enabled_at=NULL,updated_at=NULL,revision=0 WHERE singleton=1",
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
  });
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
it("keeps a failed backup episode while its health is unknown instead of clearing and re-sending it", async () => {
  const f = await fixture(),
    at = Date.now(),
    run = crypto.randomUUID(),
    c = await configureInfrastructureBackups(
      enabled(),
      config(f.region),
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
  await runInfrastructureHealthAlerts(enabled(), Date.now());
  const armed = (await infrastructureAlertStatus(env.DB, f.region)).find(
    (a) => a.kind === "infrastructure_backup_failed",
  );
  expect(armed).toMatchObject({ active: true });
  // The run history is gone: nothing failed, nothing completed and the 36 h grace has not run out.
  await env.DB.prepare("DELETE FROM infrastructure_backup_runs").run();
  expect(await infrastructureBackupHealth(env, Date.now())).toContainEqual(
    expect.objectContaining({
      kind: "d1",
      region_id: f.region,
      status: "unknown",
    }),
  );
  await runInfrastructureHealthAlerts(enabled(), Date.now() + 1000);
  expect(
    (await infrastructureAlertStatus(env.DB, f.region)).find(
      (a) => a.kind === "infrastructure_backup_failed",
    ),
  ).toMatchObject({ active: true, event_id: armed!.event_id });
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
it("prepared artifact receipts accept full D1 rows by their exact bound identity and reject another run's", async () => {
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

it("does not reuse a same-region success after the configured D1 database changes", async () => {
  const f = await fixture(),
    now = Date.now(),
    binding = enabled(),
    run = crypto.randomUUID(),
    selected = await configureInfrastructureBackups(
      binding,
      config(f.region),
      now,
    );
  const at = new Date(now).toISOString(),
    day = at.slice(0, 10);
  await env.DB.batch([
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
  ]);
  expect(
    (await infrastructureBackupHealth(env, now))
      .filter((value) => value.region_id === f.region)
      .map((value) => value.status),
  ).toEqual(["ok"]);
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
  const fresh = await infrastructureBackupHealth(env, now + 2);
  expect(fresh.map((value) => [value.kind, value.status])).toEqual([
    ["d1", "unknown"],
  ]);
  expect(fresh.every((value) => value.last_completed_at === null)).toBe(true);
});

/** A running daily run of the configured D1 export with its artifact fixed, as the Workflow sees it. */
async function capturedRun() {
  const f = await fixture(),
    at = Date.now(),
    run = crypto.randomUUID(),
    binding = enabled(),
    c = await configureInfrastructureBackups(binding, config(f.region), at);
  await env.DB.prepare(
    "INSERT INTO infrastructure_backup_runs(id,day,attempt,config_revision,status,created_at,expires_at) VALUES(?,?,1,?,'pending',?,?)",
  )
    .bind(
      run,
      new Date(at).toISOString().slice(0, 10),
      c.revision,
      new Date(at).toISOString(),
      new Date(at + 3600000).toISOString(),
    )
    .run();
  const [artifact] = await initializeInfrastructureBackup(binding, run);
  return { f, run, binding, artifact: artifact! };
}
/** The export as the signed URL serves it, in small uneven chunks. */
function exportServer(...bodies: Uint8Array[]) {
  const requests: RequestInit[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    requests.push(init!);
    const bytes = bodies[Math.min(requests.length, bodies.length) - 1]!;
    let offset = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (offset === bytes.length) return controller.close();
          const end = Math.min(offset + 4099, bytes.length);
          controller.enqueue(bytes.slice(offset, end));
          offset = end;
        },
      }),
    );
  };
  return { fetcher, requests };
}
const dump = (text: string) => new TextEncoder().encode(text.repeat(2000));

it("encrypts the D1 export into its R2 object as a PGCFINF1 envelope and completes only after full readback", async () => {
  const { run, binding, artifact } = await capturedRun(),
    plain = dump("INSERT INTO retained VALUES (7);\n"),
    server = exportServer(plain);
  await captureInfrastructureArtifact(
    binding,
    run,
    artifact.id,
    "https://export.example.com/control.sql",
    server.fetcher,
  );
  // One read measures the export, the second one is encrypted; neither follows a redirect.
  expect(server.requests.map((init) => init.redirect)).toEqual([
    "error",
    "error",
  ]);
  const [prepared] = (await readInfrastructureBackupRun(env.DB, run)).artifacts;
  expect(prepared).toMatchObject({
    status: "prepared",
    kid: "v1",
    plaintext_bytes: plain.length,
  });
  const object = await env.ARCHIVE.get(artifact.object_key);
  expect(object!.customMetadata).toEqual({
    run_id: run,
    artifact_id: artifact.id,
    kid: "v1",
  });
  const envelope = new Uint8Array(await object!.arrayBuffer());
  expect(envelope.length).toBe(prepared!.encrypted_bytes);
  // The documented layout opens with WebCrypto alone: magic, AAD length, AAD, nonce, ciphertext
  // and tag, under the key derived from the recorded kid.
  expect(new TextDecoder().decode(envelope.subarray(0, 8))).toBe("PGCFINF1");
  const length = new DataView(envelope.buffer).getUint32(8),
    aad = envelope.subarray(12, 12 + length),
    nonce = envelope.subarray(12 + length, 24 + length);
  expect(JSON.parse(new TextDecoder().decode(aad))).toMatchObject({
    version: 1,
    run_id: run,
    artifact_id: artifact.id,
    kind: "d1",
    kid: "v1",
    plaintext_bytes: plain.length,
    plaintext_sha256: prepared!.plaintext_sha256,
  });
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(
      atob(
        (await infrastructureBackupKey(env.CREDENTIAL_KEYS, "v1")).key
          .replace(/-/g, "+")
          .replace(/_/g, "/"),
      ),
      (c) => c.charCodeAt(0),
    ),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const opened = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
      key,
      envelope.subarray(24 + length),
    ),
  );
  expect(opened).toEqual(plain);
  expect(
    (await verifyInfrastructureArtifact(binding, run, artifact.id))
      .readback_verified,
  ).toBe(true);
  await finishInfrastructureBackup(binding, run);
  expect(await infrastructureBackupStatus(env.DB, run)).toMatchObject({
    status: "complete",
    artifacts: [{ status: "complete", encrypted_bytes: envelope.length }],
  });
  await env.ARCHIVE.delete(artifact.object_key);
});

it("stores nothing when the export changes between its two reads and never overwrites a run's object", async () => {
  const changed = await capturedRun(),
    server = exportServer(dump("first;\n"), dump("other;\n"));
  await expect(
    captureInfrastructureArtifact(
      changed.binding,
      changed.run,
      changed.artifact.id,
      "https://export.example.com/control.sql",
      server.fetcher,
    ),
  ).rejects.toThrow("infrastructure_backup_source_changed");
  expect(await env.ARCHIVE.head(changed.artifact.object_key)).toBeNull();
  expect(
    (await readInfrastructureBackupRun(env.DB, changed.run)).artifacts[0]!
      .status,
  ).toBe("pending");
  await env.ARCHIVE.put(changed.artifact.object_key, "foreign");
  await expect(
    captureInfrastructureArtifact(
      changed.binding,
      changed.run,
      changed.artifact.id,
      "https://export.example.com/control.sql",
      exportServer(dump("first;\n")).fetcher,
    ),
  ).rejects.toThrow("infrastructure_backup_object_exists");
  expect(
    await (await env.ARCHIVE.get(changed.artifact.object_key))!.text(),
  ).toBe("foreign");
  await env.ARCHIVE.delete(changed.artifact.object_key);
});

it("refuses a readback whose bytes, identity or key differ from the prepared receipt", async () => {
  const { run, binding, artifact } = await capturedRun();
  await captureInfrastructureArtifact(
    binding,
    run,
    artifact.id,
    "https://export.example.com/control.sql",
    exportServer(dump("CREATE TABLE t (id INTEGER);\n")).fetcher,
  );
  const object = await env.ARCHIVE.get(artifact.object_key),
    bytes = new Uint8Array(await object!.arrayBuffer()),
    metadata = object!.customMetadata!;
  bytes[bytes.length - 40] = bytes[bytes.length - 40]! ^ 1;
  await env.ARCHIVE.put(artifact.object_key, bytes, {
    customMetadata: metadata,
  });
  await expect(
    verifyInfrastructureArtifact(binding, run, artifact.id),
  ).rejects.toThrow("infrastructure_backup_readback_failed");
  bytes[bytes.length - 40] = bytes[bytes.length - 40]! ^ 1;
  await env.ARCHIVE.put(artifact.object_key, bytes, {
    customMetadata: { ...metadata, run_id: crypto.randomUUID() },
  });
  await expect(
    verifyInfrastructureArtifact(binding, run, artifact.id),
  ).rejects.toThrow("infrastructure_backup_r2_identity_changed");
  await env.ARCHIVE.put(artifact.object_key, bytes, {
    customMetadata: metadata,
  });
  await expect(
    verifyInfrastructureArtifact(
      {
        ...binding,
        CREDENTIAL_KEYS: JSON.stringify({
          active: "v1",
          keys: {
            v1: btoa(
              String.fromCharCode(
                ...crypto.getRandomValues(new Uint8Array(32)),
              ),
            )
              .replace(/\+/g, "-")
              .replace(/\//g, "_")
              .replace(/=+$/, ""),
          },
        }),
      },
      run,
      artifact.id,
    ),
  ).rejects.toThrow("infrastructure_backup_readback_failed");
  expect(
    (await verifyInfrastructureArtifact(binding, run, artifact.id))
      .readback_verified,
  ).toBe(true);
  await env.ARCHIVE.delete(artifact.object_key);
});

it("reads an earlier run that also captured an etcd snapshot as its D1 export alone", async () => {
  const f = await fixture(),
    at = new Date().toISOString(),
    day = at.slice(0, 10),
    run = crypto.randomUUID(),
    c = await configureInfrastructureBackups(enabled(), config(f.region));
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO infrastructure_backup_runs(id,day,attempt,config_revision,status,created_at,completed_at,expires_at) VALUES(?,?,1,?,'complete',?,?,?)",
    ).bind(run, day, c.revision, at, at, at),
    env.DB.prepare(
      "INSERT INTO infrastructure_backup_artifacts(run_id,id,kind,day,region_id,source_id,status,completed_at,object_key) VALUES(?,'d1-control','d1',?,?,?,'complete',?,?)",
    ).bind(run, day, f.region, c.d1_database_id, at, `test/${run}/d1`),
    env.DB.prepare(
      "INSERT INTO infrastructure_backup_artifacts(run_id,id,kind,day,region_id,source_id,status,completed_at,object_key) VALUES(?,?,'etcd',?,?,?,'complete',?,?)",
    ).bind(
      run,
      `etcd-${f.region}`,
      day,
      f.region,
      crypto.randomUUID(),
      at,
      `test/${run}/etcd`,
    ),
  ]);
  expect(await infrastructureBackupStatus(env.DB, run)).toMatchObject({
    status: "complete",
    artifacts: [{ id: "d1-control", kind: "d1" }],
  });
  expect(
    await (await request("/v1/infrastructure-backups", f.admin)).json(),
  ).toMatchObject({ latest: { id: run, artifacts: [{ kind: "d1" }] } });
});
