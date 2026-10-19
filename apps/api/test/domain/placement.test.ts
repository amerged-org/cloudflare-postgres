// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  DatabaseWithOperation,
  NODE_SAMPLE_INTERVAL_MS,
  newOperationId,
} from "@pgcf/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLOCK_SKEW_MS,
  PLACEMENT_LIMIT_PPM,
  choosePlacement,
  placementNodes,
  type PlacementNeed,
  type PlacementNode,
} from "../../src/domain/placement.ts";
import { addNode, cleanupFixtures, fixture } from "./fixtures.ts";
import {
  GIB,
  NODE_BYTES,
  OPEN_POOL,
  seedSamples,
  steady,
  type SampleSeed,
} from "./node-samples.ts";

afterEach(cleanupFixtures);

const NOW = Date.parse("2030-06-15T12:00:00.000Z");
const DAY = 86_400_000;
/** 256 MiB are 25,000 ppm of the 10 GiB test node. */
const SMALL: PlacementNeed = {
  memory_mib: 256,
  cpu_millicores: 500,
  storage_gib: 5,
};

/** A node that reported a minute ago and has no pending placements; override what a case needs. */
function node(overrides: Partial<PlacementNode> = {}): PlacementNode {
  return {
    id: "nod_aaaaaaaaaaaaaaaaaaaa",
    region_id: "eu-1",
    ready: 1,
    schedulable: 1,
    lost_at: null,
    database_placement_enabled: 1,
    database_placement_closed_at: null,
    sampled_at: new Date(NOW - 60_000).toISOString(),
    memory_total_bytes: NODE_BYTES,
    cpu_cores: 8,
    room: 1,
    pool_data_total_bytes: OPEN_POOL.dataTotal,
    pool_data_used_bytes: OPEN_POOL.dataUsed,
    pool_metadata_total_bytes: OPEN_POOL.metadataTotal,
    pool_metadata_used_bytes: OPEN_POOL.metadataUsed,
    pool_nominal_bytes: OPEN_POOL.nominal,
    ram_peak_ppm: 0,
    cpu_peak_ppm: 0,
    ram_now_ppm: 0,
    pending_memory_mib: 0,
    pending_storage_gib: 0,
    ...overrides,
  };
}
const pick = (nodes: PlacementNode[], need = SMALL, now = NOW) =>
  choosePlacement(nodes, need, now)?.id ?? null;
const id = (letter: string) => `nod_${letter.repeat(20)}`;

