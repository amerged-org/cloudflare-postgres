// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.ts";
import type {
  ContaboInstance,
  ContaboFirewall,
  ContaboFirewallCreateInput,
  ContaboMutationResult,
  ContaboRequest,
} from "../../src/providers/contabo.ts";
import {
  configureNodeRegionPolicy,
  reserveNodeAddition,
  recordNodeReceipt,
  recordNodeAudit,
} from "../../src/domain/node-state.ts";
import { ensureNodeInstallationFirewall } from "../../src/domain/node-firewall-allocation.ts";
import { fixture, cleanupFixtures } from "./fixtures.ts";

const operations: string[] = [];
const value = () => crypto.randomUUID();
const id = () => String(crypto.getRandomValues(new Uint32Array(1))[0]! + 1);
afterEach(async () => {
  vi.restoreAllMocks();
  for (const operation of operations.splice(0))
    await env.DB.prepare(
      "DELETE FROM node_firewall_allocations WHERE operation_id=?",
    )
      .bind(operation)
      .run();
  await cleanupFixtures();
});
async function setup() {
  const state = await fixture(),
    instanceId = id(),
    relayId = id(),
    now = new Date().toISOString();
  await env.DB.prepare("UPDATE regions SET provider_region='EU' WHERE id=?")
    .bind(state.region)
    .run();
  await configureNodeRegionPolicy(env.DB, {
    region_id: state.region,
    max_nodes: 4,
    purchases_enabled: false,
    order: null,
  });
  let addition = await reserveNodeAddition(env.DB, {
    request_key: value(),
    request: {
      mode: "adopt",
      region_id: state.region,
      provider_instance_id: instanceId,
    },
  });
  const operationId = addition.intent.operation_id;
  operations.push(operationId);
  addition = await recordNodeReceipt(env.DB, operationId, addition.revision, {
    provider_instance_id: instanceId,
    request_id: null,
    reference: value(),
    received_at: now,
  });
  addition = await recordNodeAudit(env.DB, operationId, addition.revision, {
    provider_instance_id: instanceId,
    provider_region: "EU",
    product_id: "fixture",
    image_id: value(),
    reference: value(),
    observed_at: now,
  });
  const actual: ContaboInstance = {
    id: instanceId,
    tenantId: value(),
    customerId: value(),
    name: value(),
    displayName: addition.intent.requested_hostname,
    dataCenter: "fixture",
    region: "EU",
    regionName: "fixture",
    productId: "fixture",
    productName: "fixture",
    imageId: addition.audit!.image_id,
    ipConfig: {
      v4: { ip: "198.51.100.1", gateway: "198.51.100.254", netmaskCidr: 24 },
    },
    additionalIps: [],
    ramMb: 8192,
    cpuCores: 4,
    diskMb: 153600,
    macAddress: "02:00:00:00:00:01",
    osType: "Linux",
    applicationId: null,
    createdDate: now,
    cancelDate: null,
    status: "running",
    addOns: [],
  };
  const relay = { ...actual, id: relayId },
    firewalls: ContaboFirewall[] = [];
  const provider = {
    getInstance: vi.fn(async (target: string) =>
      structuredClone(target === relayId ? relay : actual),
    ),
    getFirewall: vi.fn(async (target: string) =>
      structuredClone(firewalls.find((row) => row.firewallId === target)!),
    ),
    listFirewalls: vi.fn(async ({ name }: { name?: string }) =>
      structuredClone(firewalls.filter((row) => row.name === name)),
    ),
    createFirewall: vi.fn(
      async (
        input: ContaboFirewallCreateInput,
        request: ContaboRequest,
      ): Promise<ContaboMutationResult<ContaboFirewall>> => {
        const created: ContaboFirewall = {
          tenantId: actual.tenantId,
          customerId: actual.customerId,
          firewallId: value(),
          name: input.name,
          description: input.description ?? "",
          status: input.status,
          instances: [],
          instanceStatus: [],
          rules: { inbound: [] },
          createdDate: now,
          updatedDate: now,
        };
        firewalls.push(created);
        return {
          kind: "accepted",
          code: "accepted",
          requestId: request.requestId,
          status: 201,
          dispatched: true,
          value: structuredClone(created),
        };
      },
    ),
  };
  const config = {
    ...env,
    BOOTSTRAP_FIREWALL_BINDINGS: "{}",
    BOOTSTRAP_RELAY_PROVIDER_INSTANCE_ID: relayId,
  } as Env;
  const ensure = () =>
    ensureNodeInstallationFirewall(config, operationId, { provider });
  const claim = () =>
    env.DB.prepare(
      "SELECT * FROM node_firewall_allocations WHERE operation_id=?",
    )
      .bind(operationId)
      .first<Record<string, unknown>>();
  return {
    addition,
    operationId,
    actual,
    relay,
    firewalls,
    provider,
    config,
    ensure,
    claim,
  };
}
it("persists a permanent original claim and creates once across concurrent installation calls", async () => {
  const f = await setup();
  await Promise.all([f.ensure(), f.ensure()]);
  expect(await f.ensure()).toBe(f.firewalls[0]!.firewallId);
  expect(f.provider.createFirewall).toHaveBeenCalledTimes(1);
  const claim = (await f.claim())!;
  expect(claim).toMatchObject({
    state: "confirmed",
    firewall_id: f.firewalls[0]!.firewallId,
    provider_instance_id: f.actual.id,
  });
  const [input, request] = f.provider.createFirewall.mock.calls[0]!;
  expect(request.requestId).toBe(claim.request_id);
  expect(input).toEqual({
    name: claim.name,
    description: claim.description,
    status: "active",
    rules: { inbound: [] },
  });
  await expect(
    env.DB.prepare(
      "UPDATE node_firewall_allocations SET request_id=? WHERE operation_id=?",
    )
      .bind(value(), f.operationId)
      .run(),
  ).rejects.toThrow();
});
it("retains the original creation result when a concurrent read confirms it before the response arrives", async () => {
  const f = await setup(),
    create = f.provider.createFirewall.getMockImplementation()!;
  let created!: () => void, release!: () => void;
  const createdBarrier = new Promise<void>((resolve) => {
    created = resolve;
  });
  const responseBarrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.provider.createFirewall.mockImplementation(async (input, request) => {
    const result = await create(input, request);
    created();
    await responseBarrier;
    return result;
  });
  const first = f.ensure();
  await createdBarrier;
  expect(await f.ensure()).toBe(f.firewalls[0]!.firewallId);
  expect((await f.claim())!.state).toBe("confirmed");
  release();
  await first;
  const claim = (await f.claim())!;
  expect(JSON.parse(String(claim.result_json))).toMatchObject({
    kind: "accepted",
    requestId: claim.request_id,
    firewallId: claim.firewall_id,
  });
  expect(claim.state).toBe("confirmed");
  expect(f.provider.createFirewall).toHaveBeenCalledTimes(1);
});
it("resolves a lost response using exact controlled name and owned readback without another POST", async () => {
  const f = await setup(),
    create = f.provider.createFirewall.getMockImplementation()!;
  let visible = false;
  f.provider.listFirewalls.mockImplementation(async ({ name }) =>
    visible
      ? structuredClone(f.firewalls.filter((row) => row.name === name))
      : [],
  );
  f.provider.createFirewall.mockImplementation(async (input, request) => {
    await create(input, request);
    return {
      kind: "unknown",
      code: "network_error",
      requestId: request.requestId,
      dispatched: true,
    };
  });
  expect(await f.ensure()).toBeNull();
  const original = (await f.claim())!;
  expect(original.state).toBe("unknown");
  expect(await f.ensure()).toBeNull();
  visible = true;
  expect(await f.ensure()).toBe(f.firewalls[0]!.firewallId);
  expect(f.provider.createFirewall).toHaveBeenCalledTimes(1);
  expect((await f.claim())!.request_id).toBe(original.request_id);
  expect(JSON.parse(String((await f.claim())!.result_json))).toMatchObject({
    kind: "unknown",
    requestId: original.request_id,
  });
});
it("blocks duplicate or foreign controlled-name readback instead of choosing or creating another firewall", async () => {
  const f = await setup(),
    create = f.provider.createFirewall.getMockImplementation()!;
  f.provider.createFirewall.mockImplementation(async (input, request) => {
    const result = await create(input, request);
    f.firewalls.push({ ...f.firewalls[0]!, firewallId: value() });
    return result;
  });
  expect(await f.ensure()).toBeNull();
  expect((await f.claim())!.state).toBe("blocked");
  expect(await f.ensure()).toBeNull();
  expect(f.provider.createFirewall).toHaveBeenCalledTimes(1);
  const foreign = await setup(),
    foreignCreate = foreign.provider.createFirewall.getMockImplementation()!;
  foreign.provider.createFirewall.mockImplementation(async (input, request) => {
    const result = await foreignCreate(input, request);
    foreign.firewalls[0]!.customerId = value();
    return result;
  });
  expect(await foreign.ensure()).toBeNull();
  expect((await foreign.claim())!.state).toBe("blocked");
});
it("uses a verified configured firewall first, refuses foreign attachments and never buys entitlement", async () => {
  const f = await setup();
  const created = await f.provider.createFirewall(
    {
      name: value(),
      description: "configured",
      status: "active",
      rules: { inbound: [] },
    },
    { requestId: value() },
  );
  if (created.kind !== "accepted") throw Error("fixture");
  f.provider.createFirewall.mockClear();
  f.config.BOOTSTRAP_FIREWALL_BINDINGS = JSON.stringify({
    [f.actual.id]: created.value.firewallId,
  });
  expect(await f.ensure()).toBe(created.value.firewallId);
  expect(await f.claim()).toBeNull();
  expect(f.provider.listFirewalls).not.toHaveBeenCalled();
  expect(f.provider.createFirewall).not.toHaveBeenCalled();
  f.firewalls[0]!.instanceStatus = [{ instanceId: id(), status: "ok" }];
  await expect(f.ensure()).rejects.toMatchObject({ code: "conflict" });
  const noEntitlement = await setup();
  noEntitlement.provider.createFirewall.mockImplementation(
    async (_input, request) => ({
      kind: "rejected",
      code: "provider_rejected",
      requestId: request.requestId,
      status: 402,
      dispatched: true,
    }),
  );
  expect(await noEntitlement.ensure()).toBeNull();
  expect(await noEntitlement.ensure()).toBeNull();
  expect((await noEntitlement.claim())!).toMatchObject({
    state: "rejected",
    failure_code: "provider_rejected",
  });
  expect(noEntitlement.provider.createFirewall).toHaveBeenCalledTimes(1);
});
it("waits for actual allocated hardware and prevents POST when node or region authority changes during preflight", async () => {
  const pending = await setup();
  pending.actual.status = "pending_payment";
  pending.actual.ramMb = null;
  pending.actual.diskMb = null;
  pending.actual.ipConfig = null;
  pending.actual.macAddress = null;
  expect(await pending.ensure()).toBeNull();
  expect(await pending.claim()).toBeNull();
  expect(pending.provider.createFirewall).not.toHaveBeenCalled();
  const changed = await setup();
  changed.provider.listFirewalls.mockImplementation(async () => {
    await env.DB.prepare(
      "UPDATE node_additions SET revision=revision+1 WHERE operation_id=?",
    )
      .bind(changed.operationId)
      .run();
    return [];
  });
  expect(await changed.ensure()).toBeNull();
  expect(changed.provider.createFirewall).not.toHaveBeenCalled();
  expect((await changed.claim())!.state).toBe("claimed");
  const wrongRegion = await setup();
  wrongRegion.actual.region = "US-central";
  await expect(wrongRegion.ensure()).rejects.toMatchObject({
    code: "conflict",
  });
  expect(wrongRegion.provider.createFirewall).not.toHaveBeenCalled();
});
