// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { newDatabaseId, newProjectId } from "../src/index.ts";
import { UsageQuery, UsageSample } from "../src/usage.ts";

const query = () => ({
  project_id: newProjectId(),
  from: "2026-01-01T00:00:00.000Z",
  to: "2026-02-01T00:00:00.000Z",
  granularity: "day" as const,
});
describe("usage contracts", () => {
  it("accepts exactly hourly/day UTC queries up to 31 days", () => {
    expect(UsageQuery.parse(query()).limit).toBe(50);
    expect(
      UsageQuery.safeParse({ ...query(), granularity: "month" }).success,
    ).toBe(false);
    expect(
      UsageQuery.safeParse({ ...query(), to: "2026-02-02T00:00:00.000Z" })
        .success,
    ).toBe(false);
  });
  it("rejects broad, conflicting and unaligned scopes", () => {
    const broad = {
      from: query().from,
      to: query().to,
      granularity: query().granularity,
    };
    expect(UsageQuery.safeParse(broad).success).toBe(false);
    expect(
      UsageQuery.safeParse({ ...query(), database_id: newDatabaseId() })
        .success,
    ).toBe(false);
    expect(
      UsageQuery.safeParse({ ...query(), from: "2026-01-01T01:00:00.000Z" })
        .success,
    ).toBe(false);
    expect(UsageQuery.safeParse({ ...query(), to: query().from }).success).toBe(
      false,
    );
  });
  it("accepts measured zero separately from unknown components", () => {
    const sample = UsageSample.parse({
      source: "agent",
      database_id: newDatabaseId(),
      producer_id: "node",
      sequence: 0,
      observed_at: query().from,
      storage_used_bytes: 0,
      storage_allocated_bytes: null,
    });
    expect(sample.source === "agent" && sample.storage_used_bytes).toBe(0);
    expect(
      sample.source === "agent" && sample.storage_allocated_bytes,
    ).toBeNull();
  });
  it("requires exact hour-contained traffic intervals and a unique roster", () => {
    const sample = {
      source: "gateway",
      database_id: newDatabaseId(),
      producer_id: "gateway_a",
      sequence: 0,
      observed_at: "2026-01-01T01:00:00.000Z",
      interval_start: query().from,
      interval_end: "2026-01-01T01:00:00.000Z",
      expected_producers: ["gateway_a"],
      ingress_bytes: 0,
      egress_bytes: 0,
      connections: 0,
      connection_seconds: 0,
    };
    expect(UsageSample.safeParse(sample).success).toBe(true);
    expect(
      UsageSample.safeParse({
        ...sample,
        interval_end: "2026-01-01T01:00:00.001Z",
      }).success,
    ).toBe(false);
    expect(
      UsageSample.safeParse({
        ...sample,
        expected_producers: ["gateway_a", "gateway_a"],
      }).success,
    ).toBe(false);
    expect(
      UsageSample.safeParse({ ...sample, expected_producers: ["gateway_b"] })
        .success,
    ).toBe(false);
    expect(
      UsageSample.safeParse({ ...sample, ingress_bytes: -1 }).success,
    ).toBe(false);
  });
});
