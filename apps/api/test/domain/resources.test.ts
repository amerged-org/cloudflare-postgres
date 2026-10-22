// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  Database,
  DatabaseWithOperation,
  newOperationId,
  type DatabaseResources,
} from "@pgcf/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  addNode,
  cleanupFixtures,
  desiredPage,
  fixture,
  refusal,
  report,
  request,
} from "./fixtures.ts";
import { GIB, OPEN_POOL, seedSamples, steady } from "./node-samples.ts";

afterEach(cleanupFixtures);

type Fixture = Awaited<ReturnType<typeof fixture>>;
const own = (values: Partial<DatabaseResources>): DatabaseResources => ({
  memory_mib: null,
  cpu_millicores: null,
  storage_gib: null,
  ...values,
});
/** A database of the fixture's class (512 MiB, 500 millicores, 5 GiB) that the region reported ready. */
async function ready(f: Fixture) {
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  expect((await report(f, created.database.id, 1)).status).toBe(200);
  return created.database.id;
}
const put = (f: Fixture, id: string, body: unknown, key = f.admin) =>
  request(`/v1/databases/${id}/resources`, key, "PUT", body);
/** The region reports a generation, as it does when it has applied it. */
async function applied(f: Fixture, id: string, generation: number) {
  expect((await report(f, id, generation)).status).toBe(200);
}
const read = async (f: Fixture, id: string) =>
  Database.parse(await (await request(`/v1/databases/${id}`, f.admin)).json());
const stored = (id: string) =>
  env.DB.prepare(
    "SELECT own_memory_mib,own_cpu_millicores,own_storage_gib,generation FROM databases WHERE id=?",
  )
    .bind(id)
    .first();

