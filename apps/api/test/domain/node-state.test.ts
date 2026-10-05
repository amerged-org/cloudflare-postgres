// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { newNodeId } from "@pgcf/contracts";
import type {
  NodeAddition,
  NodeOrderConfiguration,
} from "@pgcf/contracts/nodes";
import { afterEach, expect, it } from "vitest";
import {
  configureNodeRegionPolicy,
  reserveNodeAddition,
  approveNodePurchase,
  claimNodeDispatch,
  readNodeAddition,
  markNodeDispatchUnknown,
  recordNodeReceipt,
  recordNodeAudit,
  saveNodeBootstrapCheckpoint,
  verifyNodeNetwork,
  verifyNodeCapacity,
  completeNodeAddition,
  cancelUnattemptedNodeAddition,
  markNodeAdditionFailed,
  nodeRegionOccupiedSlots,
} from "../../src/domain/node-state.ts";
import { cleanupFixtures, fixture } from "./fixtures.ts";

const regions: string[] = [],
  observed: string[] = [];
afterEach(async () => {
  for (const id of observed.splice(0))
    await env.DB.prepare("DELETE FROM nodes WHERE id=?").bind(id).run();
  for (const region of regions.splice(0))
    await env.DB.batch([
      env.DB.prepare("DELETE FROM node_additions WHERE region_id=?").bind(
        region,
      ),
      env.DB.prepare("DELETE FROM node_region_policies WHERE region_id=?").bind(
        region,
      ),
    ]);
  await cleanupFixtures();
});
const providerId = () =>
  String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!);
const reference = () => `fixture-${crypto.randomUUID()}`;
async function setup(enabled = false) {
  const f = await fixture();
  regions.push(f.region, f.foreign);
  const order: NodeOrderConfiguration = {
    product_id: reference(),
    provider_region: "test",
    image_id: crypto.randomUUID(),
    term_months: 1,
    location: "fixture location",
  };
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 2,
    purchases_enabled: enabled,
    order,
  });
  const reserve = (request_key = crypto.randomUUID()) =>
    reserveNodeAddition(env.DB, {
      request_key,
      request: { region_id: f.region, mode: "order", order },
    });
  return { ...f, order, reserve };
}
async function approve(addition: NodeAddition) {
  if (addition.intent.request.mode !== "order")
    throw new Error("fixture order required");
  return approveNodePurchase(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    {
      intent_hash: addition.intent_hash,
      owner_reference: reference(),
      approved_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      monthly_amount: "1.0000",
      setup_amount: "0.0000",
      currency: "EUR",
      term_months: addition.intent.request.order.term_months,
      location: addition.intent.request.order.location,
    },
  );
}
async function audited(f: Awaited<ReturnType<typeof setup>>) {
  const instance = providerId();
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
      reference: reference(),
      received_at: new Date().toISOString(),
    },
  );
  addition = await recordNodeAudit(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    {
      provider_instance_id: instance,
      provider_region: "test",
      product_id: reference(),
      image_id: crypto.randomUUID(),
      reference: reference(),
      observed_at: new Date().toISOString(),
    },
  );
  return addition;
}
async function joined(addition: NodeAddition) {
  return saveNodeBootstrapCheckpoint(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    {
      stage: "joined",
      reference: reference(),
      saved_at: new Date().toISOString(),
    },
  );
}
const proofScope = (addition: NodeAddition) => ({
  node_id: addition.intent.node_id,
  operation_id: addition.intent.operation_id,
  intent_hash: addition.intent_hash,
  checkpoint_reference: addition.checkpoint!.reference,
  proof_reference: reference(),
});
async function observe(addition: NodeAddition, wrongId = false) {
  const id = wrongId ? newNodeId() : addition.intent.node_id,
    now = new Date().toISOString();
  observed.push(id);
  await env.DB.prepare(
    `INSERT INTO nodes(id,region_id,k8s_node_name,provider_instance_id,ready,schedulable,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at)
    VALUES(?,?,?,?,1,0,8192,4000,80,128,500,?,?,?)`,
  )
    .bind(
      id,
      addition.intent.request.region_id,
      addition.intent.requested_hostname,
      addition.provider_instance_id,
      now,
      now,
      now,
    )
    .run();
  return {
    ...proofScope(addition),
    observed_at: now,
    allocatable_memory_mib: 8192,
    allocatable_cpu_millicores: 4000,
    storage_gib_total: 80,
    platform_reserved_memory_mib: 128,
    platform_reserved_cpu_millicores: 500,
  };
}

