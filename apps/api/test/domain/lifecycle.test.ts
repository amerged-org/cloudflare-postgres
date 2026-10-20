// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { recoverQuiescence } from "../../src/domain/lifecycle.ts";
import { afterEach, expect, it } from "vitest";
import {
  cleanupFixtures,
  desiredPage,
  fixture,
  request,
  report,
  verdicts,
} from "./fixtures.ts";

afterEach(cleanupFixtures);
async function ready() {
  const f = await fixture();
  const result = DatabaseWithOperation.parse(await (await f.create()).json());
  await report(f, result.database.id, 1);
  return { ...f, id: result.database.id };
}
const change = (
  f: Awaited<ReturnType<typeof ready>>,
  action: string,
  key?: string,
  auth = f.integrator,
) => request(`/v1/databases/${f.id}/${action}`, auth, "POST", undefined, key);

it("authorizes suspend/resume and keeps one operation, reservation and archive across replay", async () => {
  const f = await ready();
  expect((await change(f, "suspend", undefined, f.otherKey)).status).toBe(404);
  const before = await env.DB.prepare(
    "SELECT archive_path,node_id,size_class_id FROM databases WHERE id=?",
  )
    .bind(f.id)
    .first();
  const first = await change(f, "suspend", "suspend-once");
  expect(first.status).toBe(202);
  const suspended = DatabaseWithOperation.parse(await first.json());
  expect(suspended.database.desired_state).toBe("suspended");
  expect(suspended.database.suspension_reason).toBe("manual");
  expect(suspended.operation.kind).toBe("database.suspend");
  expect(suspended.operation.status).toBe("pending");
  expect(
    DatabaseWithOperation.parse(
      await (await change(f, "suspend", "suspend-once")).json(),
    ).operation.id,
  ).toBe(suspended.operation.id);
  expect(
    DatabaseWithOperation.parse(
      await (await change(f, "suspend", "second-key")).json(),
    ).operation.id,
  ).toBe(suspended.operation.id);
  const db = (await desiredPage(f)).databases.find((d) => d.id === f.id)!;
  expect(db).toMatchObject({
    operation: suspended.operation.id,
    generation: 2,
    desired_state: "suspended",
  });
  expect(await verdicts(await report(f, f.id, 2, "asleep"))).toEqual([
    "accept",
  ]);
  expect((await request(`/v1/databases/${f.id}`, f.integrator)).status).toBe(
    200,
  );
  expect(
    await env.DB.prepare("SELECT status FROM operations WHERE id=?")
      .bind(suspended.operation.id)
      .first("status"),
  ).toBe("succeeded");
  expect(
    await (await request(`/v1/databases/${f.id}`, f.integrator)).json(),
  ).toMatchObject({ observed_state: "hibernated", observed_generation: 2 });
  const resume = DatabaseWithOperation.parse(
    await (await change(f, "resume", "resume-once")).json(),
  );
  expect(resume.database.observed_state).toBe("provisioning");
  expect(resume.operation.kind).toBe("database.resume");
  expect(resume.database.generation).toBe(3);
  expect(
    await env.DB.prepare(
      "SELECT archive_path,node_id,size_class_id FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual(before);
  expect(
    (await request(`/v1/operations/${suspended.operation.id}`, f.integrator))
      .status,
  ).toBe(200);
});

it("requires exact power-ready identity and current generation before completing resume", async () => {
  const f = await ready();
  const suspended = DatabaseWithOperation.parse(
    await (await change(f, "suspend")).json(),
  );
  const resume = DatabaseWithOperation.parse(
    await (await change(f, "resume")).json(),
  );
  // A report names the generation and the operation that made it: another operation of the
  // generation conflicts, and an older generation is stale.
  for (const [generation, operation, verdict] of [
    [3, suspended.operation.id, "conflict"],
    [2, resume.operation.id, "stale"],
  ] as const) {
    expect(
      await verdicts(await report(f, f.id, generation, "ready", { operation })),
    ).toEqual([verdict]);
    expect(
      await env.DB.prepare("SELECT status FROM operations WHERE id=?")
        .bind(resume.operation.id)
        .first("status"),
    ).toBe("pending");
  }
  expect(await verdicts(await report(f, f.id, 3))).toEqual(["accept"]);
  expect(
    await env.DB.prepare("SELECT status FROM operations WHERE id=?")
      .bind(resume.operation.id)
      .first("status"),
  ).toBe("succeeded");
  const events = (
    await env.DB.prepare(
      "SELECT * FROM lifecycle_events WHERE database_id=? AND kind='woke'",
    )
      .bind(f.id)
      .all()
  ).results;
  expect(events).toHaveLength(1);
  expect(JSON.parse(events[0]!.resource_snapshot as string)).toEqual({
    memory_mib: expect.any(Number),
    cpu_millicores: 500,
  });
  await expect(
    env.DB.prepare(
      "UPDATE lifecycle_events SET resource_snapshot='{}' WHERE database_id=?",
    )
      .bind(f.id)
      .run(),
  ).rejects.toThrow();
});

it("refuses quiescence safely with a newer running intent and ignores stale refusals", async () => {
  const f = await ready();
  const suspended = DatabaseWithOperation.parse(
    await (await change(f, "suspend")).json(),
  );
  const refuse = () => report(f, f.id, 2, "ready", { refusal: "power_busy" });
  expect(await verdicts(await refuse())).toEqual(["accept"]);
  const row = await env.DB.prepare(
    "SELECT desired_state,generation,power_operation FROM databases WHERE id=?",
  )
    .bind(f.id)
    .first();
  expect(row).toMatchObject({ desired_state: "running", generation: 3 });
  expect(row!.power_operation).not.toBe(suspended.operation.id);
  expect(
    await env.DB.prepare("SELECT status,error_code FROM operations WHERE id=?")
      .bind(suspended.operation.id)
      .first(),
  ).toEqual({ status: "failed", error_code: "power_busy" });
  expect(await verdicts(await refuse())).toEqual(["stale"]);
  expect(
    await env.DB.prepare(
      "SELECT desired_state,generation,power_operation FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual(row);
  await request(`/v1/databases/${f.id}`, f.integrator, "DELETE");
  expect(await verdicts(await refuse())).toEqual(["stale"]);
  expect(
    await env.DB.prepare("SELECT desired_state FROM databases WHERE id=?")
      .bind(f.id)
      .first("desired_state"),
  ).toBe("deleted");
});

it("keeps ready same-state resume as a stable no-op and refuses superseding deletion", async () => {
  const f = await ready();
  const first = DatabaseWithOperation.parse(
    await (await change(f, "resume", "noop")).json(),
  );
  expect(first.operation.status).toBe("succeeded");
  expect(first.database.generation).toBe(1);
  expect(
    DatabaseWithOperation.parse(
      await (await change(f, "resume", "second")).json(),
    ).operation.id,
  ).toBe(first.operation.id);
  await request(`/v1/databases/${f.id}`, f.integrator, "DELETE");
  expect((await change(f, "resume")).status).toBe(409);
  expect((await change(f, "suspend")).status).toBe(409);
});

it("timeout compensation is exact, monotonic and cannot undo a later resume or deletion", async () => {
  const f = await ready();
  const suspended = DatabaseWithOperation.parse(
    await (await change(f, "suspend")).json(),
  );
  const expected = {
    databaseId: f.id,
    operation: suspended.operation.id,
    revision: 2,
  };
  const recovery = await recoverQuiescence(env, expected, "timeout");
  expect(recovery).toMatchObject({ revision: 3, nodeId: f.node });
  expect(await recoverQuiescence(env, expected, "timeout")).toBeNull();
  expect(
    await env.DB.prepare("SELECT status,error_code FROM operations WHERE id=?")
      .bind(suspended.operation.id)
      .first(),
  ).toEqual({ status: "failed", error_code: "power_timeout" });
  expect(
    await env.DB.prepare(
      "SELECT observed_state,observed_generation FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ observed_state: "provisioning", observed_generation: 1 });
  await request(`/v1/databases/${f.id}`, f.integrator, "DELETE");
  expect(await recoverQuiescence(env, expected, "timeout")).toBeNull();
  expect(
    await env.DB.prepare("SELECT desired_state FROM databases WHERE id=?")
      .bind(f.id)
      .first("desired_state"),
  ).toBe("deleted");
});

it("resuming a still-pending manual quiesce supersedes it atomically without pretending a ready Pod", async () => {
  const f = await ready();
  const suspended = DatabaseWithOperation.parse(
    await (await change(f, "suspend")).json(),
  );
  const resumed = DatabaseWithOperation.parse(
    await (await change(f, "resume")).json(),
  );
  expect(resumed.database).toMatchObject({
    generation: 3,
    desired_state: "running",
    observed_state: "provisioning",
    observed_generation: 1,
  });
  expect(
    await env.DB.prepare("SELECT status,error_code FROM operations WHERE id=?")
      .bind(suspended.operation.id)
      .first(),
  ).toEqual({ status: "failed", error_code: "superseded" });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM operations WHERE database_id=? AND kind='database.resume'",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(1);
});

it("stale CAS cannot leave a partial power operation or change another intent", async () => {
  const f = await ready();
  const before = await env.DB.prepare("SELECT * FROM databases WHERE id=?")
    .bind(f.id)
    .first<import("../../src/domain/rows.ts").DatabaseRow>();
  const { powerTransitionStatements } =
    await import("../../src/domain/power-transition.ts");
  const { newOperationId } = await import("@pgcf/contracts");
  const first = newOperationId(),
    second = newOperationId(),
    now = new Date().toISOString();
  const results = await Promise.all([
    env.DB.batch(
      powerTransitionStatements(env.DB, before!, "suspend", first, now),
    ),
    env.DB.batch(
      powerTransitionStatements(env.DB, before!, "suspend", second, now),
    ),
  ]);
  expect(results.map((result) => result[0]!.meta.changes).sort()).toEqual([
    0, 1,
  ]);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM operations WHERE database_id=? AND kind='database.suspend'",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(1);
  const winner = await env.DB.prepare(
    "SELECT power_operation FROM databases WHERE id=?",
  )
    .bind(f.id)
    .first("power_operation");
  expect([first, second]).toContain(winner);
  expect(
    await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
      .bind(f.id)
      .first("generation"),
  ).toBe(2);
});
