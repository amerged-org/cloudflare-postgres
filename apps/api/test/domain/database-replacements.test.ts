// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { openLink, nextMessage, heldLink } from "./node-fixtures.ts";
import { afterEach, expect, it } from "vitest";
import {
  assignRelease,
  request,
  nodeRequest,
  observationOf,
  reportBody,
  nodeOs,
  nodeSample,
} from "./fixtures.ts";
import {
  lifecycle,
  keyedEnv,
  cleanup,
  BACKUP,
  PROOF,
  pageOf,
  observation as lifecycleObservation,
  report,
  done,
} from "./lifecycle-fixture.ts";

import { deliverArchiveCredential } from "../../src/domain/archive-credentials.ts";
import type { Env } from "../../src/env.ts";
import { progressReplacements } from "../../src/domain/database-replacements.ts";
import { expireReplacementArchives } from "../../src/domain/database-replacements.ts";
import { applyLifecycleObservations } from "../../src/domain/lifecycle-observations.ts";

const observation = (input: Parameters<typeof lifecycleObservation>[0]) =>
  lifecycleObservation({
    ...input,
    ...(input.state === "ready" ? { instance: crypto.randomUUID() } : {}),
  });

const keys: string[] = [];
afterEach(async () => {
  if (keys.length) await env.ARCHIVE.delete(keys.splice(0));
  await env.DB.prepare("DELETE FROM database_replacements").run();
  await cleanup();
});

it("refuses in-place PITR before any work when the owning node has not advertised support", async () => {
  const f = await lifecycle();
  const before = await f.row();
  const response = await request(
    `/v1/databases/${f.id}/restore-in-place`,
    f.integrator,
    "POST",
    {
      mode: "pitr",
      target_time: "2026-10-18T09:32:00.000Z",
    },
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "conflict" } });
  expect(await f.row()).toEqual(before);
  expect(
    (await env.DB.prepare("SELECT COUNT(*) n FROM lifecycle_orders").first<{
      n: number;
    }>())!.n,
  ).toBe(0);
});

async function capable() {
  const f = await lifecycle(),
    release = await assignRelease(f);
  await env.DB.prepare(
    "UPDATE nodes SET reported_release_id=?,restore_in_place_capable=1,last_sample_json=json_set(last_sample_json,'$.capabilities',json('[\"restore_in_place_v1\"]')) WHERE id=?",
  )
    .bind(release, f.node)
    .run();
  const row = await f.row(),
    prefix =
      row.archive_path.replace(`s3://${env.ARCHIVE_BUCKET_NAME}/`, "") +
      "/database/";
  const objects: [string, string][] = [
    [
      `${prefix}base/${BACKUP.backup_id}/backup.info`,
      "status=DONE\nbegin_time=2026-10-18T09:30:00.000Z\nend_time=2026-10-18T09:31:00.000Z\nbegin_wal=000000010000000000000001\nend_wal=000000010000000000000001\nxlog_segment_size=16777216\n",
    ],
    [`${prefix}base/${BACKUP.backup_id}/data.tar.gz`, "data"],
    [`${prefix}wals/0000000100000000/000000010000000000000001.gz`, "wal"],
    [`${prefix}wals/0000000100000000/000000010000000000000002.gz`, "wal"],
  ];
  for (const [key, value] of objects) {
    keys.push(key);
    await env.ARCHIVE.put(key, value!);
  }
  return f;
}
async function start(
  f: Awaited<ReturnType<typeof capable>>,
  key = crypto.randomUUID(),
) {
  const response = await request(
    `/v1/databases/${f.id}/restore-in-place`,
    f.integrator,
    "POST",
    { mode: "pitr", target_time: "2026-10-18T09:32:00.000Z" },
    key,
  );
  const body = await response.json<{
    database: { id: string };
    operation: { id: string; status: string };
  }>();
  expect(response.status, JSON.stringify(body)).toBe(202);
  expect(body.database.id).toBe(f.id);
  return body.operation.id;
}
async function stage(
  f: Awaited<ReturnType<typeof capable>>,
  operation: string,
) {
  const row = await f.row();
  await applyLifecycleObservations(
    env,
    f.node,
    report(
      [
        observation({
          id: f.id,
          generation: row.generation,
          operation,
          state: "asleep",
        }),
      ],
      [done(operation)],
    ),
  );
  const page = await pageOf(f.node),
    entry = page.databases.find((d) => d.id === f.id)!;
  expect(entry.origin?.kind).toBe("replace");
  const credential = await deliverArchiveCredential(
    keyedEnv(),
    f.node,
    entry.archive.credential.id,
    Date.now(),
  );
  expect(
    credential && { path: credential.path, access: credential.access },
  ).toEqual({ path: entry.archive.path, access: "read_write" });
  return entry;
}
const replacement = (op: string) =>
  env.DB.prepare("SELECT * FROM database_replacements WHERE operation=?")
    .bind(op)
    .first<{
      phase: string;
      source_archive_path: string;
      target_storage_generation: number;
      rollback_storage_generation: number | null;
      retained_until: string | null;
    }>();

