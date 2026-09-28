// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from "vitest";
import {
  accountingCall,
  accountingFixture,
  installerHeaders,
} from "./accounting-fixture";

it("distinguishes current funded execution authority from paused, changed and expired historical receipts", async () => {
  const fixture = await accountingFixture("Runtime authority");
  const tokenResponse = await accountingCall(
    `/v1/organizations/${fixture.organizationId}/budget-tokens/reissue`,
    { method: "POST", headers: installerHeaders },
  );
  expect(tokenResponse.status).toBe(201);
  const grantor = (await tokenResponse.json()) as { apiToken: string };
  const headers = {
    authorization: `Bearer ${grantor.apiToken}`,
    "content-type": "application/json",
  };
  const budget = `/v1/organizations/${fixture.organizationId}/projects/${fixture.projectId}/budget`;
  const period = {
    start: new Date(Date.now() - 60_000).toISOString(),
    end: new Date(Date.now() + 600_000).toISOString(),
  };
  const policy = await accountingCall(budget, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      expectedRevision: "0",
      period,
      granted: { cpu_millicore_ms: "100", memory_byte_ms: "0" },
    }),
  });
  expect(policy.status).toBe(200);
  const request = {
    requestId: crypto.randomUUID(),
    environmentId: fixture.environmentId,
    leaseSeconds: 90,
    units: { cpu_millicore_ms: "100" },
  };
  const reservations = `/v1/regions/${fixture.regionId}/allowance-reservations`;
  const issued = await accountingCall(reservations, {
    method: "POST",
    headers: fixture.regionHeaders,
    body: JSON.stringify(request),
  });
  expect(issued.status).toBe(201);
  const receipt = (await issued.json()) as {
    reservation: {
      id: string;
      epoch: string;
      specHash: string;
      expiresAt: string;
      fenceToken: string;
    };
  };
  const path = `${reservations}/${receipt.reservation.id}/authority`;
  const first = await accountingCall(path, { headers: fixture.regionHeaders });
  expect(first.status).toBe(200);
  const authorized = (await first.json()) as {
    authority: {
      decision: string;
      reason: string;
      validUntil: string;
      evidenceHash: string;
      reservationId: string;
      environmentId: string;
      projectId: string;
      limitedMetrics: string[];
      specHash: string;
      runtimeEnforced: boolean;
    };
  };
  expect(authorized.authority.decision).toBe("allow");
  expect(authorized.authority.reason).toBe("authorized");
  expect(authorized.authority.reservationId).toBe(receipt.reservation.id);
  expect(authorized.authority.environmentId).toBe(fixture.environmentId);
  expect(authorized.authority.projectId).toBe(fixture.projectId);
  expect(authorized.authority.limitedMetrics).toEqual([
    "cpu_millicore_ms",
    "memory_byte_ms",
  ]);
  expect(authorized.authority.specHash).toBe(receipt.reservation.specHash);
  expect(authorized.authority.runtimeEnforced).toBe(false);
  expect(authorized.authority.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
  expect(Date.parse(authorized.authority.validUntil)).toBeLessThanOrEqual(
    Date.now() + 15_000,
  );
  expect(JSON.stringify(authorized)).not.toContain(
    receipt.reservation.fenceToken,
  );
  expect(
    (await accountingCall(path, { headers: fixture.orgHeaders })).status,
  ).toBe(401);
  const foreign = `/v1/regions/11111111-1111-4111-8111-111111111111/allowance-reservations/${receipt.reservation.id}/authority`;
  expect(
    (await accountingCall(foreign, { headers: fixture.regionHeaders })).status,
  ).toBe(404);
  const paused = await accountingCall(`${budget}/pause`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedRevision: "1" }),
  });
  expect(paused.status).toBe(200);
  const stopped = (await (
    await accountingCall(path, { headers: fixture.regionHeaders })
  ).json()) as { authority: { decision: string; reason: string } };
  expect(stopped.authority).toMatchObject({
    decision: "stop",
    reason: "budget_paused",
  });
  const historical = (await (
    await accountingCall(`${reservations}/${receipt.reservation.id}`, {
      headers: fixture.regionHeaders,
    })
  ).json()) as typeof receipt;
  expect(historical.reservation.fenceToken).toBe(
    receipt.reservation.fenceToken,
  );
  expect(historical.reservation.expiresAt).toBe(receipt.reservation.expiresAt);
  const resumed = await accountingCall(`${budget}/resume`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedRevision: "2" }),
  });
  expect(resumed.status).toBe(200);
  const changed = (await (
    await accountingCall(path, { headers: fixture.regionHeaders })
  ).json()) as typeof stopped;
  expect(changed.authority).toMatchObject({
    decision: "stop",
    reason: "policy_changed",
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse(receipt.reservation.expiresAt) + 1000);
  try {
    const expired = (await (
      await accountingCall(path, { headers: fixture.regionHeaders })
    ).json()) as typeof stopped;
    expect(expired.authority).toMatchObject({
      decision: "stop",
      reason: "reservation_expired",
    });
    const replay = await accountingCall(reservations, {
      method: "POST",
      headers: fixture.regionHeaders,
      body: JSON.stringify(request),
    });
    expect(replay.status).toBe(200);
    expect(
      ((await replay.json()) as typeof receipt).reservation.expiresAt,
    ).toBe(receipt.reservation.expiresAt);
  } finally {
    vi.useRealTimers();
  }
});
