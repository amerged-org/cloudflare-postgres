// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { newDatabaseId, newNodeId, newOperationId } from "@pgcf/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupFixtures,
  fixture,
  nodeKeyPair,
  nodeRequest,
  request,
} from "./fixtures.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
});

type F = Awaited<ReturnType<typeof fixture>>;
async function database(f: F) {
  const response = await f.create();
  expect(response.status).toBe(202);
  return ((await response.json()) as { database: { id: string } }).database.id;
}
const GIB = 1024 ** 3;
const volume = (id: string, extra: Record<string, unknown> = {}) => ({
  database: id,
  storage_generation: 1,
  mounted: true,
  size_bytes: 5 * GIB,
  pool_used_bytes: 300 * 1024 ** 2,
  filesystem: {
    total_bytes: 5 * GIB,
    used_bytes: 200 * 1024 ** 2,
    inodes_total: 327_680,
    inodes_used: 1500,
  },
  ...extra,
});
const post = (
  f: Parameters<typeof nodeRequest>[0],
  path: string,
  body: unknown,
) => nodeRequest(f, path, { method: "POST", body });
const volumes = (f: F, list: unknown[], at = new Date().toISOString()) =>
  post(f, "/node/v1/volumes", { observed_at: at, volumes: list });
const stored = (node: string) =>
  env.DB.prepare(
    "SELECT database_id,storage_generation,mounted,size_bytes,pool_used_bytes,filesystem_used_bytes,inodes_used FROM node_volumes WHERE node_id=? ORDER BY database_id,storage_generation",
  )
    .bind(node)
    .all<Record<string, number | string | null>>()
    .then((rows) => rows.results);

describe("the volumes of a node", () => {
  it("replace its previous report and keep the volumes of databases that are gone", async () => {
    const f = await fixture();
    const id = await database(f);
    const orphan = newDatabaseId();
    const response = await volumes(f, [
      volume(id),
      volume(orphan, { mounted: false, filesystem: null }),
    ]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 2 });
    expect(await stored(f.node)).toEqual(
      [
        {
          database_id: id,
          storage_generation: 1,
          mounted: 1,
          size_bytes: 5 * GIB,
          pool_used_bytes: 300 * 1024 ** 2,
          filesystem_used_bytes: 200 * 1024 ** 2,
          inodes_used: 1500,
        },
        {
          database_id: orphan,
          storage_generation: 1,
          mounted: 0,
          size_bytes: 5 * GIB,
          pool_used_bytes: 300 * 1024 ** 2,
          filesystem_used_bytes: null,
          inodes_used: null,
        },
      ].sort((a, b) => (a.database_id < b.database_id ? -1 : 1)),
    );
    // What the next report no longer names is gone from the node.
    await volumes(
      f,
      [volume(id, { pool_used_bytes: 400 * 1024 ** 2 })],
      new Date(Date.now() + 1000).toISOString(),
    );
    expect(await stored(f.node)).toEqual([
      expect.objectContaining({
        database_id: id,
        pool_used_bytes: 400 * 1024 ** 2,
      }),
    ]);
  });

  it("do not let an older report overwrite a newer one", async () => {
    const f = await fixture();
    const id = await database(f);
    await volumes(f, [volume(id, { pool_used_bytes: 500 * 1024 ** 2 })]);
    await volumes(
      f,
      [volume(id, { pool_used_bytes: 100 * 1024 ** 2 })],
      new Date(Date.now() - 60_000).toISOString(),
    );
    expect((await stored(f.node))[0]!.pool_used_bytes).toBe(500 * 1024 ** 2);
  });

  it("take volumes of every size in chunks", async () => {
    const f = await fixture();
    const list = Array.from({ length: 450 }, () => volume(newDatabaseId()));
    expect((await volumes(f, list)).status).toBe(200);
    expect(await stored(f.node)).toHaveLength(450);
  });

  it("become the storage samples that the database's health and usage read, once per quarter hour", async () => {
    const f = await fixture();
    const id = await database(f);
    const at = new Date(
      Math.floor(Date.now() / 900_000) * 900_000 - 900_000 + 1000,
    ).toISOString();
    await volumes(f, [volume(id), volume(newDatabaseId())], at);
    await volumes(
      f,
      [
        volume(id, {
          filesystem: {
            total_bytes: 5 * GIB,
            used_bytes: 999,
            inodes_total: 1,
            inodes_used: 0,
          },
        }),
      ],
      new Date(Date.parse(at) + 60_000).toISOString(),
    );
    const samples = await env.DB.prepare(
      "SELECT database_id,producer_id,sequence,payload FROM usage_samples WHERE source='agent'",
    ).all<{
      database_id: string;
      producer_id: string;
      sequence: number;
      payload: string;
    }>();
    // The orphan has no database to be billed, and the second report is in the same quarter hour.
    expect(samples.results).toHaveLength(1);
    expect(samples.results[0]).toMatchObject({
      database_id: id,
      producer_id: f.nodeUid,
      sequence: Math.floor(Date.parse(at) / 900_000),
    });
    expect(JSON.parse(samples.results[0]!.payload)).toMatchObject({
      source: "agent",
      storage_used_bytes: 200 * 1024 ** 2,
      storage_allocated_bytes: 5 * GIB,
    });
    const view = (await (
      await request(`/v1/databases/${id}`, f.integrator)
    ).json()) as {
      storage: { used_bytes: number; allocated_bytes: number };
    };
    expect(view.storage).toMatchObject({
      used_bytes: 200 * 1024 ** 2,
      allocated_bytes: 5 * GIB,
    });
    // The next quarter hour is a sample of its own, and an unmounted volume counts the pool's chunks.
    await volumes(
      f,
      [volume(id, { mounted: false, filesystem: null })],
      new Date(Date.parse(at) + 900_000).toISOString(),
    );
    const later = await env.DB.prepare(
      "SELECT payload FROM usage_samples WHERE source='agent' ORDER BY sequence",
    ).all<{ payload: string }>();
    expect(later.results).toHaveLength(2);
    expect(JSON.parse(later.results[1]!.payload).storage_used_bytes).toBe(
      300 * 1024 ** 2,
    );
  });

  it("are refused when a mounted volume has no filesystem or a volume is named twice", async () => {
    const f = await fixture();
    const id = await database(f);
    expect((await volumes(f, [volume(id, { filesystem: null })])).status).toBe(
      400,
    );
    expect((await volumes(f, [volume(id), volume(id)])).status).toBe(400);
    expect(
      (
        await volumes(
          f,
          [volume(id)],
          new Date(Date.now() + 3600_000).toISOString(),
        )
      ).status,
    ).toBe(400);
  });
});

