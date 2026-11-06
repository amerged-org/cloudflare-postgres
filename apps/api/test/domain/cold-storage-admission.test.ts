// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import {
  archiveDestinationPath,
  DatabaseRuntime,
  DatabaseWithOperation,
  newOperationId,
} from "@pgcf/contracts";
import { afterEach, expect, it, vi } from "vitest";
import {
  publishDatabaseAdmission,
  readDatabaseAdmissionSnapshot,
} from "../../src/domain/database-admission-snapshot.ts";
import { runColdStorageCron } from "../../src/domain/cold-storage.ts";
import { sleepingSnapshotFixture } from "./admission-snapshot-fixture.ts";
import { cleanupFixtures, request } from "./fixtures.ts";
import { PROOF, BACKUP } from "./lifecycle-fixture.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
});
const actor = (id: string) =>
  env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id));
const waitEvents = () => {
  const log = vi.spyOn(console, "log");
  return () =>
    log.mock.calls.flatMap(([line]) =>
      typeof line === "string" && line.includes('"event":"cold_restore_wait"')
        ? [
            JSON.parse(line) as {
              outcome: string;
              duration_ms: number;
              operation: string | null;
            },
          ]
        : [],
    );
};

/** An accepted archival result in real D1; source bytes/recovery verification have their own tests. */
async function archived(reason: "idle" | "manual" = "idle") {
  const f = await sleepingSnapshotFixture(reason),
    operation = newOperationId(),
    at = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO cold_storage_operations(id,kind,status,project_id,database_id,generation,created_at,updated_at,completed_at)
      SELECT ?,'database.archive','succeeded',project_id,id,generation,?,?,? FROM databases WHERE id=?`,
    ).bind(operation, at, at, at, f.id),
    env.DB.prepare(
      `INSERT INTO database_cold_storage(operation,kind,database_id,project_id,region_id,phase,source_node_id,
        source_generation,source_storage_generation,source_archive_path,source_backup_id,proven_sleep_json,
        verification_receipt_json,source_removed_at,created_at,updated_at,completed_at)
      SELECT ?,'archive',id,project_id,region_id,'archived',node_id,generation,storage_generation,archive_path,?,?,?, ?,?,?,?
      FROM databases WHERE id=?`,
    ).bind(
      operation,
      BACKUP.backup_id,
      JSON.stringify(PROOF),
      "{}",
      at,
      at,
      at,
      at,
      f.id,
    ),
    env.DB.prepare(
      `INSERT INTO archive_pins(operation,archive_path,database_id,created_at)
      SELECT ?,archive_path,id,? FROM databases WHERE id=?`,
    ).bind(operation, at, f.id),
    env.DB.prepare(
      `UPDATE databases SET storage_residency='archived',storage_operation_id=?,node_id=NULL,runtime_json=NULL WHERE id=?`,
    ).bind(operation, f.id),
  ]);
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  return { ...f, archiveOperation: operation };
}

it("a nonlocal snapshot cannot issue a prepared local wake ticket or expose its former runtime", async () => {
  const f = await sleepingSnapshotFixture();
  expect(await actor(f.id).pendingTicket()).not.toBeNull();
  await env.DB.prepare(
    "UPDATE databases SET storage_residency='archiving' WHERE id=?",
  )
    .bind(f.id)
    .run();
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  const snapshot = (await readDatabaseAdmissionSnapshot(env, f.id))!.snapshot;
  expect(snapshot).toMatchObject({
    storage_residency: "archiving",
    admissible: false,
    wakeable: false,
    runtime: null,
  });
  expect(await actor(f.id).pendingTicket()).toBeNull();
  expect(await actor(f.id).admit(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
});

it("archived manual suspension rejects connections without creating a recovery", async () => {
  const f = await archived("manual");
  expect(await actor(f.id).ensureAwake(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
  expect(await actor(f.id).admitWake(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM cold_storage_operations WHERE database_id=? AND kind='database.rehydrate'",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(0);
});

it("unknown and expired role hints cannot restore an archived database", async () => {
  const f = await archived();
  expect(await actor(f.id).admitWake(f.id, "missing")).toEqual({
    ok: false,
    sqlstate: "28P01",
  });
  await env.DB.prepare(
    "UPDATE roles SET valid_until=? WHERE database_id=? AND name='app'",
  )
    .bind("2020-01-01T00:00:00.000Z", f.id)
    .run();
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  expect(await actor(f.id).admitWake(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "28P01",
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM cold_storage_operations WHERE database_id=? AND kind='database.rehydrate'",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(0);
});

it("manual suspension of an archived idle database completes without a node and replays its receipt", async () => {
  const f = await archived(),
    key = crypto.randomUUID(),
    path = `/v1/databases/${f.id}/suspend`;
  const first = await request(
    path,
    f.integrator,
    "POST",
    { expected_generation: f.sleepGeneration },
    key,
  );
  expect(first.status).toBe(202);
  const body = DatabaseWithOperation.parse(await first.json());
  expect(body.database).toMatchObject({
    storage_residency: "archived",
    suspension_reason: "manual",
    node_id: null,
  });
  expect(body.operation).toMatchObject({
    kind: "database.suspend",
    status: "succeeded",
  });
  const replay = await request(
    path,
    f.integrator,
    "POST",
    { expected_generation: f.sleepGeneration },
    key,
  );
  expect(replay.status).toBe(202);
  expect(DatabaseWithOperation.parse(await replay.json()).operation.id).toBe(
    body.operation.id,
  );
  expect(await actor(f.id).ensureAwake(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
});

it("authorized resume of an archived manual pause creates one replayable recovery and respects expected_generation", async () => {
  const f = await archived("manual"),
    path = `/v1/databases/${f.id}/resume`,
    key = crypto.randomUUID(),
    input = { expected_generation: f.sleepGeneration };
  const stale = await request(
    path,
    f.integrator,
    "POST",
    { expected_generation: f.sleepGeneration + 1 },
    crypto.randomUUID(),
  );
  expect(stale.status).toBe(409);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM cold_storage_operations WHERE database_id=? AND kind='database.rehydrate'",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(0);
  const first = await request(path, f.integrator, "POST", input, key);
  expect(first.status).toBe(202);
  const result = DatabaseWithOperation.parse(await first.json());
  expect(result.database).toMatchObject({
    desired_state: "running",
    suspension_reason: null,
    storage_residency: "restoring",
  });
  expect(result.operation.kind).toBe("database.rehydrate");
  const replay = await request(path, f.integrator, "POST", input, key);
  expect(replay.status).toBe(202);
  expect(DatabaseWithOperation.parse(await replay.json()).operation.id).toBe(
    result.operation.id,
  );
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM cold_storage_operations WHERE database_id=? AND kind='database.rehydrate'",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(1);
});

it("a later manual pause supersedes deferred resume before its recovery is claimed", async () => {
  const f = await archived("manual"),
    at = new Date().toISOString();
  // Resume was accepted while the local copy retired, then the control process stopped after
  // acknowledging removal and before claiming the successor. Its durable intent remains due.
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE database_cold_storage SET wake_requested=1,manual_resume_requested=1,updated_at=? WHERE operation=?",
    ).bind(at, f.archiveOperation),
    env.DB.prepare(
      "UPDATE cold_storage_operations SET status='running',completed_at=NULL WHERE id=?",
    ).bind(f.archiveOperation),
  ]);
  const paused = await request(
    `/v1/databases/${f.id}/suspend`,
    f.integrator,
    "POST",
    { expected_generation: f.sleepGeneration },
    crypto.randomUUID(),
  );
  expect(paused.status).toBe(202);
  await runColdStorageCron(env);
  expect(
    await env.DB.prepare(
      "SELECT desired_state,suspension_reason,storage_residency FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({
    desired_state: "suspended",
    suspension_reason: "manual",
    storage_residency: "archived",
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM cold_storage_operations WHERE database_id=? AND kind='database.rehydrate'",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT status,error_code FROM cold_storage_operations WHERE id=?",
    )
      .bind(f.archiveOperation)
      .first(),
  ).toEqual({ status: "failed", error_code: "superseded" });
});

it("a held recovery request times out without cancelling the durable operation and joins it after Actor eviction", async () => {
  const f = await archived();
  const events = waitEvents();
  const result = await actor(f.id).admitWake(f.id, "app", {
    deadline: Date.now() + 300,
  });
  expect(result).toEqual({ ok: false, sqlstate: "57P03" });
  const operations = () =>
    env.DB.prepare(
      "SELECT id,status FROM cold_storage_operations WHERE database_id=? AND kind='database.rehydrate'",
    )
      .bind(f.id)
      .all<{ id: string; status: string }>();
  const first = (await operations()).results;
  expect(first).toHaveLength(1);
  expect(["pending", "running"]).toContain(first[0]!.status);
  expect(
    await runInDurableObject(
      actor(f.id),
      (instance) => Reflect.get(instance, "coldWaiters").size,
    ),
  ).toBe(0);
  await evictDurableObject(actor(f.id));
  expect(
    await actor(f.id).admitWake(f.id, "app", { deadline: Date.now() + 300 }),
  ).toEqual({ ok: false, sqlstate: "57P03" });
  expect((await operations()).results).toEqual(first);
  expect(events().map((event) => event.outcome)).toEqual([
    "timeout",
    "timeout",
  ]);
  expect(events().every((event) => event.duration_ms >= 0)).toBe(true);
});

it("concurrent archived admissions coalesce and cancelling one leaves other callers and recovery intact", async () => {
  const f = await archived(),
    firstId = crypto.randomUUID(),
    secondId = crypto.randomUUID();
  const events = waitEvents();
  const first = actor(f.id).ensureAwake(f.id, "app", {
    deadline: Date.now() + 3000,
    waiterId: firstId,
  });
  const second = actor(f.id).ensureAwake(f.id, "app", {
    deadline: Date.now() + 3000,
    waiterId: secondId,
  });
  for (let i = 0; i < 100; i++) {
    if (
      await runInDurableObject(
        actor(f.id),
        (instance) => Reflect.get(instance, "coldWaiters").size === 2,
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(await actor(f.id).cancelWakeWaiter(f.id, firstId)).toBe(true);
  expect(await first).toEqual({ ok: false, sqlstate: "57P03" });
  expect(
    await runInDurableObject(actor(f.id), (instance) =>
      Reflect.get(instance, "coldWaiters").has(secondId),
    ),
  ).toBe(true);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM cold_storage_operations WHERE database_id=? AND kind='database.rehydrate'",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(1);
  expect(await actor(f.id).cancelWakeWaiter(f.id, secondId)).toBe(true);
  expect(await second).toEqual({ ok: false, sqlstate: "57P03" });
  expect(
    await env.DB.prepare(
      "SELECT status FROM cold_storage_operations WHERE database_id=? AND kind='database.rehydrate'",
    )
      .bind(f.id)
      .first("status"),
  ).toBe("pending");
  expect(events().map((event) => event.outcome)).toEqual([
    "cancelled",
    "cancelled",
  ]);
});

it("keeps the first request open across the storage generation change and releases it only after route publication", async () => {
  const f = await archived(),
    waiterId = crypto.randomUUID(),
    generation = f.sleepGeneration + 1;
  const events = waitEvents();
  let answered = false;
  const pending = actor(f.id)
    .admitWake(f.id, "app", { deadline: Date.now() + 4000, waiterId })
    .then((value) => {
      answered = true;
      return value;
    });
  let operation: string | null = null;
  for (let i = 0; i < 100; i++) {
    operation = await env.DB.prepare(
      "SELECT id FROM cold_storage_operations WHERE database_id=? AND kind='database.rehydrate'",
    )
      .bind(f.id)
      .first<string>("id");
    if (
      operation &&
      (await runInDurableObject(actor(f.id), (instance) =>
        Reflect.get(instance, "coldWaiters").has(waiterId),
      ))
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(operation).not.toBeNull();
  expect(answered).toBe(false);
  const targetPath = archiveDestinationPath(
      env.ARCHIVE_BUCKET_NAME!,
      f.region,
      f.id,
      2,
      operation!,
    ),
    at = new Date().toISOString(),
    runtime = DatabaseRuntime.parse({
      ...f.runtime,
      generation,
      storage_generation: 2,
      instance: crypto.randomUUID(),
      observed_at: Date.now(),
    });
  // Trusted final recovery facts, isolated from the native recovery executor's own tests.
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE database_cold_storage SET phase='succeeded',target_node_id=?,target_generation=?,target_storage_generation=2,target_archive_path=?,completed_at=? WHERE operation=?",
    ).bind(f.node, generation, targetPath, at, operation),
    env.DB.prepare(
      "UPDATE cold_storage_operations SET status='succeeded',updated_at=?,completed_at=? WHERE id=?",
    ).bind(at, at, operation),
    env.DB.prepare(
      "UPDATE databases SET storage_residency='local',node_id=?,generation=?,observed_generation=?,storage_generation=2,archive_path=?,desired_state='running',suspension_reason=NULL,observed_state='ready',observed_power='awake',runtime_json=?,power_operation=NULL,updated_at=? WHERE id=?",
    ).bind(
      f.node,
      generation,
      generation,
      targetPath,
      JSON.stringify(runtime),
      at,
      f.id,
    ),
    env.DB.prepare(
      "UPDATE database_admission_epochs SET admission_revision=admission_revision+1,route_revision=route_revision+1 WHERE database_id=?",
    ).bind(f.id),
  ]);
  await actor(f.id).observedReady(f.id, generation, operation);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(answered).toBe(false);
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  expect(await pending).toMatchObject({
    ok: true,
    node: f.node,
    target: { revision: generation },
  });
  expect(events()).toMatchObject([{ outcome: "ready", operation }]);
});
