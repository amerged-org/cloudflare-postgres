// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { configureNodeRegionPolicy } from "../../src/domain/node-state.ts";
import { recoverQuiescence } from "../../src/domain/lifecycle.ts";
import {
  recordStartupReadyStatement,
  recordStartupObservationStatement,
  releaseCoveredStartupReservationsStatement,
} from "../../src/domain/startup-admission.ts";
import {
  cleanupFixtures,
  fixture,
  observation,
  observedBody,
  request,
} from "./fixtures.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
});
const mib = 1024 * 1024;
async function coldDatabases(count = 2) {
  const f = await fixture(4096, 40);
  const uid = crypto.randomUUID();
  await env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?")
    .bind(uid, f.node)
    .run();
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 2,
    purchases_enabled: false,
    order: null,
    placement_mode: "actual_ram",
    maximum_database_memory_mib: 4096,
    postgres_memory_request_mib: 128,
  });
  const databases: string[] = [];
  for (let index = 0; index < count; index++) {
    const created = DatabaseWithOperation.parse(
      await (await f.create(`cold-${index}`)).json(),
    );
    const id = created.database.id;
    databases.push(id);
    // An established, already-settled cohort isolates cold-start admission from
    // initial-placement tests. The real API creates its credentials/operation;
    // the fixture supplies the pre-existing placement before the actual ready ack.
    await env.DB.prepare(
      "UPDATE databases SET node_id=?,observed_state='provisioning' WHERE id=?",
    )
      .bind(f.node, id)
      .run();
    await request(
      "/agent/v1/observations",
      f.agent,
      "POST",
      observedBody([observation(id, 1)]),
    );
    const suspended = DatabaseWithOperation.parse(
      await (
        await request(`/v1/databases/${id}/suspend`, f.integrator, "POST")
      ).json(),
    );
    await request(
      "/agent/v1/observations",
      f.agent,
      "POST",
      observedBody([
        {
          ...observation(id, suspended.database.generation, "hibernated"),
          power: {
            operation: suspended.operation.id,
            revision: suspended.database.generation,
            state: "hibernated",
          },
        },
      ]),
    );
  }
  await env.DB.prepare(
    "UPDATE nodes SET database_placement_closed_at=?,memory_window_valid=0 WHERE id=?",
  )
    .bind(new Date().toISOString(), f.node)
    .run();
  return { ...f, uid, databases };
}
async function sample(
  f: Awaited<ReturnType<typeof coldDatabases>>,
  available: number | null,
  at = Date.now(),
  pressure: number | null = 0,
  uid = f.uid,
) {
  const observedAt = new Date(at).toISOString();
  await env.DB.prepare(
    `INSERT INTO node_memory_samples(node_id,node_uid,minute,observed_at,working_set_bytes,capacity_memory_bytes,available_bytes,memory_pressure)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(node_id,node_uid,minute) DO UPDATE SET observed_at=excluded.observed_at,working_set_bytes=excluded.working_set_bytes,capacity_memory_bytes=excluded.capacity_memory_bytes,available_bytes=excluded.available_bytes,memory_pressure=excluded.memory_pressure`,
  )
    .bind(
      f.node,
      uid,
      Math.floor(at / 60000),
      observedAt,
      available === null ? null : 8192 * mib - available,
      8192 * mib,
      available,
      pressure,
    )
    .run();
}
const resume = (f: Awaited<ReturnType<typeof coldDatabases>>, id: string) =>
  request(
    `/v1/databases/${id}/resume`,
    f.integrator,
    "POST",
    undefined,
    crypto.randomUUID(),
  );

