// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.ts";
import type { NodeAddition } from "@pgcf/contracts/nodes";
import type { Env } from "../../src/env.ts";
import {
  ContaboClient,
  type ContaboInstance,
} from "../../src/providers/contabo.ts";
import {
  approveNodePurchase,
  claimNodeDispatch,
  configureNodeRegionPolicy,
  nodeRegionOccupiedSlots,
  readNodeAddition,
  recordNodeAudit,
  recordNodeReceipt,
  reserveNodeAddition,
} from "../../src/domain/node-state.ts";
import { cleanupFixtures, fixture } from "./fixtures.ts";
import { ensureNodeInstallationFirewall } from "../../src/domain/node-firewall-allocation.ts";

const adoptedOperations: string[] = [],
  adoptedRegions: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const operation of adoptedOperations.splice(0)) {
    await env.DB.prepare(
      "DELETE FROM node_installation_bindings WHERE operation_id=?",
    )
      .bind(operation)
      .run();
    await env.DB.prepare(
      "DELETE FROM node_firewall_allocations WHERE operation_id=?",
    )
      .bind(operation)
      .run();
  }
  for (const region of adoptedRegions.splice(0))
    await env.DB.prepare(
      "DELETE FROM node_installation_profiles WHERE region_id=?",
    )
      .bind(region)
      .run();
  await cleanupFixtures();
});

