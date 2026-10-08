// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { placementNodes } from "../../src/domain/placement.ts";
import { configureNodeRegionPolicy } from "../../src/domain/node-state.ts";
import {
  cleanupFixtures,
  fixture,
  observation,
  observedBody,
  request,
} from "./fixtures.ts";

afterEach(cleanupFixtures);

async function readyDatabase(
  f: Awaited<ReturnType<typeof fixture>>,
  name: string,
) {
  const created = DatabaseWithOperation.parse(
    await (await f.create(name)).json(),
  );
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
  return created.database.id;
}
async function stop(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const suspended = DatabaseWithOperation.parse(
    await (
      await request(`/v1/databases/${id}/suspend`, f.integrator, "POST")
    ).json(),
  );
  const response = await request(
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
  expect(await response.json()).toEqual({ accepted: 1 });
  expect(
    await env.DB.prepare("SELECT status FROM operations WHERE id=?")
      .bind(suspended.operation.id)
      .first("status"),
  ).toBe("succeeded");
  return suspended;
}
async function coldCohort() {
  const f = await fixture(8192, 60),
    uid = crypto.randomUUID();
  await env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?")
    .bind(uid, f.node)
    .run();
  const first = await readyDatabase(f, "first"),
    second = await readyDatabase(f, "second");
  await stop(f, first);
  await stop(f, second);
  await env.DB.prepare(
    "UPDATE nodes SET allocatable_cpu_millicores=700 WHERE id=?",
  )
    .bind(f.node)
    .run();
  return { ...f, uid, first, second };
}
const resume = (f: Awaited<ReturnType<typeof fixture>>, id: string) =>
  request(
    `/v1/databases/${id}/resume`,
    f.integrator,
    "POST",
    undefined,
    crypto.randomUUID(),
  );

it("releases CPU only after an accepted owned stop, while retaining storage and uncertain quiescence", async () => {
  const f = await fixture(8192, 60);
  const id = await readyDatabase(f, "sleep-accounting");
  const before = await env.DB.prepare(
    "SELECT archive_path,node_id,size_class_id FROM databases WHERE id=?",
  )
    .bind(id)
    .first();
  expect(
    (await placementNodes(env.DB, f.region))[0]?.reserved_cpu_millicores,
  ).toBe(600);
  const suspended = DatabaseWithOperation.parse(
    await (
      await request(`/v1/databases/${id}/suspend`, f.integrator, "POST")
    ).json(),
  );
  expect(
    (await placementNodes(env.DB, f.region))[0]?.reserved_cpu_millicores,
  ).toBe(600);
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(id, 2, "hibernated"),
        power: {
          operation: suspended.operation.id,
          revision: 2,
          state: "hibernated",
        },
      },
    ]),
  );
  const node = (await placementNodes(env.DB, f.region))[0]!;
  expect(node.reserved_cpu_millicores).toBe(0);
  expect(node.reserved_storage_gib).toBe(5);
  expect(
    await env.DB.prepare(
      "SELECT archive_path,node_id,size_class_id FROM databases WHERE id=?",
    )
      .bind(id)
      .first(),
  ).toEqual(before);
  await env.DB.prepare("UPDATE operations SET status='failed' WHERE id=?")
    .bind(suspended.operation.id)
    .run();
  expect(
    (await placementNodes(env.DB, f.region))[0]?.reserved_cpu_millicores,
  ).toBe(600);
});

it("atomically reacquires CPU for only one concurrent resume under reserved RAM", async () => {
  const f = await coldCohort();
  const results = await Promise.all([resume(f, f.first), resume(f, f.second)]);
  expect(results.map((row) => row.status).sort()).toEqual([202, 409]);
  expect(
    (await placementNodes(env.DB, f.region))[0]?.reserved_cpu_millicores,
  ).toBe(600);
  const rows = await env.DB.prepare(
    "SELECT desired_state,generation FROM databases WHERE id IN(?,?)",
  )
    .bind(f.first, f.second)
    .all<{ desired_state: string; generation: number }>();
  expect(
    rows.results.filter(
      (row) => row.desired_state === "running" && row.generation === 3,
    ),
  ).toHaveLength(1);
  expect(
    rows.results.filter(
      (row) => row.desired_state === "suspended" && row.generation === 2,
    ),
  ).toHaveLength(1);
});