describe("which node takes a new database", () => {
  it("is the fullest node that stays under 80 % active RAM after the database", () => {
    const nodes = [
      node({ id: id("a"), ram_peak_ppm: 500_000 }),
      node({ id: id("b"), ram_peak_ppm: 300_000 }),
      node({ id: id("c"), ram_peak_ppm: 700_000 }),
    ];
    expect(pick(nodes)).toBe(id("c"));
    // Order of the list does not matter.
    expect(pick([...nodes].reverse())).toBe(id("c"));
  });

  it("skips the fullest node when the database would take it to 80 % and goes on to the next", () => {
    const nodes = [
      node({ id: id("a"), ram_peak_ppm: 500_000 }),
      node({ id: id("c"), ram_peak_ppm: 780_000 }),
    ];
    expect(pick(nodes)).toBe(id("a"));
  });

  it("refuses a node whose RAM peak plus the database is exactly 80 %, and takes one that is a part per million below", () => {
    expect(PLACEMENT_LIMIT_PPM).toBe(800_000);
    expect(pick([node({ ram_peak_ppm: 775_000 })])).toBeNull();
    expect(pick([node({ ram_peak_ppm: 774_999 })])).not.toBeNull();
  });

  it("refuses a node whose RAM peak is already 80 %", () => {
    expect(pick([node({ ram_peak_ppm: 800_000 })])).toBeNull();
    expect(pick([node({ ram_peak_ppm: 900_000 })])).toBeNull();
  });

  it("refuses a node whose CPU peak is 80 % and takes one a part per million below", () => {
    expect(pick([node({ cpu_peak_ppm: 800_000 })])).toBeNull();
    expect(pick([node({ cpu_peak_ppm: 799_999 })])).not.toBeNull();
  });

  it("does not let a low CPU peak make up for a full RAM, nor the other way round", () => {
    const nodes = [
      node({ id: id("a"), ram_peak_ppm: 100_000, cpu_peak_ppm: 850_000 }),
      node({ id: id("b"), ram_peak_ppm: 850_000, cpu_peak_ppm: 100_000 }),
    ];
    expect(pick(nodes)).toBeNull();
  });

  it("counts a database no sample includes yet at its full memory", () => {
    // 2,048 MiB pending are 20 % of the node: 55 % + 20 % + 2.5 % stays under 80 %, 57.5 % + 20 % + 2.5 % is 80 %.
    expect(
      pick([node({ ram_peak_ppm: 550_000, pending_memory_mib: 2048 })]),
    ).not.toBeNull();
    expect(
      pick([node({ ram_peak_ppm: 575_000, pending_memory_mib: 2048 })]),
    ).toBeNull();
    // A burst of creates fills the quiet node in the sight of the next one.
    expect(
      pick([
        node({ id: id("a"), ram_peak_ppm: 600_000 }),
        // 8,000 MiB pending are 78 % of the node.
        node({ id: id("b"), ram_peak_ppm: 0, pending_memory_mib: 8000 }),
      ]),
    ).toBe(id("a"));
  });

  it("lets the newest sample stand in for an average that has not caught up with a burst of starts", () => {
    // The average is 10 %, the newest sample shows 75 % of the node in use: a 256 MiB database (2.5 %) reaches 77.5 %, 1,024 MiB (10 %) would not fit.
    expect(
      pick([node({ ram_peak_ppm: 100_000, ram_now_ppm: 750_000 })]),
    ).not.toBeNull();
    expect(
      pick([node({ ram_peak_ppm: 100_000, ram_now_ppm: 750_000 })], {
        ...SMALL,
        memory_mib: 1024,
      }),
    ).toBeNull();
    // A sample below the average changes nothing.
    expect(
      pick([node({ ram_peak_ppm: 790_000, ram_now_ppm: 100_000 })]),
    ).toBeNull();
  });

  it("ranks by peak plus pending, so a node that just took several databases counts as fuller", () => {
    expect(
      pick([
        node({ id: id("a"), ram_peak_ppm: 300_000 }),
        node({ id: id("b"), ram_peak_ppm: 100_000, pending_memory_mib: 4096 }),
      ]),
    ).toBe(id("b"));
  });

  it("breaks a tie by node ID", () => {
    expect(
      pick([
        node({ id: id("b"), ram_peak_ppm: 400_000 }),
        node({ id: id("a"), ram_peak_ppm: 400_000 }),
      ]),
    ).toBe(id("a"));
  });

  it("measures the database against the node's own memory", () => {
    const small = node({ memory_total_bytes: 2 * GIB, ram_peak_ppm: 500_000 });
    // 1,024 MiB are 50 % of 2 GiB.
    expect(pick([small], { ...SMALL, memory_mib: 1024 })).toBeNull();
    expect(pick([small], { ...SMALL, memory_mib: 256 })).not.toBeNull();
  });

  it("needs a node that is online: a fresh sample, not lost, ready, schedulable and open", () => {
    expect(pick([node({ sampled_at: null })])).toBeNull();
    // 180 s old is still online, one millisecond more is not.
    expect(
      pick([node({ sampled_at: new Date(NOW - 180_000).toISOString() })]),
    ).not.toBeNull();
    expect(
      pick([node({ sampled_at: new Date(NOW - 180_001).toISOString() })]),
    ).toBeNull();
    // A clock that runs ahead by more than the link takes (one sample interval) is not a fresh sample either.
    expect(CLOCK_SKEW_MS).toBe(NODE_SAMPLE_INTERVAL_MS);
    expect(
      pick([node({ sampled_at: new Date(NOW + CLOCK_SKEW_MS).toISOString() })]),
    ).not.toBeNull();
    expect(
      pick([
        node({ sampled_at: new Date(NOW + CLOCK_SKEW_MS + 1).toISOString() }),
      ]),
    ).toBeNull();
    expect(pick([node({ lost_at: "2030-06-15T11:00:00.000Z" })])).toBeNull();
    expect(pick([node({ ready: 0 })])).toBeNull();
    expect(pick([node({ schedulable: 0 })])).toBeNull();
    expect(pick([node({ database_placement_enabled: 0 })])).toBeNull();
    expect(
      pick([
        node({ database_placement_closed_at: "2030-06-15T11:00:00.000Z" }),
      ]),
    ).toBeNull();
  });

  it("closes the pool at 80 % of its data and at 50 % of its metadata, and when the node has no room", () => {
    const data = (used: number) =>
      node({ pool_data_used_bytes: used, pool_data_total_bytes: 100 * GIB });
    expect(pick([data(80 * GIB)])).toBeNull();
    expect(pick([data(80 * GIB - 1)])).not.toBeNull();
    const metadata = (used: number) =>
      node({ pool_metadata_used_bytes: used, pool_metadata_total_bytes: GIB });
    expect(pick([metadata(GIB / 2)])).toBeNull();
    expect(pick([metadata(GIB / 2 - 1)])).not.toBeNull();
    expect(pick([node({ room: 0 })])).toBeNull();
    expect(
      pick([
        node({
          pool_data_total_bytes: null,
          pool_data_used_bytes: null,
          pool_metadata_total_bytes: null,
          pool_metadata_used_bytes: null,
          pool_nominal_bytes: null,
        }),
      ]),
    ).toBeNull();
  });

  it("keeps the sold storage within four times the pool's data", () => {
    const pool = (nominal: number) =>
      node({ pool_data_total_bytes: 100 * GIB, pool_nominal_bytes: nominal });
    // 400 GiB is the logical cap; the database brings 5 GiB.
    expect(pick([pool(395 * GIB)])).not.toBeNull();
    expect(pick([pool(395 * GIB + 1)])).toBeNull();
    expect(pick([pool(400 * GIB)])).toBeNull();
  });

  it("counts the storage of databases the node has not finished against the same cap", () => {
    const pool = (pending: number) =>
      node({
        pool_data_total_bytes: 100 * GIB,
        pool_nominal_bytes: 390 * GIB,
        pending_storage_gib: pending,
      });
    // The cap is 400 GiB; 390 GiB are reported, the database brings 5 GiB.
    expect(pick([pool(5)])).not.toBeNull();
    expect(pick([pool(6)])).toBeNull();
    expect(pick([pool(10)])).toBeNull();
  });

  it("needs a node with the cores the database is allowed to use", () => {
    const eight = node({ cpu_cores: 8 });
    expect(pick([eight], { ...SMALL, cpu_millicores: 8000 })).not.toBeNull();
    expect(pick([eight], { ...SMALL, cpu_millicores: 8001 })).toBeNull();
  });

  it("answers nothing when no node qualifies", () => {
    expect(pick([])).toBeNull();
  });
});

