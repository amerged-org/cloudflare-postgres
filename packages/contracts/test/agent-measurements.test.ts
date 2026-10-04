// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import * as contracts from "../src/index.ts";

it("exports bounded authenticated agent activity and usage request schemas", () => {
  expect(contracts).toHaveProperty("AgentActivityRequest");
  expect(contracts).toHaveProperty("AgentUsageRequest");
});
it("agent usage cannot carry a recorder principal or forged variant fields", () => {
  const schema = (
    contracts as unknown as {
      AgentUsageRequest: { safeParse(value: unknown): { success: boolean } };
    }
  ).AgentUsageRequest;
  const sample = {
    database_id: contracts.newDatabaseId(),
    source: "agent",
    producer_id: crypto.randomUUID(),
    sequence: 1,
    observed_at: new Date().toISOString(),
    storage_used_bytes: null,
    storage_allocated_bytes: null,
  };
  expect(schema.safeParse({ samples: [sample] }).success).toBe(true);
  expect(
    schema.safeParse({
      samples: [sample],
      principal: { source: "agent", region_id: "eu-test" },
    }).success,
  ).toBe(false);
  expect(
    schema.safeParse({ samples: [{ ...sample, source: "gateway" }] }).success,
  ).toBe(false);
  expect(
    schema.safeParse({ samples: Array.from({ length: 26 }, () => sample) })
      .success,
  ).toBe(false);
});

it("one process epoch cannot masquerade as two distinct gateway pods", () => {
  const id = contracts.newDatabaseId(),
    now = new Date().toISOString(),
    epoch = crypto.randomUUID(),
    pods = [crypto.randomUUID(), crypto.randomUUID()];
  const reports = pods.map((pod) => ({
    region: "eu-test",
    database: id,
    revision: 1,
    pod,
    processEpoch: epoch,
    epoch: crypto.randomUUID(),
    startedAt: now,
    counterStartedAt: now,
    observedAt: now,
    history: "complete",
    countersSince: now,
    ingressBytes: 1,
    egressBytes: 1,
    totalConnections: 1,
    connectionMilliseconds: 0,
    connections: 0,
    authenticatedConnections: 0,
    busyConnections: 0,
    pendingDials: 0,
    lastActivityAt: now,
  }));
  const schema = contracts.AgentActivityRequest;
  expect(
    schema.safeParse({
      databases: [
        {
          id,
          revision: 1,
          observed_at: now,
          last_activity_at: now,
          connections: 0,
          busy_connections: 0,
          pending_dials: 0,
          expected_gateway_pods: pods,
          reports,
        },
      ],
    }).success,
  ).toBe(false);
});
