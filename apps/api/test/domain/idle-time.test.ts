// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  Database,
  DatabaseWithOperation,
  newDatabaseId,
} from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import {
  cleanupFixtures,
  fixture,
  observation,
  observedBody,
  refusal,
  request,
} from "./fixtures.ts";

const classes: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of classes.splice(0))
    await env.DB.prepare("DELETE FROM size_classes WHERE id=?").bind(id).run();
});
async function ready() {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  expect(
    (
      await request(
        "/agent/v1/observations",
        f.agent,
        "POST",
        observedBody([observation(created.database.id, 1)]),
      )
    ).status,
  ).toBe(200);
  const put = (body: unknown, key?: string | null, auth = f.integrator) =>
    request(
      `/v1/databases/${created.database.id}/idle-time`,
      auth,
      "PUT",
      body,
      key,
    );
  return { ...f, id: created.database.id, put };
}
const classValue = (id: string, value: number | null) =>
  env.DB.prepare("UPDATE size_classes SET sleep_after_seconds=? WHERE id=?")
    .bind(value, id)
    .run();
const stored = (id: string) =>
  env.DB.prepare(
    "SELECT sleep_after_seconds,generation,updated_at FROM databases WHERE id=?",
  )
    .bind(id)
    .first();

it("stores the database's own idle time, falls back to its class, else never sleeps, and reports it", async () => {
  const f = await ready();
  const read = async () =>
    Database.parse(
      await (await request(`/v1/databases/${f.id}`, f.integrator)).json(),
    );
  expect(await read()).toMatchObject({
    sleep_after_seconds: null,
    effective_sleep_after_seconds: null,
  });
  await classValue(f.size, 1800);
  const before = await stored(f.id);
  const set = await f.put({ sleep_after_seconds: 300 }, "idle-300");
  expect(set.status).toBe(200);
  const result = Database.parse(await set.json());
  expect(result).toMatchObject({
    id: f.id,
    generation: 1,
    sleep_after_seconds: 300,
    effective_sleep_after_seconds: 300,
  });
  // It takes no generation, leaves updated_at (the resize CAS) alone and creates no operation.
  expect(await stored(f.id)).toEqual({ ...before, sleep_after_seconds: 300 });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM operations WHERE database_id=? AND kind<>'database.create'",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(0);
  const replay = await f.put({ sleep_after_seconds: 300 }, "idle-300");
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(result);
  const listed = (await (
    await request("/v1/databases", f.integrator)
  ).json()) as { data: unknown[] };
  expect(listed.data).toMatchObject([
    { id: f.id, sleep_after_seconds: 300, effective_sleep_after_seconds: 300 },
  ]);
  const cleared = await f.put({ sleep_after_seconds: null });
  expect(cleared.status).toBe(200);
  expect(Database.parse(await cleared.json())).toMatchObject({
    sleep_after_seconds: null,
    effective_sleep_after_seconds: 1800,
  });
  await classValue(f.size, null);
  expect(await read()).toMatchObject({
    sleep_after_seconds: null,
    effective_sleep_after_seconds: null,
  });
  for (const body of [
    { sleep_after_seconds: 59 },
    { sleep_after_seconds: 901 },
    { sleep_after_seconds: 60.5 },
    { sleep_after_seconds: "300" },
    { sleep_after_seconds: 300, size_class_id: f.size },
    {},
  ])
    expect((await f.put(body)).status, JSON.stringify(body)).toBe(400);
  expect((await f.put({ sleep_after_seconds: 300 }, null)).status).toBe(400);
  expect(await stored(f.id)).toMatchObject({ sleep_after_seconds: null });
  const created = await request("/v1/databases", f.integrator, "POST", {
    project_id: f.project,
    region_id: f.region,
    name: "idle",
    size_class_id: f.size,
    sleep_after_seconds: 900,
  });
  expect(created.status).toBe(202);
  expect(
    DatabaseWithOperation.parse(await created.json()).database,
  ).toMatchObject({
    sleep_after_seconds: 900,
    effective_sleep_after_seconds: 900,
  });
});

it("hides an unknown or foreign database and refuses a deleted one", async () => {
  const f = await ready();
  expect(
    await refusal(
      await request(
        `/v1/databases/${newDatabaseId()}/idle-time`,
        f.integrator,
        "PUT",
        { sleep_after_seconds: 300 },
      ),
    ),
  ).toMatchObject({ status: 404, code: "not_found" });
  expect(
    await refusal(
      await f.put({ sleep_after_seconds: 300 }, undefined, f.otherKey),
    ),
  ).toMatchObject({ status: 404, code: "not_found" });
  expect(
    (await request(`/v1/databases/${f.id}`, f.integrator, "DELETE")).status,
  ).toBe(202);
  expect(
    await refusal(await f.put({ sleep_after_seconds: 300 }, "idle-deleted")),
  ).toMatchObject({ status: 409, reason: "database_deleted" });
  expect(await stored(f.id)).toMatchObject({ sleep_after_seconds: null });
  expect(
    await env.DB.prepare("SELECT COUNT(*) n FROM idempotency_keys WHERE key=?")
      .bind("idle-deleted")
      .first("n"),
  ).toBe(0);
});