describe("the load of a node, read from its samples", () => {
  const regionWith = async () => {
    const f = await fixture(0);
    return { f, a: await addNode(f.region, 0), b: await addNode(f.region, 0) };
  };
  const load = async (region: string, nodeId: string, now = NOW) =>
    (await placementNodes(env.DB, region, now)).find((n) => n.id === nodeId)!;

  it("is the highest 30-minute average, not the highest sample", async () => {
    const { f, a } = await regionWith();
    // 91 minutes at 10 % with one sample at 95 %.
    const samples = steady(NOW, 90, { ramPpm: 100_000, cpuPpm: 100_000 });
    samples[45] = { ...samples[45]!, ramPpm: 950_000, cpuPpm: 950_000 };
    await seedSamples(a, samples);
    const n = await load(f.region, a);
    // The window of the 95 % sample holds 31 samples: the spike and 30 at 10 %.
    expect(n.ram_peak_ppm).toBe(Math.floor((950_000 + 30 * 100_000) / 31));
    expect(n.cpu_peak_ppm).toBe(Math.floor((950_000 + 30 * 100_000) / 31));
  });

  it("keeps a 30-minute stretch of high load for seven days", async () => {
    const { f, a } = await regionWith();
    // Nearly seven days old, so only a window of seven days still sees it.
    const high = steady(NOW - 6.9 * DAY, 31, { ramPpm: 850_000 });
    const quiet = steady(NOW, 120, { ramPpm: 50_000 });
    await seedSamples(a, [...high, ...quiet]);
    expect((await load(f.region, a)).ram_peak_ppm).toBe(850_000);
  });

  it("forgets what is older than seven days", async () => {
    const { f, a } = await regionWith();
    const old = steady(NOW - 8 * DAY, 60, { ramPpm: 900_000, cpuPpm: 900_000 });
    const quiet = steady(NOW, 60, { ramPpm: 50_000, cpuPpm: 70_000 });
    await seedSamples(a, [...old, ...quiet]);
    const n = await load(f.region, a);
    expect(n.ram_peak_ppm).toBe(50_000);
    expect(n.cpu_peak_ppm).toBe(70_000);
  });

  it("uses the available history of a node that is new", async () => {
    const { f, a } = await regionWith();
    await seedSamples(a, [
      { at: NOW - 30_000, ramPpm: 200_000, cpuPpm: 300_000 },
    ]);
    const n = await load(f.region, a);
    expect(n.ram_peak_ppm).toBe(200_000);
    expect(n.cpu_peak_ppm).toBe(300_000);
    expect(n.sampled_at).toBe(new Date(NOW - 30_000).toISOString());
  });

  it("does not let one sample at the start of the history stand for a 30-minute average", async () => {
    const { f, a } = await regionWith();
    // A boot spike at 95 %, then three hours at 10 %.
    const samples = steady(NOW, 180, { ramPpm: 100_000, cpuPpm: 100_000 });
    samples[0] = { ...samples[0]!, ramPpm: 950_000, cpuPpm: 950_000 };
    await seedSamples(a, samples);
    const n = await load(f.region, a);
    // The first window with ten minutes of history holds the spike and ten samples at 10 %.
    const first = Math.floor((950_000 + 10 * 100_000) / 11);
    expect(n.ram_peak_ppm).toBe(first);
    expect(n.cpu_peak_ppm).toBe(first);
  });

  it("does not let one sample after a gap of 30 minutes or more stand for a 30-minute average", async () => {
    const { f, a } = await regionWith();
    // Two hours at 10 %, 40 minutes of silence, and 85 % when the link returns.
    const before = steady(NOW - 40 * 60_000, 120, {
      ramPpm: 100_000,
      cpuPpm: 100_000,
    });
    await seedSamples(a, [
      ...before,
      { at: NOW, ramPpm: 850_000, cpuPpm: 850_000 },
    ]);
    const n = await load(f.region, a);
    expect(n.ram_peak_ppm).toBe(100_000);
    expect(n.cpu_peak_ppm).toBe(100_000);
  });

  it("averages all of the history of a node that has less than 30 minutes of it", async () => {
    const { f, a } = await regionWith();
    const samples = steady(NOW, 20, { ramPpm: 100_000 });
    samples[0] = { ...samples[0]!, ramPpm: 900_000 };
    await seedSamples(a, samples);
    // 21 samples, one at 90 % and 20 at 10 %, not the 90 % of the first sample alone.
    expect((await load(f.region, a)).ram_peak_ppm).toBe(
      Math.floor((900_000 + 20 * 100_000) / 21),
    );
  });

  it("averages the ratio of each sample, so a node whose memory changed stays right", async () => {
    const { f, a } = await regionWith();
    await seedSamples(a, [
      { at: NOW - 60_000, totalBytes: 1_000_000_000, usedBytes: 100_000_000 },
      { at: NOW, totalBytes: 4_000_000_000, usedBytes: 3_200_000_000 },
    ]);
    // 10 % and 80 % average to 45 %; the bytes added up would say 66 %.
    expect((await load(f.region, a)).ram_peak_ppm).toBe(450_000);
  });

  it("reads the newest sample and its pool, and keeps the nodes apart", async () => {
    const { f, a, b } = await regionWith();
    await seedSamples(a, [
      { at: NOW - 120_000, ramPpm: 100_000, room: false },
      { at: NOW - 60_000, ramPpm: 100_000, pool: null },
      { at: NOW, ramPpm: 100_000, cores: 4 },
    ]);
    await seedSamples(b, [{ at: NOW - 5_000, ramPpm: 600_000, room: false }]);
    const first = await load(f.region, a),
      second = await load(f.region, b);
    expect(first).toMatchObject({
      sampled_at: new Date(NOW).toISOString(),
      cpu_cores: 4,
      room: 1,
      memory_total_bytes: NODE_BYTES,
      pool_data_total_bytes: OPEN_POOL.dataTotal,
      pool_nominal_bytes: OPEN_POOL.nominal,
      ram_peak_ppm: 100_000,
    });
    expect(second).toMatchObject({ room: 0, ram_peak_ppm: 600_000 });
  });

  it("has no peak, and no sample, for a node that never reported", async () => {
    const { f, a } = await regionWith();
    expect(await load(f.region, a)).toMatchObject({
      sampled_at: null,
      ram_peak_ppm: null,
      cpu_peak_ppm: null,
      pending_memory_mib: 0,
    });
  });

  it("lists only the nodes of the region", async () => {
    const { f, a } = await regionWith();
    const other = await fixture(0);
    const foreign = await addNode(other.region, 0);
    const ids = (await placementNodes(env.DB, f.region, NOW)).map((n) => n.id);
    expect(ids).toContain(a);
    expect(ids).not.toContain(foreign);
  });

  it("counts the databases placed after the node's newest sample at their full memory, the class's or their own", async () => {
    const { f, a } = await regionWith();
    await seedSamples(a, steady(NOW, 5, { ramPpm: 100_000 }));
    const sampleAt = (await load(f.region, a)).sampled_at;
    expect(sampleAt).not.toBeNull();
    const after = Date.parse(sampleAt!) + 1_000;
    const place = (
      name: string,
      placedAt: number | null,
      memory: number | null,
      state = "ready",
    ) =>
      env.DB.prepare(
        `INSERT INTO databases(id,project_id,region_id,node_id,name,size_class_id,desired_state,observed_state,generation,archive_path,created_at,updated_at,placed_at,own_memory_mib)
        VALUES(?,?,?,?,?,?,'running',?,1,'s3://b/x',?,?,?,?)`,
      ).bind(
        "d" + crypto.randomUUID().replaceAll("-", "").slice(0, 19),
        f.project,
        f.region,
        a,
        name,
        f.size,
        state,
        new Date(NOW).toISOString(),
        new Date(NOW).toISOString(),
        placedAt === null ? null : new Date(placedAt).toISOString(),
        memory,
      );
    await env.DB.batch([
      // The class of the fixture has 512 MiB.
      place("after-class", after, null),
      place("after-own", after + 5_000, 1024),
      // The newest sample has these: their memory is in it, and in the average from then on.
      place("before-sample", after - 600_000, 2048),
      place("never-placed-here", null, 4096),
    ]);
    expect((await load(f.region, a)).pending_memory_mib).toBe(512 + 1024);
  });

  it("reads the active RAM of the newest sample", async () => {
    const { f, a } = await regionWith();
    await seedSamples(a, steady(NOW, 5, { ramPpm: 250_000 }));
    const got = await load(f.region, a);
    expect(got.ram_now_ppm).toBeGreaterThan(240_000);
    expect(got.ram_now_ppm).toBeLessThan(260_000);
  });

  it("does not count a database that is deleted", async () => {
    const { f, a } = await regionWith();
    await seedSamples(a, steady(NOW, 1));
    await env.DB.prepare(
      `INSERT INTO databases(id,project_id,region_id,node_id,name,size_class_id,desired_state,observed_state,generation,archive_path,created_at,updated_at,deleted_at,placed_at)
      VALUES(?,?,?,?,'gone',?,'deleted','deleted',2,'s3://b/x',?,?,?,?)`,
    )
      .bind(
        "d" + crypto.randomUUID().replaceAll("-", "").slice(0, 19),
        f.project,
        f.region,
        a,
        f.size,
        new Date(NOW).toISOString(),
        new Date(NOW).toISOString(),
        new Date(NOW).toISOString(),
        new Date(NOW - 60_000).toISOString(),
      )
      .run();
    expect((await load(f.region, a)).pending_memory_mib).toBe(0);
  });
});