it("atomically grants only one full startup peak across concurrent existing resumes on a placement-closed node", async () => {
  const f = await coldDatabases();
  await sample(f, 1024 * mib);
  const results = await Promise.all(f.databases.map((id) => resume(f, id)));
  expect(results.map((response) => response.status).sort()).toEqual([202, 409]);
  const rows = (
    await env.DB.prepare(
      "SELECT id,desired_state,generation FROM databases WHERE id IN(?,?) ORDER BY id",
    )
      .bind(...f.databases)
      .all<{ id: string; desired_state: string; generation: number }>()
  ).results;
  expect(rows.filter((row) => row.desired_state === "running")).toHaveLength(1);
  expect(
    rows.filter(
      (row) => row.desired_state === "suspended" && row.generation === 2,
    ),
  ).toHaveLength(1);
  const leases = (
    await env.DB.prepare(
      "SELECT node_id,node_uid,budget_bytes FROM database_start_admissions",
    ).all()
  ).results;
  expect(leases).toEqual([
    { node_id: f.node, node_uid: f.uid, budget_bytes: 1024 * mib },
  ]);
});

it("refuses missing or stale physical memory and never falls back from a newer unknown sample to an older healthy one", async () => {
  const f = await coldDatabases(1);
  const id = f.databases[0]!;
  expect((await resume(f, id)).status).toBe(409);
  await sample(f, 2048 * mib, Date.now() - 91000);
  expect((await resume(f, id)).status).toBe(409);
  await sample(f, 2048 * mib, Date.now() - 60000);
  await sample(f, null, Date.now(), null);
  expect((await resume(f, id)).status).toBe(409);
  expect(
    await env.DB.prepare(
      "SELECT desired_state,generation FROM databases WHERE id=?",
    )
      .bind(id)
      .first(),
  ).toEqual({ desired_state: "suspended", generation: 2 });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) count FROM operations WHERE database_id=? AND kind='database.resume'",
    )
      .bind(id)
      .first("count"),
  ).toBe(0);
});

it("requires the current physical Node UID and refuses MemoryPressure before granting a start", async () => {
  const f = await coldDatabases(1);
  const id = f.databases[0]!;
  await sample(f, 2048 * mib, Date.now(), 0, crypto.randomUUID());
  expect((await resume(f, id)).status).toBe(409);
  await sample(f, 2048 * mib, Date.now(), 1);
  expect((await resume(f, id)).status).toBe(409);
  await sample(f, 2048 * mib, Date.now() + 1, 0);
  expect((await resume(f, id)).status).toBe(202);
});

it("refuses a cold Actor wake before changing idle intent when the full startup peak does not fit", async () => {
  const f = await coldDatabases(1);
  const id = f.databases[0]!;
  const operation = (await env.DB.prepare(
    "SELECT power_operation FROM databases WHERE id=?",
  )
    .bind(id)
    .first("power_operation")) as string;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE operations SET kind='database.hibernate' WHERE id=? AND database_id=? AND generation=2",
    ).bind(operation, id),
    env.DB.prepare(
      "UPDATE databases SET suspension_reason='idle',power_operation=? WHERE id=?",
    ).bind(operation, id),
  ]);
  await sample(f, 256 * mib);
  const actor = env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id));
  expect(
    await actor.ensureAwake(id, "app", { deadline: Date.now() + 25 }),
  ).toEqual({ ok: false, sqlstate: "57P03" });
  expect(
    await env.DB.prepare(
      "SELECT desired_state,suspension_reason,power_operation,generation FROM databases WHERE id=?",
    )
      .bind(id)
      .first(),
  ).toEqual({
    desired_state: "suspended",
    suspension_reason: "idle",
    power_operation: operation,
    generation: 2,
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) count FROM operations WHERE database_id=? AND kind='database.wake'",
    )
      .bind(id)
      .first("count"),
  ).toBe(0);
});

