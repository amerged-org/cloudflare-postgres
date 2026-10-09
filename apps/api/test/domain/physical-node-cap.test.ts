// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { newNodeId } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import {
  configureNodeRegionPolicy,
  reserveNodeAddition,
  approveNodePurchase,
  claimNodeDispatch,
  nodeRegionOccupiedSlots,
} from "../../src/domain/node-state.ts";
import { cleanupFixtures, fixture } from "./fixtures.ts";

afterEach(cleanupFixtures);
async function setup(max = 3) {
  const f = await fixture(),
    now = new Date().toISOString();
  const provider = () =>
    String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!);
  await env.DB.prepare("UPDATE nodes SET provider_instance_id=? WHERE id=?")
    .bind(provider(), f.node)
    .run();
  const ids = [newNodeId(), newNodeId()];
  for (const [i, id] of ids.entries())
    await env.DB.prepare(
      "INSERT INTO nodes(id,region_id,k8s_node_name,ready,schedulable,database_placement_enabled,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at,node_uid,provider_instance_id) VALUES(?,?,?,1,1,?,8192,2000,40,128,100,?,?,?,?,?)",
    )
      .bind(
        id,
        f.region,
        `paid-${i}`,
        i === 0 ? 0 : 1,
        now,
        now,
        now,
        crypto.randomUUID(),
        provider(),
      )
      .run();
  const order = {
    product_id: "V159",
    provider_region: "test",
    image_id: crypto.randomUUID(),
    term_months: 1 as const,
    location: "Test fixture",
  };
  const policy = {
    region_id: f.region,
    max_nodes: max,
    purchases_enabled: true,
    order,
  };
  await configureNodeRegionPolicy(env.DB, policy);
  return {
    ...f,
    ids,
    order,
    policy,
    reserve: () =>
      reserveNodeAddition(env.DB, {
        request_key: crypto.randomUUID(),
        request: { region_id: f.region, mode: "order", order },
      }),
  };
}
it("keeps the paid control and lost VPS inside a three-server cap before reserving another purchase", async () => {
  const f = await setup();
  await env.DB.prepare(
    "UPDATE nodes SET lost_at=?,ready=0,schedulable=0 WHERE id=?",
  )
    .bind(new Date().toISOString(), f.ids[1]!)
    .run();
  expect(await nodeRegionOccupiedSlots(env.DB, f.region)).toBe(3);
  await expect(f.reserve()).rejects.toMatchObject({
    code: "capacity_unavailable",
  });
  expect(
    await env.DB.prepare(
      "SELECT count(*) count FROM node_additions WHERE region_id=?",
    )
      .bind(f.region)
      .first("count"),
  ).toBe(0);
});
it("refuses a previously queued first dispatch when three allocated VPS remain tracked after one is lost", async () => {
  const f = await setup(4),
    addition = await f.reserve();
  const approved = await approveNodePurchase(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    {
      intent_hash: addition.intent_hash,
      owner_reference: "local-test-cost-approval",
      approved_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
      monthly_amount: "1.0000",
      setup_amount: "0.0000",
      currency: "EUR",
      term_months: 1,
      location: f.order.location,
    },
  );
  await env.DB.prepare(
    "UPDATE nodes SET lost_at=?,ready=0,schedulable=0 WHERE id=?",
  )
    .bind(new Date().toISOString(), f.ids[1]!)
    .run();
  await configureNodeRegionPolicy(env.DB, { ...f.policy, max_nodes: 3 });
  await expect(
    claimNodeDispatch(env.DB, approved.intent.operation_id, approved.revision),
  ).rejects.toMatchObject({ code: "approval_required" });
  expect(
    await env.DB.prepare(
      "SELECT dispatch_request_id FROM node_additions WHERE operation_id=?",
    )
      .bind(addition.intent.operation_id)
      .first("dispatch_request_id"),
  ).toBeNull();
});

it("removes a selected cap without a sentinel while preserving tracked physical allocations", async () => {
  const f = await setup();
  expect(await nodeRegionOccupiedSlots(env.DB, f.region)).toBe(3);
  await configureNodeRegionPolicy(env.DB, { ...f.policy, max_nodes: null });
  const addition = await f.reserve();
  expect(addition.status).toBe("reserved");
  expect(await nodeRegionOccupiedSlots(env.DB, f.region)).toBe(4);
  expect(
    await env.DB.prepare(
      "SELECT max_nodes FROM node_region_policies WHERE region_id=?",
    )
      .bind(f.region)
      .first("max_nodes"),
  ).toBeNull();
});