it("keeps the public identity and credentials, holds all admissions, and cuts over only after a ready backed-up replacement", async () => {
  const f = await capable(),
    before = await f.row(),
    key = crypto.randomUUID();
  const roles = (
    await env.DB.prepare("SELECT * FROM roles WHERE database_id=?")
      .bind(f.id)
      .all()
  ).results;
  const op = await start(f, key);
  expect(await start(f, key)).toBe(op);
  expect(
    await env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(f.id)).admitWake(
      f.id,
      "app",
    ),
  ).toEqual({ ok: false, sqlstate: "57P03" });
  expect(
    (await request(`/v1/databases/${f.id}/resume`, f.integrator, "POST"))
      .status,
  ).toBe(409);
  expect(
    (
      await request(
        `/v1/databases/${f.id}/roles/app/reset-password`,
        f.integrator,
        "POST",
        {},
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(409);
  const entry = await stage(f, op);
  expect(await f.row()).toEqual(before);
  expect(entry).toMatchObject({
    id: f.id,
    storage_generation: 2,
    origin: {
      kind: "replace",
      source: { database_id: f.id, path: before.archive_path },
      previous: { storage_generation: 1, end: PROOF },
    },
  });
  await applyLifecycleObservations(
    env,
    f.node,
    report([
      observation({
        id: f.id,
        generation: entry.generation,
        operation: op,
        storage_generation: 2,
        state: "ready",
        backup: null,
      }),
    ]),
  );
  expect((await replacement(op))?.phase).toBe("restoring");
  await applyLifecycleObservations(
    env,
    f.node,
    report([
      observation({
        id: f.id,
        generation: entry.generation,
        operation: op,
        storage_generation: 2,
        state: "ready",
        backup: { ...BACKUP, timeline: 2 },
      }),
    ]),
  );
  expect((await replacement(op))?.phase).toBe("succeeded");
  expect(
    await env.DB.prepare(
      "SELECT kind,generation FROM lifecycle_events WHERE database_id=? AND generation=? AND kind='ready'",
    )
      .bind(f.id, entry.generation)
      .first(),
  ).toMatchObject({ kind: "ready", generation: entry.generation });
  expect(await f.row()).toMatchObject({
    id: f.id,
    node_id: f.node,
    generation: entry.generation,
    storage_generation: 2,
    archive_path: entry.archive.path,
  });
  expect(
    (
      await env.DB.prepare("SELECT * FROM roles WHERE database_id=?")
        .bind(f.id)
        .all()
    ).results,
  ).toEqual(roles);
  const history = await request(
    `/v1/databases/${f.id}/restores/in-place`,
    f.integrator,
  );
  expect(await history.json()).toMatchObject({
    data: [
      { operation: op, phase: "succeeded", retained_until: expect.any(String) },
    ],
  });
  const restored = await request(
    `/v1/databases/${f.id}/restore`,
    f.integrator,
    "POST",
    { mode: "full", name: "before-pitr", source_operation_id: op },
  );
  expect(restored.status, await restored.clone().text()).toBe(202);
  const target = await restored.json<{ target_database: { id: string } }>();
  expect(target.target_database.id).not.toBe(f.id);
  expect(
    await env.DB.prepare(
      "SELECT source_archive_path FROM database_restores WHERE target_database_id=?",
    )
      .bind(target.target_database.id)
      .first(),
  ).toEqual({ source_archive_path: before.archive_path });
});

it("rolls failure forward to the exact proven end, stays closed during rollback failure and never lowers a generation", async () => {
  const f = await capable(),
    before = await f.row(),
    op = await start(f),
    entry = await stage(f, op);
  await applyLifecycleObservations(
    env,
    f.node,
    report([
      observation({
        id: f.id,
        generation: entry.generation,
        operation: op,
        storage_generation: 2,
        state: "error",
        error: "no_recovery_point",
      }),
    ]),
  );
  expect(await replacement(op)).toMatchObject({
    phase: "rolling_back",
    rollback_storage_generation: 3,
  });
  const rollback = (await pageOf(f.node)).databases.find((d) => d.id === f.id)!;
  expect(rollback).toMatchObject({
    generation: entry.generation + 1,
    storage_generation: 3,
    origin: {
      kind: "replace_rollback",
      source: { path: before.archive_path },
      previous: { storage_generation: 1, end: PROOF },
      replacement_generation: 2,
    },
  });
  await applyLifecycleObservations(
    env,
    f.node,
    report([
      observation({
        id: f.id,
        generation: rollback.generation,
        operation: op,
        storage_generation: 3,
        state: "error",
        error: "archive_unusable",
      }),
    ]),
  );
  expect((await replacement(op))?.phase).toBe("rolling_back");
  expect(await f.row()).toEqual(before);
  expect(
    await env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(f.id)).admit(
      f.id,
      "app",
    ),
  ).toEqual({ ok: false, sqlstate: "57P03" });
  await applyLifecycleObservations(
    env,
    f.node,
    report([
      observation({
        id: f.id,
        generation: rollback.generation,
        operation: op,
        storage_generation: 3,
        state: "ready",
        backup: { ...BACKUP, timeline: 2 },
      }),
    ]),
  );
  expect((await replacement(op))?.phase).toBe("failed");
  expect(await f.row()).toMatchObject({
    generation: rollback.generation,
    storage_generation: 3,
    archive_path: rollback.archive.path,
  });
  expect(
    await env.DB.prepare("SELECT status,error_code FROM operations WHERE id=?")
      .bind(op)
      .first(),
  ).toEqual({ status: "failed", error_code: "no_recovery_point" });
});

it("requires advertised support on the currently converged release and refuses a missing idempotency key", async () => {
  const f = await capable();
  await env.DB.prepare("UPDATE nodes SET reported_release_id=NULL WHERE id=?")
    .bind(f.node)
    .run();
  const body = { mode: "pitr", target_time: "2026-10-18T09:32:00.000Z" };
  expect(
    (
      await request(
        `/v1/databases/${f.id}/restore-in-place`,
        f.integrator,
        "POST",
        body,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await request(
        `/v1/databases/${f.id}/restore-in-place`,
        f.integrator,
        "POST",
        body,
        null,
      )
    ).status,
  ).toBe(400);
  expect(
    (await env.DB.prepare(
      "SELECT COUNT(*) n FROM database_replacements",
    ).first<{ n: number }>())!.n,
  ).toBe(0);
});

it("retains the prior archive until the window expires and its last restore reader releases it", async () => {
  const f = await capable(),
    op = await start(f),
    entry = await stage(f, op);
  await applyLifecycleObservations(
    env,
    f.node,
    report([
      observation({
        id: f.id,
        generation: entry.generation,
        operation: op,
        storage_generation: 2,
        state: "ready",
        backup: { ...BACKUP, timeline: 2 },
      }),
    ]),
  );
  const row = (await replacement(op))!;
  expect(await expireReplacementArchives(env, Date.now())).toEqual({
    archives: 0,
    objects: 0,
  });
  const response = await request(
    `/v1/databases/${f.id}/restore`,
    f.integrator,
    "POST",
    { mode: "full", name: "retention-reader", source_operation_id: op },
  );
  expect(response.status).toBe(202);
  const restored = await response.json<{
    operation: { id: string };
    target_database: { id: string };
  }>();
  const afterExpiry = Date.parse(row.retained_until!) + 1;
  expect(await expireReplacementArchives(env, afterExpiry)).toEqual({
    archives: 0,
    objects: 0,
  });
  await env.DB.prepare(
    "UPDATE operations SET status='failed',error_code='build_failed',error_message='test recovery failed',completed_at=? WHERE id=?",
  )
    .bind(new Date().toISOString(), restored.operation.id)
    .run();
  const removed = await expireReplacementArchives(env, afterExpiry);
  expect(removed.objects).toBe(4);
  expect((await expireReplacementArchives(env, afterExpiry)).archives).toBe(1);
  const refused = await request(
    `/v1/databases/${f.id}/restore`,
    f.integrator,
    "POST",
    { mode: "full", name: "claimed-history", source_operation_id: op },
  );
  expect(refused.status).toBe(409);
  expect(await f.row()).toMatchObject({
    storage_generation: 2,
    archive_path: entry.archive.path,
  });
});

it("holds concurrent role and power writes at the D1 boundary and hides history from another project", async () => {
  const f = await capable(),
    op = await start(f);
  expect(
    (await request(`/v1/databases/${f.id}/restores/in-place`, f.otherKey))
      .status,
  ).toBe(404);
  await expect(
    env.DB.prepare(
      "UPDATE roles SET password_revision=password_revision+1 WHERE database_id=?",
    )
      .bind(f.id)
      .run(),
  ).rejects.toThrow("database_replacement_in_progress");
  await expect(
    env.DB.prepare(
      "UPDATE databases SET desired_state='suspended',suspension_reason='manual',generation=generation+1 WHERE id=?",
    )
      .bind(f.id)
      .run(),
  ).rejects.toThrow("database_replacement_in_progress");
  expect((await replacement(op))?.phase).toBe("proving");
  await stage(f, op);
  await env.DB.prepare("UPDATE nodes SET restore_in_place_capable=0 WHERE id=?")
    .bind(f.node)
    .run();
  expect(
    (await pageOf(f.node)).databases.find((d) => d.id === f.id)?.origin?.kind,
  ).not.toBe("replace");
  expect(
    await env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(f.id)).admitWake(
      f.id,
      "app",
    ),
  ).toEqual({ ok: false, sqlstate: "57P03" });
});

it("advances through authenticated observation intake without prematurely succeeding the restore operation", async () => {
  const f = await capable(),
    op = await start(f);
  const asleep = async () => {
    const row = await f.row();
    const response = await nodeRequest(f, "/node/v1/observations", {
      method: "POST",
      body: reportBody(
        [
          await observationOf(f.id, row.generation, "asleep", {
            backup: BACKUP,
            operation: op,
            proven_sleep: PROOF,
          }),
        ],
        [done(op)],
      ),
    });
    expect(response.status, await response.clone().text()).toBe(200);
  };
  await asleep();
  await asleep();
  expect((await replacement(op))?.phase).toBe("restoring");
  expect(
    await env.DB.prepare("SELECT status FROM operations WHERE id=?")
      .bind(op)
      .first(),
  ).toEqual({ status: "running" });
  const entry = (await pageOf(f.node)).databases.find((d) => d.id === f.id)!;
  const ready = await nodeRequest(f, "/node/v1/observations", {
    method: "POST",
    body: reportBody([
      observation({
        id: f.id,
        generation: entry.generation,
        operation: op,
        storage_generation: entry.storage_generation,
        state: "ready",
        instance: crypto.randomUUID(),
        backup: { ...BACKUP, timeline: 2 },
      }),
    ]),
  });
  expect(ready.status, await ready.clone().text()).toBe(200);
  expect((await replacement(op))?.phase).toBe("succeeded");
  expect(
    (
      await env.DATABASE_ACTOR.get(
        env.DATABASE_ACTOR.idFromName(f.id),
      ).admitWake(f.id, "app")
    ).ok,
  ).toBe(true);
});

it("pins rollback to the newest backup in the quiesced proof rather than the older PITR-selected backup", async () => {
  const f = await capable(),
    op = await start(f),
    row = await f.row();
  const latest = {
    ...BACKUP,
    backup_id: "20261018T093300",
    completed_at: "2026-10-18T09:34:00.000Z",
  };
  const prefix =
    row.archive_path.replace(`s3://${env.ARCHIVE_BUCKET_NAME}/`, "") +
    "/database/";
  for (const [suffix, value] of [
    [
      "backup.info",
      "status=DONE\nbegin_time=2026-10-18T09:33:00.000Z\nend_time=2026-10-18T09:34:00.000Z\nbegin_wal=000000010000000000000002\nend_wal=000000010000000000000002\nxlog_segment_size=16777216\n",
    ],
    ["data.tar.gz", "newer data"],
  ]) {
    const key = `${prefix}base/${latest.backup_id}/${suffix}`;
    keys.push(key);
    await env.ARCHIVE.put(key, value!);
  }
  await applyLifecycleObservations(
    env,
    f.node,
    report(
      [
        observation({
          id: f.id,
          generation: row.generation,
          operation: op,
          state: "asleep",
          backup: latest,
        }),
      ],
      [done(op)],
    ),
  );
  const staged = (await pageOf(f.node)).databases.find((d) => d.id === f.id)!;
  expect(staged.origin).toMatchObject({
    kind: "replace",
    source: { backup_id: BACKUP.backup_id },
  });
  await applyLifecycleObservations(
    env,
    f.node,
    report([
      observation({
        id: f.id,
        generation: staged.generation,
        operation: op,
        storage_generation: staged.storage_generation,
        state: "error",
        error: "no_recovery_point",
      }),
    ]),
  );
  expect(
    (await pageOf(f.node)).databases.find((d) => d.id === f.id)?.origin,
  ).toMatchObject({
    kind: "replace_rollback",
    source: { backup_id: latest.backup_id },
    previous: { end: PROOF },
  });
});

it("ends an interrupted replacement at declared node loss and permits the existing public recovery into a new identity", async () => {
  const f = await capable(),
    before = await f.row(),
    op = await start(f);
  await stage(f, op);
  const uid = await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
    .bind(f.node)
    .first<string>("node_uid");
  const lost = await request(`/v1/nodes/${f.node}/mark-lost`, f.admin, "POST", {
    expected_node_uid: uid,
    reason: "test node lost during recovery",
  });
  expect(lost.status, await lost.clone().text()).toBe(200);
  expect(await replacement(op)).toMatchObject({ phase: "failed" });
  expect(
    await env.DB.prepare("SELECT status,error_code FROM operations WHERE id=?")
      .bind(op)
      .first(),
  ).toEqual({ status: "failed", error_code: "node_lost" });
  expect(await f.row()).toEqual(before);
  expect(
    await env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(f.id)).admitWake(
      f.id,
      "app",
    ),
  ).toEqual({ ok: false, sqlstate: "57P03" });
  // The existing node-fence workflow persists these ordered receipts after external fencing.
  const at = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE node_losses SET tunnel_deleted_at=?,power_off_requested_at=?,powered_off_at=? WHERE node_id=?",
  )
    .bind(at, at, at, f.node)
    .run();
  const response = await request(
    `/v1/databases/${f.id}/restore`,
    f.integrator,
    "POST",
    { mode: "full", name: "node-loss-recovered" },
  );
  expect(response.status, await response.clone().text()).toBe(202);
  const restored = await response.json<{
    target_database: { id: string; node_id: string };
  }>();
  expect(restored.target_database.id).not.toBe(f.id);
  expect(restored.target_database.node_id).toBe(f.other);
  const entry = (await pageOf(f.other)).databases.find(
    (d) => d.id === restored.target_database.id,
  )!;
  expect(entry.origin).toMatchObject({
    kind: "restore",
    source: { database_id: f.id, path: before.archive_path },
  });
  expect(
    (await env.DB.prepare(
      "SELECT COUNT(*) n FROM lifecycle_orders WHERE operation=? AND closed_at IS NULL",
    )
      .bind(op)
      .first<{ n: number }>())!.n,
  ).toBe(0);
});