it("coalesces ten eligible cold connections to one startup lease without reopening manual suspension", async () => {
  const f = await coldDatabases();
  const id = f.databases[0]!;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE operations SET kind='database.hibernate' WHERE id=(SELECT power_operation FROM databases WHERE id=?)",
    ).bind(id),
    env.DB.prepare(
      "UPDATE databases SET suspension_reason='idle' WHERE id=?",
    ).bind(id),
  ]);
  await sample(f, 1024 * mib);
  const manual = env.DATABASE_ACTOR.get(
    env.DATABASE_ACTOR.idFromName(f.databases[1]!),
  );
  expect(
    await manual.ensureAwake(f.databases[1], "app", {
      deadline: Date.now() + 100,
    }),
  ).toEqual({ ok: false, sqlstate: "57P03" });
  const actor = env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id));
  const connections = Array.from({ length: 10 }, () =>
    actor.ensureAwake(id, "app", { deadline: Date.now() + 3000 }),
  );
  await expect
    .poll(
      async () =>
        await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
          .bind(id)
          .first("generation"),
    )
    .toBe(3);
  const operation = (await env.DB.prepare(
    "SELECT power_operation FROM databases WHERE id=?",
  )
    .bind(id)
    .first("power_operation")) as string;
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(id, 3),
        power: { operation, revision: 3, state: "awake" },
      },
    ]),
  );
  expect((await Promise.all(connections)).every((result) => result.ok)).toBe(
    true,
  );
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) count FROM database_start_admissions WHERE database_id=?",
    )
      .bind(id)
      .first("count"),
  ).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) count FROM operations WHERE database_id=? AND kind='database.wake'",
    )
      .bind(id)
      .first("count"),
  ).toBe(1);
});

it("retains failed uncertain starts despite fresh memory and only releases a bound-ready start after a later physical sample", async () => {
  const f = await coldDatabases();
  await sample(f, 1024 * mib);
  const resumed = DatabaseWithOperation.parse(
    await (await resume(f, f.databases[0]!)).json(),
  );
  const release = () =>
    releaseCoveredStartupReservationsStatement(env.DB, {
      nodeId: f.node,
      nodeUid: f.uid,
    }).run();
  await env.DB.prepare(
    "UPDATE operations SET status='failed',error_code='operation_timeout',completed_at=? WHERE id=?",
  )
    .bind(new Date().toISOString(), resumed.operation.id)
    .run();
  await sample(f, 1024 * mib, Date.now() + 1);
  expect((await release()).meta.changes).toBe(0);
  expect((await resume(f, f.databases[1]!)).status).toBe(409);
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(resumed.database.id, 3),
        power: { operation: resumed.operation.id, revision: 3, state: "awake" },
      },
    ]),
  );
  const readyAt = (await env.DB.prepare(
    "SELECT updated_at FROM databases WHERE id=?",
  )
    .bind(resumed.database.id)
    .first("updated_at")) as string;
  await recordStartupReadyStatement(env.DB, {
    databaseId: resumed.database.id,
    generation: 3,
    readyAt,
  }).run();
  expect(
    await env.DB.prepare(
      "SELECT ready_at FROM database_start_admissions WHERE operation_id=?",
    )
      .bind(resumed.operation.id)
      .first("ready_at"),
  ).toBe(readyAt);
  expect((await release()).meta.changes).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 5100));
  await sample(f, 1024 * mib);
  expect((await release()).meta.changes).toBe(1);
  expect((await resume(f, f.databases[1]!)).status).toBe(202);
}, 15000);

it("settles delete-before-ready only from accepted deletion and a later physical observation", async () => {
  const f = await coldDatabases(1);
  await sample(f, 1024 * mib);
  const resumed = DatabaseWithOperation.parse(
    await (await resume(f, f.databases[0]!)).json(),
  );
  const deleted = DatabaseWithOperation.parse(
    await (
      await request(
        `/v1/databases/${resumed.database.id}`,
        f.integrator,
        "DELETE",
      )
    ).json(),
  );
  const prematureAt = (await env.DB.prepare(
    "SELECT updated_at FROM databases WHERE id=?",
  )
    .bind(resumed.database.id)
    .first("updated_at")) as string;
  expect(
    (
      await recordStartupObservationStatement(env.DB, {
        databaseId: resumed.database.id,
        generation: deleted.database.generation,
        observedAt: prematureAt,
        state: "deleted",
      }).run()
    ).meta.changes,
  ).toBe(0);
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      observation(resumed.database.id, deleted.database.generation, "deleted"),
    ]),
  );
  const stoppedAt = (await env.DB.prepare(
    "SELECT updated_at FROM databases WHERE id=?",
  )
    .bind(resumed.database.id)
    .first("updated_at")) as string;
  await recordStartupObservationStatement(env.DB, {
    databaseId: resumed.database.id,
    generation: deleted.database.generation,
    observedAt: stoppedAt,
    state: "deleted",
  }).run();
  const release = () =>
    releaseCoveredStartupReservationsStatement(env.DB, {
      nodeId: f.node,
      nodeUid: f.uid,
    }).run();
  expect((await release()).meta.changes).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 5100));
  await sample(f, 1024 * mib);
  expect((await release()).meta.changes).toBe(1);
}, 15000);

