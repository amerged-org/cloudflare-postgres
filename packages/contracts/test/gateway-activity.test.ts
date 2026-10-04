// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { newDatabaseId, newOperationId } from "../src/index.ts";
import {
  signGatewayControl,
  verifyGatewayControl,
} from "../src/gateway-control.ts";
import {
  signGatewayActivity,
  verifyGatewayActivity,
  gatewayActivityReportSchema,
} from "../src/gateway-activity.ts";

it("separates activity purpose, enforces expiry and binds pod/region/database/revision", async () => {
  const keyring = {
      active: "test",
      keys: new Map([["test", randomBytes(32)]]),
    },
    pod = randomUUID(),
    database = newDatabaseId(),
    now = Date.now();
  const input = {
    keyring,
    region: "test-region",
    database,
    revision: 1,
    pod,
    now,
  };
  const value = await signGatewayActivity(input),
    expected = { keys: keyring.keys, region: input.region, pod, now };
  const result = await verifyGatewayActivity(value, expected);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.claims.database).toBe(database);
    expect(result.claims.revision).toBe(1);
  }
  expect(
    (await verifyGatewayActivity(value, { ...expected, pod: randomUUID() })).ok,
  ).toBe(false);
  expect(
    (
      await verifyGatewayActivity(value, {
        ...expected,
        region: "other-region",
      })
    ).ok,
  ).toBe(false);
  expect(
    (await verifyGatewayActivity(value, { ...expected, now: now + 31_000 })).ok,
  ).toBe(false);
  const control = await signGatewayControl({
    ...input,
    operation: newOperationId(),
    action: "status",
  });
  expect((await verifyGatewayActivity(control, expected)).ok).toBe(false);
  expect(
    (await verifyGatewayControl(value, { ...expected, action: "status" })).ok,
  ).toBe(false);
  await expect(
    signGatewayActivity({ ...input, ttlSeconds: 31 }),
  ).rejects.toThrow();
});

it("keeps missing history and current-process absence distinct with bounded timestamps and counts", () => {
  const now = new Date().toISOString();
  const report = {
    region: "test-region",
    database: newDatabaseId(),
    revision: 1,
    pod: randomUUID(),
    processEpoch: randomUUID(),
    epoch: randomUUID(),
    startedAt: now,
    counterStartedAt: now,
    observedAt: now,
    history: "current_process_absence",
    countersSince: now,
    ingressBytes: 0,
    egressBytes: 0,
    totalConnections: 0,
    connectionMilliseconds: 0,
    connections: 0,
    authenticatedConnections: 0,
    busyConnections: 0,
    pendingDials: 0,
    lastActivityAt: null,
  };
  expect(gatewayActivityReportSchema.safeParse(report).success).toBe(true);
  expect(
    gatewayActivityReportSchema.safeParse({ ...report, history: "unavailable" })
      .success,
  ).toBe(false);
  expect(
    gatewayActivityReportSchema.safeParse({ ...report, busyConnections: 1 })
      .success,
  ).toBe(false);
  expect(
    gatewayActivityReportSchema.safeParse({
      ...report,
      history: "unavailable",
      countersSince: null,
      ingressBytes: null,
      egressBytes: null,
      totalConnections: null,
      connectionMilliseconds: null,
    }).success,
  ).toBe(true);
});