/** Interleave another real D1/Actor transition after the handler reads its source row. */
function afterSourceRead(run: () => Promise<void>): Env {
  let used = false;
  const sourceSql =
    "SELECT id,node_id,region_id,generation,storage_generation,archive_path,deleted_at FROM databases WHERE id=?";
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...args: Parameters<D1PreparedStatement["bind"]>) =>
            wrap(target.bind(...args));
        if (property === "first")
          return async (...args: Parameters<D1PreparedStatement["first"]>) => {
            const value = await target.first(...args);
            if (!used) {
              used = true;
              await run();
            }
            return value;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const DB = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) =>
          sql === sourceSql ? wrap(target.prepare(sql)) : target.prepare(sql);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...env, DB };
}

it("a delayed proving failure cannot fail a replacement or close its order after restoring won", async () => {
  const f = await capable(),
    op = await start(f);
  const interleaved = afterSourceRead(async () => {
    await stage(f, op);
  });
  await progressReplacements(
    interleaved,
    f.node,
    report([], [{ operation: op, status: "failed", reason: "power_busy" }]),
    Date.now(),
  );
  expect((await replacement(op))?.phase).toBe("restoring");
  expect(
    await env.DB.prepare("SELECT status FROM operations WHERE id=?")
      .bind(op)
      .first(),
  ).toEqual({ status: "running" });
  expect(
    await env.DB.prepare(
      "SELECT closed_at FROM lifecycle_orders WHERE operation=?",
    )
      .bind(op)
      .first(),
  ).toEqual({ closed_at: null });
});