async function adoptedFixture() {
  const f = await fixture(),
    id = String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!);
  adoptedRegions.push(f.region);
  await env.DB.prepare(
    "UPDATE regions SET provider_region='US-central' WHERE id=?",
  )
    .bind(f.region)
    .run();
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 2,
    purchases_enabled: false,
    order: null,
  });
  let addition = await reserveNodeAddition(env.DB, {
    request_key: crypto.randomUUID(),
    request: { mode: "adopt", region_id: f.region, provider_instance_id: id },
  });
  adoptedOperations.push(addition.intent.operation_id);
  addition = await recordNodeReceipt(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    {
      provider_instance_id: id,
      request_id: null,
      reference: "fixture adopted receipt",
      received_at: new Date().toISOString(),
    },
  );
  addition = await recordNodeAudit(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    {
      provider_instance_id: id,
      provider_region: "US-central",
      product_id: "V159",
      image_id: crypto.randomUUID(),
      reference: "fixture adopted audit",
      observed_at: new Date().toISOString(),
    },
  );
  const actual: ContaboInstance = {
    id,
    tenantId: "fixture tenant",
    customerId: "fixture customer",
    name: "fixture",
    displayName: "existing purchased server",
    dataCenter: "fixture",
    region: "US-central",
    regionName: "fixture",
    productId: "V159",
    productName: "fixture",
    imageId: addition.audit!.image_id,
    ipConfig: {
      v4: { ip: "192.0.2.10", gateway: "192.0.2.1", netmaskCidr: 24 },
    },
    additionalIps: [],
    ramMb: 8192,
    cpuCores: 4,
    diskMb: 153600,
    macAddress: "02:00:00:00:00:10",
    osType: "linux",
    applicationId: null,
    createdDate: new Date().toISOString(),
    cancelDate: null,
    status: "running",
    addOns: [],
  };
  const requestId = crypto.randomUUID(),
    name = `pgcf-install-${addition.intent.node_id}-${requestId}`,
    now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO node_firewall_allocations(operation_id,node_id,region_id,provider_instance_id,provider_region,product_id,image_id,intent_hash,inventory_revision,tenant_id,customer_id,request_id,name,description,state,failure_code,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'blocked','readback_unavailable',?,?)`,
  )
    .bind(
      addition.intent.operation_id,
      addition.intent.node_id,
      f.region,
      id,
      actual.region,
      actual.productId,
      actual.imageId!,
      addition.intent_hash,
      addition.revision,
      actual.tenantId,
      actual.customerId,
      requestId,
      name,
      `pgcf-node-installation/v1:${addition.intent_hash}:${requestId}`,
      now,
      now,
    )
    .run();
  return { ...f, addition, actual };
}

it("cancels an empty audited adoption while preserving its ambiguous firewall claim and allows a distinct new adoption", async () => {
  const f = await adoptedFixture(),
    operation = f.addition.intent.operation_id;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO region_bootstrap_credentials(region_id,purpose,revision,version,kid,iv,ciphertext,created_at) VALUES(?,'agent_key',1,1,'fixture',?,?,?)",
  )
    .bind(f.region, "a".repeat(16), "b".repeat(22), now)
    .run();
  await env.DB.prepare(
    "INSERT INTO node_installation_profiles(region_id,profile_sha256,kid,iv,ciphertext,created_at) VALUES(?,?,'fixture',?,'fixture',?)",
  )
    .bind(f.region, "a".repeat(64), "a".repeat(16), now)
    .run();
  const profile = await env.DB.prepare(
    "SELECT * FROM node_installation_profiles WHERE region_id=?",
  )
    .bind(f.region)
    .first();
  const custody = await env.DB.prepare(
    "SELECT * FROM region_bootstrap_credentials WHERE region_id=?",
  )
    .bind(f.region)
    .first();
  const readClaim = (id = operation) =>
    env.DB.prepare(
      "SELECT * FROM node_firewall_allocations WHERE operation_id=?",
    )
      .bind(id)
      .first<Record<string, unknown>>();
  const claim = await readClaim();
  vi.spyOn(ContaboClient.prototype, "getInstance").mockResolvedValue(f.actual);
  const result = await cancelRoute(f);
  expect(result.response.status).toBe(200);
  expect(await result.response.json()).toMatchObject({
    status: "cancelled",
    slot_held: false,
    receipt: f.addition.receipt,
    audit: f.addition.audit,
    dispatch_request_id: null,
  });
  expect(await readClaim()).toEqual(claim);
  expect(
    await env.DB.prepare(
      "SELECT * FROM node_installation_profiles WHERE region_id=?",
    )
      .bind(f.region)
      .first(),
  ).toEqual(profile);
  expect(
    await env.DB.prepare(
      "SELECT * FROM region_bootstrap_credentials WHERE region_id=?",
    )
      .bind(f.region)
      .first(),
  ).toEqual(custody);
  expect(result.getWorkflow).toHaveBeenCalledExactlyOnceWith(operation);
  expect(result.terminate).toHaveBeenCalledTimes(1);
  const next = await reserveNodeAddition(env.DB, {
    request_key: crypto.randomUUID(),
    request: {
      mode: "adopt",
      region_id: f.region,
      provider_instance_id: f.actual.id,
    },
  });
  adoptedOperations.push(next.intent.operation_id);
  expect(next.intent.node_id).not.toBe(f.addition.intent.node_id);
  expect(next.intent.operation_id).not.toBe(operation);
  const audited = await recordNodeReceipt(
    env.DB,
    next.intent.operation_id,
    next.revision,
    { ...f.addition.receipt!, received_at: new Date().toISOString() },
  );
  await recordNodeAudit(env.DB, next.intent.operation_id, audited.revision, {
    ...f.addition.audit!,
    observed_at: new Date().toISOString(),
  });
  const relayId = String(BigInt(f.actual.id) + 1n),
    listFirewalls = vi.fn(async () => {
      throw new Error("fixture list unavailable before dispatch");
    }),
    createFirewall = vi.fn();
  await ensureNodeInstallationFirewall(
    {
      ...env,
      BOOTSTRAP_FIREWALL_BINDINGS: "{}",
      BOOTSTRAP_RELAY_PROVIDER_INSTANCE_ID: relayId,
    },
    next.intent.operation_id,
    {
      provider: {
        getInstance: vi.fn(async (id) => ({ ...f.actual, id })),
        listFirewalls,
        createFirewall,
        getFirewall: vi.fn(),
      },
    },
  );
  const fresh = await readClaim(next.intent.operation_id);
  expect(fresh?.request_id).not.toBe(claim?.request_id);
  expect(fresh?.name).not.toBe(claim?.name);
  expect(createFirewall).not.toHaveBeenCalled();
  expect(await nodeRegionOccupiedSlots(env.DB, f.region)).toBe(2);
  expect(await readClaim()).toEqual(claim);
});

it("refuses audited adoption cancellation when an installation binding commits during the provider read", async () => {
  const f = await adoptedFixture();
  vi.spyOn(ContaboClient.prototype, "getInstance").mockImplementation(
    async () => {
      const now = new Date().toISOString();
      await env.DB.prepare(
        "INSERT INTO node_installation_profiles(region_id,profile_sha256,kid,iv,ciphertext,created_at) VALUES(?,?,'fixture',?,'fixture',?)",
      )
        .bind(f.region, "a".repeat(64), "a".repeat(16), now)
        .run();
      await env.DB.prepare(
        "INSERT INTO node_installation_bindings(operation_id,node_id,region_id,provider_instance_id,profile_sha256,binding_sha256,firewall_id,inspection_hash,kid,iv,ciphertext,created_at) VALUES(?,?,?,?,?,?,?,?,'fixture',?,'fixture',?)",
      )
        .bind(
          f.addition.intent.operation_id,
          f.addition.intent.node_id,
          f.region,
          f.actual.id,
          "a".repeat(64),
          "b".repeat(64),
          crypto.randomUUID(),
          "c".repeat(64),
          "a".repeat(16),
          now,
        )
        .run();
      return f.actual;
    },
  );
  const result = await cancelRoute(f);
  expect(result.response.status).toBe(409);
  expect(result.getWorkflow).not.toHaveBeenCalled();
  expect(
    await readNodeAddition(env.DB, f.addition.intent.operation_id),
  ).toEqual(f.addition);
});

it("refuses audited adoption cancellation when its immutable network preparation commits during the provider read", async () => {
  const f = await adoptedFixture();
  vi.spyOn(ContaboClient.prototype, "getInstance").mockImplementation(
    async () => {
      const now = new Date().toISOString();
      await env.DB.prepare(
        "INSERT INTO node_network_preparations(operation_id,intent_hash,plan_sha256,plan_json,created_at,updated_at) VALUES(?,?,?,'{}',?,?)",
      )
        .bind(
          f.addition.intent.operation_id,
          f.addition.intent_hash,
          "a".repeat(64),
          now,
          now,
        )
        .run();
      return f.actual;
    },
  );
  const result = await cancelRoute(f);
  expect(result.response.status).toBe(409);
  expect(result.getWorkflow).not.toHaveBeenCalled();
  expect(
    await readNodeAddition(env.DB, f.addition.intent.operation_id),
  ).toEqual(f.addition);
});

it("refuses audited adoption cancellation when a native job commits during the provider read", async () => {
  const f = await adoptedFixture();
  vi.spyOn(ContaboClient.prototype, "getInstance").mockImplementation(
    async () => {
      const now = new Date().toISOString();
      await env.DB.prepare(
        "INSERT INTO node_bootstrap_jobs(operation_id,node_id,region_id,input_hash,inventory_revision,sealed_revision,input_ciphertext,input_iv,input_kid,callback_hash,checkpoint_json,created_at,updated_at) VALUES(?,?,?,?,?,1,'fixture',?,'fixture',?,'{}',?,?)",
      )
        .bind(
          f.addition.intent.operation_id,
          f.addition.intent.node_id,
          f.region,
          "a".repeat(64),
          f.addition.revision,
          "a".repeat(16),
          "b".repeat(64),
          now,
          now,
        )
        .run();
      return f.actual;
    },
  );
  const result = await cancelRoute(f);
  expect(result.response.status).toBe(409);
  expect(result.getWorkflow).not.toHaveBeenCalled();
  expect(
    await readNodeAddition(env.DB, f.addition.intent.operation_id),
  ).toEqual(f.addition);
});

it("refuses audited adoption cancellation when its server becomes an observed Node during the provider read", async () => {
  const f = await adoptedFixture();
  vi.spyOn(ContaboClient.prototype, "getInstance").mockImplementation(
    async () => {
      await env.DB.prepare("UPDATE nodes SET provider_instance_id=? WHERE id=?")
        .bind(f.actual.id, f.node)
        .run();
      return f.actual;
    },
  );
  const result = await cancelRoute(f);
  expect(result.response.status).toBe(409);
  expect(result.getWorkflow).not.toHaveBeenCalled();
  expect(
    await readNodeAddition(env.DB, f.addition.intent.operation_id),
  ).toEqual(f.addition);
});

it("refuses audited adoption cancellation when firewall dispatch begins during the provider read", async () => {
  const f = await adoptedFixture();
  vi.spyOn(ContaboClient.prototype, "getInstance").mockImplementation(
    async () => {
      await env.DB.prepare(
        "UPDATE node_firewall_allocations SET state='dispatching',failure_code=NULL WHERE operation_id=?",
      )
        .bind(f.addition.intent.operation_id)
        .run();
      return f.actual;
    },
  );
  const result = await cancelRoute(f);
  expect(result.response.status).toBe(409);
  expect(result.getWorkflow).not.toHaveBeenCalled();
  expect(
    await readNodeAddition(env.DB, f.addition.intent.operation_id),
  ).toEqual(f.addition);
});

it("refuses audited adoption cancellation when a provider-host mutation begins during the provider read", async () => {
  const f = await adoptedFixture();
  vi.spyOn(ContaboClient.prototype, "getInstance").mockImplementation(
    async () => {
      const now = new Date().toISOString();
      await env.DB.prepare(
        "INSERT INTO node_provider_mutations(operation_id,mutation,request_id,revision,state,created_at,updated_at) VALUES(?,'rescue',?,?,'dispatching',?,?)",
      )
        .bind(
          f.addition.intent.operation_id,
          crypto.randomUUID(),
          f.addition.revision,
          now,
          now,
        )
        .run();
      return f.actual;
    },
  );
  const result = await cancelRoute(f);
  expect(result.response.status).toBe(409);
  expect(result.getWorkflow).not.toHaveBeenCalled();
  expect(
    await readNodeAddition(env.DB, f.addition.intent.operation_id),
  ).toEqual(f.addition);
});

it("preserves the issued regional agent custody but refuses new seed material during adoption cancellation", async () => {
  const f = await adoptedFixture(),
    now = new Date().toISOString();
  const insert = (purpose: string) =>
    env.DB.prepare(
      "INSERT INTO region_bootstrap_credentials(region_id,purpose,revision,version,kid,iv,ciphertext,created_at) VALUES(?,?,1,1,'fixture',?,?,?)",
    )
      .bind(f.region, purpose, "a".repeat(16), "b".repeat(22), now)
      .run();
  await insert("agent_key");
  vi.spyOn(ContaboClient.prototype, "getInstance").mockImplementation(
    async () => {
      await insert("region_seed");
      return f.actual;
    },
  );
  const result = await cancelRoute(f);
  expect(result.response.status).toBe(409);
  expect(result.getWorkflow).not.toHaveBeenCalled();
  expect(
    await readNodeAddition(env.DB, f.addition.intent.operation_id),
  ).toEqual(f.addition);
  expect(
    (
      await env.DB.prepare(
        "SELECT purpose FROM region_bootstrap_credentials WHERE region_id=?",
      )
        .bind(f.region)
        .all()
    ).results,
  ).toHaveLength(2);
});

async function paidFixture(audited = true) {
  const f = await fixture(),
    order = {
      product_id: "V155",
      provider_region: "EU",
      image_id: crypto.randomUUID(),
      term_months: 1 as const,
      location: "fixture EU",
    };
  await env.DB.prepare("UPDATE regions SET provider_region='EU' WHERE id=?")
    .bind(f.region)
    .run();
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 2,
    purchases_enabled: true,
    order,
  });
  let addition = await reserveNodeAddition(env.DB, {
    request_key: crypto.randomUUID(),
    request: { mode: "order", region_id: f.region, order },
  });
  addition = await approveNodePurchase(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    {
      intent_hash: addition.intent_hash,
      owner_reference: "fixture costed owner",
      approved_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      monthly_amount: "1.0000",
      setup_amount: "0.0000",
      currency: "EUR",
      term_months: 1,
      location: order.location,
    },
  );
  addition = (
    await claimNodeDispatch(
      env.DB,
      addition.intent.operation_id,
      addition.revision,
    )
  ).addition;
  const id = String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!);
  addition = await recordNodeReceipt(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    {
      provider_instance_id: id,
      request_id: addition.dispatch_request_id,
      reference: "fixture original CREATED receipt",
      received_at: new Date().toISOString(),
    },
  );
  if (audited)
    addition = await recordNodeAudit(
      env.DB,
      addition.intent.operation_id,
      addition.revision,
      {
        provider_instance_id: id,
        provider_region: order.provider_region,
        product_id: order.product_id,
        image_id: order.image_id,
        reference: "fixture original CREATED audit",
        observed_at: new Date().toISOString(),
      },
    );
  const actual: ContaboInstance = {
    id,
    tenantId: "fixture owned tenant",
    customerId: "fixture owned customer",
    name: "fixture",
    displayName: addition.intent.requested_hostname,
    dataCenter: "fixture",
    region: "EU",
    regionName: "fixture",
    productId: order.product_id,
    productName: "fixture",
    imageId: order.image_id,
    ipConfig: {
      v4: { ip: "192.0.2.10", gateway: "192.0.2.1", netmaskCidr: 24 },
    },
    additionalIps: [],
    ramMb: 24576,
    cpuCores: 8,
    diskMb: 307200,
    macAddress: "02:00:00:00:00:10",
    osType: "linux",
    applicationId: null,
    sshKeys: [],
    createdDate: new Date().toISOString(),
    cancelDate: new Date(Date.now() + 30 * 86400_000)
      .toISOString()
      .slice(0, 10),
    status: "rescue",
    addOns: [],
  };
  return { ...f, addition, actual };
}

async function cancelRoute(
  f: { admin: string; addition: NodeAddition },
  expected = f.addition.revision,
  key = f.admin,
  terminationFails = false,
) {
  const terminate = vi.fn(async () => {
      if (terminationFails) throw new Error("fixture termination unavailable");
    }),
    getWorkflow = vi.fn(async () => ({ terminate })),
    ctx = createExecutionContext();
  const response = await createApp().fetch(
    new Request(
      `https://api.invalid/v1/nodes/additions/${f.addition.intent.operation_id}/cancel`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expected_revision: expected }),
      },
    ),
    {
      ...env,
      CONTABO_CLIENT_ID: crypto.randomUUID(),
      CONTABO_CLIENT_SECRET: crypto.randomUUID(),
      CONTABO_USERNAME: crypto.randomUUID(),
      CONTABO_PASSWORD: crypto.randomUUID(),
      ADD_NODE: { get: getWorkflow } as unknown as Env["ADD_NODE"],
    },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { response, terminate, getWorkflow };
}