describe("the storage a node has not finished", () => {
  /** A database of the region's fixture on `nodeId` with `storage` GiB and one operation. */
  async function withOperation(
    f: Awaited<ReturnType<typeof fixture>>,
    nodeId: string,
    storage: number,
    operation: {
      kind: string;
      status: string;
      completedAt?: number;
      deleted?: boolean;
    },
  ) {
    const database = "d" + crypto.randomUUID().replaceAll("-", "").slice(0, 19),
      at = new Date(NOW).toISOString(),
      completed =
        operation.completedAt === undefined
          ? null
          : new Date(operation.completedAt).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO databases(id,project_id,region_id,node_id,name,size_class_id,desired_state,observed_state,generation,archive_path,created_at,updated_at,deleted_at,own_storage_gib)
        VALUES(?,?,?,?,?,?,?,'ready',1,'s3://b/x',?,?,?,?)`,
      ).bind(
        database,
        f.project,
        f.region,
        nodeId,
        database,
        f.size,
        operation.deleted ? "deleted" : "running",
        at,
        at,
        operation.deleted ? at : null,
        storage,
      ),
      env.DB.prepare(
        `INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at,completed_at)
        VALUES(?,?,?,?,?,1,?,?,?)`,
      ).bind(
        newOperationId(),
        operation.kind,
        operation.status,
        f.project,
        database,
        at,
        at,
        completed,
      ),
    ]);
  }
  const pending = async (region: string, nodeId: string) =>
    (await placementNodes(env.DB, region, NOW)).find((n) => n.id === nodeId)!
      .pending_storage_gib;

  it("is the storage of the databases whose create, restore or resize is still open, or finished after the node's newest sample", async () => {
    const f = await fixture(0),
      a = await addNode(f.region, 0),
      b = await addNode(f.region, 0);
    // The newest sample of both nodes is 30 s old.
    await seedSamples(a, [{ at: NOW - 30_000 }]);
    await seedSamples(b, [{ at: NOW - 30_000 }]);
    const open = (kind: string, status: string) => ({ kind, status });
    await withOperation(f, a, 7, open("database.create", "pending"));
    await withOperation(f, a, 11, open("database.resize", "running"));
    await withOperation(f, a, 13, open("database.restore", "pending"));
    // Finished 10 s ago: the sample of 30 s ago cannot hold its volume yet.
    await withOperation(f, a, 3, {
      kind: "database.create",
      status: "succeeded",
      completedAt: NOW - 10_000,
    });
    // Finished a minute before the sample: the node's pool figure holds it, or never will.
    await withOperation(f, a, 100, {
      kind: "database.create",
      status: "succeeded",
      completedAt: NOW - 90_000,
    });
    await withOperation(f, a, 100, {
      kind: "database.restore",
      status: "failed",
      completedAt: NOW - 90_000,
    });
    // Other operations and deleted databases change nothing, nor does another node.
    await withOperation(f, a, 100, {
      kind: "database.wake",
      status: "pending",
    });
    await withOperation(f, a, 100, {
      kind: "database.create",
      status: "pending",
      deleted: true,
    });
    await withOperation(f, b, 100, {
      kind: "database.create",
      status: "pending",
    });
    expect(await pending(f.region, a)).toBe(7 + 11 + 13 + 3);
    expect(await pending(f.region, b)).toBe(100);
  });

  it("is zero for a node with nothing in flight and for a node that never reported", async () => {
    const f = await fixture(0),
      quiet = await addNode(f.region, 0);
    expect(await pending(f.region, quiet)).toBe(0);
    expect(await pending(f.region, f.node)).toBe(0);
  });
});

describe("placement over real samples", () => {
  it("stops a burst of creates at the logical cap before the node has reported any of them", async () => {
    const f = await fixture(0);
    // 30 GiB of pool data give a cap of 120 GiB; 115 GiB are sold when the node last reported.
    await seedSamples(
      f.node,
      steady(Date.now(), 40, {
        pool: {
          ...OPEN_POOL,
          dataTotal: 30 * GIB,
          dataUsed: 0,
          nominal: 115 * GIB,
        },
      }),
    );
    const create = async (name: string) =>
      DatabaseWithOperation.parse(await (await f.create(name)).json());
    // The class has 5 GiB: the first create reaches the cap exactly, the second would pass it.
    expect((await create("one")).database.node_id).toBe(f.node);
    expect((await create("two")).database.node_id).toBeNull();
    expect((await create("three")).database.node_id).toBeNull();
  });

  it("puts a database on the fullest node that has room and on a quiet one when the fullest is full", async () => {
    const f = await fixture(0);
    const quiet = await addNode(f.region, 0),
      busy = await addNode(f.region, 0),
      full = await addNode(f.region, 0);
    const recent = (seed: Omit<SampleSeed, "at">) =>
      steady(Date.now(), 40, seed);
    await seedSamples(quiet, recent({ ramPpm: 100_000 }));
    await seedSamples(busy, recent({ ramPpm: 600_000 }));
    await seedSamples(full, recent({ ramPpm: 790_000 }));
    const nodes = await placementNodes(env.DB, f.region);
    // 512 MiB are 5 % of the node: 79 % + 5 % crosses 80 %, 60 % + 5 % does not.
    expect(
      choosePlacement(nodes, {
        memory_mib: 512,
        cpu_millicores: 500,
        storage_gib: 5,
      })?.id,
    ).toBe(busy);
    expect(
      choosePlacement(
        nodes.filter((n) => n.id !== busy),
        { memory_mib: 512, cpu_millicores: 500, storage_gib: 5 },
      )?.id,
    ).toBe(quiet);
  });
});
