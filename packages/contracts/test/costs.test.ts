// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { newNodeId } from "../src/ids.ts";
import {
  InfrastructureCostFactCreate,
  InfrastructureCostsQuery,
  prorateMonthlyCost,
} from "../src/costs.ts";

it("prorates exact UTC leap and short months with fixed hour arithmetic", () => {
  expect(
    prorateMonthlyCost(
      "696.0000",
      "2024-02-01T00:00:00.000Z",
      "2024-02-01T01:00:00.000Z",
    ),
  ).toEqual({ numerator: "1", denominator: "1", amount: "1.000000000000" });
  expect(
    prorateMonthlyCost(
      "672.0000",
      "2025-02-01T00:00:00.000Z",
      "2025-02-01T01:00:00.000Z",
    ).numerator,
  ).toBe("1");
  expect(
    prorateMonthlyCost(
      "744.0000",
      "2025-01-01T00:15:00.000Z",
      "2025-01-01T00:45:00.000Z",
    ),
  ).toEqual({ numerator: "1", denominator: "2", amount: "0.500000000000" });
});
it("splits a real interval at UTC month boundaries without rounding its exact fraction", () => {
  const result = prorateMonthlyCost(
    "1.0000",
    "2025-01-31T23:30:00.000Z",
    "2025-02-01T00:30:00.000Z",
  );
  expect(BigInt(result.numerator) * (2n * 744n * 672n)).toBe(
    BigInt(result.denominator) * (744n + 672n),
  );
  expect(
    prorateMonthlyCost(
      "0.0000",
      "2025-01-01T00:00:00.000Z",
      "2025-01-01T01:00:00.000Z",
    ).amount,
  ).toBe("0.000000000000");
});
it("validates explicit provenance, bounded effective periods and aligned hourly scope", () => {
  const input = {
    node_id: newNodeId(),
    region_id: "test-region",
    monthly_amount: "10.0000",
    currency: "EUR",
    effective_from: "2025-01-01T00:30:00.000Z",
    effective_to: "2025-01-02T00:30:00.000Z",
    provenance: {
      kind: "contract",
      reference: "fixture-contract",
      issued_at: "2025-01-01T00:00:00.000Z",
    },
  };
  expect(InfrastructureCostFactCreate.safeParse(input).success).toBe(true);
  expect(
    InfrastructureCostFactCreate.safeParse({
      ...input,
      monthly_amount: "-1.0000",
    }).success,
  ).toBe(false);
  expect(
    InfrastructureCostFactCreate.safeParse({
      ...input,
      effective_to: input.effective_from,
    }).success,
  ).toBe(false);
  expect(
    InfrastructureCostsQuery.safeParse({
      node_id: input.node_id,
      from: "2025-01-01T00:00:00.000Z",
      to: "2025-02-01T00:00:00.000Z",
      granularity: "hour",
    }).success,
  ).toBe(true);
  expect(
    InfrastructureCostsQuery.safeParse({
      from: "2025-01-01T00:00:00.000Z",
      to: "2025-02-01T00:00:00.000Z",
      granularity: "hour",
    }).success,
  ).toBe(false);
});