it("records an already cancelled paid provider without deleting it, frees only its empty reservation, and stops the same Workflow", async () => {
  const f = await paidFixture(),
    before = await env.DB.prepare(
      "SELECT * FROM node_additions WHERE operation_id=?",
    )
      .bind(f.addition.intent.operation_id)
      .first();
  const get = vi
    .spyOn(ContaboClient.prototype, "getInstance")
    .mockResolvedValue(f.actual);
  expect(await nodeRegionOccupiedSlots(env.DB, f.region)).toBe(2);
  const result = await cancelRoute(f);
  expect(result.response.status).toBe(200);
  const cancelled = await result.response.json();
  expect(cancelled).toMatchObject({
    status: "cancelled",
    slot_held: false,
    revision: f.addition.revision + 1,
    receipt: f.addition.receipt,
    audit: f.addition.audit,
    approval: f.addition.approval,
    dispatch_request_id: f.addition.dispatch_request_id,
  });
  const after = await env.DB.prepare(
    "SELECT * FROM node_additions WHERE operation_id=?",
  )
    .bind(f.addition.intent.operation_id)
    .first();
  for (const field of [
    "intent_json",
    "receipt_json",
    "audit_json",
    "approval_json",
    "dispatch_request_id",
    "provider_instance_id",
    "request_key",
    "request_hash",
    "intent_hash",
  ])
    expect(after?.[field]).toBe(before?.[field]);
  expect(await nodeRegionOccupiedSlots(env.DB, f.region)).toBe(1);
  expect(get).toHaveBeenCalledExactlyOnceWith(
    f.actual.id,
    expect.objectContaining({ requestId: expect.any(String) }),
  );
  expect(result.getWorkflow).toHaveBeenCalledExactlyOnceWith(
    f.addition.intent.operation_id,
  );
  expect(result.terminate).toHaveBeenCalledTimes(1);
});