it("a delayed replacement-ready report cannot overwrite a completed forward rollback", async () => {
  const f = await capable(),
    op = await start(f),
    entry = await stage(f, op);
  let rollbackGeneration = 0;
  const interleaved = afterSourceRead(async () => {
    await applyLifecycleObservations(
      env,
      f.node,
      report([
        observation({
          id: f.id,
          generation: entry.generation,
          operation: op,
          storage_generation: 2,
          state: "error",
          error: "no_recovery_point",
        }),
      ]),
    );
    const rollback = (await pageOf(f.node)).databases.find(
      (d) => d.id === f.id,
    )!;
    rollbackGeneration = rollback.generation;
    await applyLifecycleObservations(
      env,
      f.node,
      report([
        observation({
          id: f.id,
          generation: rollback.generation,
          operation: op,
          storage_generation: 3,
          state: "ready",
          backup: { ...BACKUP, timeline: 2 },
        }),
      ]),
    );
  });
  await progressReplacements(
    interleaved,
    f.node,
    report([
      observation({
        id: f.id,
        generation: entry.generation,
        operation: op,
        storage_generation: 2,
        state: "ready",
        backup: { ...BACKUP, timeline: 2 },
      }),
    ]),
    Date.now(),
  );
  expect((await replacement(op))?.phase).toBe("failed");
  expect(
    await env.DB.prepare(
      "SELECT status,generation,error_code FROM operations WHERE id=?",
    )
      .bind(op)
      .first(),
  ).toEqual({
    status: "failed",
    generation: rollbackGeneration,
    error_code: "no_recovery_point",
  });
  expect(await f.row()).toMatchObject({
    generation: rollbackGeneration,
    storage_generation: 3,
  });
  const terminal = await pageOf(f.node);
  expect(terminal.databases.find((d) => d.id === f.id)?.origin).toBeUndefined();
  expect(terminal.orders).toContainEqual(
    expect.objectContaining({
      type: "superseded",
      storage_generation: 2,
      remove_volume: true,
    }),
  );
});

