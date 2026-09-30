// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import {
  accountingCall as call,
  accountingFixture,
  installerHeaders,
} from "./accounting-fixture";

interface Claim {
  operationId: string;
  environmentId: string;
  leaseToken: string;
  leaseEpoch: number;
}
interface Funding {
  version: 1;
  envelopeVersion: 1;
  operationId: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  regionId: string;
  specRevision: number;
  specHash: string;
  runEpoch: string | null;
  fundingSeconds: number;
  rates: Record<string, string>;
  units: Record<string, string>;
  reservation: {
    id: string;
    units: Record<string, string>;
    issuedAt: string;
    expiresAt: string;
    fenceToken: string;
    runtimeEnforced: false;
    enforcementStatus: "pending_runtime";
  };
}

it("funds the immutable provisioning envelope once under the winning lease and never advances recovered expiry", async () => {
  const f = await accountingFixture("Provisioning funding", undefined, {
    instances: 2,
    executionFencing: { version: 1 },
    pooling: {
      version: 1,
      image: `example.invalid/pooler@sha256:${"b".repeat(64)}`,
      mode: "session",
      compute: {
        requests: { cpuMilli: 100, memoryMiB: 128 },
        limits: { cpuMilli: 200, memoryMiB: 256 },
      },
      connections: {
        maxClients: 20,
        poolSize: 4,
        maxDatabaseConnections: 8,
        maxUserConnections: 8,
      },
      timeouts: {
        queryWaitSeconds: 5,
        connectSeconds: 5,
        cancelWaitSeconds: 5,
      },
    },
  });
  const grantorResponse = await call(
    `/v1/organizations/${f.organizationId}/budget-tokens/reissue`,
    {
      method: "POST",
      headers: installerHeaders,
    },
  );
  expect(grantorResponse.status).toBe(201);
  const grantor = (await grantorResponse.json()) as { apiToken: string };
  const budgetHeaders = {
    authorization: `Bearer ${grantor.apiToken}`,
    "content-type": "application/json",
  };
  const budgetPath = `/v1/organizations/${f.organizationId}/projects/${f.projectId}/budget`;
  const granted = {
    cpu_millicore_ms: "1000000000",
    memory_byte_ms: "1000000000000000",
    data_storage_byte_ms: "10000000000000000",
  };
  const budgetResponse = await call(budgetPath, {
    method: "PUT",
    headers: budgetHeaders,
    body: JSON.stringify({
      expectedRevision: "0",
      period: {
        start: new Date(Date.now() - 60_000).toISOString(),
        end: new Date(Date.now() + 3_600_000).toISOString(),
      },
      granted,
    }),
  });
  expect(budgetResponse.status).toBe(200);
  const claimResponse = await call(
    `/v1/regions/${f.regionId}/operations/claim`,
    {
      method: "POST",
      headers: f.regionHeaders,
      body: JSON.stringify({ leaseSeconds: 90 }),
    },
  );
  expect(claimResponse.status).toBe(200);
  const current = ((await claimResponse.json()) as { claim: Claim }).claim;
  const path = `/v1/regions/${f.regionId}/operations/${current.operationId}/funding`;
  const request = {
    leaseToken: current.leaseToken,
    leaseEpoch: current.leaseEpoch,
    fundingSeconds: 30,
  };
  const originalNow = Date.now.bind(Date);
  let clockSamples = 0;
  const clock = vi
    .spyOn(Date, "now")
    .mockImplementation(() => originalNow() + ++clockSamples);
  let response: Response;
  try {
    response = await call(path, {
      method: "POST",
      headers: f.regionHeaders,
      body: JSON.stringify(request),
    });
  } finally {
    clock.mockRestore();
  }
  expect(response.status).toBe(201);
  const first = ((await response.json()) as { funding: Funding }).funding;
  expect(
    Date.parse(first.reservation.expiresAt) -
      Date.parse(first.reservation.issuedAt),
  ).toBe(30_000);
  expect(first).toMatchObject({
    version: 1,
    envelopeVersion: 1,
    operationId: current.operationId,
    organizationId: f.organizationId,
    projectId: f.projectId,
    environmentId: f.environmentId,
    regionId: f.regionId,
    specRevision: 1,
    runEpoch: "1",
    fundingSeconds: 30,
    rates: {
      cpu_millicore_ms: "1675",
      memory_byte_ms: "1946157056",
      data_storage_byte_ms: "25769803776",
    },
    units: {
      cpu_millicore_ms: "50250000",
      memory_byte_ms: "58384711680000",
      data_storage_byte_ms: "773094113280000",
    },
    reservation: {
      runtimeEnforced: false,
      enforcementStatus: "pending_runtime",
    },
  });
  expect(first.reservation.units).toEqual(first.units);
  const retained = await env.DB.prepare(
    "SELECT * FROM allowance_reservations WHERE request_id=? AND region_id=?",
  )
    .bind(current.operationId, f.regionId)
    .first();
  expect(retained).toMatchObject({
    id: first.reservation.id,
    environment_id: f.environmentId,
    issued_at: first.reservation.issuedAt,
    expires_at: first.reservation.expiresAt,
  });
  const replay = await call(path, {
    method: "POST",
    headers: f.regionHeaders,
    body: JSON.stringify(request),
  });
  expect(replay.status).toBe(200);
  expect(((await replay.json()) as { funding: Funding }).funding).toEqual(
    first,
  );
  const changed = await call(path, {
    method: "POST",
    headers: f.regionHeaders,
    body: JSON.stringify({ ...request, fundingSeconds: 31 }),
  });
  expect(changed.status).toBe(409);

  const rotatedResponse = await call(
    `/v1/regions/${f.regionId}/tokens/reissue`,
    { method: "POST", headers: installerHeaders },
  );
  expect(rotatedResponse.status).toBe(201);
  const rotated = (await rotatedResponse.json()) as { apiToken: string };
  const nextHeaders = {
    authorization: `Bearer ${rotated.apiToken}`,
    "content-type": "application/json",
  };
  const wrongActor = await call(path, {
    method: "POST",
    headers: nextHeaders,
    body: JSON.stringify(request),
  });
  expect(wrongActor.status).toBe(409);
  await env.DB.prepare("UPDATE operations SET lease_expires_at=? WHERE id=?")
    .bind(new Date(Date.now() - 1000).toISOString(), current.operationId)
    .run();
  const reclaimedResponse = await call(
    `/v1/regions/${f.regionId}/operations/claim`,
    {
      method: "POST",
      headers: nextHeaders,
      body: JSON.stringify({ leaseSeconds: 90 }),
    },
  );
  expect(reclaimedResponse.status).toBe(200);
  const reclaimed = ((await reclaimedResponse.json()) as { claim: Claim })
    .claim;
  expect(reclaimed.operationId).toBe(current.operationId);
  const nextRequest = {
    leaseToken: reclaimed.leaseToken,
    leaseEpoch: reclaimed.leaseEpoch,
    fundingSeconds: 30,
  };
  const recovered = await call(path, {
    method: "POST",
    headers: nextHeaders,
    body: JSON.stringify(nextRequest),
  });
  expect(recovered.status).toBe(200);
  expect(((await recovered.json()) as { funding: Funding }).funding).toEqual(
    first,
  );

  const winningActor = await env.DB.prepare(
    "SELECT lease_actor_token_id AS id FROM operations WHERE id=?",
  )
    .bind(current.operationId)
    .first<{ id: string }>();
  expect(winningActor).not.toBeNull();
  const savedScopes = await env.DB.prepare(
    "SELECT scopes FROM region_tokens WHERE id=?",
  )
    .bind(winningActor!.id)
    .first<{ scopes: string }>();
  expect(savedScopes).not.toBeNull();
  const originalJson = Response.prototype.json;
  let changedAtParse = false;
  const parse = vi
    .spyOn(Response.prototype, "json")
    .mockImplementation(async function (this: Response) {
      const value = (await originalJson.call(this)) as {
        reservation?: { id?: string };
      };
      if (!changedAtParse && value.reservation?.id === first.reservation.id) {
        changedAtParse = true;
        await env.DB.prepare("UPDATE region_tokens SET scopes='' WHERE id=?")
          .bind(winningActor!.id)
          .run();
      }
      return value;
    });
  let revokedAfterService: Response;
  try {
    revokedAfterService = await call(path, {
      method: "POST",
      headers: nextHeaders,
      body: JSON.stringify(nextRequest),
    });
  } finally {
    parse.mockRestore();
    await env.DB.prepare("UPDATE region_tokens SET scopes=? WHERE id=?")
      .bind(savedScopes!.scopes, winningActor!.id)
      .run();
  }
  expect(changedAtParse).toBe(true);
  expect(revokedAfterService.status).toBe(409);
  expect(await revokedAfterService.json()).toEqual({
    error: { code: "provisioning_funding_unavailable" },
  });

  await new Promise((resolve) =>
    setTimeout(
      resolve,
      Math.max(0, Date.parse(first.reservation.expiresAt) - Date.now() + 100),
    ),
  );
  const expired = await call(path, {
    method: "POST",
    headers: nextHeaders,
    body: JSON.stringify(nextRequest),
  });
  expect(expired.status).toBe(409);
  expect(await expired.json()).toEqual({
    error: { code: "provisioning_funding_expired" },
  });
  expect(
    await env.DB.prepare(
      "SELECT * FROM allowance_reservations WHERE request_id=? AND region_id=?",
    )
      .bind(current.operationId, f.regionId)
      .first(),
  ).toEqual(retained);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS count FROM allowance_reservations WHERE environment_id=?",
    )
      .bind(f.environmentId)
      .first(),
  ).toEqual({ count: 1 });
}, 60_000);
