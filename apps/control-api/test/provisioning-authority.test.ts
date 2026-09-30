// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
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

async function state(environmentId: string) {
  const [environment, operation, assertions] = await Promise.all([
    env.DB.prepare("SELECT * FROM environments WHERE id=?")
      .bind(environmentId)
      .first(),
    env.DB.prepare(
      "SELECT * FROM operations WHERE environment_id=? AND kind='environment.create'",
    )
      .bind(environmentId)
      .first(),
    env.DB.prepare(
      "SELECT count(*) AS count FROM accounting_assertions",
    ).first(),
  ]);
  return { environment, operation, assertions };
}

function revokeAtBodyRead(regionId: string, input: unknown) {
  let reads = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        reads++;
        expect(reads).toBe(1);
        // With no eager buffering, this executes only after the route's initial
        // authorization has completed and it starts consuming the request body.
        const reissued = await call(`/v1/regions/${regionId}/tokens/reissue`, {
          method: "POST",
          headers: installerHeaders,
        });
        expect(reissued.status).toBe(201);
        controller.enqueue(new TextEncoder().encode(JSON.stringify(input)));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  return { body, reads: () => reads };
}

async function claim(fixture: Awaited<ReturnType<typeof accountingFixture>>) {
  const response = await call(
    `/v1/regions/${fixture.regionId}/operations/claim`,
    {
      method: "POST",
      headers: fixture.regionHeaders,
      body: JSON.stringify({ leaseSeconds: 60 }),
    },
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { claim: Claim }).claim;
}

it("refuses a provisioning claim revoked at body read without persisting a lease or idle guard", async () => {
  const fixture = await accountingFixture("Revoked provisioning claim");
  const before = await state(fixture.environmentId);
  const barrier = revokeAtBodyRead(fixture.regionId, { leaseSeconds: 60 });
  const response = await call(
    `/v1/regions/${fixture.regionId}/operations/claim`,
    {
      method: "POST",
      headers: fixture.regionHeaders,
      body: barrier.body,
    },
  );

  expect(barrier.reads()).toBe(1);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: { code: "unauthorized" } });
  expect(await state(fixture.environmentId)).toEqual(before);
});

it("refuses provisioning renewal revoked at body read without extending the existing lease", async () => {
  const fixture = await accountingFixture("Revoked provisioning renewal");
  const current = await claim(fixture);
  const before = await state(fixture.environmentId);
  const barrier = revokeAtBodyRead(fixture.regionId, {
    leaseToken: current.leaseToken,
    leaseEpoch: current.leaseEpoch,
    leaseSeconds: 90,
  });
  const response = await call(
    `/v1/regions/${fixture.regionId}/operations/${current.operationId}/renew`,
    { method: "POST", headers: fixture.regionHeaders, body: barrier.body },
  );

  expect(barrier.reads()).toBe(1);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: { code: "unauthorized" } });
  expect(await state(fixture.environmentId)).toEqual(before);
});

it("refuses a provisioning result revoked at body read without publishing a terminal state", async () => {
  const fixture = await accountingFixture("Revoked provisioning result");
  const current = await claim(fixture);
  const before = await state(fixture.environmentId);
  const barrier = revokeAtBodyRead(fixture.regionId, {
    leaseToken: current.leaseToken,
    leaseEpoch: current.leaseEpoch,
    status: "failed",
    resultCode: "reconcile_failed",
    observation: null,
  });
  const response = await call(
    `/v1/regions/${fixture.regionId}/operations/${current.operationId}/result`,
    { method: "POST", headers: fixture.regionHeaders, body: barrier.body },
  );

  expect(barrier.reads()).toBe(1);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: { code: "unauthorized" } });
  expect(await state(fixture.environmentId)).toEqual(before);
});