it("sets the idle time while a resize is pending, without touching the resize", async () => {
  const f = await ready();
  const target = "i" + crypto.randomUUID().replaceAll("-", "").slice(0, 20);
  classes.push(target);
  await env.DB.prepare(
    `INSERT INTO size_classes(id,memory_mib,cpu_millicores,storage_gib,max_connections,sleep_after_seconds,archive_timeout_seconds,backup_retention_days,enabled,created_at,updated_at)
    SELECT ?,1024,750,storage_gib,max_connections,sleep_after_seconds,archive_timeout_seconds,backup_retention_days,1,created_at,updated_at FROM size_classes WHERE id=?`,
  )
    .bind(target, f.size)
    .run();
  const resized = await request(
    `/v1/databases/${f.id}`,
    f.integrator,
    "PATCH",
    {
      size_class_id: target,
    },
  );
  expect(resized.status).toBe(202);
  const pending = DatabaseWithOperation.parse(await resized.json());
  expect(pending.operation).toMatchObject({
    kind: "database.resize",
    status: "pending",
    generation: 2,
  });
  const before = await stored(f.id);
  const set = await f.put({ sleep_after_seconds: 120 });
  expect(set.status).toBe(200);
  expect(Database.parse(await set.json())).toMatchObject({
    size_class_id: target,
    generation: 2,
    observed_state: "provisioning",
    sleep_after_seconds: 120,
    effective_sleep_after_seconds: 120,
  });
  expect(await stored(f.id)).toEqual({ ...before, sleep_after_seconds: 120 });
  expect(
    (
      await env.DB.prepare(
        "SELECT id,status FROM operations WHERE database_id=? AND kind='database.resize'",
      )
        .bind(f.id)
        .all()
    ).results,
  ).toEqual([{ id: pending.operation.id, status: "pending" }]);
});

it("completes the Idempotency-Key only with the stored value", async () => {
  const f = await ready();
  await env.DB.exec(
    `CREATE TRIGGER idle_time_fault BEFORE UPDATE OF sleep_after_seconds ON databases WHEN NEW.id='${f.id}' BEGIN SELECT RAISE(ABORT,'injected idle time write failure'); END`,
  );
  let failed: Response;
  try {
    failed = await f.put({ sleep_after_seconds: 600 }, "idle-fault");
  } finally {
    await env.DB.exec("DROP TRIGGER idle_time_fault");
  }
  expect(failed.status).toBe(500);
  expect(await stored(f.id)).toMatchObject({ sleep_after_seconds: null });
  expect(
    await env.DB.prepare("SELECT COUNT(*) n FROM idempotency_keys WHERE key=?")
      .bind("idle-fault")
      .first("n"),
  ).toBe(0);
  // The retry with the same key executes again instead of replaying a success that was never stored.
  const retried = await f.put({ sleep_after_seconds: 600 }, "idle-fault");
  expect(retried.status).toBe(200);
  expect(Database.parse(await retried.json()).sleep_after_seconds).toBe(600);
  expect(await stored(f.id)).toMatchObject({ sleep_after_seconds: 600 });
});

it("never completes the key for a database deleted between its read and its write", async () => {
  const f = await ready();
  // The key's reservation is inserted after the request read the live row: delete it right then.
  await env.DB.exec(
    `CREATE TRIGGER idle_time_race AFTER INSERT ON idempotency_keys WHEN NEW.key='idle-race' BEGIN UPDATE databases SET desired_state='deleted',deleted_at='${new Date().toISOString()}' WHERE id='${f.id}'; END`,
  );
  let raced: Response;
  try {
    raced = await f.put({ sleep_after_seconds: 600 }, "idle-race");
  } finally {
    await env.DB.exec("DROP TRIGGER idle_time_race");
  }
  expect(raced.status).toBe(409);
  expect(
    await env.DB.prepare("SELECT COUNT(*) n FROM idempotency_keys WHERE key=?")
      .bind("idle-race")
      .first("n"),
  ).toBe(0);
  expect((await f.put({ sleep_after_seconds: 600 }, "idle-race")).status).toBe(
    409,
  );
});

it("keeps PATCH to the size class alone", async () => {
  const f = await ready();
  const patch = (body: unknown) =>
    request(`/v1/databases/${f.id}`, f.integrator, "PATCH", body);
  for (const body of [
    { sleep_after_seconds: 300 },
    { size_class_id: f.size, sleep_after_seconds: 300 },
    {},
  ])
    expect((await patch(body)).status, JSON.stringify(body)).toBe(400);
  expect(await stored(f.id)).toMatchObject({ sleep_after_seconds: null });
  const same = await patch({ size_class_id: f.size });
  expect(same.status).toBe(202);
  expect(DatabaseWithOperation.parse(await same.json())).toMatchObject({
    database: { generation: 1, sleep_after_seconds: null },
    operation: { kind: "database.resize", status: "succeeded", generation: 1 },
  });
});
