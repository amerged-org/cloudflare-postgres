// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { newNodeId } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import {
  configureNodeRegionPolicy,
  reserveNodeAddition,
} from "../../src/domain/node-state.ts";
import { recordNodeMemoryObservation } from "../../src/domain/memory-capacity.ts";
import { runNodeCapacity } from "../../src/domain/node-capacity.ts";
import { cleanupFixtures, fixture } from "./fixtures.ts";

afterEach(cleanupFixtures);
const capacity = 8 * 1024 ** 3;
async function setup() {
  const f = await fixture(8192, 40);
  const order = {
    product_id: "V159",
    provider_region: "test",
    image_id: crypto.randomUUID(),
    term_months: 1 as const,
    location: "Test",
  };
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 5,
    purchases_enabled: false,
    order,
    placement_mode: "actual_ram",
    maximum_database_memory_mib: 4096,
    postgres_memory_request_mib: 128,
  });
  await env.DB.prepare(
    "UPDATE node_region_policies SET autoscale_enabled=1 WHERE region_id=?",
  )
    .bind(f.region)
    .run();
  const node = {
    id: f.node,
    uid: crypto.randomUUID(),
    provider: String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!),
  };
  await env.DB.prepare(
    "UPDATE nodes SET node_uid=?,provider_instance_id=? WHERE id=?",
  )
    .bind(node.uid, node.provider, node.id)
    .run();
  return { ...f, order, node };
}
async function add(f: Awaited<ReturnType<typeof setup>>, id = newNodeId()) {
  const node = {
    id,
    uid: crypto.randomUUID(),
    provider: String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!),
  };
  await env.DB.prepare(
    `INSERT INTO nodes(id,region_id,k8s_node_name,ready,schedulable,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at,node_uid,provider_instance_id)
    SELECT ?,region_id,?,1,1,8192,2000,40,128,100,last_observed_at,created_at,updated_at,?,? FROM nodes WHERE id=?`,
  )
    .bind(
      node.id,
      `worker-${crypto.randomUUID()}`,
      node.uid,
      node.provider,
      f.node.id,
    )
    .run();
  return node;
}
async function samples(
  f: Awaited<ReturnType<typeof setup>>,
  node: typeof f.node,
  percent: number,
  count = 10,
  at = Date.now(),
  physicalCapacity = capacity,
) {
  for (let i = count - 1; i >= 0; i--) {
    const time = at - i * 60_000,
      observed_at = new Date(time).toISOString();
    expect(
      await recordNodeMemoryObservation(
        env.DB,
        f.region,
        {
          node_id: node.id,
          node_uid: node.uid,
          provider_instance_id: node.provider,
          memory: {
            node_uid: node.uid,
            observed_at,
            capacity_memory_bytes: physicalCapacity,
            working_set_bytes: Math.floor((physicalCapacity * percent) / 100),
            available_bytes:
              physicalCapacity - Math.floor((physicalCapacity * percent) / 100),
            memory_pressure: false,
          },
        },
        observed_at,
        time,
      ),
    ).toBe(true);
  }
}

it("does not order again for another old hot source after a newly Ready spare lowers regional RAM", async () => {
  const f = await setup(),
    at = Date.now();
  await samples(f, f.node, 90, 10, at);
  const otherHot = await add(f);
  await samples(f, otherHot, 90, 10, at);
  expect((await runNodeCapacity(env, f.region, true)).action).toBe("order");
  const completed = await reserveNodeAddition(env.DB, {
    request_key: `capacity-ram-${f.node.uid}`,
    request: { region_id: f.region, mode: "order", order: f.order },
  });
  await env.DB.prepare(
    "UPDATE node_additions SET status='ready' WHERE operation_id=?",
  )
    .bind(completed.intent.operation_id)
    .run();
  const spare = await add(f, completed.intent.node_id);
  await samples(f, spare, 20, 10, at);
  expect((await runNodeCapacity(env, f.region, true)).action).toBe("idle");
  expect(
    await env.DB.prepare(
      "SELECT count(*) count FROM node_additions WHERE region_id=?",
    )
      .bind(f.region)
      .first("count"),
  ).toBe(1);
});

it("blocks a new order while a Ready spare lacks ten aligned samples or changes physical identity", async () => {
  const f = await setup(),
    at = Date.now();
  await samples(f, f.node, 90, 10, at);
  const spare = await add(f);
  await samples(f, spare, 20, 1, at);
  expect((await runNodeCapacity(env, f.region, true)).action).not.toBe("order");
  await samples(f, spare, 20, 10, at + 1);
  const replacement = { ...spare, uid: crypto.randomUUID() };
  await env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?")
    .bind(replacement.uid, spare.id)
    .run();
  expect((await runNodeCapacity(env, f.region, true)).action).not.toBe("order");
  await samples(f, replacement, 20, 10, at - 60_000);
  expect((await runNodeCapacity(env, f.region, true)).action).not.toBe("order");
});

it("weights actual physical bytes and excludes the control role from zone pressure", async () => {
  const f = await setup(),
    at = Date.now();
  await env.DB.prepare(
    "UPDATE nodes SET allocatable_memory_mib=24576 WHERE id=?",
  )
    .bind(f.node.id)
    .run();
  await samples(f, f.node, 90, 10, at, capacity * 3);
  const second = await add(f);
  await samples(f, second, 40, 10, at);
  const control = await add(f);
  await env.DB.prepare(
    "UPDATE nodes SET database_placement_enabled=0 WHERE id=?",
  )
    .bind(control.id)
    .run();
  await samples(f, control, 0, 10, at, capacity * 4);
  // (24GiB*90% + 8GiB*40%)/32GiB = 77.5%; averaging node percentages gives the wrong answer.
  expect((await runNodeCapacity(env, f.region, true)).action).toBe("order");
});

it("counts a Ready customer node's RAM when only its new-placement timestamp is closed", async () => {
  const f = await setup(),
    at = Date.now();
  await samples(f, f.node, 92, 10, at);
  const second = await add(f);
  await samples(f, second, 62, 10, at);
  await env.DB.prepare(
    "UPDATE nodes SET database_placement_closed_at=? WHERE id=?",
  )
    .bind(new Date().toISOString(), f.node.id)
    .run();
  expect((await runNodeCapacity(env, f.region, true)).action).toBe("order");
});