it("ignores a ready observation carrying another operation through the authenticated intake", async () => {
  const f = await capable(),
    op = await start(f),
    entry = await stage(f, op);
  const wrong = await nodeRequest(f, "/node/v1/observations", {
    method: "POST",
    body: reportBody([
      observation({
        id: f.id,
        generation: entry.generation,
        operation: f.operation,
        storage_generation: 2,
        state: "ready",
        backup: { ...BACKUP, timeline: 2 },
      }),
    ]),
  });
  expect(wrong.status).toBe(200);
  expect((await replacement(op))?.phase).toBe("restoring");
  expect(
    await env.DB.prepare("SELECT status FROM operations WHERE id=?")
      .bind(op)
      .first(),
  ).toEqual({ status: "running" });
});

it("retains the newer prior-state promise when an earlier successful replacement reaches expiry", async () => {
  const f = await capable(),
    first = await start(f),
    firstEntry = await stage(f, first);
  await applyLifecycleObservations(
    env,
    f.node,
    report([
      observation({
        id: f.id,
        generation: firstEntry.generation,
        operation: first,
        storage_generation: 2,
        state: "ready",
        backup: { ...BACKUP, timeline: 2 },
      }),
    ]),
  );
  const terminal = await pageOf(f.node);
  expect(terminal.databases.find((d) => d.id === f.id)?.origin).toBeUndefined();
  expect(terminal.orders).toContainEqual(
    expect.objectContaining({
      type: "superseded",
      storage_generation: 1,
      remove_volume: true,
    }),
  );
  const prefix =
    firstEntry.archive.path.replace(`s3://${env.ARCHIVE_BUCKET_NAME}/`, "") +
    "/database/";
  for (const [suffix, value] of [
    [
      `base/${BACKUP.backup_id}/backup.info`,
      "status=DONE\nbegin_time=2026-10-18T09:30:00.000Z\nend_time=2026-10-18T09:31:00.000Z\nbegin_wal=000000020000000000000001\nend_wal=000000020000000000000001\nxlog_segment_size=16777216\n",
    ],
    [`base/${BACKUP.backup_id}/data.tar.gz`, "second data"],
    ["wals/0000000200000000/000000020000000000000001.gz", "second wal"],
    ["wals/0000000200000000/000000020000000000000002.gz", "second wal"],
  ] as const) {
    const key = prefix + suffix;
    keys.push(key);
    await env.ARCHIVE.put(key, value);
  }
  const second = await start(f),
    row = await f.row();
  const proof = {
    ...PROOF,
    timeline: 2,
    last_archived_segment: "000000020000000000000002",
  };
  await applyLifecycleObservations(
    env,
    f.node,
    report(
      [
        observation({
          id: f.id,
          generation: row.generation,
          operation: second,
          storage_generation: 2,
          state: "asleep",
          backup: { ...BACKUP, timeline: 2 },
          proven_sleep: proof,
        }),
      ],
      [done(second)],
    ),
  );
  const secondEntry = (await pageOf(f.node)).databases.find(
    (d) => d.id === f.id,
  )!;
  await applyLifecycleObservations(
    env,
    f.node,
    report([
      observation({
        id: f.id,
        generation: secondEntry.generation,
        operation: second,
        storage_generation: 3,
        state: "ready",
        backup: { ...BACKUP, timeline: 3 },
      }),
    ]),
  );
  const firstExpiry = Date.parse((await replacement(first))!.retained_until!);
  await env.DB.prepare(
    "UPDATE database_replacements SET retained_until=? WHERE operation=?",
  )
    .bind(new Date(firstExpiry + 86400000).toISOString(), second)
    .run();
  await expireReplacementArchives(env, firstExpiry + 1);
  await expireReplacementArchives(env, firstExpiry + 1);
  expect(
    await env.ARCHIVE.head(`${prefix}base/${BACKUP.backup_id}/backup.info`),
  ).not.toBeNull();
  const restored = await request(
    `/v1/databases/${f.id}/restore`,
    f.integrator,
    "POST",
    { mode: "full", name: "newer-prior-state", source_operation_id: second },
  );
  expect(restored.status, await restored.clone().text()).toBe(202);
});