it("uses the same CPU wake admission under actual RAM without releasing existing peak holds", async () => {
  const f = await coldCohort();
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 2,
    purchases_enabled: false,
    order: null,
    placement_mode: "actual_ram",
    maximum_database_memory_mib: 4096,
    postgres_memory_request_mib: 128,
  });
  const at = Date.now();
  await env.DB.prepare(
    "INSERT INTO node_memory_samples(node_id,node_uid,minute,observed_at,working_set_bytes,capacity_memory_bytes,available_bytes,memory_pressure) VALUES(?,?,?,?,?,?,?,0)",
  )
    .bind(
      f.node,
      f.uid,
      Math.floor(at / 60000),
      new Date(at).toISOString(),
      1024 * 2 ** 20,
      8192 * 2 ** 20,
      7168 * 2 ** 20,
    )
    .run();
  const results = await Promise.all([resume(f, f.first), resume(f, f.second)]);
  expect(results.map((row) => row.status).sort()).toEqual([202, 409]);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) count FROM database_start_admissions WHERE node_id=?",
    )
      .bind(f.node)
      .first("count"),
  ).toBe(1);
  expect(
    (await placementNodes(env.DB, f.region))[0]?.reserved_cpu_millicores,
  ).toBe(600);
});

it("serializes a cold resume against a new create competing for the same CPU", async () => {
  const f = await coldCohort();
  const [wake, create] = await Promise.all([
    resume(f, f.first),
    f.create("new-contender"),
  ]);
  expect(create.status).toBe(202);
  expect([202, 409]).toContain(wake.status);
  expect(
    (await placementNodes(env.DB, f.region))[0]?.reserved_cpu_millicores,
  ).toBe(600);
  const created = DatabaseWithOperation.parse(await create.json());
  const assigned = await env.DB.prepare(
    "SELECT COUNT(*) count FROM databases WHERE id IN(?,?) AND desired_state='running' AND node_id=?",
  )
    .bind(f.first, created.database.id, f.node)
    .first("count");
  expect(assigned).toBe(1);
});

it("refuses CPU reacquisition with stale or missing physical identity even in reserved RAM mode", async () => {
  const f = await coldCohort();
  await env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
    .bind(new Date(Date.now() - 181_000).toISOString(), f.node)
    .run();
  expect((await resume(f, f.first)).status).toBe(409);
  await env.DB.prepare(
    "UPDATE nodes SET last_observed_at=?,node_uid=NULL WHERE id=?",
  )
    .bind(new Date().toISOString(), f.node)
    .run();
  expect((await resume(f, f.first)).status).toBe(409);
  expect(
    await env.DB.prepare(
      "SELECT generation,desired_state FROM databases WHERE id=?",
    )
      .bind(f.first)
      .first(),
  ).toEqual({ generation: 2, desired_state: "suspended" });
});

it("keeps a degraded stopped observation charged until the current owned no-Pod acknowledgement is restored", async () => {
  const f = await fixture(8192, 60);
  const id = await readyDatabase(f, "degraded-stop");
  const suspended = await stop(f, id);
  expect(
    (await placementNodes(env.DB, f.region))[0]?.reserved_cpu_millicores,
  ).toBe(0);
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(id, 2, "error"),
        power: {
          operation: suspended.operation.id,
          revision: 2,
          state: "hibernated",
        },
      },
    ]),
  );
  expect(
    (await placementNodes(env.DB, f.region))[0]?.reserved_cpu_millicores,
  ).toBe(600);
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(id, 2, "hibernated"),
        power: {
          operation: suspended.operation.id,
          revision: 2,
          state: "hibernated",
        },
      },
    ]),
  );
  expect(
    (await placementNodes(env.DB, f.region))[0]?.reserved_cpu_millicores,
  ).toBe(0);
});

it("retains a missing startup result's CPU charge even when its operation times out", async () => {
  const f = await coldCohort();
  const resumed = DatabaseWithOperation.parse(
    await (await resume(f, f.first)).json(),
  );
  await env.DB.prepare(
    "UPDATE operations SET status='failed',error_code='operation_timeout',completed_at=? WHERE id=?",
  )
    .bind(new Date().toISOString(), resumed.operation.id)
    .run();
  expect(
    (await placementNodes(env.DB, f.region))[0]?.reserved_cpu_millicores,
  ).toBe(600);
  expect((await resume(f, f.second)).status).toBe(409);
  expect(
    await env.DB.prepare(
      "SELECT generation,desired_state FROM databases WHERE id=?",
    )
      .bind(f.second)
      .first(),
  ).toEqual({ generation: 2, desired_state: "suspended" });
});