it("retains a live provider reservation when its cancellation date is absent or invalid", async () => {
  const f = await paidFixture();
  const get = vi
    .spyOn(ContaboClient.prototype, "getInstance")
    .mockResolvedValueOnce({ ...f.actual, cancelDate: null })
    .mockResolvedValueOnce({ ...f.actual, cancelDate: "" });
  const first = await cancelRoute(f);
  expect(first.response.status).toBe(409);
  expect(first.getWorkflow).not.toHaveBeenCalled();
  const second = await cancelRoute(f);
  expect(second.response.status).toBe(409);
  expect(second.getWorkflow).not.toHaveBeenCalled();
  expect(get).toHaveBeenCalledTimes(2);
  expect(
    await readNodeAddition(env.DB, f.addition.intent.operation_id),
  ).toEqual(f.addition);
});

it("refuses a different provider identity or changed original order selection", async () => {
  const f = await paidFixture();
  vi.spyOn(ContaboClient.prototype, "getInstance").mockResolvedValue({
    ...f.actual,
    imageId: crypto.randomUUID(),
    displayName: "a different requested host",
  });
  const result = await cancelRoute(f);
  expect(result.response.status).toBe(409);
  expect(result.getWorkflow).not.toHaveBeenCalled();
  expect(
    await readNodeAddition(env.DB, f.addition.intent.operation_id),
  ).toEqual(f.addition);
});