it("a delayed replacement-ready report cannot change source authority after rollback started", async () => {
  const f = await capable(),
    op = await start(f),
    entry = await stage(f, op),
    source = await f.row();
  const interleaved = afterSourceRead(async () => {
    await applyLifecycleObservations(
      env,
      f.node,
      report([
        observation({
          id: f.id,
          generation: entry.generation,
          operation: op,
          storage_generation: 2,
          state: "error",
          error: "no_recovery_point",
        }),
      ]),
    );
  });
  await progressReplacements(
    interleaved,
    f.node,
    report([
      observation({
        id: f.id,
        generation: entry.generation,
        operation: op,
        storage_generation: 2,
        state: "ready",
        backup: { ...BACKUP, timeline: 2 },
      }),
    ]),
    Date.now(),
  );
  expect((await replacement(op))?.phase).toBe("rolling_back");
  expect(await f.row()).toEqual(source);
  const rollback = (await pageOf(f.node)).databases.find((d) => d.id === f.id)!;
  await applyLifecycleObservations(
    env,
    f.node,
    report([
      observation({
        id: f.id,
        generation: rollback.generation,
        operation: op,
        storage_generation: 3,
        state: "ready",
        backup: { ...BACKUP, timeline: 2 },
      }),
    ]),
  );
  expect((await replacement(op))?.phase).toBe("failed");
  expect((await f.row()).storage_generation).toBe(3);
});