it("cannot refresh an identity-bound CPU admission with a UID-less node report", async () => {
  const f = await coldCohort();
  const stale = new Date(Date.now() - 181_000).toISOString();
  await env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
    .bind(stale, f.node)
    .run();
  const before = await env.DB.prepare(
    "SELECT node_uid,last_observed_at,allocatable_cpu_millicores,platform_reserved_cpu_millicores FROM nodes WHERE id=?",
  )
    .bind(f.node)
    .first();
  expect(
    (
      await request(
        "/agent/v1/observations",
        f.agent,
        "POST",
        observedBody(
          [],
          [
            {
              name: f.nodeName,
              ready: true,
              allocatable_memory_mib: 8192,
              allocatable_cpu_millicores: 12000,
              storage_gib_total: 60,
              platform_reserved_memory_mib: 128,
              platform_reserved_cpu_millicores: 0,
            },
          ],
        ),
      )
    ).status,
  ).toBe(200);
  expect(
    await env.DB.prepare(
      "SELECT node_uid,last_observed_at,allocatable_cpu_millicores,platform_reserved_cpu_millicores FROM nodes WHERE id=?",
    )
      .bind(f.node)
      .first(),
  ).toEqual(before);
  expect((await resume(f, f.first)).status).toBe(409);
});

it("records scheduling CPU requests consistently across create, sleep and wake lifecycle facts", async () => {
  const f = await fixture(8192, 60);
  await env.DB.prepare(
    "UPDATE size_classes SET cpu_millicores=250,cpu_request_millicores=25 WHERE id=?",
  )
    .bind(f.size)
    .run();
  const id = await readyDatabase(f, "metered-share");
  const suspended = await stop(f, id);
  const resumed = DatabaseWithOperation.parse(
    await (await resume(f, id)).json(),
  );
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(id, resumed.database.generation),
        power: {
          operation: resumed.operation.id,
          revision: resumed.database.generation,
          state: "awake",
        },
      },
    ]),
  );
  const events = await env.DB.prepare(
    "SELECT kind,resource_snapshot FROM lifecycle_events WHERE database_id=? ORDER BY id",
  )
    .bind(id)
    .all<{ kind: string; resource_snapshot: string }>();
  expect(suspended.operation.status).toBe("pending");
  for (const row of events.results) {
    expect(JSON.parse(row.resource_snapshot)).toMatchObject({
      cpu_millicores: 250,
      reserved_cpu_millicores: row.kind === "suspended" ? 0 : 125,
    });
  }
});

it("requires a current stop acknowledgement after a suspended database's role revision changes", async () => {
  const f = await fixture(8192, 60);
  const id = await readyDatabase(f, "revised-stop"),
    suspended = await stop(f, id);
  expect(
    (await placementNodes(env.DB, f.region))[0]?.reserved_cpu_millicores,
  ).toBe(0);
  expect(
    (
      await request(`/v1/databases/${id}/roles`, f.integrator, "POST", {
        name: "reader",
      })
    ).status,
  ).toBe(201);
  expect(
    (await placementNodes(env.DB, f.region))[0]?.reserved_cpu_millicores,
  ).toBe(600);
  const generation = await env.DB.prepare(
    "SELECT generation FROM databases WHERE id=?",
  )
    .bind(id)
    .first<number>("generation");
  expect(generation).toBe(3);
  expect(
    await (
      await request(
        "/agent/v1/observations",
        f.agent,
        "POST",
        observedBody([
          {
            ...observation(id, generation!, "hibernated"),
            power: {
              operation: suspended.operation.id,
              revision: generation,
              state: "hibernated",
            },
          },
        ]),
      )
    ).json(),
  ).toEqual({ accepted: 1 });
  expect(
    (await placementNodes(env.DB, f.region))[0]?.reserved_cpu_millicores,
  ).toBe(0);
});

it("completes the owned stop after an intervening role revision and keeps CPU facts independent of archive backlog", async () => {
  const f = await fixture(8192, 60);
  const id = await readyDatabase(f, "pending-stop-revision");
  const suspended = DatabaseWithOperation.parse(
    await (
      await request(`/v1/databases/${id}/suspend`, f.integrator, "POST")
    ).json(),
  );
  expect(
    (
      await request(`/v1/databases/${id}/roles`, f.integrator, "POST", {
        name: "reader",
      })
    ).status,
  ).toBe(201);
  const response = await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(id, 3, "hibernated"),
        archive: { continuous: true, ready_wal_files: 1 },
        power: {
          operation: suspended.operation.id,
          revision: 3,
          state: "hibernated",
        },
      },
    ]),
  );
  expect(await response.json()).toEqual({ accepted: 1 });
  expect(
    await env.DB.prepare("SELECT status FROM operations WHERE id=?")
      .bind(suspended.operation.id)
      .first("status"),
  ).toBe("succeeded");
  expect(
    (await placementNodes(env.DB, f.region))[0]?.reserved_cpu_millicores,
  ).toBe(0);
  const event = await env.DB.prepare(
    "SELECT resource_snapshot FROM lifecycle_events WHERE database_id=? AND kind='suspended' AND generation=3",
  )
    .bind(id)
    .first<string>("resource_snapshot");
  expect(JSON.parse(event!).reserved_cpu_millicores).toBe(0);
});
