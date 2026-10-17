// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  NodeSample,
  NodeVolumeReport,
  newDatabaseId,
  type NodeVolume,
} from "@pgcf/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  recordNodeSample,
  recordNodeVolumes,
} from "../../src/domain/node-reports.ts";
import { choosePlacement, placementNodes } from "../../src/domain/placement.ts";
import { cleanupFixtures, fixture } from "./fixtures.ts";
import { GIB, MIB } from "./node-samples.ts";

afterEach(cleanupFixtures);

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
/** A sample as the agent sends it every 15 s: a 12 GiB node at 25 % RAM and 1 of 6 cores busy. */
function sample(at: number, overrides: Partial<NodeSample> = {}): NodeSample {
  return NodeSample.parse({
    observed_at: iso(at),
    memory: { total_bytes: 12 * GIB, available_bytes: 9 * GIB },
    cpu: { cores: 6, busy_millicores: 1000 },
    pool: {
      observed_at: iso(at - 2000),
      data_total_bytes: 100 * GIB,
      data_used_bytes: 10 * GIB,
      metadata_total_bytes: GIB,
      metadata_used_bytes: 8 * MIB,
      nominal_bytes: 60 * GIB,
    },
    room: true,
    volumes: { total: 12, mounted: 12 },
    archive: { ready_files: 0, oldest_ready_seconds: null },
    awake: [],
    awake_memory_mib: 0,
    starting: 0,
    queued: 0,
    credentials_revision: 1,
    ...overrides,
  });
}
const rows = (node: string) =>
  env.DB.prepare(
    "SELECT * FROM node_samples WHERE node_id=? ORDER BY observed_at",
  )
    .bind(node)
    .all();

describe("the node's sample, stored as placement reads it", () => {
  it("keeps the figures placement and the alerts read, and shows the node online", async () => {
    const f = await fixture(0),
      at = Date.now();
    expect(await recordNodeSample(env.DB, f.node, sample(at))).toBe(true);
    expect((await rows(f.node)).results).toEqual([
      {
        node_id: f.node,
        observed_at: iso(at),
        memory_total_bytes: 12 * GIB,
        memory_available_bytes: 9 * GIB,
        cpu_cores: 6,
        cpu_busy_millicores: 1000,
        pool_data_total_bytes: 100 * GIB,
        pool_data_used_bytes: 10 * GIB,
        pool_metadata_total_bytes: GIB,
        pool_metadata_used_bytes: 8 * MIB,
        pool_nominal_bytes: 60 * GIB,
        room: 1,
        capacity_refusals: 0,
      },
    ]);
    const [node] = await placementNodes(env.DB, f.region);
    expect(node).toMatchObject({
      id: f.node,
      sampled_at: iso(at),
      ram_peak_ppm: 250_000,
      // 1,000 of 6,000 millicores.
      cpu_peak_ppm: 166_666,
      room: 1,
    });
    expect(
      choosePlacement([node!], {
        memory_mib: 512,
        cpu_millicores: 500,
        storage_gib: 5,
      })?.id,
    ).toBe(f.node);
    // The node's liveness for the stale-node alert and the operator view moves with its samples.
    expect(
      await env.DB.prepare("SELECT last_observed_at FROM nodes WHERE id=?")
        .bind(f.node)
        .first("last_observed_at"),
    ).toBe(iso(at));
  });

  it("stores a pool the node could not read as no pool, and the refusals counted since the last row", async () => {
    const f = await fixture(0),
      at = Date.now();
    await recordNodeSample(
      env.DB,
      f.node,
      sample(at, { pool: null, room: false }),
      3,
    );
    expect((await rows(f.node)).results[0]).toMatchObject({
      pool_data_total_bytes: null,
      pool_data_used_bytes: null,
      pool_metadata_total_bytes: null,
      pool_metadata_used_bytes: null,
      pool_nominal_bytes: null,
      room: 0,
      capacity_refusals: 3,
    });
  });

  it("replaces a repeated instant and refuses a lost node, a future sample and a malformed one", async () => {
    const f = await fixture(0),
      at = Date.now();
    await recordNodeSample(env.DB, f.node, sample(at));
    await recordNodeSample(
      env.DB,
      f.node,
      sample(at, {
        memory: { total_bytes: 12 * GIB, available_bytes: 6 * GIB },
      }),
    );
    expect((await rows(f.node)).results).toHaveLength(1);
    expect((await rows(f.node)).results[0]).toMatchObject({
      memory_available_bytes: 6 * GIB,
    });
    // More than 5 s ahead of the clock.
    expect(
      await recordNodeSample(env.DB, f.node, sample(at + 6000), 0, at),
    ).toBe(false);
    // Available above total is no sample.
    await expect(
      recordNodeSample(env.DB, f.node, {
        ...sample(at + 1),
        memory: { total_bytes: GIB, available_bytes: 2 * GIB },
      }),
    ).rejects.toThrow();
    await env.DB.prepare("UPDATE nodes SET lost_at=? WHERE id=?")
      .bind(iso(at), f.node)
      .run();
    expect(await recordNodeSample(env.DB, f.node, sample(at + 1000))).toBe(
      false,
    );
    expect((await rows(f.node)).results).toHaveLength(1);
    // A node of no region at all.
    expect(
      await recordNodeSample(env.DB, "nod_" + "z".repeat(20), sample(at)),
    ).toBe(false);
  });

  it("keeps seven days and 30 minutes of history, the window the peak needs", async () => {
    const f = await fixture(0),
      now = Date.now();
    for (const age of [7 * DAY + 31 * 60_000, 7 * DAY + 29 * 60_000, 3 * DAY])
      await env.DB.prepare(
        `INSERT INTO node_samples(node_id,observed_at,memory_total_bytes,memory_available_bytes,cpu_cores,cpu_busy_millicores,room)
        VALUES(?,?,?,?,1,0,1)`,
      )
        .bind(f.node, iso(now - age), GIB, GIB)
        .run();
    await recordNodeSample(env.DB, f.node, sample(now), 0, now);
    expect((await rows(f.node)).results.map((row) => row.observed_at)).toEqual([
      iso(now - (7 * DAY + 29 * 60_000)),
      iso(now - 3 * DAY),
      iso(now),
    ]);
  });
});