describe("resources of a database", () => {
  it("shows the size class's values until the database has its own", async () => {
    const f = await fixture();
    const id = await ready(f);
    expect((await read(f, id)).resources).toEqual({
      memory_mib: 512,
      cpu_millicores: 500,
      storage_gib: 5,
    });
  });

  it("is set by an admin key and takes the next generation as a resize", async () => {
    const f = await fixture(16384);
    const id = await ready(f);
    const response = await put(
      f,
      id,
      own({ memory_mib: 1024, cpu_millicores: 750, storage_gib: 8 }),
    );
    expect(response.status).toBe(202);
    const result = DatabaseWithOperation.parse(await response.json());
    expect(result.database.resources).toEqual({
      memory_mib: 1024,
      cpu_millicores: 750,
      storage_gib: 8,
    });
    expect(result.database.generation).toBe(2);
    expect(result.database.size_class_id).toBe(f.size);
    expect(result.operation).toMatchObject({
      kind: "database.resize",
      status: "pending",
    });
    expect(await stored(id)).toEqual({
      own_memory_mib: 1024,
      own_cpu_millicores: 750,
      own_storage_gib: 8,
      generation: 2,
    });
    expect((await read(f, id)).resources.memory_mib).toBe(1024);
  });

  it("is what the node's desired page carries", async () => {
    const f = await fixture(16384);
    const id = await ready(f);
    const resources = async () =>
      (await desiredPage(f)).databases.find((database) => database.id === id)
        ?.resources;
    expect(await resources()).toEqual({
      memory_mib: 512,
      cpu_millicores: 500,
      storage_gib: 5,
    });
    await put(
      f,
      id,
      own({ memory_mib: 2048, cpu_millicores: 200, storage_gib: 8 }),
    );
    expect(await resources()).toEqual({
      memory_mib: 2048,
      cpu_millicores: 200,
      storage_gib: 8,
    });
  });

  it("meters the effective values: the created and the resized events carry them", async () => {
    const f = await fixture(16384);
    const created = DatabaseWithOperation.parse(
      await (
        await request("/v1/databases", f.admin, "POST", {
          project_id: f.project,
          region_id: f.region,
          name: "metered",
          size_class_id: f.size,
          resources: { memory_mib: 768 * 2, storage_gib: 20 },
        })
      ).json(),
    );
    const id = created.database.id;
    await applied(f, id, 1);
    const snapshots = async (kind: string) =>
      (
        await env.DB.prepare(
          "SELECT resource_snapshot FROM lifecycle_events WHERE database_id=? AND kind=?",
        )
          .bind(id, kind)
          .all<{ resource_snapshot: string }>()
      ).results.map((row) => JSON.parse(row.resource_snapshot));
    // Every event keeps exactly the limits, whichever event it is, and nothing else.
    expect(await snapshots("created")).toEqual([
      { memory_mib: 1536, cpu_millicores: 500 },
    ]);
    expect(await snapshots("ready")).toEqual(await snapshots("created"));
    await put(
      f,
      id,
      own({ memory_mib: 1024, cpu_millicores: 750, storage_gib: 24 }),
    );
    await applied(f, id, 2);
    expect(await snapshots("resized")).toEqual([
      { memory_mib: 1024, cpu_millicores: 750 },
    ]);
  });

  it("hands a field back to the size class with null", async () => {
    const f = await fixture(16384);
    const id = await ready(f);
    await put(f, id, own({ memory_mib: 1024, storage_gib: 8 }));
    await applied(f, id, 2);
    // Storage keeps its 8 GiB: the class's 5 would be a shrink.
    const back = DatabaseWithOperation.parse(
      await (await put(f, id, own({ storage_gib: 8 }))).json(),
    );
    expect(back.database.resources).toEqual({
      memory_mib: 512,
      cpu_millicores: 500,
      storage_gib: 8,
    });
    expect(back.database.generation).toBe(3);
    expect(await stored(id)).toMatchObject({
      own_memory_mib: null,
      own_storage_gib: 8,
    });
  });

  it("is refused for a key that is not an admin's", async () => {
    const f = await fixture(16384);
    const id = await ready(f);
    const response = await put(f, id, own({ memory_mib: 1024 }), f.integrator);
    expect(await refusal(response)).toMatchObject({
      status: 403,
      code: "forbidden",
    });
    expect((await stored(id))?.own_memory_mib).toBeNull();
  });

  it("is refused for a body that is not a whole PUT, and for values off the grid", async () => {
    const f = await fixture(16384);
    const id = await ready(f);
    for (const body of [
      { memory_mib: 1024 },
      own({ memory_mib: 1000 }),
      own({ cpu_millicores: 50 }),
      own({ storage_gib: 0 }),
      { ...own({}), swap_mib: 1 },
    ])
      expect((await put(f, id, body)).status, JSON.stringify(body)).toBe(400);
  });

  it("is held to the region's memory maximum", async () => {
    const f = await fixture(16384);
    const id = await ready(f);
    // The default maximum is 4,096 MiB.
    expect((await put(f, id, own({ memory_mib: 4352 }))).status).toBe(400);
    expect((await put(f, id, own({ memory_mib: 4096 }))).status).toBe(202);
    await env.DB.prepare(
      "INSERT INTO node_region_policies(region_id,max_nodes,maximum_database_memory_mib) VALUES(?,4,1024)",
    )
      .bind(f.region)
      .run();
    expect(
      await refusal(await put(f, id, own({ memory_mib: 2048 }))),
    ).toMatchObject({ status: 400, code: "invalid_request" });
  });

  it("is held to the cores of the region's largest node", async () => {
    const f = await fixture(16384);
    const id = await ready(f);
    // The fixture's node has 8 cores.
    expect((await put(f, id, own({ cpu_millicores: 8001 }))).status).toBe(400);
    expect((await put(f, id, own({ cpu_millicores: 8000 }))).status).toBe(202);
  });

  it("never shrinks the storage", async () => {
    const f = await fixture(16384);
    const id = await ready(f);
    expect((await put(f, id, own({ storage_gib: 8 }))).status).toBe(202);
    expect(
      await refusal(await put(f, id, own({ storage_gib: 6 }))),
    ).toMatchObject({ status: 400, code: "invalid_request" });
    // null would hand back the class's 5 GiB, which is a shrink as well.
    expect((await put(f, id, own({}))).status).toBe(400);
    expect((await stored(id))?.own_storage_gib).toBe(8);
  });

  it("changes nothing when the effective values stay and records an own value that equals the class's", async () => {
    const f = await fixture(16384);
    const id = await ready(f);
    const same = await put(f, id, own({ memory_mib: 512 }));
    expect(same.status).toBe(202);
    const result = DatabaseWithOperation.parse(await same.json());
    expect(result.database.generation).toBe(1);
    expect(result.operation.status).toBe("succeeded");
    expect(await stored(id)).toMatchObject({
      own_memory_mib: 512,
      generation: 1,
    });
    // The same again is the same operation's no-op.
    const again = await put(f, id, own({ memory_mib: 512 }));
    expect(again.status).toBe(202);
    expect((await stored(id))?.generation).toBe(1);
  });

  it("replays an Idempotency-Key and refuses a deleted database", async () => {
    const f = await fixture(16384);
    const id = await ready(f);
    const key = crypto.randomUUID();
    const first = await request(
      `/v1/databases/${id}/resources`,
      f.admin,
      "PUT",
      own({ memory_mib: 1024 }),
      key,
    );
    const second = await request(
      `/v1/databases/${id}/resources`,
      f.admin,
      "PUT",
      own({ memory_mib: 1024 }),
      key,
    );
    expect(second.status).toBe(first.status);
    expect(DatabaseWithOperation.parse(await second.json()).operation.id).toBe(
      DatabaseWithOperation.parse(await first.json()).operation.id,
    );
    expect((await stored(id))?.generation).toBe(2);
    await request(`/v1/databases/${id}`, f.admin, "DELETE");
    expect(
      await refusal(await put(f, id, own({ memory_mib: 2048 }))),
    ).toMatchObject({ status: 409, reason: "database_deleted" });
  });

  it("is refused with 503 when the database's node cannot take the memory", async () => {
    const f = await fixture(16384);
    const id = await ready(f);
    // A 10 GiB node at 70 % active RAM: 1,536 MiB more are 15 %.
    const busy = await addNode(f.region, 0);
    await seedSamples(busy, steady(Date.now(), 40, { ramPpm: 700_000 }));
    await env.DB.prepare("UPDATE databases SET node_id=? WHERE id=?")
      .bind(busy, id)
      .run();
    const refused = await put(f, id, own({ memory_mib: 2048 }));
    expect(await refusal(refused)).toMatchObject({
      status: 503,
      code: "capacity_exhausted",
      reason: "node_capacity",
    });
    expect((await stored(id))?.generation).toBe(1);
    // CPU and a smaller memory need no room.
    expect((await put(f, id, own({ cpu_millicores: 750 }))).status).toBe(202);
    expect((await put(f, id, own({ cpu_millicores: 750 }))).status).toBe(202);
  });

  /** The fixture's node reports a 30 GiB pool (cap 120 GiB) with `soldGib` GiB sold. */
  const sold = (f: Fixture, soldGib: number) =>
    seedSamples(
      f.node,
      steady(Date.now(), 40, {
        pool: {
          ...OPEN_POOL,
          dataTotal: 30 * GIB,
          dataUsed: 0,
          nominal: soldGib * GIB,
        },
      }),
    );

  it("holds the storage growth of an awake database to the node's logical cap, counting the growth still open", async () => {
    const f = await fixture(16384);
    const id = await ready(f);
    await sold(f, 112);
    // 112 GiB and 5 GiB more are under the cap of 120 GiB.
    expect((await put(f, id, own({ storage_gib: 10 }))).status).toBe(202);
    await applied(f, id, 2);
    // The node has not reported the volume yet: 112 GiB, the 10 GiB in flight and 5 GiB more pass it.
    expect(
      await refusal(await put(f, id, own({ storage_gib: 15 }))),
    ).toMatchObject({
      status: 503,
      code: "capacity_exhausted",
      reason: "node_capacity",
    });
    expect((await stored(id))?.own_storage_gib).toBe(10);
  });

  it("applies at the next wake for a database that sleeps, whatever its node reports", async () => {
    const f = await fixture(16384);
    const id = await ready(f);
    const busy = await addNode(f.region, 0);
    await seedSamples(busy, steady(Date.now(), 40, { ramPpm: 900_000 }));
    const at = new Date().toISOString(),
      stop = newOperationId();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at,completed_at) VALUES(?,'database.hibernate','succeeded',?,?,1,?,?,?)",
      ).bind(stop, f.project, id, at, at, at),
      env.DB.prepare(
        "UPDATE databases SET node_id=?,desired_state='suspended',suspension_reason='idle',power_operation=?,observed_state='provisioning',observed_power='hibernated',observed_generation=generation WHERE id=?",
      ).bind(busy, stop, id),
    ]);
    const response = await put(f, id, own({ memory_mib: 2048 }));
    expect(response.status).toBe(202);
    expect((await stored(id))?.own_memory_mib).toBe(2048);
  });
});