const admission = (
  id: string,
  extra: Record<string, unknown> = {},
  at = Date.now(),
) => ({
  type: "admission",
  id: crypto.randomUUID(),
  at: new Date(at).toISOString(),
  database: newDatabaseId(),
  generation: 3,
  operation: newOperationId(),
  start: "wake",
  decision: "admitted",
  waited_ms: 0,
  memory_mib: 256,
  ...extra,
});
const minutes = (node: string) =>
  env.DB.prepare(
    "SELECT minute,samples,admitted,refused_no_room,refused_no_headroom,early_sleeps,queue_waits,queue_wait_ms_sum,queue_wait_ms_max FROM node_minutes WHERE node_id=? ORDER BY minute",
  )
    .bind(node)
    .all<Record<string, number>>()
    .then((rows) => rows.results);

describe("the events of a node", () => {
  it("count its decisions in the minute they happened", async () => {
    const f = await fixture(0);
    const at = Math.floor(Date.now() / 60_000) * 60_000 - 5 * 60_000 + 1000;
    const events = [
      admission("a", {}, at),
      admission("b", { waited_ms: 400 }, at + 1000),
      admission(
        "c",
        { decision: "refused", reason: "no_room", waited_ms: 0 },
        at + 2000,
      ),
      admission(
        "d",
        {
          decision: "refused",
          reason: "no_headroom",
          retry_after_seconds: 5,
          waited_ms: 10_000,
        },
        at + 3000,
      ),
      {
        type: "early_sleep",
        id: crypto.randomUUID(),
        at: new Date(at + 4000).toISOString(),
        database: newDatabaseId(),
        generation: 2,
        for_database: newDatabaseId(),
      },
      admission("e", {}, at + 61_000),
    ];
    const response = await post(f, "/node/v1/events", { events });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 6, duplicates: 0 });
    expect(await minutes(f.node)).toEqual([
      {
        minute: at / 60_000 - (at % 60_000) / 60_000,
        samples: 0,
        admitted: 2,
        refused_no_room: 1,
        refused_no_headroom: 1,
        early_sleeps: 1,
        queue_waits: 2,
        queue_wait_ms_sum: 10_400,
        queue_wait_ms_max: 10_000,
      },
      expect.objectContaining({ admitted: 1, queue_waits: 0 }),
    ]);
  });

  it("count once when a post is retried", async () => {
    const f = await fixture();
    const events = [admission("a"), admission("b", { waited_ms: 50 })];
    expect(await (await post(f, "/node/v1/events", { events })).json()).toEqual(
      { accepted: 2, duplicates: 0 },
    );
    expect(
      await (
        await post(f, "/node/v1/events", {
          events: [...events, admission("c")],
        })
      ).json(),
    ).toEqual({ accepted: 1, duplicates: 2 });
    const [row] = await minutes(f.node);
    expect(row).toMatchObject({
      admitted: 3,
      queue_waits: 1,
      queue_wait_ms_sum: 50,
    });
    // A node's ids are its own.
    const other = await fixture();
    expect(
      await (await post(other, "/node/v1/events", { events })).json(),
    ).toEqual({ accepted: 2, duplicates: 0 });
  });

  it("forget the ids of a post that can no longer be retried", async () => {
    const f = await fixture();
    await post(f, "/node/v1/events", { events: [admission("a")] });
    await env.DB.prepare(
      "UPDATE node_event_ids SET received_at=? WHERE node_id=?",
    )
      .bind(Date.now() - 3600_000, f.node)
      .run();
    await post(f, "/node/v1/events", { events: [admission("b")] });
    expect(
      await env.DB.prepare(
        "SELECT count(*) n FROM node_event_ids WHERE node_id=?",
      )
        .bind(f.node)
        .first("n"),
    ).toBe(1);
  });

  it("log a wake with its phases and count nothing", async () => {
    const f = await fixture(0);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const wake = {
      type: "wake",
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      database: newDatabaseId(),
      generation: 3,
      operation: newOperationId(),
      outcome: "started",
      phases_ms: {
        admission: 1,
        queue_wait: 0,
        pg_control: 2,
        mount: 0,
        start: 61,
        release: 1,
      },
    };
    expect((await post(f, "/node/v1/events", { events: [wake] })).status).toBe(
      200,
    );
    const logged = lines
      .map((line) => JSON.parse(line))
      .find((line) => line.event === "node_wake");
    expect(logged).toMatchObject({
      node_id: f.node,
      database_id: wake.database,
      outcome: "started",
      phases_ms: { start: 61 },
    });
    expect(await minutes(f.node)).toEqual([]);
  });

  it("are refused when they are invalid or from the future", async () => {
    const f = await fixture();
    expect((await post(f, "/node/v1/events", { events: [] })).status).toBe(400);
    expect(
      (
        await post(f, "/node/v1/events", {
          events: [{ ...admission("a"), reason: "no_room" }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(f, "/node/v1/events", {
          events: [admission("a", {}, Date.now() + 3600_000)],
        })
      ).status,
    ).toBe(400);
  });
});

const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000;
const row = (
  id: string,
  offset: number,
  extra: Record<string, unknown> = {},
) => ({
  database: id,
  interval_start: new Date(hour + offset).toISOString(),
  interval_end: new Date(hour + offset + 60_000).toISOString(),
  awake_ms: 60_000,
  ingress_bytes: 1000,
  egress_bytes: 5000,
  connections: 3,
  connection_ms: 90_000,
  ...extra,
});

describe("the usage of a node", () => {
  it("is recorded as the gateway samples of that node, once per interval", async () => {
    const f = await fixture();
    const id = await database(f);
    const rows = [row(id, 0), row(id, 60_000, { ingress_bytes: null })];
    const response = await post(f, "/node/v1/usage", { rows });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      recorded: 2,
      duplicates: 0,
      refused: 0,
    });
    const samples = await env.DB.prepare(
      "SELECT producer_id,sequence,payload FROM usage_samples WHERE database_id=? AND source='gateway' ORDER BY sequence",
    )
      .bind(id)
      .all<{ producer_id: string; sequence: number; payload: string }>();
    expect(samples.results.map((sample) => sample.sequence)).toEqual([
      hour,
      hour + 60_000,
    ]);
    expect(JSON.parse(samples.results[0]!.payload)).toEqual({
      source: "gateway",
      database_id: id,
      producer_id: f.nodeUid,
      sequence: hour,
      observed_at: new Date(hour + 60_000).toISOString(),
      interval_start: new Date(hour).toISOString(),
      interval_end: new Date(hour + 60_000).toISOString(),
      expected_producers: [f.nodeUid],
      ingress_bytes: 1000,
      egress_bytes: 5000,
      connections: 3,
      connection_seconds: 90,
    });
    expect(JSON.parse(samples.results[1]!.payload).ingress_bytes).toBeNull();
    // A retried post changes nothing.
    expect(await (await post(f, "/node/v1/usage", { rows })).json()).toEqual({
      recorded: 0,
      duplicates: 2,
      refused: 0,
    });
  });

  it("is recorded only for the databases the node serves, also when another node of its region posts them", async () => {
    const f = await fixture();
    const id = await database(f);
    const key = await nodeKeyPair(),
      now = new Date().toISOString(),
      neighbour = {
        node: newNodeId(),
        nodeUid: crypto.randomUUID(),
        nodeKey: key.privateKey,
      };
    await env.DB.prepare(
      "INSERT INTO nodes(id,region_id,hostname,ready,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at,node_uid,public_key,enrolled_at) VALUES (?,?,?,1,4096,2000,30,128,100,?,?,?,?,?,?)",
    )
      .bind(
        neighbour.node,
        f.region,
        "node-neighbour",
        now,
        now,
        now,
        neighbour.nodeUid,
        key.publicKey,
        now,
      )
      .run();
    const forged = row(id, 0, {
      ingress_bytes: 10 ** 12,
      egress_bytes: 10 ** 12,
    });
    expect(
      await (
        await post(neighbour, "/node/v1/usage", { rows: [forged] })
      ).json(),
    ).toEqual({ recorded: 0, duplicates: 0, refused: 1 });
    expect(
      await env.DB.prepare(
        "SELECT count(*) n FROM usage_samples WHERE database_id=?",
      )
        .bind(id)
        .first("n"),
    ).toBe(0);
    // The foreign row did not pre-empt the interval: the serving node still records its own.
    expect(
      await (await post(f, "/node/v1/usage", { rows: [row(id, 0)] })).json(),
    ).toEqual({ recorded: 1, duplicates: 0, refused: 0 });
  });

  it("acknowledges a row it cannot record, so the node's outbox drains", async () => {
    const f = await fixture();
    const id = await database(f);
    const nothing = row(id, 0, {
      ingress_bytes: null,
      egress_bytes: null,
      connections: null,
      connection_ms: null,
    });
    const strangers = row(newDatabaseId(), 60_000);
    const future = row(id, 120_000, {
      interval_start: new Date(Date.now() + 3600_000).toISOString(),
      interval_end: new Date(Date.now() + 3600_000 + 60_000).toISOString(),
    });
    const response = await post(f, "/node/v1/usage", {
      rows: [nothing, strangers, future, row(id, 180_000)],
    });
    expect(await response.json()).toEqual({
      recorded: 1,
      duplicates: 0,
      refused: 3,
    });
    // A different measurement under the same interval is a conflict, acknowledged as refused.
    expect(
      await (
        await post(f, "/node/v1/usage", {
          rows: [row(id, 180_000, { ingress_bytes: 7 })],
        })
      ).json(),
    ).toEqual({ recorded: 0, duplicates: 0, refused: 1 });
  });

  it("is refused when an interval crosses an hour or a row is named twice", async () => {
    const f = await fixture();
    const id = await database(f);
    const crossing = row(id, 3_600_000 - 30_000);
    expect((await post(f, "/node/v1/usage", { rows: [crossing] })).status).toBe(
      400,
    );
    expect(
      (await post(f, "/node/v1/usage", { rows: [row(id, 0), row(id, 0)] }))
        .status,
    ).toBe(400);
    expect((await post(f, "/node/v1/usage", { rows: [] })).status).toBe(400);
  });
});
