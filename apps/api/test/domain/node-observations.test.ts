// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation, newOperationId } from "@pgcf/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  fixture,
  instanceOf,
  nodeRequest,
  observationOf,
  report,
  reportBody,
  request,
  served,
  setNodePolicy,
  verdicts,
} from "./fixtures.ts";

afterEach(cleanupFixtures);

type F = Awaited<ReturnType<typeof fixture>>;
async function created(f: F) {
  const result = DatabaseWithOperation.parse(await (await f.create()).json());
  return { id: result.database.id, operation: result.operation.id };
}
const row = (id: string) =>
  env.DB.prepare("SELECT * FROM databases WHERE id=?")
    .bind(id)
    .first<Record<string, string | number | null>>();
const status = async (operation: string) =>
  env.DB.prepare("SELECT status,error_code FROM operations WHERE id=?")
    .bind(operation)
    .first<{ status: string; error_code: string | null }>();
const events = async (id: string) =>
  (
    await env.DB.prepare(
      "SELECT kind,generation FROM lifecycle_events WHERE database_id=? ORDER BY id",
    )
      .bind(id)
      .all<{ kind: string; generation: number }>()
  ).results;
const created1 = { kind: "created", generation: 1 };
const ready1 = { kind: "ready", generation: 1 };
const suspend = (f: F, id: string) =>
  request(
    `/v1/databases/${id}/suspend`,
    f.integrator,
    "POST",
    undefined,
    crypto.randomUUID(),
  );

describe("a database the node reports ready", () => {
  it("becomes ready with the unit the node named, and ends the create", async () => {
    const f = await fixture();
    const db = await created(f);
    const response = await report(f, db.id, 1);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      databases: [{ id: db.id, verdict: "accept" }],
      orders: 0,
    });
    expect(await row(db.id)).toMatchObject({
      observed_state: "ready",
      observed_power: "awake",
      observed_generation: 1,
      status_message: null,
    });
    expect(
      JSON.parse((await row(db.id))!.runtime_json as string),
    ).toMatchObject({
      database_id: db.id,
      node_id: f.node,
      generation: 1,
      storage_generation: 1,
      instance: instanceOf(db.id),
    });
    expect((await status(db.operation))!.status).toBe("succeeded");
    expect(await events(db.id)).toEqual([created1, ready1]);
    expect(
      await (await request(`/v1/databases/${db.id}`, f.integrator)).json(),
    ).toMatchObject({ observed_state: "ready", observed_generation: 1 });
  });

  it("is accepted again without a second event, and a changed unit replaces the first", async () => {
    const f = await fixture();
    const db = await created(f);
    await report(f, db.id, 1);
    expect(await verdicts(await report(f, db.id, 1))).toEqual(["accept"]);
    expect(await events(db.id)).toEqual([created1, ready1]);
    const instance = crypto.randomUUID().toUpperCase();
    expect(
      await verdicts(await report(f, db.id, 1, "ready", { instance })),
    ).toEqual(["accept"]);
    // The route names the unit in lower case.
    expect(
      JSON.parse((await row(db.id))!.runtime_json as string).instance,
    ).toBe(instance.toLowerCase());
  });

  it("answers stale for an older generation, conflict for another operation and stale for another node's database", async () => {
    const f = await fixture();
    const other = await fixture();
    const db = await created(f);
    expect(
      await request(
        `/v1/databases/${db.id}/roles`,
        f.integrator,
        "POST",
        { name: "reader" },
        crypto.randomUUID(),
      ),
    ).toBeTruthy();
    // The role advanced the generation to 2.
    expect(await verdicts(await report(f, db.id, 1))).toEqual(["stale"]);
    expect(
      await verdicts(
        await report(f, db.id, 2, "ready", { operation: newOperationId() }),
      ),
    ).toEqual(["conflict"]);
    expect(await verdicts(await report(other, db.id, 2))).toEqual(["stale"]);
    expect(await verdicts(await report(f, db.id, 3))).toEqual(["conflict"]);
    expect((await row(db.id))!.observed_state).not.toBe("ready");
    // A database that does not exist is no one's to report.
    const unknown = await observationOf(db.id, 2);
    expect(
      await verdicts(
        await nodeRequest(f, "/node/v1/observations", {
          method: "POST",
          body: reportBody([{ ...unknown, id: "a".repeat(20) }]),
        }),
      ),
    ).toEqual(["stale"]);
    expect(await verdicts(await report(f, db.id, 2))).toEqual(["accept"]);
  });

  it("is not accepted for another storage generation than D1's", async () => {
    const f = await fixture();
    const db = await created(f);
    // A unit of a storage generation D1 never named must neither open the database nor end its
    // create; the older one is a retired volume, the newer one an unknown.
    await env.DB.prepare("UPDATE databases SET storage_generation=2 WHERE id=?")
      .bind(db.id)
      .run();
    for (const storage_generation of [1, 7])
      expect(
        await verdicts(
          await report(f, db.id, 1, "ready", { storage_generation }),
        ),
      ).toEqual(["conflict"]);
    expect(await row(db.id)).toMatchObject({
      observed_state: "pending",
      runtime_json: null,
    });
    expect((await status(db.operation))!.status).not.toBe("succeeded");
    expect(await verdicts(await report(f, db.id, 1))).toEqual(["accept"]);
  });

  it("is not accepted for a database that is not wanted running", async () => {
    const f = await fixture();
    const db = await created(f);
    await report(f, db.id, 1);
    await suspend(f, db.id);
    expect(await verdicts(await report(f, db.id, 2))).toEqual(["conflict"]);
    expect((await row(db.id))!.observed_state).not.toBe("hibernated");
  });

  it("ends a resize, and a role change needs no operation of its own", async () => {
    const f = await fixture();
    const db = await created(f);
    await report(f, db.id, 1);
    expect(
      await request(
        `/v1/databases/${db.id}/roles`,
        f.integrator,
        "POST",
        { name: "reader" },
        crypto.randomUUID(),
      ),
    ).toBeTruthy();
    expect(await verdicts(await report(f, db.id, 2))).toEqual(["accept"]);
    expect(await row(db.id)).toMatchObject({
      observed_generation: 2,
      observed_state: "ready",
    });
    expect(await events(db.id)).toEqual([
      created1,
      ready1,
      { kind: "ready", generation: 2 },
    ]);
  });
});