describe("the node's volume report", () => {
  const volume = (
    database: string,
    overrides: Partial<NodeVolume> = {},
  ): NodeVolume => ({
    database,
    storage_generation: 1,
    mounted: true,
    size_bytes: 5 * GIB,
    pool_used_bytes: 300 * MIB,
    filesystem: {
      total_bytes: 5 * GIB,
      used_bytes: 400 * MIB,
      inodes_total: 327_680,
      inodes_used: 1200,
    },
    ...overrides,
  });
  const report = (at: number, volumes: NodeVolume[]) =>
    NodeVolumeReport.parse({ observed_at: iso(at), volumes });
  const stored = (node: string) =>
    env.DB.prepare(
      "SELECT database_id,storage_generation,observed_at,fs_total_bytes,fs_used_bytes,inodes_total,inodes_used FROM node_volumes WHERE node_id=? ORDER BY database_id,storage_generation",
    )
      .bind(node)
      .all();

  it("replaces the volumes of the node with the report, filesystem figures only while mounted", async () => {
    const f = await fixture(0),
      at = Date.now(),
      first = newDatabaseId(),
      second = newDatabaseId(),
      gone = newDatabaseId();
    expect(
      await recordNodeVolumes(
        env.DB,
        f.node,
        report(at, [volume(first), volume(gone)]),
      ),
    ).toBe(true);
    expect(
      await recordNodeVolumes(
        env.DB,
        f.node,
        report(at + 60_000, [
          volume(first, { storage_generation: 2 }),
          volume(second, { mounted: false, filesystem: null }),
        ]),
        at + 60_000,
      ),
    ).toBe(true);
    expect(
      (await stored(f.node)).results.map((row) => [
        row.database_id,
        row.storage_generation,
      ]),
    ).toEqual(
      [
        [first, 2],
        [second, 1],
      ].sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
    );
    expect(
      (await stored(f.node)).results.find((row) => row.database_id === second),
    ).toMatchObject({
      observed_at: iso(at + 60_000),
      fs_total_bytes: null,
      fs_used_bytes: null,
      inodes_total: null,
      inodes_used: null,
    });
    expect(
      (await stored(f.node)).results.find((row) => row.database_id === first),
    ).toMatchObject({
      fs_total_bytes: 5 * GIB,
      fs_used_bytes: 400 * MIB,
      inodes_total: 327_680,
      inodes_used: 1200,
    });
  });

  it("ignores a report older than what is stored, a future one and a lost node's", async () => {
    const f = await fixture(0),
      at = Date.now(),
      database = newDatabaseId();
    await recordNodeVolumes(env.DB, f.node, report(at, [volume(database)]), at);
    // An older post that arrived late.
    expect(
      await recordNodeVolumes(env.DB, f.node, report(at - 60_000, []), at),
    ).toBe(false);
    expect(
      await recordNodeVolumes(env.DB, f.node, report(at + 6000, []), at),
    ).toBe(false);
    expect((await stored(f.node)).results).toHaveLength(1);
    await env.DB.prepare("UPDATE nodes SET lost_at=? WHERE id=?")
      .bind(iso(at), f.node)
      .run();
    expect(
      await recordNodeVolumes(env.DB, f.node, report(at + 1000, []), at + 1000),
    ).toBe(false);
    expect((await stored(f.node)).results).toHaveLength(1);
  });

  it("takes a report of thousands of volumes", async () => {
    const f = await fixture(0),
      at = Date.now(),
      volumes = Array.from({ length: 2500 }, () => volume(newDatabaseId()));
    expect(await recordNodeVolumes(env.DB, f.node, report(at, volumes))).toBe(
      true,
    );
    expect(
      await env.DB.prepare(
        "SELECT count(*) n FROM node_volumes WHERE node_id=?",
      )
        .bind(f.node)
        .first("n"),
    ).toBe(2500);
  });
});
