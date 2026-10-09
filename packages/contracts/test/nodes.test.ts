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
  CostedNodeApproval,
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

it("accepts generic RAM authority for an exact operator-selected order and preserves legacy triggers", () => {
  const order = {
    product_id: "operator-selected-product",
    provider_region: "EU",
    image_id: crypto.randomUUID(),
    term_months: 12,
    location: "European Union",
    add_ons: [{ id: "123", quantity: 1 }],
  };
  const profile = {
    id: "owner-ram-expansion",
    trigger: "regional_actual_ram",
    order,
    owner_reference: "owner-authorized-regional-expansion",
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
    ram_expansion_threshold_ppm: 810000,
    standing_cost_profile: profile,
  };
  expect(NodeRegionPolicy.parse(policy).max_nodes).toBeNull();
  expect(
    NodeRegionPolicy.parse({
      ...policy,
      standing_cost_profile: { ...profile, trigger: "ram_76_percent" },
    }).standing_cost_profile?.trigger,
  ).toBe("ram_76_percent");
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
  expect(
    NodeRegionPolicy.parse({
      ...policy,
      placement_mode: "reserved",
    }).placement_mode,
  ).toBe("reserved");
  expect(
    NodeRegionPolicy.safeParse({
      ...policy,
      order: { ...order, product_id: "another-product" },
    }).success,
  ).toBe(false);
});

it("leaves omitted capacity and warning fields unset and accepts an explicitly uncapped disabled policy", () => {
  const fresh = NodeRegionPolicy.parse({ region_id: "eu-test" });
  expect(fresh.purchases_enabled).toBe(false);
  expect(fresh).not.toHaveProperty("max_nodes");
  expect(fresh).not.toHaveProperty("ram_expansion_threshold_ppm");
  expect(fresh).not.toHaveProperty("ram_warning_threshold_ppm");
  expect(fresh).not.toHaveProperty("cap_warning_enabled");
  expect(
    NodeRegionPolicy.parse({
      region_id: "eu-test",
      max_nodes: null,
      ram_expansion_threshold_ppm: null,
      ram_warning_threshold_ppm: null,
      cap_warning_enabled: false,
    }),
  ).toMatchObject({
    max_nodes: null,
    purchases_enabled: false,
    ram_expansion_threshold_ppm: null,
    ram_warning_threshold_ppm: null,
    cap_warning_enabled: false,
  });
});

it("bounds configured RAM thresholds to integer parts per million and requires an explicit warning boolean", () => {
  expect(
    NodeRegionPolicy.parse({
      region_id: "eu-test",
      ram_expansion_threshold_ppm: 1,
      ram_warning_threshold_ppm: 1_000_000,
      cap_warning_enabled: true,
    }),
  ).toMatchObject({
    ram_expansion_threshold_ppm: 1,
    ram_warning_threshold_ppm: 1_000_000,
    cap_warning_enabled: true,
  });
  expect(
    NodeRegionPolicy.safeParse({
      region_id: "eu-test",
      ram_expansion_threshold_ppm: 0,
    }).success,
  ).toBe(false);
  expect(
    NodeRegionPolicy.safeParse({
      region_id: "eu-test",
      ram_warning_threshold_ppm: 1_000_001,
    }).success,
  ).toBe(false);
  expect(
    NodeRegionPolicy.safeParse({
      region_id: "eu-test",
      ram_expansion_threshold_ppm: 750000.5,
    }).success,
  ).toBe(false);
  expect(
    NodeRegionPolicy.safeParse({
      region_id: "eu-test",
      cap_warning_enabled: "true",
    }).success,
  ).toBe(false);
});

it("allows unknown cost only for finite derived RAM authority with either supported trigger", () => {
  const approval = {
    intent_hash: "a".repeat(64),
    owner_reference: "approved-exact-order",
    approved_at: "2026-10-09T00:00:00.000Z",
    expires_at: "2026-10-09T00:05:00.000Z",
    monthly_amount: null,
    setup_amount: null,
    currency: null,
    term_months: 12,
    location: "European Union",
    standing_profile_id: "owner-ram-expansion",
    trigger: "regional_actual_ram",
  };
  expect(CostedNodeApproval.parse(approval)).toEqual(approval);
  expect(
    CostedNodeApproval.parse({ ...approval, trigger: "ram_76_percent" })
      .trigger,
  ).toBe("ram_76_percent");
  expect(
    CostedNodeApproval.safeParse({
      ...approval,
      standing_profile_id: undefined,
    }).success,
  ).toBe(false);
  expect(
    CostedNodeApproval.safeParse({ ...approval, trigger: undefined }).success,
  ).toBe(false);
  expect(
    CostedNodeApproval.safeParse({
      ...approval,
      expires_at: approval.approved_at,
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
