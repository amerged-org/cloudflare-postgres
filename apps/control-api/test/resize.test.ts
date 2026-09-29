// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import {
  accountingCall as call,
  accountingFixture,
} from "./accounting-fixture";

it("retains one approved manual resize intention without claiming physical or budget authority", async () => {
  const policy = {
    version: 1 as const,
    initialSizeId: "standard",
    sizes: [
      { id: "small", cpuMilli: 250, memoryMiB: 256 },
      { id: "standard", cpuMilli: 500, memoryMiB: 512 },
      { id: "large", cpuMilli: 1000, memoryMiB: 1024 },
    ],
  };
  const f = await accountingFixture("manual resize", policy);
  const claim = await call(`/v1/regions/${f.regionId}/operations/claim`, {
    method: "POST",
    headers: f.regionHeaders,
    body: JSON.stringify({ leaseSeconds: 90 }),
  });
  expect(claim.status).toBe(200);
  const creation = (await claim.json()) as {
    claim: { operationId: string; leaseToken: string; leaseEpoch: number };
  };
  expect(
    (
      await call(
        `/v1/regions/${f.regionId}/operations/${creation.claim.operationId}/result`,
        {
          method: "POST",
          headers: f.regionHeaders,
          body: JSON.stringify({
            leaseToken: creation.claim.leaseToken,
            leaseEpoch: creation.claim.leaseEpoch,
            status: "ready",
            resultCode: "cnpg_ready",
            observation: {
              clusterUid: "33333333-3333-4333-8333-333333333333",
              clusterGeneration: 1,
              readyInstances: 1,
            },
          }),
        },
      )
    ).status,
  ).toBe(200);
  const environment = `/v1/organizations/${f.organizationId}/projects/${f.projectId}/environments/${f.environmentId}`;
  const baselineResponse = await call(`${environment}/compute`, {
    headers: f.orgHeaders,
  });
  expect(baselineResponse.status).toBe(200);
  expect((await baselineResponse.json()) as object).toMatchObject({
    compute: {
      revision: 0,
      requestedSizeId: "standard",
      effectiveSizeId: "standard",
      phase: "effective",
      operationId: null,
    },
  });
  const create = () =>
    call(`${environment}/resize`, {
      method: "POST",
      headers: { ...f.orgHeaders, "idempotency-key": "resize-to-large" },
      body: JSON.stringify({ sizeId: "large", expectedRevision: 0 }),
    });
  const accepted = await create();
  expect(accepted.status).toBe(202);
  const response = (await accepted.json()) as {
    compute: {
      revision: number;
      requestedSizeId: string;
      effectiveSizeId: string;
      phase: string;
      operationId: string;
    };
    operation: { id: string; kind: string; status: string; resultCode: string };
  };
  expect(response.compute).toMatchObject({
    revision: 1,
    requestedSizeId: "large",
    effectiveSizeId: "standard",
    phase: "requested",
  });
  expect(response.operation).toMatchObject({
    id: response.compute.operationId,
    kind: "environment.resize",
    status: "queued",
    resultCode: "awaiting_authority",
  });
  expect((await (await create()).json()) as object).toEqual(response);
  expect(
    (await (
      await call(`${environment}/compute`, { headers: f.orgHeaders })
    ).json()) as object,
  ).toMatchObject({
    compute: response.compute,
  });
  expect(
    (
      await call(
        `/v1/organizations/${f.organizationId}/operations/${response.operation.id}`,
        { headers: f.orgHeaders },
      )
    ).status,
  ).toBe(200);
  expect(JSON.stringify(response)).not.toMatch(
    /clusterUid|specHash|endpointURL|destinationPath|credentialSecret|leaseToken/,
  );
});
