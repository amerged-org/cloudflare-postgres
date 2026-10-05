// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newNodeId, randomString } from "@pgcf/contracts";
import { NodeAddition } from "@pgcf/contracts/nodes";
import {
  approveNodePurchase,
  configureNodeRegionPolicy,
  readNodeAddition,
  recordNodeAudit,
  recordNodeReceipt,
  reserveNodeAddition,
} from "../../src/domain/node-state.ts";
import {
  dispatchNodeOrder,
  reconcileNodeProvider,
  ensureNodeRescue,
} from "../../src/workflows/add-node.ts";
import { runNodeCapacity } from "../../src/domain/node-capacity.ts";
import { cleanupFixtures, fixture, observedBody, request } from "./fixtures.ts";
const workflows: string[] = [];
afterEach(async () => {
  for (const id of workflows.splice(0))
    await (await env.ADD_NODE.get(id)).terminate();
  await cleanupFixtures();
});
const providerId = () => String(BigInt("1" + randomString("0123456789", 9)));
const order = () => ({
  product_id: crypto.randomUUID(),
  provider_region: "EU",
  image_id: crypto.randomUUID(),
  term_months: 1 as const,
  location: crypto.randomUUID(),
});
async function configured() {
  const f = await fixture();
  await env.DB.prepare("UPDATE regions SET provider_region='EU' WHERE id=?")
    .bind(f.region)
    .run();
  const selection = order();
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 2,
    purchases_enabled: false,
    order: selection,
  });
  return { ...f, selection };
}
describe("node composition with actual Workers/D1", () => {
  it("blocks rescue without verified network preparation even before a private job exists", async () => {
    const f = await configured(),
      instance = providerId();
    let addition = await reserveNodeAddition(env.DB, {
      request_key: crypto.randomUUID(),
      request: {
        region_id: f.region,
        mode: "adopt",
        provider_instance_id: instance,
      },
    });
    addition = await recordNodeReceipt(
      env.DB,
      addition.intent.operation_id,
      addition.revision,
      {
        provider_instance_id: instance,
        request_id: null,
        reference: crypto.randomUUID(),
        received_at: new Date().toISOString(),
      },
    );
    addition = await recordNodeAudit(
      env.DB,
      addition.intent.operation_id,
      addition.revision,
      {
        provider_instance_id: instance,
        provider_region: "EU",
        product_id: crypto.randomUUID(),
        image_id: crypto.randomUUID(),
        reference: crypto.randomUUID(),
        observed_at: new Date().toISOString(),
      },
    );
    const get = vi.fn(async () => {
        throw new Error("unexpected_provider_get");
      }),
      rescue = vi.fn(async () => {
        throw new Error("unexpected_rescue_dispatch");
      }),
      audits = vi.fn(async () => []);
    expect(
      await ensureNodeRescue(env, addition.intent.operation_id, {
        getInstance: get,
        rescue,
        actionAudits: audits,
      }),
    ).toBe(false);
    expect(get).not.toHaveBeenCalled();
    expect(rescue).not.toHaveBeenCalled();
  });
  it("enforces administrator scope and canonical request replay without purchase", async () => {
    const f = await configured(),
      body = { region_id: f.region, mode: "order", order: f.selection };
    expect(
      (
        await request(
          "/v1/nodes/additions",
          f.integrator,
          "POST",
          body,
          "admin-only",
        )
      ).status,
    ).toBe(403);
    const first = await request(
      "/v1/nodes/additions",
      f.admin,
      "POST",
      body,
      "node-once",
    );
    expect(first.status).toBe(202);
    const addition = NodeAddition.parse(await first.json());
    workflows.push(addition.intent.operation_id);
    const replay = await request(
      "/v1/nodes/additions",
      f.admin,
      "POST",
      { order: { ...f.selection }, mode: "order", region_id: f.region },
      "node-once",
    );
    expect(NodeAddition.parse(await replay.json()).intent).toEqual(
      addition.intent,
    );
    expect(
      (
        await request(
          `/v1/nodes/additions/${addition.intent.operation_id}`,
          f.integrator,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          `/v1/nodes/additions/${addition.intent.operation_id}`,
          f.admin,
        )
      ).status,
    ).toBe(200);
    expect(
      (await readNodeAddition(env.DB, addition.intent.operation_id))
        .dispatch_request_id,
    ).toBeNull();
    expect(
      (
        await request(
          "/v1/nodes/additions",
          f.admin,
          "POST",
          { ...body, order: { ...f.selection, term_months: 12 } },
          "node-once",
        )
      ).status,
    ).toBe(409);
  });
  it("quarantines every newly observed unknown node and refuses a forged reserved identity", async () => {
    const f = await configured(),
      instance = providerId();
    let addition = await reserveNodeAddition(env.DB, {
      request_key: crypto.randomUUID(),
      request: {
        region_id: f.region,
        mode: "adopt",
        provider_instance_id: instance,
      },
    });
    addition = await recordNodeReceipt(
      env.DB,
      addition.intent.operation_id,
      addition.revision,
      {
        provider_instance_id: instance,
        request_id: null,
        reference: crypto.randomUUID(),
        received_at: new Date().toISOString(),
      },
    );
    addition = await recordNodeAudit(
      env.DB,
      addition.intent.operation_id,
      addition.revision,
      {
        provider_instance_id: instance,
        provider_region: "EU",
        product_id: crypto.randomUUID(),
        image_id: crypto.randomUUID(),
        reference: crypto.randomUUID(),
        observed_at: new Date().toISOString(),
      },
    );
    const observed = {
      name: addition.intent.requested_hostname,
      ready: true,
      allocatable_memory_mib: 4096,
      allocatable_cpu_millicores: 2000,
      storage_gib_total: 30,
      platform_reserved_memory_mib: 128,
      platform_reserved_cpu_millicores: 100,
    };
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
                ...observed,
                node_id: newNodeId(),
                provider_instance_id: instance,
                node_uid: crypto.randomUUID(),
              },
            ],
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT ready,schedulable,provider_instance_id FROM nodes WHERE id=?",
      )
        .bind(addition.intent.node_id)
        .first(),
    ).toEqual({ ready: 0, schedulable: 0, provider_instance_id: null });
    const uid = crypto.randomUUID();
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
                ...observed,
                node_id: addition.intent.node_id,
                provider_instance_id: instance,
                node_uid: uid,
              },
            ],
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT ready,schedulable,provider_instance_id,node_uid FROM nodes WHERE id=?",
      )
        .bind(addition.intent.node_id)
        .first(),
    ).toEqual({
      ready: 1,
      schedulable: 0,
      provider_instance_id: instance,
      node_uid: uid,
    });
    const unknown = "node-" + crypto.randomUUID();
    await request(
      "/agent/v1/observations",
      f.agent,
      "POST",
      observedBody([], [{ ...observed, name: unknown }]),
    );
    expect(
      await env.DB.prepare(
        "SELECT schedulable FROM nodes WHERE region_id=? AND k8s_node_name=?",
      )
        .bind(f.region, unknown)
        .first("schedulable"),
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT schedulable FROM nodes WHERE id=?")
        .bind(f.node)
        .first("schedulable"),
    ).toBe(1);
  });
  it("keeps a lost dispatch unknown across restart without a second provider POST or speculative release", async () => {
    const f = await configured();
    await configureNodeRegionPolicy(env.DB, {
      region_id: f.region,
      max_nodes: 2,
      purchases_enabled: true,
      order: f.selection,
    });
    let addition = await reserveNodeAddition(env.DB, {
      request_key: crypto.randomUUID(),
      request: { region_id: f.region, mode: "order", order: f.selection },
    });
    addition = await approveNodePurchase(
      env.DB,
      addition.intent.operation_id,
      addition.revision,
      {
        intent_hash: addition.intent_hash,
        owner_reference: crypto.randomUUID(),
        approved_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        monthly_amount: "1.0000",
        setup_amount: "0.0000",
        currency: "EUR",
        term_months: 1,
        location: f.selection.location,
      },
    );
    const post = vi.fn(async () => {
      throw new Error(crypto.randomUUID());
    });
    const settings = {
      ...env,
      CONTABO_ORDER_DEFAULT_USER: "root",
      CONTABO_ORDER_SSH_KEY_IDS: JSON.stringify([providerId()]),
    };
    await dispatchNodeOrder(settings, addition.intent.operation_id, {
      order: post,
    });
    const dispatched = await readNodeAddition(
      env.DB,
      addition.intent.operation_id,
    );
    expect(dispatched.status).toBe("unknown");
    expect(dispatched.slot_held).toBe(true);
    expect(dispatched.dispatch_request_id).not.toBeNull();
    await dispatchNodeOrder(settings, addition.intent.operation_id, {
      order: post,
    });
    await reconcileNodeProvider(settings, addition.intent.operation_id, {
      getInstance: vi.fn(),
      instanceAudits: vi.fn(async () => []),
    });
    const resumed = await readNodeAddition(
      env.DB,
      addition.intent.operation_id,
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(resumed.status).toBe("unknown");
    expect(resumed.dispatch_request_id).toBe(dispatched.dispatch_request_id);
    expect(resumed.slot_held).toBe(true);
  });
  it("makes an autoscale dry run from real headroom without creating a reservation", async () => {
    const f = await configured();
    await env.DB.prepare(
      "UPDATE nodes SET allocatable_memory_mib=128 WHERE id=?",
    )
      .bind(f.node)
      .run();
    await env.DB.prepare(
      "UPDATE node_region_policies SET autoscale_enabled=1,adopt_instance_ids=? WHERE region_id=?",
    )
      .bind(JSON.stringify([providerId()]), f.region)
      .run();
    expect((await runNodeCapacity(env, f.region, true)).action).toBe("adopt");
    expect(
      await env.DB.prepare(
        "SELECT count(*) count FROM node_additions WHERE region_id=?",
      )
        .bind(f.region)
        .first("count"),
    ).toBe(0);
  });
});