it("never releases a slot when the fresh authenticated provider read fails", async () => {
  const f = await paidFixture();
  vi.spyOn(ContaboClient.prototype, "getInstance").mockRejectedValue(
    new Error("fixture provider read unavailable"),
  );
  const result = await cancelRoute(f);
  expect(result.response.status).toBe(500);
  expect(result.getWorkflow).not.toHaveBeenCalled();
  expect(
    await readNodeAddition(env.DB, f.addition.intent.operation_id),
  ).toEqual(f.addition);
});

it("rejects a stale expected revision before any provider read or Workflow action", async () => {
  const f = await paidFixture(),
    get = vi
      .spyOn(ContaboClient.prototype, "getInstance")
      .mockResolvedValue(f.actual);
  const result = await cancelRoute(f, f.addition.revision - 1);
  expect(result.response.status).toBe(409);
  expect(get).not.toHaveBeenCalled();
  expect(result.getWorkflow).not.toHaveBeenCalled();
  expect(
    await readNodeAddition(env.DB, f.addition.intent.operation_id),
  ).toEqual(f.addition);
});

it("does not turn an ambiguous dispatch without its original receipt into a cancelled paid claim", async () => {
  const f = await paidFixture(),
    get = vi
      .spyOn(ContaboClient.prototype, "getInstance")
      .mockResolvedValue(f.actual);
  await env.DB.prepare(
    "UPDATE node_additions SET receipt_json=NULL WHERE operation_id=?",
  )
    .bind(f.addition.intent.operation_id)
    .run();
  const before = await readNodeAddition(env.DB, f.addition.intent.operation_id),
    result = await cancelRoute(f);
  expect(result.response.status).toBe(409);
  expect(get).not.toHaveBeenCalled();
  expect(result.getWorkflow).not.toHaveBeenCalled();
  expect(
    await readNodeAddition(env.DB, f.addition.intent.operation_id),
  ).toEqual(before);
});

