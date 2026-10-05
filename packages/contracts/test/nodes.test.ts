// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { newNodeId } from "../src/ids.ts";
import {
  NodeAdditionRequest,
  nodeAdditionHostname,
  ProviderInstanceId,
  NodeMarkLost,
  NodeLoss,
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