it("an old hello clears support and a delayed capability-bearing sample cannot re-enable it", async () => {
  const f = await capable();
  const release = await env.DB.prepare(
    "SELECT reported_release_id FROM nodes WHERE id=?",
  )
    .bind(f.node)
    .first<string>("reported_release_id");
  const greet = async (capable: boolean) => {
    const socket = await openLink(f, false),
      welcome = nextMessage(socket);
    socket.send(
      JSON.stringify({
        type: "hello",
        protocol: 1,
        agent_version: "test",
        release_id: release,
        os: nodeOs(),
        ...(capable ? { capabilities: ["restore_in_place_v1"] } : {}),
      }),
    );
    await welcome;
    return socket;
  };
  const original = await greet(true);
  expect(
    await env.DB.prepare(
      "SELECT restore_in_place_capable FROM nodes WHERE id=?",
    )
      .bind(f.node)
      .first<number>("restore_in_place_capable"),
  ).toBe(1);
  original.close(1000);
  const older = await greet(false),
    sample = nodeSample(Date.now(), { capabilities: ["restore_in_place_v1"] });
  older.send(JSON.stringify({ type: "sample", sample }));
  await expect
    .poll(async () => (await heldLink(f.node)).sample?.observed_at, {
      timeout: 2000,
      interval: 10,
    })
    .toBe(sample.observed_at);
  await runDurableObjectAlarm(
    env.NODE_ACTOR.get(env.NODE_ACTOR.idFromName(f.node)),
  );
  expect(
    await env.DB.prepare(
      "SELECT restore_in_place_capable,json_extract(last_sample_json,'$.capabilities[0]') diagnostic_capability FROM nodes WHERE id=?",
    )
      .bind(f.node)
      .first(),
  ).toEqual({
    restore_in_place_capable: 0,
    diagnostic_capability: "restore_in_place_v1",
  });
  const refused = await request(
    `/v1/databases/${f.id}/restore-in-place`,
    f.integrator,
    "POST",
    { mode: "pitr", target_time: "2026-10-18T09:32:00.000Z" },
  );
  expect(refused.status).toBe(409);
  older.close(1000);
});