it("can record an empty provider-bound paid order before its audit has been saved", async () => {
  const f = await paidFixture(false);
  expect(f.addition.status).toBe("provider_bound");
  expect(f.addition.audit).toBeNull();
  vi.spyOn(ContaboClient.prototype, "getInstance").mockResolvedValue(f.actual);
  const result = await cancelRoute(f);
  expect(result.response.status).toBe(200);
  expect(
    await readNodeAddition(env.DB, f.addition.intent.operation_id),
  ).toMatchObject({
    status: "cancelled",
    slot_held: false,
    receipt: f.addition.receipt,
    audit: null,
    dispatch_request_id: f.addition.dispatch_request_id,
  });
});

it("can close an unknown order only when its original paid receipt is already known", async () => {
  const f = await paidFixture(false);
  await env.DB.prepare(
    "UPDATE node_additions SET status='unknown',failure_code='provider_unknown' WHERE operation_id=?",
  )
    .bind(f.addition.intent.operation_id)
    .run();
  f.addition = await readNodeAddition(env.DB, f.addition.intent.operation_id);
  vi.spyOn(ContaboClient.prototype, "getInstance").mockResolvedValue(f.actual);
  const result = await cancelRoute(f);
  expect(result.response.status).toBe(200);
  expect(
    await readNodeAddition(env.DB, f.addition.intent.operation_id),
  ).toMatchObject({
    status: "cancelled",
    slot_held: false,
    receipt: f.addition.receipt,
    audit: null,
    dispatch_request_id: f.addition.dispatch_request_id,
    failure_code: "provider_unknown",
  });
});

