// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
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

it("keeps an irreversible deletion barrier after mutable runtime and budget changes while preserving historical allowance custody", async () => {
  const fixture = await accountingFixture("Deletion authority");
  const createLane = `/v1/regions/${fixture.regionId}/operations`;
  const claimResponse = await accountingCall(`${createLane}/claim`, {
    method: "POST",
    headers: fixture.regionHeaders,
    body: JSON.stringify({ leaseSeconds: 90 }),
  });
  expect(claimResponse.status).toBe(200);
  const creation = (await claimResponse.json()) as {
    claim: { operationId: string; leaseToken: string; leaseEpoch: number };
  };
  const readyBody = {
    leaseToken: creation.claim.leaseToken,
    leaseEpoch: creation.claim.leaseEpoch,
    status: "ready",
    resultCode: "cnpg_ready",
    observation: {
      clusterUid: "44444444-4444-4444-8444-444444444444",
      clusterGeneration: 1,
      readyInstances: 1,
    },
  };
  expect(
    (
      await accountingCall(
        `${createLane}/${creation.claim.operationId}/result`,
        {
          method: "POST",
          headers: fixture.regionHeaders,
          body: JSON.stringify(readyBody),
        },
      )
    ).status,
  ).toBe(200);
  const reissued = await accountingCall(
    `/v1/organizations/${fixture.organizationId}/budget-tokens/reissue`,
    { method: "POST", headers: installerHeaders },
  );
  expect(reissued.status).toBe(201);
  const grantor = (await reissued.json()) as { apiToken: string };
  const budgetHeaders = {
    authorization: `Bearer ${grantor.apiToken}`,
    "content-type": "application/json",
  };
  const budget = `/v1/organizations/${fixture.organizationId}/projects/${fixture.projectId}/budget`;
  expect(
    (
      await accountingCall(budget, {
        method: "PUT",
        headers: budgetHeaders,
        body: JSON.stringify({
          expectedRevision: "0",
          period: {
            start: new Date(Date.now() - 60_000).toISOString(),
            end: new Date(Date.now() + 600_000).toISOString(),
          },
          granted: { cpu_millicore_ms: "200" },
        }),
      })
    ).status,
  ).toBe(200);
  const reservations = `/v1/regions/${fixture.regionId}/allowance-reservations`;
  const reservationBody = {
    requestId: crypto.randomUUID(),
    environmentId: fixture.environmentId,
    leaseSeconds: 90,
    units: { cpu_millicore_ms: "100" },
  };
  const issued = await accountingCall(reservations, {
    method: "POST",
    headers: fixture.regionHeaders,
    body: JSON.stringify(reservationBody),
  });
  expect(issued.status).toBe(201);
  const historical = (await issued.json()) as {
    reservation: {
      id: string;
      fenceToken: string;
      expiresAt: string;
      status: string;
    };
  };
  const authorityPath = `${reservations}/${historical.reservation.id}/authority`;
  expect(
    await (
      await accountingCall(authorityPath, {
        headers: fixture.regionHeaders,
      })
    ).json(),
  ).toMatchObject({ authority: { decision: "allow", reason: "authorized" } });
  const heldBefore = await env.DB.prepare(
    "SELECT status,units_json,fence_ciphertext,fence_iv,fence_key_version,fence_token_hash,stopped_at,stop_evidence_hash FROM allowance_reservations WHERE id=?",
  )
    .bind(historical.reservation.id)
    .first();
  const environment = `/v1/organizations/${fixture.organizationId}/projects/${fixture.projectId}/environments/${fixture.environmentId}`;
  const suspension = await accountingCall(`${environment}/suspend`, {
    method: "POST",
    headers: {
      ...fixture.orgHeaders,
      "idempotency-key": "delete-authority-stop",
    },
    body: JSON.stringify({ expectedRevision: 0 }),
  });
  expect(suspension.status).toBe(202);
  const stopIntent = (await suspension.json()) as {
    operation: { id: string };
  };
  const deletion = await accountingCall(environment, {
    method: "DELETE",
    headers: {
      ...fixture.orgHeaders,
      "idempotency-key": "delete-authority",
    },
    body: JSON.stringify({
      expectedRevision: 1,
      volumePolicy: "delete",
      backupPolicy: "retain",
    }),
  });
  expect(deletion.status).toBe(202);
  expect(await deletion.json()).toMatchObject({
    deletion: { stopOperationId: stopIntent.operation.id },
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM operations WHERE environment_id=? AND kind='environment.suspend'",
    )
      .bind(fixture.environmentId)
      .first(),
  ).toEqual({ count: 1 });
  const stopped = await accountingCall(authorityPath, {
    headers: fixture.regionHeaders,
  });
  expect(stopped.status).toBe(200);
  expect(await stopped.json()).toMatchObject({
    authority: {
      decision: "stop",
      reason: "environment_deleting",
      runtimeEnforced: false,
      enforcementStatus: "pending_runtime",
    },
  });

  // Current runtime state is mutable; deleting authority is not reconstructed
  // from it and cannot be removed by changing it back to running.
  await env.DB.prepare(
    "UPDATE environment_runtime SET desired_state='running',phase='running',version_token=? WHERE environment_id=?",
  )
    .bind(crypto.randomUUID(), fixture.environmentId)
    .run();
  expect(
    (
      await accountingCall(`${budget}/pause`, {
        method: "POST",
        headers: budgetHeaders,
        body: JSON.stringify({ expectedRevision: "1" }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await accountingCall(`${budget}/resume`, {
        method: "POST",
        headers: budgetHeaders,
        body: JSON.stringify({ expectedRevision: "2" }),
      })
    ).status,
  ).toBe(200);
  const unchangedStop = await accountingCall(authorityPath, {
    headers: fixture.regionHeaders,
  });
  expect(unchangedStop.status).toBe(200);
  expect(await unchangedStop.json()).toMatchObject({
    authority: { decision: "stop", reason: "environment_deleting" },
  });
  expect(
    (
      await accountingCall(reservations, {
        method: "POST",
        headers: fixture.regionHeaders,
        body: JSON.stringify({
          ...reservationBody,
          requestId: crypto.randomUUID(),
        }),
      })
    ).status,
  ).toBe(409);
  const replay = await accountingCall(reservations, {
    method: "POST",
    headers: fixture.regionHeaders,
    body: JSON.stringify(reservationBody),
  });
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(historical);
  const read = await accountingCall(
    `${reservations}/${historical.reservation.id}`,
    { headers: fixture.regionHeaders },
  );
  expect(read.status).toBe(200);
  expect(await read.json()).toEqual(historical);
  expect(
    await env.DB.prepare(
      "SELECT status,units_json,fence_ciphertext,fence_iv,fence_key_version,fence_token_hash,stopped_at,stop_evidence_hash FROM allowance_reservations WHERE id=?",
    )
      .bind(historical.reservation.id)
      .first(),
  ).toEqual(heldBefore);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM allowance_settlement_versions WHERE reservation_id=?",
    )
      .bind(historical.reservation.id)
      .first(),
  ).toEqual({ count: 0 });
});
