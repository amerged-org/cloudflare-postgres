// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runNodeCapacity } from "../../src/domain/node-capacity.ts";
import { configureNodeRegionPolicy } from "../../src/domain/node-state.ts";
import { addNode, cleanupFixtures, fixture, request } from "./fixtures.ts";
import { patchSample, reports, seedSamples, steady } from "./node-samples.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
});

const providerId = () =>
  String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!);
const order = {
  product_id: "V159",
  provider_region: "test",
  image_id: crypto.randomUUID(),
  term_months: 1 as const,
  location: "Test fixture",
};
type Fixture = Awaited<ReturnType<typeof fixture>>;
/** A region whose only node (fixture memory) reports now; the policy buys by adoption or order. */
async function region(
  memory = 4096,
  policy: {
    autoscale?: boolean;
    adopt?: string[];
    order?: boolean;
    purchases?: boolean;
  } = {},
) {
  const f = await fixture(memory);
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 3,
    purchases_enabled: policy.purchases ?? false,
    order: policy.order ? order : null,
  });
  await env.DB.prepare(
    "UPDATE node_region_policies SET autoscale_enabled=?,adopt_instance_ids=? WHERE region_id=?",
  )
    .bind(
      Number(policy.autoscale ?? true),
      JSON.stringify(policy.adopt ?? []),
      f.region,
    )
    .run();
  return f;
}
const decide = async (f: Fixture, dryRun = true) =>
  (await runNodeCapacity(env, f.region, dryRun)).action;
const additions = (f: Fixture) =>
  env.DB.prepare("SELECT count(*) n FROM node_additions WHERE region_id=?")
    .bind(f.region)
    .first("n");