it("the cancellation CAS cannot pass a native job inserted during the provider read", async () => {
  const f = await paidFixture();
  vi.spyOn(ContaboClient.prototype, "getInstance").mockImplementation(
    async () => {
      const now = new Date().toISOString();
      await env.DB.prepare(
        "INSERT INTO node_bootstrap_jobs(operation_id,node_id,region_id,input_hash,inventory_revision,sealed_revision,input_ciphertext,input_iv,input_kid,callback_hash,checkpoint_json,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?,?,?,'{}',?,?)",
      )
        .bind(
          f.addition.intent.operation_id,
          f.addition.intent.node_id,
          f.region,
          "a".repeat(64),
          f.addition.revision,
          "fixture sealed job",
          "a".repeat(16),
          "fixture",
          "b".repeat(64),
          now,
          now,
        )
        .run();
      return f.actual;
    },
  );
  const result = await cancelRoute(f);
  expect(result.response.status).toBe(409);
  expect(result.getWorkflow).not.toHaveBeenCalled();
  expect(
    await readNodeAddition(env.DB, f.addition.intent.operation_id),
  ).toEqual(f.addition);
});

it("the cancellation CAS protects an installed Node with the same provider ID even under another Node ID", async () => {
  const f = await paidFixture();
  vi.spyOn(ContaboClient.prototype, "getInstance").mockImplementation(
    async () => {
      await env.DB.prepare("UPDATE nodes SET provider_instance_id=? WHERE id=?")
        .bind(f.actual.id, f.node)
        .run();
      return f.actual;
    },
  );
  const result = await cancelRoute(f);
  expect(result.response.status).toBe(409);
  expect(result.getWorkflow).not.toHaveBeenCalled();
  expect(
    await readNodeAddition(env.DB, f.addition.intent.operation_id),
  ).toEqual(f.addition);
});

it("the cancellation CAS retains a paid claim whose audit evidence changed during the provider read", async () => {
  const f = await paidFixture();
  vi.spyOn(ContaboClient.prototype, "getInstance").mockImplementation(
    async () => {
      await env.DB.prepare(
        "UPDATE node_additions SET audit_json=json_set(audit_json,'$.reference',?) WHERE operation_id=?",
      )
        .bind(
          "fixture audit concurrently changed",
          f.addition.intent.operation_id,
        )
        .run();
      return f.actual;
    },
  );
  const result = await cancelRoute(f);
  expect(result.response.status).toBe(409);
  expect(result.getWorkflow).not.toHaveBeenCalled();
  const saved = await readNodeAddition(env.DB, f.addition.intent.operation_id);
  expect(saved.status).toBe("audited");
  expect(saved.slot_held).toBe(true);
  expect(saved.revision).toBe(f.addition.revision);
});

it("keeps a committed logical cancellation when same-Workflow termination fails", async () => {
  const f = await paidFixture();
  vi.spyOn(ContaboClient.prototype, "getInstance").mockResolvedValue(f.actual);
  const result = await cancelRoute(f, f.addition.revision, f.admin, true);
  expect(result.response.status).toBe(200);
  expect(result.terminate).toHaveBeenCalledTimes(1);
  expect(
    await readNodeAddition(env.DB, f.addition.intent.operation_id),
  ).toMatchObject({ status: "cancelled", slot_held: false });
});