it("keeps busy compensation on the existing awake path but refuses an unknown restart without memory evidence", async () => {
  const f = await coldDatabases();
  for (const id of f.databases)
    await env.DB.prepare(
      "UPDATE operations SET status='running',completed_at=NULL WHERE id=(SELECT power_operation FROM databases WHERE id=?)",
    )
      .bind(id)
      .run();
  const unknownId = f.databases[0]!,
    busyId = f.databases[1]!;
  const unknown = (await env.DB.prepare(
    "SELECT power_operation FROM databases WHERE id=?",
  )
    .bind(unknownId)
    .first("power_operation")) as string;
  expect(
    await recoverQuiescence(
      env.DB,
      { databaseId: unknownId, operation: unknown, revision: 2 },
      "unknown",
    ),
  ).toBeNull();
  await env.DB.prepare(
    "UPDATE databases SET observed_power='awake',observed_generation=1 WHERE id=?",
  )
    .bind(busyId)
    .run();
  const busy = (await env.DB.prepare(
    "SELECT power_operation FROM databases WHERE id=?",
  )
    .bind(busyId)
    .first("power_operation")) as string;
  expect(
    await recoverQuiescence(
      env.DB,
      { databaseId: busyId, operation: busy, revision: 2 },
      "busy",
    ),
  ).toMatchObject({ revision: 3, regionId: f.region });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) count FROM database_start_admissions",
    ).first("count"),
  ).toBe(0);
});

it("does not let a stale busy refusal reopen a same-timestamp confirmed hibernation without an admission", async () => {
  const f = await coldDatabases(1);
  const id = f.databases[0]!;
  const row = await env.DB.prepare(
    "SELECT power_operation,updated_at FROM databases WHERE id=?",
  )
    .bind(id)
    .first<{ power_operation: string; updated_at: string }>();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE operations SET status='running',completed_at=NULL WHERE id=?",
    ).bind(row!.power_operation),
    env.DB.prepare(
      "UPDATE databases SET observed_power='awake',observed_generation=1 WHERE id=?",
    ).bind(id),
  ]);
  const prototype = Object.getPrototypeOf(env.DB);
  const batch = prototype.batch;
  vi.spyOn(prototype, "batch").mockImplementationOnce(
    async function (statements) {
      // Exact real D1 updates model the accepted stop arriving between read and CAS.
      await env.DB.prepare(
        "UPDATE databases SET observed_power='hibernated',observed_generation=generation WHERE id=?",
      )
        .bind(id)
        .run();
      await env.DB.prepare(
        "UPDATE operations SET status='succeeded',completed_at=? WHERE id=?",
      )
        .bind(row!.updated_at, row!.power_operation)
        .run();
      return batch.call(env.DB, statements);
    },
  );
  expect(
    await recoverQuiescence(
      env.DB,
      { databaseId: id, operation: row!.power_operation, revision: 2 },
      "busy",
    ),
  ).toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT desired_state,observed_power,generation FROM databases WHERE id=?",
    )
      .bind(id)
      .first(),
  ).toEqual({
    desired_state: "suspended",
    observed_power: "hibernated",
    generation: 2,
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) count FROM database_start_admissions",
    ).first("count"),
  ).toBe(0);
});