describe("a database the node is still building or cannot run", () => {
  it("is provisioning while it builds and does not fall back from ready", async () => {
    const f = await fixture();
    const db = await created(f);
    expect(
      await verdicts(
        await report(f, db.id, 1, "building", { message: "initdb" }),
      ),
    ).toEqual(["accept"]);
    expect(await row(db.id)).toMatchObject({
      observed_state: "provisioning",
      observed_generation: 0,
      status_message: "initdb",
    });
    expect((await status(db.operation))!.status).toBe("running");
    await report(f, db.id, 1);
    expect((await row(db.id))!.observed_state).toBe("ready");
  });

  it("fails the operations that asked with the error, and recovers with a ready", async () => {
    const f = await fixture();
    const db = await created(f);
    await report(f, db.id, 1, "error", {
      error: "prefix_not_empty",
      message: "the archive path holds objects",
    });
    expect(await row(db.id)).toMatchObject({
      observed_state: "error",
      status_message: "prefix_not_empty: the archive path holds objects",
    });
    expect(await status(db.operation)).toEqual({
      status: "failed",
      error_code: "prefix_not_empty",
    });
    expect(
      await (await request(`/v1/databases/${db.id}`, f.integrator)).json(),
    ).toMatchObject({ observed_state: "error" });
    await report(f, db.id, 1);
    expect((await row(db.id))!.observed_state).toBe("ready");
  });

  it("is told apart from a ready one while its recovery after a crash runs", async () => {
    const f = await fixture();
    const db = await created(f);
    await report(f, db.id, 1);
    expect(await verdicts(await report(f, db.id, 1, "unproven"))).toEqual([
      "accept",
    ]);
    expect(await row(db.id)).toMatchObject({
      observed_state: "provisioning",
      observed_power: "awake",
      runtime_json: null,
    });
  });
});

