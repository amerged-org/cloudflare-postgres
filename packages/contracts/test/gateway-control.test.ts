// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { newDatabaseId, newOperationId } from "../src/ids.ts";
import { deriveRegionKeyring, signRouteToken } from "../src/route-token.ts";
import {
  signGatewayControl,
  verifyGatewayControl,
  gatewayIntentSchema,
} from "../src/gateway-control.ts";

describe("gateway controls", () => {
  it("separates purpose and binds region, recipient, action, identity and expiry", async () => {
    const region = "test-region",
      database = newDatabaseId(),
      operation = newOperationId(),
      pod = randomUUID();
    const master = {
      active: "fixture",
      keys: new Map([["fixture", crypto.getRandomValues(new Uint8Array(32))]]),
    };
    const keyring = await deriveRegionKeyring(master, region);
    const input = {
      keyring,
      region,
      database,
      operation,
      revision: 1,
      pod,
      action: "begin" as const,
      now: 100000,
    };
    const value = await signGatewayControl(input);
    const expected = {
      keys: keyring.keys,
      region,
      pod,
      action: "begin" as const,
      now: 100000,
    };
    expect((await verifyGatewayControl(value, expected)).ok).toBe(true);
    expect(
      (
        await verifyGatewayControl(
          value.slice(0, -1) + (value.endsWith("a") ? "b" : "a"),
          expected,
        )
      ).ok,
    ).toBe(false);
    expect(
      (await verifyGatewayControl(value, { ...expected, now: 131000 })).ok,
    ).toBe(false);
    expect(
      (await verifyGatewayControl(value, { ...expected, pod: randomUUID() }))
        .ok,
    ).toBe(false);
    expect(
      (await verifyGatewayControl(value, { ...expected, action: "close" })).ok,
    ).toBe(false);
    expect(
      (
        await verifyGatewayControl(value, {
          ...expected,
          region: "wrong-region",
        })
      ).ok,
    ).toBe(false);
    const route = await signRouteToken({
      keyring: master,
      region,
      db: database,
      user: "app",
      cid: randomUUID(),
      now: 100000,
    });
    expect((await verifyGatewayControl(route, expected)).ok).toBe(false);
    await expect(
      signGatewayControl({ ...input, ttlSeconds: 31 }),
    ).rejects.toThrow();
    expect(
      gatewayIntentSchema.safeParse({
        database,
        operation,
        revision: 1,
        mode: "quiesce",
      }).success,
    ).toBe(true);
    expect(
      gatewayIntentSchema.safeParse({
        database,
        operation,
        revision: 0,
        mode: "running",
      }).success,
    ).toBe(false);
  });
});

it("retirement controls and reports remain distinct from routing/activity purposes", async () => {
  const { gatewayControlReportSchema } =
    await import("../src/gateway-control.ts");
  const { signGatewayActivity } = await import("../src/gateway-activity.ts");
  const region = "test-region",
    database = newDatabaseId(),
    operation = newOperationId(),
    pod = randomUUID();
  const keyring = {
    active: "fixture",
    keys: new Map([["fixture", crypto.getRandomValues(new Uint8Array(32))]]),
  };
  const input = {
    keyring,
    region,
    database,
    operation,
    revision: 2,
    pod,
    action: "retire" as const,
    now: 100000,
  };
  const expected = {
    keys: keyring.keys,
    region,
    pod,
    action: "retire" as const,
    now: 100000,
  };
  expect(
    (await verifyGatewayControl(await signGatewayControl(input), expected)).ok,
  ).toBe(true);
  expect(
    (
      await verifyGatewayControl(
        await signGatewayActivity({ ...input }),
        expected,
      )
    ).ok,
  ).toBe(false);
  expect(
    (
      await verifyGatewayControl(
        await signGatewayControl({ ...input, action: "begin" }),
        expected,
      )
    ).ok,
  ).toBe(false);
  const report = {
    database,
    operation,
    revision: 2,
    pod,
    mode: "retired",
    status: "retired",
    connections: 0,
    busyConnections: 0,
    pendingDials: 0,
  };
  expect(gatewayControlReportSchema.safeParse(report).success).toBe(true);
  expect(
    gatewayControlReportSchema.safeParse({ ...report, pendingDials: 1 })
      .success,
  ).toBe(false);
  expect(
    gatewayControlReportSchema.safeParse({ ...report, mode: "running" })
      .success,
  ).toBe(false);
});