it("atomically caps actual legacy nodes plus separate outstanding reservations", async () => {
  const f = await setup();
  await env.DB.prepare("UPDATE nodes SET ready=0,schedulable=0 WHERE id=?")
    .bind(f.node)
    .run();
  const results = await Promise.allSettled([f.reserve(), f.reserve()]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(await nodeRegionOccupiedSlots(env.DB, f.region)).toBe(2);
  expect(
    (
      await env.DB.prepare("SELECT count(*) n FROM nodes WHERE region_id=?")
        .bind(f.region)
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
});
it("concurrent exact request replay preserves generated intent, hostname and one slot", async () => {
  const f = await setup(),
    key = crypto.randomUUID();
  const [first, second] = await Promise.all([f.reserve(key), f.reserve(key)]);
  expect(second).toEqual(first);
  expect(first.intent.requested_hostname).toBe(
    `pgcf-node-${first.intent.node_id.slice(4)}`,
  );
  expect(await nodeRegionOccupiedSlots(env.DB, f.region)).toBe(2);
  await expect(
    reserveNodeAddition(env.DB, {
      request_key: key,
      request: {
        region_id: f.region,
        mode: "adopt",
        provider_instance_id: providerId(),
      },
    }),
  ).rejects.toThrow("another intent");
  await expect(
    env.DB.prepare(
      "UPDATE node_additions SET request_hash=? WHERE operation_id=?",
    )
      .bind("f".repeat(64), first.intent.operation_id)
      .run(),
  ).rejects.toThrow("immutable");
});
it("requires explicit enabled purchases and bound cost approval before one saved dispatch claim", async () => {
  const f = await setup(),
    reserved = await f.reserve();
  await expect(
    claimNodeDispatch(env.DB, reserved.intent.operation_id, reserved.revision),
  ).rejects.toThrow("approval");
  let addition = await approve(reserved);
  await expect(
    claimNodeDispatch(env.DB, addition.intent.operation_id, addition.revision),
  ).rejects.toThrow("disabled");
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 2,
    purchases_enabled: true,
    order: f.order,
  });
  const claims = await Promise.all([
    claimNodeDispatch(env.DB, addition.intent.operation_id, addition.revision),
    claimNodeDispatch(env.DB, addition.intent.operation_id, addition.revision),
  ]);
  expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
  addition = await readNodeAddition(env.DB, addition.intent.operation_id);
  expect(addition.dispatch_request_id).not.toBeNull();
  expect(addition.status).toBe("dispatching");
  expect(claims.map((claim) => claim.addition.dispatch_request_id)).toEqual([
    addition.dispatch_request_id,
    addition.dispatch_request_id,
  ]);
});
it("refuses dispatch after a configured cap is lowered without freeing its held slot", async () => {
  const f = await setup(true),
    addition = await approve(await f.reserve());
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 1,
    purchases_enabled: true,
    order: f.order,
  });
  await expect(
    claimNodeDispatch(env.DB, addition.intent.operation_id, addition.revision),
  ).rejects.toThrow();
  expect(
    (await readNodeAddition(env.DB, addition.intent.operation_id))
      .dispatch_request_id,
  ).toBeNull();
  expect(await nodeRegionOccupiedSlots(env.DB, f.region)).toBe(2);
});
it("retains a slot and can never claim another POST after an unknown result or restart", async () => {
  const f = await setup(true),
    approved = await approve(await f.reserve());
  const dispatch = await claimNodeDispatch(
    env.DB,
    approved.intent.operation_id,
    approved.revision,
  );
  expect(dispatch.claimed).toBe(true);
  const unknown = await markNodeDispatchUnknown(
    env.DB,
    approved.intent.operation_id,
    dispatch.addition.revision,
  );
  const restored = await readNodeAddition(env.DB, unknown.intent.operation_id);
  expect(
    (
      await claimNodeDispatch(
        env.DB,
        restored.intent.operation_id,
        restored.revision,
      )
    ).claimed,
  ).toBe(false);
  expect(restored.dispatch_request_id).toBe(
    dispatch.addition.dispatch_request_id,
  );
  await expect(
    cancelUnattemptedNodeAddition(
      env.DB,
      restored.intent.operation_id,
      restored.revision,
    ),
  ).rejects.toThrow("attempted");
  const failed = await markNodeAdditionFailed(
    env.DB,
    restored.intent.operation_id,
    restored.revision,
    "provider_unknown",
  );
  expect(await nodeRegionOccupiedSlots(env.DB, f.region)).toBe(2);
  await expect(f.reserve()).rejects.toThrow("slot");
  await expect(
    cancelUnattemptedNodeAddition(
      env.DB,
      failed.intent.operation_id,
      failed.revision,
    ),
  ).rejects.toThrow("attempted");
});
it("lost dispatch response retains the saved claim and unknown slots rather than retrying", async () => {
  const f = await setup(true),
    addition = await approve(await f.reserve());
  await claimNodeDispatch(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
  );
  const restarted = await readNodeAddition(
    env.DB,
    addition.intent.operation_id,
  );
  expect(
    (
      await claimNodeDispatch(
        env.DB,
        restarted.intent.operation_id,
        restarted.revision,
      )
    ).claimed,
  ).toBe(false);
  expect(await nodeRegionOccupiedSlots(env.DB, f.region)).toBe(2);
});
it("only explicit cancellation of a known unattempted intent can release a reservation", async () => {
  const f = await setup(),
    addition = await f.reserve();
  const failed = await markNodeAdditionFailed(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    "bootstrap_failed",
  );
  expect(await nodeRegionOccupiedSlots(env.DB, f.region)).toBe(2);
  const cancelled = await cancelUnattemptedNodeAddition(
    env.DB,
    failed.intent.operation_id,
    failed.revision,
  );
  expect(cancelled.slot_held).toBe(false);
  expect(await nodeRegionOccupiedSlots(env.DB, f.region)).toBe(1);
  expect((await f.reserve()).status).toBe("reserved");
});
it("binds provider receipts/audits to the exact saved request and refuses stale revisions", async () => {
  const f = await setup(true),
    approved = await approve(await f.reserve()),
    dispatch = await claimNodeDispatch(
      env.DB,
      approved.intent.operation_id,
      approved.revision,
    ),
    instance = providerId();
  const receipt = {
    provider_instance_id: instance,
    request_id: crypto.randomUUID(),
    reference: reference(),
    received_at: new Date().toISOString(),
  };
  await expect(
    recordNodeReceipt(
      env.DB,
      approved.intent.operation_id,
      dispatch.addition.revision,
      receipt,
    ),
  ).rejects.toThrow("original dispatch");
  const bound = await recordNodeReceipt(
    env.DB,
    approved.intent.operation_id,
    dispatch.addition.revision,
    { ...receipt, request_id: dispatch.addition.dispatch_request_id },
  );
  const audit = {
    provider_instance_id: instance,
    provider_region: f.order.provider_region,
    product_id: f.order.product_id,
    image_id: f.order.image_id,
    reference: reference(),
    observed_at: new Date().toISOString(),
  };
  await expect(
    recordNodeAudit(
      env.DB,
      bound.intent.operation_id,
      bound.revision - 1,
      audit,
    ),
  ).rejects.toThrow("revision");
  await expect(
    recordNodeAudit(env.DB, bound.intent.operation_id, bound.revision, {
      ...audit,
      product_id: reference(),
    }),
  ).rejects.toThrow("selection");
  expect(
    (
      await recordNodeAudit(
        env.DB,
        bound.intent.operation_id,
        bound.revision,
        audit,
      )
    ).status,
  ).toBe("audited");
});