it("replays a known cancellation without another provider read or revision increment", async () => {
  const f = await paidFixture(),
    get = vi
      .spyOn(ContaboClient.prototype, "getInstance")
      .mockResolvedValue(f.actual);
  expect((await cancelRoute(f)).response.status).toBe(200);
  const committed = await readNodeAddition(
    env.DB,
    f.addition.intent.operation_id,
  );
  expect((await cancelRoute(f)).response.status).toBe(200);
  expect(get).toHaveBeenCalledTimes(1);
  expect(
    await readNodeAddition(env.DB, f.addition.intent.operation_id),
  ).toEqual(committed);
});

it("denies integrators before reading provider state or freeing an administrator reservation", async () => {
  const f = await paidFixture(),
    get = vi
      .spyOn(ContaboClient.prototype, "getInstance")
      .mockResolvedValue(f.actual);
  const result = await cancelRoute(f, f.addition.revision, f.integrator);
  expect(result.response.status).toBe(403);
  expect(get).not.toHaveBeenCalled();
  expect(result.getWorkflow).not.toHaveBeenCalled();
  expect(
    await readNodeAddition(env.DB, f.addition.intent.operation_id),
  ).toEqual(f.addition);
});

it("preserves legacy unattempted cancellation without requiring provider credentials or a provider read", async () => {
  const f = await fixture(),
    order = {
      product_id: "V155",
      provider_region: "EU",
      image_id: crypto.randomUUID(),
      term_months: 1 as const,
      location: "fixture",
    };
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 2,
    purchases_enabled: false,
    order,
  });
  const addition = await reserveNodeAddition(env.DB, {
      request_key: crypto.randomUUID(),
      request: { mode: "order", region_id: f.region, order },
    }),
    get = vi.spyOn(ContaboClient.prototype, "getInstance");
  const result = await cancelRoute({ ...f, addition });
  expect(result.response.status).toBe(200);
  expect(get).not.toHaveBeenCalled();
  expect(
    await readNodeAddition(env.DB, addition.intent.operation_id),
  ).toMatchObject({
    status: "cancelled",
    slot_held: false,
    receipt: null,
    dispatch_request_id: null,
    provider_instance_id: null,
  });
});

it("does not release an adopted provider through the paid-order cancellation path", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE regions SET provider_region='EU' WHERE id=?")
    .bind(f.region)
    .run();
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 2,
    purchases_enabled: false,
    order: null,
  });
  const providerId = String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!);
  let addition = await reserveNodeAddition(env.DB, {
    request_key: crypto.randomUUID(),
    request: {
      mode: "adopt",
      region_id: f.region,
      provider_instance_id: providerId,
    },
  });
  addition = await recordNodeReceipt(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    {
      provider_instance_id: providerId,
      request_id: null,
      reference: "fixture adopted provider",
      received_at: new Date().toISOString(),
    },
  );
  const get = vi.spyOn(ContaboClient.prototype, "getInstance");
  const result = await cancelRoute({ ...f, addition });
  expect(result.response.status).toBe(409);
  expect(get).not.toHaveBeenCalled();
  expect(result.getWorkflow).not.toHaveBeenCalled();
  expect(await readNodeAddition(env.DB, addition.intent.operation_id)).toEqual(
    addition,
  );
});

it("the cancellation CAS protects a Node already registered under the exact target Node ID", async () => {
  const f = await paidFixture();
  vi.spyOn(ContaboClient.prototype, "getInstance").mockImplementation(
    async () => {
      const now = new Date().toISOString();
      await env.DB.prepare(
        "INSERT INTO nodes(id,region_id,k8s_node_name,ready,allocatable_memory_mib,allocatable_cpu_millicores,created_at,updated_at) VALUES(?,?,?,0,0,0,?,?)",
      )
        .bind(
          f.addition.intent.node_id,
          f.region,
          f.addition.intent.requested_hostname,
          now,
          now,
        )
        .run();
      return f.actual;
    },
  );
  const result = await cancelRoute(f);
  expect(result.response.status).toBe(409);
  expect(result.getWorkflow).not.toHaveBeenCalled();
  expect(
    await readNodeAddition(env.DB, f.addition.intent.operation_id),
  ).toEqual(f.addition);
});
