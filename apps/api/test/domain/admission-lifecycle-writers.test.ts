// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  evictDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";
import { recoverQuiescence } from "../../src/domain/lifecycle.ts";
import { databaseResizeStatement } from "../../src/domain/databases.ts";
import { withAdmissionMutation } from "../../src/domain/admission-mutations.ts";
import type { DatabaseRow, SizeRow } from "../../src/domain/rows.ts";
import { createApp } from "../../src/app.ts";

const classes: string[] = [];
afterEach(async () => {
  await env.DB.exec(
    "DROP TRIGGER IF EXISTS admission_writer_fence; DROP TRIGGER IF EXISTS admission_writer_abort; DROP TRIGGER IF EXISTS admission_writer_race",
  );
  await cleanupFixtures();
  for (const id of classes.splice(0))
    await env.DB.prepare("DELETE FROM size_classes WHERE id=?").bind(id).run();
});
const actorFor = (id: string) =>
  env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id));
async function ready() {
  const f = await fixture(8192),
    created = DatabaseWithOperation.parse(await (await f.create()).json());
  await env.DB.prepare(
    "UPDATE databases SET observed_state='ready',observed_generation=generation,power_operation=NULL WHERE id=?",
  )
    .bind(created.database.id)
    .run();
  expect(
    (await actorFor(created.database.id).admit(created.database.id, "app")).ok,
  ).toBe(true);
  return { ...f, id: created.database.id };
}
async function resizeTarget(f: Awaited<ReturnType<typeof ready>>) {
  const id =
    "admission-" + crypto.randomUUID().replaceAll("-", "").slice(0, 20);
  classes.push(id);
  await env.DB.prepare(
    "INSERT INTO size_classes(id,memory_mib,cpu_millicores,storage_gib,max_connections,sleep_after_seconds,archive_timeout_seconds,backup_retention_days,enabled,created_at,updated_at) SELECT ?,1024,750,storage_gib,max_connections,sleep_after_seconds,archive_timeout_seconds,backup_retention_days,1,created_at,updated_at FROM size_classes WHERE id=?",
  )
    .bind(id, f.size)
    .run();
  return id;
}
async function requireFence(id: string, columns: string) {
  await env.DB.exec(
    `CREATE TRIGGER admission_writer_fence BEFORE UPDATE OF ${columns} ON databases WHEN NEW.id='${id}' AND NOT EXISTS(SELECT 1 FROM database_admission_epochs e WHERE e.database_id=NEW.id AND e.mutation_id IS NOT NULL AND e.mutation_status='pending') BEGIN SELECT RAISE(ABORT,'database mutation lacks admission fence'); END`,
  );
}