it("refuses a receipt for an instance already claimed by another pending adoption", async () => {
  const f = await setup(true);
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 3,
    purchases_enabled: true,
    order: f.order,
  });
  const approved = await approve(await f.reserve());
  const dispatch = await claimNodeDispatch(
    env.DB,
    approved.intent.operation_id,
    approved.revision,
  );
  if (!dispatch.claimed) throw new Error("expected_owned_dispatch");
  const instance = providerId();
  const adoption = await reserveNodeAddition(env.DB, {
    request_key: crypto.randomUUID(),
    request: {
      mode: "adopt",
      region_id: f.region,
      provider_instance_id: instance,
    },
  });
  await expect(
    recordNodeReceipt(
      env.DB,
      approved.intent.operation_id,
      dispatch.addition.revision,
      {
        provider_instance_id: instance,
        request_id: dispatch.request_id,
        reference: reference(),
        received_at: new Date().toISOString(),
      },
    ),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(
    (await readNodeAddition(env.DB, approved.intent.operation_id))
      .provider_instance_id,
  ).toBeNull();
  expect(
    (await readNodeAddition(env.DB, adoption.intent.operation_id))
      .provider_instance_id,
  ).toBeNull();
});
it("counts a bound actual node once, never by hostname alone, and publishes only measured verified capacity", async () => {
  const f = await setup();
  let addition = await joined(await audited(f));
  await expect(
    completeNodeAddition(
      env.DB,
      addition.intent.operation_id,
      addition.revision,
    ),
  ).rejects.toThrow("proofs");
  const wrong = await observe(addition, true);
  expect(await nodeRegionOccupiedSlots(env.DB, f.region)).toBe(3);
  await expect(
    verifyNodeCapacity(
      env.DB,
      addition.intent.operation_id,
      addition.revision,
      wrong,
    ),
  ).rejects.toThrow("actual matching");
  await env.DB.prepare("DELETE FROM nodes WHERE id=?")
    .bind(observed.pop()!)
    .run();
  const capacity = await observe(addition);
  expect(await nodeRegionOccupiedSlots(env.DB, f.region)).toBe(2);
  addition = await verifyNodeCapacity(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    capacity,
  );
  await expect(
    completeNodeAddition(
      env.DB,
      addition.intent.operation_id,
      addition.revision,
    ),
  ).rejects.toThrow("proofs");
  addition = await verifyNodeNetwork(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    { ...proofScope(addition), verified_at: new Date().toISOString() },
  );
  expect(
    await env.DB.prepare("SELECT schedulable FROM nodes WHERE id=?")
      .bind(addition.intent.node_id)
      .first("schedulable"),
  ).toBe(0);
  addition = await completeNodeAddition(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
  );
  expect(addition.status).toBe("ready");
  expect(await nodeRegionOccupiedSlots(env.DB, f.region)).toBe(2);
  expect(
    await env.DB.prepare("SELECT schedulable FROM nodes WHERE id=?")
      .bind(addition.intent.node_id)
      .first("schedulable"),
  ).toBe(1);
});
it("refuses out-of-order bootstrap or proof scope and a changed measurement before release", async () => {
  const f = await setup();
  let addition = await audited(f);
  addition = await saveNodeBootstrapCheckpoint(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    {
      stage: "network_protected",
      reference: reference(),
      saved_at: new Date().toISOString(),
    },
  );
  await expect(
    verifyNodeNetwork(env.DB, addition.intent.operation_id, addition.revision, {
      ...proofScope(addition),
      verified_at: new Date().toISOString(),
    }),
  ).rejects.toThrow("joined");
  await expect(
    saveNodeBootstrapCheckpoint(
      env.DB,
      addition.intent.operation_id,
      addition.revision,
      {
        stage: "rescue",
        reference: reference(),
        saved_at: new Date().toISOString(),
      },
    ),
  ).rejects.toThrow("rewind");
  addition = await joined(addition);
  const capacity = await observe(addition);
  await expect(
    verifyNodeNetwork(env.DB, addition.intent.operation_id, addition.revision, {
      ...proofScope(addition),
      node_id: newNodeId(),
      verified_at: new Date().toISOString(),
    }),
  ).rejects.toThrow("immutable");
  addition = await verifyNodeNetwork(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    { ...proofScope(addition), verified_at: new Date().toISOString() },
  );
  addition = await verifyNodeCapacity(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    capacity,
  );
  await env.DB.prepare("UPDATE nodes SET storage_gib_total=79 WHERE id=?")
    .bind(addition.intent.node_id)
    .run();
  await expect(
    completeNodeAddition(
      env.DB,
      addition.intent.operation_id,
      addition.revision,
    ),
  ).rejects.toThrow("changed");
  expect(
    await env.DB.prepare("SELECT schedulable FROM nodes WHERE id=?")
      .bind(addition.intent.node_id)
      .first("schedulable"),
  ).toBe(0);
});
