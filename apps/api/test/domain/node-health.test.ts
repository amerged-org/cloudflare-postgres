// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { choosePlacement } from "../../src/domain/placement.ts";

it("refuses stale, missing, future and lost node observations for placement", () => {
  const now = Date.now();
  const node = {
    id: "fixture-node",
    region_id: "eu-test",
    ready: true,
    schedulable: true,
    allocatable_memory_mib: 8192,
    platform_reserved_memory_mib: 128,
    reserved_memory_mib: 0,
    allocatable_cpu_millicores: 2000,
    platform_reserved_cpu_millicores: 100,
    reserved_cpu_millicores: 0,
    storage_gib_total: 30,
    reserved_storage_gib: 0,
    last_observed_at: new Date(now).toISOString(),
    lost_at: null,
  };
  const size = { memory_mib: 512, cpu_millicores: 500, storage_gib: 5 };
  expect(choosePlacement([node], node.region_id, size)?.id).toBe(node.id);
  expect(
    choosePlacement(
      [{ ...node, last_observed_at: new Date(now - 180_001).toISOString() }],
      node.region_id,
      size,
    ),
  ).toBeNull();
  expect(
    choosePlacement(
      [{ ...node, last_observed_at: null }],
      node.region_id,
      size,
    ),
  ).toBeNull();
  expect(
    choosePlacement(
      [{ ...node, last_observed_at: new Date(now + 60_000).toISOString() }],
      node.region_id,
      size,
    ),
  ).toBeNull();
  expect(
    choosePlacement(
      [{ ...node, lost_at: new Date(now).toISOString() }],
      node.region_id,
      size,
    ),
  ).toBeNull();
});