describe("the next capacity step of a region", () => {
  it("does nothing without a policy", async () => {
    const f = await fixture();
    expect(await decide(f)).toBe("unconfigured");
  });

  it("is idle while a node can take the smallest size class", async () => {
    const f = await region(4096, { adopt: [providerId()] });
    expect(await decide(f)).toBe("idle");
    expect(await additions(f)).toBe(0);
  });

  it("buys when no node can take the smallest size class: by adoption first, else by order", async () => {
    const f = await region(4096, {
      adopt: [providerId()],
      order: true,
      purchases: true,
    });
    // The node runs at 90 % active RAM, so another 512 MiB would not stay under 80 %.
    await seedSamples(f.node, steady(Date.now(), 40, { ramPpm: 900_000 }));
    expect(await decide(f)).toBe("adopt");
    await env.DB.prepare(
      "UPDATE node_region_policies SET adopt_instance_ids='[]' WHERE region_id=?",
    )
      .bind(f.region)
      .run();
    expect(await decide(f)).toBe("order");
    expect(await additions(f)).toBe(0);
  });

  it("reserves an order when no node fits, without any regional RAM window, and waits for the owner's approval", async () => {
    const f = await region(4096, { order: true, purchases: true });
    await seedSamples(f.node, steady(Date.now(), 40, { ramPpm: 900_000 }));
    const start = vi
      .spyOn(env.ADD_NODE, "create")
      .mockResolvedValue({} as Awaited<ReturnType<typeof env.ADD_NODE.create>>);
    expect(await decide(f, false)).toBe("waiting_for_approval");
    expect(await additions(f)).toBe(1);
    expect(start).toHaveBeenCalledTimes(1);
    // The same hour's key binds the same addition: a second run reserves nothing more.
    expect(await decide(f, false)).toBe("waiting_for_approval");
    expect(await additions(f)).toBe(1);
  });

  it("reserves no order and starts no AddNode while purchases are off, and says so", async () => {
    // Adoption is no purchase and still goes first; with nothing to adopt the order is not reserved.
    const f = await region(4096, { order: true, purchases: false });
    await seedSamples(f.node, steady(Date.now(), 40, { ramPpm: 900_000 }));
    const start = vi
      .spyOn(env.ADD_NODE, "create")
      .mockResolvedValue({} as Awaited<ReturnType<typeof env.ADD_NODE.create>>);
    expect(await decide(f, true)).toBe("purchases_disabled");
    expect(await decide(f, false)).toBe("purchases_disabled");
    expect(await additions(f)).toBe(0);
    expect(start).not.toHaveBeenCalled();
    // Turning purchases on later buys for a shortage that exists then, not for one that is gone.
    await env.DB.prepare(
      "UPDATE node_region_policies SET purchases_enabled=1 WHERE region_id=?",
    )
      .bind(f.region)
      .run();
    expect(await decide(f, false)).toBe("waiting_for_approval");
    expect(await additions(f)).toBe(1);
  });

  it("reserves nothing while autoscale is off, even with purchases on and an order", async () => {
    const f = await region(4096, {
      autoscale: false,
      order: true,
      purchases: true,
      adopt: [providerId()],
    });
    await seedSamples(f.node, steady(Date.now(), 40, { ramPpm: 900_000 }));
    const start = vi
      .spyOn(env.ADD_NODE, "create")
      .mockResolvedValue({} as Awaited<ReturnType<typeof env.ADD_NODE.create>>);
    expect(await decide(f, false)).toBe("disabled");
    expect(await additions(f)).toBe(0);
    expect(start).not.toHaveBeenCalled();
  });

  it("buys when the CPU load of every node is at 80 %", async () => {
    const f = await region(4096, { adopt: [providerId()] });
    await seedSamples(f.node, steady(Date.now(), 40, { cpuPpm: 800_000 }));
    expect(await decide(f)).toBe("adopt");
  });

  it("buys when every node is closed for placement", async () => {
    const f = await region(4096, { adopt: [providerId()] });
    await env.DB.prepare(
      "UPDATE nodes SET database_placement_enabled=0 WHERE id=?",
    )
      .bind(f.node)
      .run();
    expect(await decide(f)).toBe("adopt");
  });

  it("buys nothing while a node that should report has gone quiet", async () => {
    const f = await region(4096, { adopt: [providerId()] });
    await patchSample(f.node, {
      observedAt: new Date(Date.now() - 181_000).toISOString(),
    });
    expect(await decide(f)).toBe("observations_stale");
  });

  it("names why it does not buy: autoscale off, nothing to buy with, the node cap", async () => {
    const f = await region(4096, { autoscale: false, adopt: [providerId()] });
    await seedSamples(f.node, steady(Date.now(), 40, { ramPpm: 900_000 }));
    expect(await decide(f)).toBe("disabled");
    await env.DB.prepare(
      "UPDATE node_region_policies SET autoscale_enabled=1,adopt_instance_ids='[]' WHERE region_id=?",
    )
      .bind(f.region)
      .run();
    expect(await decide(f)).toBe("selection_unconfigured");
    await configureNodeRegionPolicy(env.DB, {
      region_id: f.region,
      max_nodes: 1,
    });
    expect(await decide(f)).toBe("cap_reached");
  });

  it("places a waiting database where a node now has room, and reports that before it does", async () => {
    const f = await region(0);
    const waiting = DatabaseWithOperation.parse(
      await (await f.create("waiting")).json(),
    );
    expect(waiting.database.node_id).toBeNull();
    // The node has not reported yet: nothing is bought for it meanwhile.
    expect(await decide(f)).toBe("observations_stale");
    await reports(f.node);
    expect(await decide(f)).toBe("placement_pending");
    const result = await runNodeCapacity(env, f.region);
    expect(result.placed).toBe(1);
    expect(
      await env.DB.prepare("SELECT node_id FROM databases WHERE id=?")
        .bind(waiting.database.id)
        .first("node_id"),
    ).toBe(f.node);
    expect(await decide(f)).toBe("idle");
  });

  it("asks for capacity for the waiting database with its own size, not for the smallest class", async () => {
    // Nothing to buy with, so the decision stops where a purchase would start.
    const f = await region(8192);
    const other = await addNode(f.region, 8192);
    await seedSamples(f.node, steady(Date.now(), 40, { ramPpm: 700_000 }));
    await seedSamples(other, steady(Date.now(), 40, { ramPpm: 700_000 }));
    // The class of 512 MiB fits (70 % + 6 % on 8 GiB); a database of 2,048 MiB (25 %) does not.
    expect(await decide(f)).toBe("idle");
    const response = await request("/v1/databases", f.admin, "POST", {
      project_id: f.project,
      region_id: f.region,
      name: "big",
      size_class_id: f.size,
      resources: { memory_mib: 2048 },
    });
    expect(response.status).toBe(202);
    expect(
      DatabaseWithOperation.parse(await response.json()).database.node_id,
    ).toBeNull();
    expect(await decide(f)).toBe("selection_unconfigured");
  });

  it("does not buy for a waiting database that no node could ever take", async () => {
    const f = await region(0, { adopt: [providerId()] });
    const waiting = DatabaseWithOperation.parse(
      await (await f.create("too-big")).json(),
    );
    await env.DB.prepare(
      "UPDATE node_region_policies SET maximum_database_memory_mib=256 WHERE region_id=?",
    )
      .bind(f.region)
      .run();
    expect(waiting.database.node_id).toBeNull();
    expect(await decide(f)).toBe("size_policy_unavailable");
    await env.DB.prepare("UPDATE size_classes SET enabled=0 WHERE id=?")
      .bind(f.size)
      .run();
    expect(await decide(f)).toBe("size_policy_unavailable");
  });
});