it("delivers active recovery on the first capable hello before sampling, while new requests require fresh capacity", async () => {
  const f = await capable();
  const prior = (await env.DB.prepare(
    "SELECT reported_release_id,last_sample_json,last_observed_at FROM nodes WHERE id=?",
  )
    .bind(f.node)
    .first<{
      reported_release_id: string;
      last_sample_json: string;
      last_observed_at: string;
    }>())!;
  await env.DB.prepare(
    "UPDATE nodes SET last_sample_json=NULL,last_observed_at=NULL WHERE id=?",
  )
    .bind(f.node)
    .run();
  expect(
    (
      await request(
        `/v1/databases/${f.id}/restore-in-place`,
        f.integrator,
        "POST",
        { mode: "pitr", target_time: "2026-10-18T09:32:00.000Z" },
      )
    ).status,
  ).toBe(409);
  await env.DB.prepare(
    "UPDATE nodes SET last_sample_json=?,last_observed_at=? WHERE id=?",
  )
    .bind(prior.last_sample_json, prior.last_observed_at, f.node)
    .run();
  const op = await start(f);
  await stage(f, op);
  const socket = await openLink(f, false),
    welcome = nextMessage(socket);
  socket.send(
    JSON.stringify({
      type: "hello",
      protocol: 1,
      agent_version: "test",
      release_id: prior.reported_release_id,
      os: nodeOs(),
      capabilities: ["restore_in_place_v1"],
    }),
  );
  await welcome;
  await env.DB.prepare(
    "UPDATE nodes SET last_sample_json=NULL,last_observed_at=NULL,ready=0 WHERE id=?",
  )
    .bind(f.node)
    .run();
  const firstPage = await pageOf(f.node);
  expect(firstPage.policy).toBeDefined();
  expect(firstPage.databases.find((d) => d.id === f.id)?.origin?.kind).toBe(
    "replace",
  );
  socket.close(1000);
});
