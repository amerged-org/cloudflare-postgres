// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { bytesToHex } from "@pgcf/contracts";
import type { Env } from "../../src/env.ts";
import {
  assertBackupRun,
  configureInfrastructureBackups,
  initializeInfrastructureBackup,
  readInfrastructureBackupConfig,
  runInfrastructureBackupCron,
} from "../../src/domain/infrastructure-backups.ts";
import { cleanupFixtures, fixture } from "./fixtures.ts";

afterEach(async () => {
  await env.DB.exec("DROP TRIGGER IF EXISTS backup_notification_rollback");
  await env.DB.prepare("DELETE FROM infrastructure_backup_runs").run();
  await env.DB.prepare(
    "UPDATE infrastructure_backup_config SET enabled=0,d1_account_id=NULL,d1_database_id=NULL,d1_region_id=NULL,notification_recipient=NULL,notification_sender=NULL,enabled_at=NULL,updated_at=NULL,revision=0 WHERE singleton=1",
  ).run();
  await cleanupFixtures();
});

async function configured() {
  const f = await fixture(),
    binding: Env = {
      ...env,
      INFRASTRUCTURE_BACKUP_CF_TOKEN: crypto.randomUUID(),
    },
    input = {
      enabled: true,
      d1_account_id: "a".repeat(32),
      d1_database_id: crypto.randomUUID(),
      d1_region_id: f.region,
      notification_recipient: null as string | null,
      notification_sender: null as string | null,
    },
    config = await configureInfrastructureBackups(binding, input);
  return { ...f, binding, input, config };
}

async function run(
  configRevision: number,
  attempt = 1,
  status = "pending",
  expires = new Date(Date.now() + 3600000).toISOString(),
) {
  const id = crypto.randomUUID(),
    at = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO infrastructure_backup_runs(id,day,attempt,config_revision,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?)",
  )
    .bind(id, at.slice(0, 10), attempt, configRevision, status, at, expires)
    .run();
  return { id, expires };
}

const revision = (id: string) =>
  env.DB.prepare(
    "SELECT config_revision FROM infrastructure_backup_runs WHERE id=?",
  )
    .bind(id)
    .first<number>("config_revision");

async function hash(value: unknown) {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
  );
}

it("preserves pending and running capture authority, expiry and artifacts when only alert email changes", async () => {
  const f = await configured(),
    pending = await run(f.config.revision),
    recipient = {
      ...f.input,
      notification_recipient: "operator@example.invalid",
    },
    first = await configureInfrastructureBackups(f.binding, recipient);
  expect(first.revision).toBe(f.config.revision + 1);
  const queued = await assertBackupRun(f.binding, pending.id);
  expect(queued.row).toMatchObject({
    status: "pending",
    config_revision: first.revision,
    expires_at: pending.expires,
  });
  expect(
    await initializeInfrastructureBackup(f.binding, pending.id),
  ).toHaveLength(1);
  const beforeHash = await hash(
      (await assertBackupRun(f.binding, pending.id)).artifacts,
    ),
    second = await configureInfrastructureBackups(f.binding, {
      ...recipient,
      notification_sender: "alerts@example.invalid",
    });
  expect(second.revision).toBe(first.revision + 1);
  expect(second.enabled_at).toBe(first.enabled_at);
  const active = await assertBackupRun(f.binding, pending.id);
  expect(active.row).toMatchObject({
    status: "running",
    config_revision: second.revision,
    expires_at: pending.expires,
  });
  expect(await hash(active.artifacts)).toBe(beforeHash);
});

it("revokes changed export/archive authority and never resurrects it with a later email-only update", async () => {
  const f = await configured(),
    original = await run(f.config.revision),
    destination = {
      ...f.input,
      d1_database_id: crypto.randomUUID(),
    },
    changed = await configureInfrastructureBackups(f.binding, destination);
  expect(changed.revision).toBe(f.config.revision + 1);
  expect(await revision(original.id)).toBe(f.config.revision);
  await expect(assertBackupRun(f.binding, original.id)).rejects.toThrow(
    "infrastructure_backup_authority_expired",
  );
  const emailed = await configureInfrastructureBackups(f.binding, {
    ...destination,
    notification_recipient: "operator@example.invalid",
  });
  expect(emailed.revision).toBe(changed.revision + 1);
  expect(await revision(original.id)).toBe(f.config.revision);
  await expect(assertBackupRun(f.binding, original.id)).rejects.toThrow(
    "infrastructure_backup_authority_expired",
  );
  const current = await run(emailed.revision, 2),
    disabled = await configureInfrastructureBackups(f.binding, {
      ...destination,
      enabled: false,
    });
  expect(await revision(current.id)).toBe(emailed.revision);
  await expect(assertBackupRun(f.binding, current.id)).rejects.toThrow(
    "infrastructure_backup_authority_expired",
  );
  const reenabled = await configureInfrastructureBackups(f.binding, {
    ...destination,
    notification_sender: "alerts@example.invalid",
  });
  expect(reenabled.revision).toBe(disabled.revision + 1);
  expect(await revision(current.id)).toBe(emailed.revision);
  await expect(assertBackupRun(f.binding, current.id)).rejects.toThrow(
    "infrastructure_backup_authority_expired",
  );
});