describe("the archive and the backup the node reports", () => {
  it("maps the archive to its health and keeps the time a failure began", async () => {
    const f = await fixture();
    const db = await created(f);
    const since = new Date(Date.now() - 3600_000).toISOString();
    await report(f, db.id, 1, "ready", {
      archive: { last_segment: null, ready_files: 3, failing_since: since },
    });
    expect(await row(db.id)).toMatchObject({
      archiving_health: "failing",
      archiving_health_since: since,
    });
    await report(f, db.id, 1, "ready", {
      archive: { last_segment: null, ready_files: null, failing_since: null },
    });
    expect((await row(db.id))!.archiving_health).toBe("unknown");
    await report(f, db.id, 1, "ready");
    const healthy = await row(db.id);
    expect(healthy!.archiving_health).toBe("ok");
    expect(healthy!.archiving_health_since).not.toBe(since);
    // The same health keeps the time it began.
    await report(f, db.id, 1, "ready");
    expect((await row(db.id))!.archiving_health_since).toBe(
      healthy!.archiving_health_since,
    );
  });

  it("records the newest base backup and never an older one over it", async () => {
    const f = await fixture();
    const db = await created(f);
    const completed = new Date(Date.now() - 60_000).toISOString();
    await nodeRequest(f, "/node/v1/observations", {
      method: "POST",
      body: reportBody(
        [
          await observationOf(db.id, 1, "ready", {
            backup: {
              backup_id: "20261018T100000",
              timeline: 1,
              completed_at: completed,
            },
          }),
        ],
        [],
        new Date(Date.now() - 30_000).toISOString(),
      ),
    });
    expect(await row(db.id)).toMatchObject({
      backup_health: "ok",
      backup_last_completed_at: completed,
    });
    const older = new Date(Date.now() - 3600_000).toISOString();
    await nodeRequest(f, "/node/v1/observations", {
      method: "POST",
      body: reportBody(
        [
          await observationOf(db.id, 1, "ready", {
            backup: {
              backup_id: "20261018T090000",
              timeline: 1,
              completed_at: older,
            },
          }),
        ],
        [],
        new Date(Date.now() - 90_000).toISOString(),
      ),
    });
    expect((await row(db.id))!.backup_last_completed_at).toBe(completed);
  });
});

describe("a database the node put to sleep", () => {
  it("ends a manual suspend with the proven sleep and shows it hibernated", async () => {
    const f = await fixture();
    const db = await created(f);
    await report(f, db.id, 1);
    const suspended = DatabaseWithOperation.parse(
      await (await suspend(f, db.id)).json(),
    );
    expect(await verdicts(await report(f, db.id, 2, "asleep"))).toEqual([
      "accept",
    ]);
    expect(await row(db.id)).toMatchObject({
      observed_state: "provisioning",
      observed_power: "hibernated",
      observed_generation: 2,
      runtime_json: null,
    });
    expect(
      JSON.parse((await row(db.id))!.proven_sleep_json as string),
    ).toMatchObject({
      system_identifier: "7428512345678901234",
      timeline: 1,
    });
    expect((await status(suspended.operation.id))!.status).toBe("succeeded");
    expect((await events(db.id)).at(-1)).toEqual({
      kind: "suspended",
      generation: 2,
    });
    expect(
      await (await request(`/v1/databases/${db.id}`, f.integrator)).json(),
    ).toMatchObject({
      desired_state: "suspended",
      observed_state: "hibernated",
    });
  });

  it("is recorded as a hibernation when the node slept it on its own after its idle time", async () => {
    const f = await fixture();
    const db = await created(f);
    await report(f, db.id, 1);
    expect(await verdicts(await report(f, db.id, 1, "asleep"))).toEqual([
      "accept",
    ]);
    const after = await row(db.id);
    expect(after).toMatchObject({
      desired_state: "suspended",
      suspension_reason: "idle",
      generation: 2,
      observed_generation: 2,
      observed_state: "provisioning",
      observed_power: "hibernated",
    });
    const hibernate = await env.DB.prepare(
      "SELECT id,kind,status,generation FROM operations WHERE database_id=? AND kind='database.hibernate'",
    )
      .bind(db.id)
      .first<{ id: string; status: string; generation: number }>();
    expect(hibernate).toMatchObject({ status: "succeeded", generation: 2 });
    expect(after!.power_operation).toBe(hibernate!.id);
    expect((await events(db.id)).at(-1)).toEqual({
      kind: "hibernated",
      generation: 2,
    });
    // The node asks for the generation it slept at; the new one is the hibernation's own.
    expect(await verdicts(await report(f, db.id, 2, "asleep"))).toEqual([
      "accept",
    ]);
    // The page shows the sleeper as running at the new generation.
    await setNodePolicy(f);
  });

  it("does not hibernate a database the node reports asleep before D1 knew it ready", async () => {
    const f = await fixture();
    const db = await created(f);
    expect(await verdicts(await report(f, db.id, 1, "asleep"))).toEqual([
      "accept",
    ]);
    expect(await row(db.id)).toMatchObject({
      desired_state: "running",
      generation: 1,
      observed_power: "hibernated",
    });
    expect(await events(db.id)).toEqual([created1]);
  });

  it("leaves the database awake and wakeable when the node refuses the sleep", async () => {
    const f = await fixture();
    const db = await created(f);
    await report(f, db.id, 1);
    const suspended = DatabaseWithOperation.parse(
      await (await suspend(f, db.id)).json(),
    );
    expect(
      await verdicts(
        await report(f, db.id, 2, "ready", { refusal: "power_busy" }),
      ),
    ).toEqual(["accept"]);
    const after = await row(db.id);
    expect(after).toMatchObject({ desired_state: "running", generation: 3 });
    expect(await status(suspended.operation.id)).toEqual({
      status: "failed",
      error_code: "power_busy",
    });
    // The refusal is final for its generation.
    expect(
      await verdicts(
        await report(f, db.id, 2, "ready", { refusal: "power_busy" }),
      ),
    ).toEqual(["stale"]);
  });
});

