// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runNodeCapacity } from "../../src/domain/node-capacity.ts";
import { configureNodeRegionPolicy } from "../../src/domain/node-state.ts";
import {
  MAX_VOLUMES_PER_NODE,
  choosePlacement,
  closedPools,
  growthFits,
  placementNodes,
  type PlacementNeed,
} from "../../src/domain/placement.ts";
import { addNode, cleanupFixtures, fixture } from "./fixtures.ts";
import { seedSamples, steady } from "./node-samples.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
});

/** The smallest class: it fits the 4 GiB test node and its 30 GiB pool whenever the volumes allow. */
const SMALL: PlacementNeed = {
  memory_mib: 512,
  cpu_millicores: 500,
  storage_gib: 1,
};
/** Each report is a little newer than the one before, so the node's newest sample is the last one. */
let clock = 0;
const report = (nodeId: string, volumes: number) =>
  seedSamples(nodeId, steady(Date.now() + ++clock, 40, { volumes }));
const nodeOf = async (f: Awaited<ReturnType<typeof fixture>>, now: number) =>
  (await placementNodes(env.DB, f.region, now)).find((n) => n.id === f.node)!;

describe("the technical volume bound of a node (plan 4.8, 4.11)", () => {
  it("is 1,000 volumes", () => {
    expect(MAX_VOLUMES_PER_NODE).toBe(1000);
  });

  it("leaves a node with 999 volumes open for create, restore and move, and closes it at 1,000", async () => {
    const f = await fixture(4096);
    await report(f.node, 999);
    const open = await nodeOf(f, Date.now());
    expect(open.volumes_total).toBe(999);
    expect(choosePlacement([open], SMALL)?.id).toBe(f.node);

    await report(f.node, 1000);
    const closed = await nodeOf(f, Date.now());
    expect(closed.volumes_total).toBe(1000);
    expect(choosePlacement([closed], SMALL)).toBeNull();

    await report(f.node, 1450);
    expect(choosePlacement([await nodeOf(f, Date.now())], SMALL)).toBeNull();
  });

  it("takes the next node when the fullest one is at the bound", async () => {
    const f = await fixture(4096);
    await report(f.node, 1000);
    const other = await addNode(f.region, 4096);
    await report(other, 10);
    const nodes = await placementNodes(env.DB, f.region, Date.now());
    expect(choosePlacement(nodes, SMALL)?.id).toBe(other);
  });

  it("does not stop a resize on a node at the bound: a resize creates no volume", async () => {
    const f = await fixture(4096);
    await report(f.node, 1000);
    const node = await nodeOf(f, Date.now());
    expect(
      growthFits(node, { memory_mib: 256, cpu_millicores: 0, storage_gib: 1 }),
    ).toBe(true);
  });

  it("raises the pool-closed alarm's node list at 1,000 volumes and not at 999", async () => {
    const f = await fixture(4096);
    await report(f.node, 999);
    expect(await closedPools(env.DB, f.region)).toEqual([]);
    await report(f.node, 1000);
    expect(await closedPools(env.DB, f.region)).toEqual([f.node]);
  });

  it("counts a node at the bound as full in the capacity decision: it raises the purchase signal at 1,000, not at 999", async () => {
    const f = await fixture(4096);
    await configureNodeRegionPolicy(env.DB, {
      region_id: f.region,
      max_nodes: 3,
      purchases_enabled: false,
      order: null,
    });
    const instance = String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!);
    await env.DB.prepare(
      "UPDATE node_region_policies SET autoscale_enabled=1,adopt_instance_ids=? WHERE region_id=?",
    )
      .bind(JSON.stringify([instance]), f.region)
      .run();
    const additions = () =>
      env.DB.prepare("SELECT count(*) n FROM node_additions WHERE region_id=?")
        .bind(f.region)
        .first("n");

    await report(f.node, 999);
    expect((await runNodeCapacity(env, f.region, true)).action).toBe("idle");

    await report(f.node, 1000);
    expect((await runNodeCapacity(env, f.region, true)).action).toBe("adopt");
    expect(await additions()).toBe(0);

    const start = vi
      .spyOn(env.ADD_NODE, "create")
      .mockResolvedValue({} as Awaited<ReturnType<typeof env.ADD_NODE.create>>);
    expect((await runNodeCapacity(env, f.region)).action).toBe("adopt");
    expect(await additions()).toBe(1);
    expect(start).toHaveBeenCalledTimes(1);
  });
});
