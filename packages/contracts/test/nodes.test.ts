// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { newNodeId } from "../src/ids.ts";
import {
  NodeAdditionRequest,
  nodeAdditionHostname,
  ProviderInstanceId,
  NodeMarkLost,
  NodeLoss,
  NodeRegionPolicy,
} from "../src/nodes.ts";

it("requires an exact node UID and retains the loss identity", () => {
  const uid = crypto.randomUUID();
  expect(
    NodeMarkLost.parse({ expected_node_uid: uid, reason: " confirmed " }),
  ).toEqual({ expected_node_uid: uid, reason: "confirmed" });
  expect(NodeMarkLost.safeParse({ reason: "confirmed" }).success).toBe(false);
  expect(
    NodeMarkLost.safeParse({ expected_node_uid: uid, reason: " " }).success,
  ).toBe(false);
  expect(
    NodeMarkLost.safeParse({
      expected_node_uid: uid,
      reason: "confirmed",
      replace: true,
    }).success,
  ).toBe(false);
  const record = {
    node_id: newNodeId(),
    region_id: "eu-test",
    node_uid: uid,
    provider_instance_id: null,
    lost_at: new Date().toISOString(),
    reason: "confirmed",
  };
  expect(NodeLoss.parse(record)).toEqual(record);
});

it("allows explicit uncapped RAM-trigger authority only for the approved exact monthly V159 order", () => {
  const order = {
    product_id: "V159",
    provider_region: "EU",
    image_id: crypto.randomUUID(),
    term_months: 1,
    location: "European Union",
  };
  const profile = {
    id: "owner-ram-expansion",
    trigger: "ram_76_percent",
    order,
    owner_reference: "owner-authorized-regional-76-percent",
    approved_at: new Date().toISOString(),
    expires_at: null,
    currency: null,
    monthly_amount: null,
    setup_amount: null,
    max_orders: null,
    max_total_monthly_amount: null,
    max_total_setup_amount: null,
  };
  const policy = {
    region_id: "eu-test",
    max_nodes: null,
    purchases_enabled: true,
    order,
    placement_mode: "actual_ram",
    maximum_database_memory_mib: 4096,
    postgres_memory_request_mib: 128,
    standing_cost_profile: profile,
  };
  expect(NodeRegionPolicy.parse(policy).max_nodes).toBeNull();
  expect(
    NodeRegionPolicy.safeParse({
      ...policy,
      standing_cost_profile: { ...profile, trigger: undefined },
    }).success,
  ).toBe(false);
  expect(
    NodeRegionPolicy.safeParse({
      ...policy,
      standing_cost_profile: { ...profile, max_total_monthly_amount: "1.0000" },
    }).success,
  ).toBe(false);
  const wrong = { ...order, product_id: "V155" };
  expect(
    NodeRegionPolicy.safeParse({
      ...policy,
      order: wrong,
      standing_cost_profile: { ...profile, order: wrong },
    }).success,
  ).toBe(false);
});

it("preserves canonical provider decimal IDs and rejects unsafe numeric values", () => {
  const large = String(BigInt(Number.MAX_SAFE_INTEGER) + 2n);
  expect(ProviderInstanceId.parse(large)).toBe(large);
  expect(
    ProviderInstanceId.safeParse(Number.MAX_SAFE_INTEGER + 2).success,
  ).toBe(false);
  expect(ProviderInstanceId.safeParse("01").success).toBe(false);
  expect(ProviderInstanceId.safeParse("invalid").success).toBe(false);
});
it("generates the actual requested hostname from the immutable reserved node identity", () => {
  const id = newNodeId();
  expect(nodeAdditionHostname(id)).toBe(`pgcf-node-${id.slice(4)}`);
  expect(nodeAdditionHostname(id).length).toBeLessThanOrEqual(63);
});
it("accepts explicit adoption or configured Contabo order intent without region defaults", () => {
  expect(
    NodeAdditionRequest.parse({
      region_id: "test-region",
      mode: "adopt",
      provider_instance_id: "17",
    }).mode,
  ).toBe("adopt");
  expect(
    NodeAdditionRequest.safeParse({ region_id: "test-region", mode: "order" })
      .success,
  ).toBe(false);
});

it("requires an exact predecessor UID and provider for explicit existing-instance recovery", () => {
  const request = {
    region_id: "eu-test",
    mode: "recover",
    provider_instance_id: "17",
    predecessor_node_id: newNodeId(),
    expected_node_uid: crypto.randomUUID(),
  };
  expect(NodeAdditionRequest.parse(request)).toEqual(request);
  expect(
    NodeAdditionRequest.safeParse({ ...request, expected_node_uid: undefined })
      .success,
  ).toBe(false);
  expect(
    NodeAdditionRequest.safeParse({
      ...request,
      predecessor_node_id: undefined,
    }).success,
  ).toBe(false);
  expect(
    NodeAdditionRequest.safeParse({
      ...request,
      provider_instance_id: undefined,
    }).success,
  ).toBe(false);
});