describe("a database the node woke or removed", () => {
  it("ends the resume that asked and records the wake", async () => {
    const f = await fixture();
    const db = await created(f);
    await report(f, db.id, 1);
    await suspend(f, db.id);
    await report(f, db.id, 2, "asleep");
    const resumed = DatabaseWithOperation.parse(
      await (
        await request(
          `/v1/databases/${db.id}/resume`,
          f.integrator,
          "POST",
          undefined,
          crypto.randomUUID(),
        )
      ).json(),
    );
    expect(await verdicts(await report(f, db.id, 3))).toEqual(["accept"]);
    expect((await status(resumed.operation.id))!.status).toBe("succeeded");
    expect((await events(db.id)).map((event) => event.kind)).toEqual([
      "created",
      "ready",
      "suspended",
      "ready",
      "woke",
    ]);
    expect(await row(db.id)).toMatchObject({
      observed_state: "ready",
      observed_power: "awake",
    });
  });

  it("confirms a deletion only for a database wanted deleted", async () => {
    const f = await fixture();
    const db = await created(f);
    await report(f, db.id, 1);
    expect(
      await verdicts(
        await report(f, db.id, 1, "deleted", { instance: undefined }),
      ),
    ).toEqual(["conflict"]);
    const removed = DatabaseWithOperation.parse(
      await (
        await request(`/v1/databases/${db.id}`, f.integrator, "DELETE")
      ).json(),
    );
    expect(await verdicts(await report(f, db.id, 2, "deleted"))).toEqual([
      "accept",
    ]);
    expect(await row(db.id)).toMatchObject({
      observed_state: "deleted",
      observed_generation: 2,
    });
    expect((await status(removed.operation.id))!.status).toBe("succeeded");
    expect((await events(db.id)).at(-1)).toEqual({
      kind: "deleted",
      generation: 2,
    });
  });
});

describe("roles the node removed", () => {
  it("frees the name of a role it dropped and fails the removal of one it could not", async () => {
    const f = await fixture();
    const db = await created(f);
    await report(f, db.id, 1);
    for (const name of ["reader", "writer"]) {
      await request(
        `/v1/databases/${db.id}/roles`,
        f.integrator,
        "POST",
        { name },
        crypto.randomUUID(),
      );
      await request(
        `/v1/databases/${db.id}/roles/${name}`,
        f.integrator,
        "DELETE",
        undefined,
        crypto.randomUUID(),
      );
    }
    const generation = (await row(db.id))!.generation as number;
    await report(f, db.id, generation, "ready", {
      roles: { removed: ["reader"], blocked: ["writer"] },
    });
    const removals = await env.DB.prepare(
      "SELECT role_name,status,error_code FROM role_deletions WHERE database_id=? ORDER BY role_name",
    )
      .bind(db.id)
      .all();
    expect(removals.results).toEqual([
      { role_name: "reader", status: "succeeded", error_code: null },
      {
        role_name: "writer",
        status: "failed",
        error_code: "role_not_droppable",
      },
    ]);
    expect(
      (
        await env.DB.prepare(
          "SELECT name FROM roles WHERE database_id=? ORDER BY name",
        )
          .bind(db.id)
          .all()
      ).results,
    ).toEqual([{ name: "app" }, { name: "writer" }]);
  });
});