describe("storage growth of a database that sleeps", () => {
  it("is held to the node's logical cap like the growth of an awake one, while memory waits for the wake", async () => {
    const f = await fixture(16384);
    const id = await ready(f);
    const at = new Date().toISOString(),
      stop = newOperationId();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at,completed_at) VALUES(?,'database.hibernate','succeeded',?,?,1,?,?,?)",
      ).bind(stop, f.project, id, at, at, at),
      env.DB.prepare(
        "UPDATE databases SET desired_state='suspended',suspension_reason='idle',power_operation=?,observed_state='provisioning',observed_power='hibernated',observed_generation=generation WHERE id=?",
      ).bind(stop, id),
    ]);
    await seedSamples(
      f.node,
      steady(Date.now(), 40, {
        pool: {
          ...OPEN_POOL,
          dataTotal: 30 * GIB,
          dataUsed: 0,
          nominal: 100 * GIB,
        },
      }),
    );
    // The cap is 120 GiB: 100 GiB sold, so 60,000 GiB are refused and 8 GiB are not.
    expect(
      await refusal(await put(f, id, own({ storage_gib: 60000 }))),
    ).toMatchObject({
      status: 503,
      code: "capacity_exhausted",
      reason: "node_capacity",
    });
    expect((await stored(id))?.own_storage_gib).toBeNull();
    expect(
      (await put(f, id, own({ memory_mib: 2048, storage_gib: 8 }))).status,
    ).toBe(202);
    expect(await stored(id)).toMatchObject({
      own_memory_mib: 2048,
      own_storage_gib: 8,
    });
  });
});

