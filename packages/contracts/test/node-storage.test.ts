// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { NodeStorageSample } from "../src/node-physical-storage.ts";

describe("physical node storage samples", () => {
  it("keeps unknown and a real absent pool distinct from empty storage", () => {
    const sample = {
      node_uid: crypto.randomUUID(),
      observed_at: new Date().toISOString(),
      physical: null,
    };
    expect(NodeStorageSample.parse(sample).physical).toBeNull();
    const physical = {
      volume_group_uuid: "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef",
      total_bytes: 1000,
      free_bytes: 700,
      thick_allocated_bytes: 300,
      thin_pool: null,
    };
    expect(
      NodeStorageSample.parse({ ...sample, physical }).physical
        ?.thick_allocated_bytes,
    ).toBe(300);
    expect(
      NodeStorageSample.safeParse({
        ...sample,
        physical: { ...physical, free_bytes: 1001 },
      }).success,
    ).toBe(false);
    expect(
      NodeStorageSample.safeParse({
        ...sample,
        physical: {
          ...physical,
          thin_pool: {
            name: "pgcf_thinpool",
            data_total_bytes: 100,
            data_used_bytes_upper_bound: 101,
            metadata_total_bytes: 10,
            metadata_used_bytes_upper_bound: 1,
          },
        },
      }).success,
    ).toBe(false);
  });
});