it("revokes an account-only or archive-region-only change independently of email settings", async () => {
  const f = await configured(),
    original = await run(f.config.revision),
    accountInput = { ...f.input, d1_account_id: "b".repeat(32) },
    account = await configureInfrastructureBackups(f.binding, accountInput);
  expect(account.revision).toBe(f.config.revision + 1);
  expect(await revision(original.id)).toBe(f.config.revision);
  await expect(assertBackupRun(f.binding, original.id)).rejects.toThrow(
    "infrastructure_backup_authority_expired",
  );
  const current = await run(account.revision, 2),
    regionInput = { ...accountInput, d1_region_id: f.foreign },
    region = await configureInfrastructureBackups(f.binding, regionInput);
  expect(region.revision).toBe(account.revision + 1);
  expect(await revision(current.id)).toBe(account.revision);
  await expect(assertBackupRun(f.binding, current.id)).rejects.toThrow(
    "infrastructure_backup_authority_expired",
  );
  await configureInfrastructureBackups(f.binding, {
    ...regionInput,
    notification_sender: "alerts@example.invalid",
  });
  expect(await revision(current.id)).toBe(account.revision);
  await expect(assertBackupRun(f.binding, current.id)).rejects.toThrow(
    "infrastructure_backup_authority_expired",
  );
});

it("carries no stale, expired or terminal run across an email update", async () => {
  const f = await configured(),
    stale = await run(f.config.revision - 1),
    expired = await run(
      f.config.revision,
      2,
      "running",
      new Date(Date.now() - 1000).toISOString(),
    ),
    complete = await run(f.config.revision, 3, "complete"),
    failed = await run(f.config.revision, 4, "failed");
  await configureInfrastructureBackups(f.binding, {
    ...f.input,
    notification_sender: "alerts@example.invalid",
  });
  expect(await revision(stale.id)).toBe(f.config.revision - 1);
  expect(await revision(expired.id)).toBe(f.config.revision);
  expect(await revision(complete.id)).toBe(f.config.revision);
  expect(await revision(failed.id)).toBe(f.config.revision);
  await expect(assertBackupRun(f.binding, stale.id)).rejects.toThrow(
    "infrastructure_backup_authority_expired",
  );
  await expect(assertBackupRun(f.binding, expired.id)).rejects.toThrow(
    "infrastructure_backup_authority_expired",
  );
});

it("rolls back the valid run carry when SQLite rejects the config update in the same batch", async () => {
  const f = await configured(),
    pending = await run(f.config.revision);
  await env.DB.exec(
    "CREATE TRIGGER backup_notification_rollback BEFORE UPDATE ON infrastructure_backup_config WHEN NEW.notification_recipient IS NOT OLD.notification_recipient BEGIN SELECT RAISE(ABORT,'backup_notification_test_rollback'); END",
  );
  await expect(
    configureInfrastructureBackups(f.binding, {
      ...f.input,
      notification_recipient: "operator@example.invalid",
    }),
  ).rejects.toThrow("backup_notification_test_rollback");
  expect(await readInfrastructureBackupConfig(env.DB)).toMatchObject({
    revision: f.config.revision,
    notification_recipient: null,
  });
  expect(await revision(pending.id)).toBe(f.config.revision);
  expect((await assertBackupRun(f.binding, pending.id)).row.expires_at).toBe(
    pending.expires,
  );
});

it("reads one coherent authority snapshot during a real concurrent notification update", async () => {
  const f = await configured(),
    pending = await run(f.config.revision),
    reading = assertBackupRun(f.binding, pending.id),
    updating = configureInfrastructureBackups(f.binding, {
      ...f.input,
      notification_recipient: "operator@example.invalid",
    });
  const [snapshot, updated] = await Promise.all([reading, updating]);
  expect(snapshot.row.config_revision).toBe(snapshot.config.revision);
  expect(snapshot.row.expires_at).toBe(pending.expires);
  const current = await assertBackupRun(f.binding, pending.id);
  expect(current.row.config_revision).toBe(updated.revision);
  expect(current.config.revision).toBe(updated.revision);
});

it("keeps the day's run valid when alert email changes between the cron's configuration read and its run insert", async () => {
  const f = await configured(),
    created: string[] = [];
  const interleaved = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith("INSERT INTO infrastructure_backup_runs"))
            return statement;
          return {
            bind: (...values: unknown[]) => ({
              run: async () => {
                // The operator's PUT lands after the cron read the configuration and before its insert.
                await configureInfrastructureBackups(f.binding, {
                  ...f.input,
                  notification_sender: "alerts@example.invalid",
                });
                return statement.bind(...values).run();
              },
            }),
          } as unknown as D1PreparedStatement;
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await runInfrastructureBackupCron({
    ...f.binding,
    DB: interleaved,
    INFRASTRUCTURE_BACKUP: {
      async get() {
        throw new Error("instance.not_found");
      },
      async create(options: { id: string }) {
        created.push(options.id);
      },
    } as unknown as Workflow<{ run_id: string }>,
  });
  expect(created).toHaveLength(1);
  const current = await readInfrastructureBackupConfig(env.DB);
  expect(current.revision).toBe(f.config.revision + 1);
  expect(await revision(created[0]!)).toBe(current.revision);
  await expect(assertBackupRun(f.binding, created[0]!)).resolves.toMatchObject({
    row: { status: "pending" },
  });
});