describe("resources on create", () => {
  const create = (f: Fixture, resources: unknown, key = f.admin) =>
    request("/v1/databases", key, "POST", {
      project_id: f.project,
      region_id: f.region,
      name: "own",
      size_class_id: f.size,
      resources,
    });

  it("lets an admin key give the database its own values next to its size class", async () => {
    const f = await fixture(16384);
    const response = await create(f, { memory_mib: 1024, storage_gib: 20 });
    expect(response.status).toBe(202);
    const result = DatabaseWithOperation.parse(await response.json());
    expect(result.database.resources).toEqual({
      memory_mib: 1024,
      cpu_millicores: 500,
      storage_gib: 20,
    });
    expect(result.database.node_id).toBe(f.node);
    expect(await stored(result.database.id)).toMatchObject({
      own_memory_mib: 1024,
      own_cpu_millicores: null,
      own_storage_gib: 20,
    });
  });

  it("refuses an integrator key and values outside the region's bounds", async () => {
    const f = await fixture(16384);
    expect(
      await refusal(await create(f, { memory_mib: 1024 }, f.integrator)),
    ).toMatchObject({ status: 403, code: "forbidden" });
    expect((await create(f, { memory_mib: 4352 })).status).toBe(400);
    expect((await create(f, { cpu_millicores: 9000 })).status).toBe(400);
  });

  it("places the database by its own memory", async () => {
    const f = await fixture(4096);
    // 3,072 MiB are 75 % of the 4 GiB node; the class's 512 MiB would have fitted twice.
    const first = DatabaseWithOperation.parse(
      await (await create(f, { memory_mib: 3072 })).json(),
    );
    expect(first.database.node_id).toBe(f.node);
    const second = DatabaseWithOperation.parse(
      await (
        await request("/v1/databases", f.admin, "POST", {
          project_id: f.project,
          region_id: f.region,
          name: "second",
          size_class_id: f.size,
        })
      ).json(),
    );
    expect(second.database.node_id).toBeNull();
  });
});