it("manual suspend and resume reserve the admission fence before their authoritative field writes", async () => {
  const f = await ready();
  await requireFence(f.id, "desired_state");
  const suspended = await request(
    `/v1/databases/${f.id}/suspend`,
    f.integrator,
    "POST",
  );
  expect(suspended.status).toBe(202);
  await evictDurableObject(actorFor(f.id));
  expect(await actorFor(f.id).admit(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
  const resumed = await request(
    `/v1/databases/${f.id}/resume`,
    f.integrator,
    "POST",
  );
  expect(resumed.status).toBe(202);
  expect(
    await env.DB.prepare(
      "SELECT generation,observed_generation,desired_state FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({
    generation: 3,
    observed_generation: 1,
    desired_state: "running",
  });
  expect(await actorFor(f.id).admit(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
  expect(
    await env.DB.prepare(
      "SELECT mutation_id,mutation_outcome,admission_revision FROM database_admission_epochs WHERE database_id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({
    mutation_id: null,
    mutation_outcome: "committed",
    admission_revision: 3,
  });
});

it("manual resize reserves the admission fence before changing the runtime generation", async () => {
  const f = await ready(),
    target = await resizeTarget(f);
  await requireFence(f.id, "size_class_id");
  const response = await request(
    `/v1/databases/${f.id}`,
    f.integrator,
    "PATCH",
    { size_class_id: target },
  );
  expect(response.status).toBe(202);
  expect(
    DatabaseWithOperation.parse(await response.json()).database,
  ).toMatchObject({ generation: 2, size_class_id: target });
  expect(await actorFor(f.id).admit(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
});

it("deletion reserves the admission fence before marking the database deleted", async () => {
  const f = await ready();
  await requireFence(f.id, "desired_state,observed_state");
  const response = await request(
    `/v1/databases/${f.id}`,
    f.integrator,
    "DELETE",
  );
  expect(response.status).toBe(202);
  expect(
    await env.DB.prepare(
      "SELECT desired_state,generation FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ desired_state: "deleted", generation: 2 });
  expect((await actorFor(f.id).admit(f.id, "app")).ok).toBe(false);
});

it("a deletion reads the generation under its own fence, so a change committed just before it does not fail it", async () => {
  const f = await ready();
  // A power change commits after the request has read the database and before the deletion takes
  // its fence: here, while the idempotency reservation is written.
  await env.DB.exec(
    `CREATE TRIGGER admission_writer_race AFTER INSERT ON idempotency_keys BEGIN UPDATE databases SET generation=generation+1 WHERE id='${f.id}'; END`,
  );
  const response = await request(
    `/v1/databases/${f.id}`,
    f.integrator,
    "DELETE",
    undefined,
    crypto.randomUUID(),
  );
  expect(response.status).toBe(202);
  const deleted = DatabaseWithOperation.parse(await response.json());
  expect(deleted.database).toMatchObject({
    desired_state: "deleted",
    generation: 3,
  });
  expect(deleted.operation).toMatchObject({
    kind: "database.delete",
    generation: 3,
  });
});

it("an unplaced deletion keeps its secondary deleted-state write inside the same fence", async () => {
  const f = await fixture(),
    created = DatabaseWithOperation.parse(
      await (
        await request("/v1/databases", f.integrator, "POST", {
          project_id: f.project,
          region_id: f.foreign,
          name: "queued-deletion",
          size_class_id: f.size,
        })
      ).json(),
    ),
    id = created.database.id;
  expect(created.database.observed_state).toBe("pending");
  await requireFence(id, "desired_state,observed_state");
  const response = await request(`/v1/databases/${id}`, f.integrator, "DELETE");
  expect(response.status).toBe(202);
  expect(DatabaseWithOperation.parse(await response.json())).toMatchObject({
    database: { desired_state: "deleted", observed_state: "deleted" },
    operation: { status: "succeeded" },
  });
  expect((await actorFor(id).admit(id, "app")).ok).toBe(false);
});

it("same-configuration resume and resize no-ops keep an already-ready Actor admitted", async () => {
  const f = await ready();
  await requireFence(f.id, "desired_state,size_class_id");
  const before = await env.DB.prepare(
    "SELECT admission_revision,route_revision FROM database_admission_epochs WHERE database_id=?",
  )
    .bind(f.id)
    .first();
  expect(
    (await request(`/v1/databases/${f.id}/resume`, f.integrator, "POST"))
      .status,
  ).toBe(202);
  expect(
    (
      await request(`/v1/databases/${f.id}`, f.integrator, "PATCH", {
        size_class_id: f.size,
      })
    ).status,
  ).toBe(202);
  expect(
    await env.DB.prepare(
      "SELECT generation,size_class_id FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ generation: 1, size_class_id: f.size });
  expect(
    await env.DB.prepare(
      "SELECT admission_revision,route_revision FROM database_admission_epochs WHERE database_id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual(before);
  expect((await actorFor(f.id).admit(f.id, "app")).ok).toBe(true);
});

it("a lost reply after an actual resize commit stays denied and idempotent replay does not write again", async () => {
  const f = await ready(),
    target = await resizeTarget(f),
    key = crypto.randomUUID();
  let businessBatches = 0;
  const db = new Proxy(env.DB, {
    get(actual, property) {
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const result = await actual.batch(statements);
          if (++businessBatches === 1)
            throw new Error("reply lost after actual resize commit");
          return result;
        };
      const value = Reflect.get(actual, property, actual);
      return typeof value === "function" ? value.bind(actual) : value;
    },
  });
  const execute = async () => {
    const context = createExecutionContext();
    const response = await createApp().fetch(
      new Request(`https://api.invalid/v1/databases/${f.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${f.integrator}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({ size_class_id: target }),
      }),
      { ...env, DB: db },
      context,
    );
    await waitOnExecutionContext(context);
    return response;
  };
  expect((await execute()).status).toBe(500);
  expect(
    await env.DB.prepare(
      "SELECT generation,size_class_id FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ generation: 2, size_class_id: target });
  await evictDurableObject(actorFor(f.id));
  expect(await actorFor(f.id).admit(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
  const replay = await execute();
  expect(replay.status).toBe(202);
  expect(
    DatabaseWithOperation.parse(await replay.json()).database.generation,
  ).toBe(2);
  expect(businessBatches).toBe(1);
});

it("quiescence compensation fences the current Actor before changing a rejected stop", async () => {
  const f = await ready(),
    suspended = DatabaseWithOperation.parse(
      await (
        await request(`/v1/databases/${f.id}/suspend`, f.integrator, "POST")
      ).json(),
    );
  await requireFence(f.id, "desired_state");
  const recovered = await recoverQuiescence(
    env,
    { databaseId: f.id, operation: suspended.operation.id, revision: 2 },
    "timeout",
  );
  expect(recovered).toMatchObject({ revision: 3, regionId: f.region });
  expect(await actorFor(f.id).admit(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
});

it("a delayed resize statement cannot change the database after an actual aborted mutation is fenced", async () => {
  const f = await ready(),
    target = await resizeTarget(f),
    row = (await env.DB.prepare("SELECT * FROM databases WHERE id=?")
      .bind(f.id)
      .first<DatabaseRow>())!,
    size = (await env.DB.prepare("SELECT * FROM size_classes WHERE id=?")
      .bind(target)
      .first<SizeRow>())!;
  let delayed: D1PreparedStatement | undefined;
  await env.DB.exec(
    `CREATE TRIGGER admission_writer_abort BEFORE UPDATE OF size_class_id ON databases WHEN NEW.id='${f.id}' BEGIN SELECT RAISE(ABORT,'actual resize interrupted'); END`,
  );
  try {
    await expect(
      withAdmissionMutation(env, [f.id], async (mutation) => {
        delayed = databaseResizeStatement(
          env.DB,
          row,
          size,
          new Date().toISOString(),
          undefined,
          undefined,
          mutation.guard(f.id),
        );
        await mutation.batch([delayed]);
      }),
    ).rejects.toThrow();
  } finally {
    await env.DB.exec("DROP TRIGGER admission_writer_abort");
  }
  expect((await delayed!.run()).meta.changes).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT size_class_id,generation FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ size_class_id: f.size, generation: 1 });
  expect(
    await env.DB.prepare(
      "SELECT mutation_id,mutation_outcome FROM database_admission_epochs WHERE database_id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ mutation_id: null, mutation_outcome: "fenced" });
});
