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

it("an explicit idle recovery window can only delay the raw gateway boundary and cannot exceed the oldest report", () => {
  const id = contracts.newDatabaseId(),
    now = Date.now(),
    start = new Date(now - 120000).toISOString(),
    floor = new Date(now - 15000).toISOString();
  const reports = [0, 1000].map((offset) => ({
    region: "eu-test",
    database: id,
    revision: 1,
    pod: crypto.randomUUID(),
    processEpoch: crypto.randomUUID(),
    epoch: crypto.randomUUID(),
    startedAt: start,
    counterStartedAt: start,
    observedAt: new Date(now - offset).toISOString(),
    history: "current_process_absence",
    countersSince: start,
    ingressBytes: 0,
    egressBytes: 0,
    totalConnections: 0,
    connectionMilliseconds: 0,
    connections: 0,
    authenticatedConnections: 0,
    busyConnections: 0,
    pendingDials: 0,
    lastActivityAt: null,
  }));
  const legacy = {
    id,
    revision: 1,
    observed_at: reports[0]!.observedAt,
    last_activity_at: start,
    connections: 0,
    busy_connections: 0,
    pending_dials: 0,
    expected_gateway_pods: reports.map((report) => report.pod),
    reports,
  };
  expect(contracts.AgentDatabaseActivity.safeParse(legacy).success).toBe(true);
  const recovered = {
    ...legacy,
    idle_observed_since: floor,
    last_activity_at: floor,
  };
  expect(contracts.AgentDatabaseActivity.safeParse(recovered).success).toBe(
    true,
  );
  expect(
    contracts.AgentDatabaseActivity.safeParse({
      ...recovered,
      idle_observed_since: reports[0]!.observedAt,
      last_activity_at: reports[0]!.observedAt,
    }).success,
  ).toBe(false);
  expect(
    contracts.AgentDatabaseActivity.safeParse({
      ...recovered,
      last_activity_at: start,
    }).success,
  ).toBe(false);
  expect(
    contracts.AgentDatabaseActivity.safeParse({
      ...recovered,
      last_activity_at: new Date(now - 5000).toISOString(),
    }).success,
  ).toBe(false);
});