describe("the results of a node's orders", () => {
  it("fails the resume of a wake the node refused, with the reason", async () => {
    const f = await fixture();
    const db = await created(f);
    await report(f, db.id, 1);
    await suspend(f, db.id);
    await report(f, db.id, 2, "asleep");
    const resumed = DatabaseWithOperation.parse(
      await (
        await request(
          `/v1/databases/${db.id}/resume`,
          f.integrator,
          "POST",
          undefined,
          crypto.randomUUID(),
        )
      ).json(),
    );
    const result = await nodeRequest(f, "/node/v1/observations", {
      method: "POST",
      body: reportBody(
        [],
        [
          {
            operation: resumed.operation.id,
            status: "failed",
            reason: "no_room",
          },
        ],
      ),
    });
    expect(await result.json()).toEqual({ databases: [], orders: 1 });
    expect(await status(resumed.operation.id)).toEqual({
      status: "failed",
      error_code: "no_room",
    });
    // A done wake is the ready report's to end.
    expect(
      await (
        await nodeRequest(f, "/node/v1/observations", {
          method: "POST",
          body: reportBody(
            [],
            [{ operation: resumed.operation.id, status: "done" }],
          ),
        })
      ).json(),
    ).toEqual({ databases: [], orders: 0 });
  });

  it("keeps the result of a move, a retired generation and a maintenance cycle once", async () => {
    const f = await fixture();
    const db = await served(f);
    const maintenance = newOperationId(),
      move = newOperationId(),
      now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO lifecycle_orders(operation,node_id,type,created_at) VALUES(?,?,'maintenance',?)",
      ).bind(maintenance, f.node, now),
      env.DB.prepare(
        "INSERT INTO lifecycle_orders(operation,node_id,type,database_id,storage_generation,created_at) VALUES(?,?,'move',?,1,?)",
      ).bind(move, f.node, db.id, now),
    ]);
    const send = (orders: unknown[]) =>
      nodeRequest(f, "/node/v1/observations", {
        method: "POST",
        body: reportBody([], orders),
      });
    expect(
      await (
        await send([
          { operation: maintenance, status: "done" },
          { operation: move, status: "failed", reason: "no_recovery_point" },
          { operation: newOperationId(), status: "done" },
        ])
      ).json(),
    ).toEqual({ databases: [], orders: 2 });
    expect(
      (
        await env.DB.prepare(
          "SELECT type,result_status result,result_reason reason FROM lifecycle_orders WHERE node_id=? ORDER BY type",
        )
          .bind(f.node)
          .all()
      ).results,
    ).toEqual([
      { type: "maintenance", result: "done", reason: null },
      { type: "move", result: "failed", reason: "no_recovery_point" },
    ]);
    // The first result stands.
    expect(
      await (
        await send([
          { operation: maintenance, status: "failed", reason: "boot" },
        ])
      ).json(),
    ).toEqual({ databases: [], orders: 0 });
    // Another node's order is not this node's to end.
    const other = await fixture();
    expect(
      await (
        await nodeRequest(other, "/node/v1/observations", {
          method: "POST",
          body: reportBody([], [{ operation: move, status: "done" }]),
        })
      ).json(),
    ).toEqual({ databases: [], orders: 0 });
  });

  it("reads a fenced node's report for its orders alone", async () => {
    const f = await fixture();
    const db = await created(f);
    await env.DB.prepare(
      "UPDATE nodes SET lost_at=?,lost_reason='test',ready=0,schedulable=0 WHERE id=?",
    )
      .bind(new Date().toISOString(), f.node)
      .run();
    const response = await report(f, db.id, 1);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ databases: [], orders: 0 });
    expect((await row(db.id))!.observed_state).not.toBe("ready");
  });
});

describe("a report that is not valid", () => {
  it("is refused whole", async () => {
    const f = await fixture();
    const db = await created(f);
    const good = await observationOf(db.id, 1);
    for (const body of [
      { ...reportBody([good]), extra: true },
      reportBody([good, good]),
      reportBody([{ ...good, instance: undefined }]),
      reportBody([{ ...good, state: "hibernated" }]),
      {
        ...reportBody([good]),
        observed_at: new Date(Date.now() + 3600_000).toISOString(),
      },
    ])
      expect(
        (
          await nodeRequest(f, "/node/v1/observations", {
            method: "POST",
            body,
          })
        ).status,
      ).toBe(400);
    expect((await row(db.id))!.observed_state).not.toBe("ready");
  });
});
