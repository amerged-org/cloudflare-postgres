// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { newNodeId } from "../src/ids.ts";
import {
  NodeAdditionRequest,
  nodeAdditionHostname,
  ProviderInstanceId,
} from "../src/nodes.ts";

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
