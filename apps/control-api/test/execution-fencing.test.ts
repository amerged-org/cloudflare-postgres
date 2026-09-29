// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import {
  accountingCall,
  accountingFixture,
  installerHeaders,
} from "./accounting-fixture";

it("freezes explicit execution fencing for a new environment and carries its initial epoch through readiness and suspension without adopting legacy state", async () => {
  const f = await accountingFixture("execution fencing");
  const old = await env.DB.prepare(
    "SELECT resolved_spec,spec_hash FROM environments WHERE id=?",
  )
    .bind(f.environmentId)
    .first<{ resolved_spec: string; spec_hash: string }>();
  const spec = JSON.parse(old!.resolved_spec) as {
    profile: Record<string, unknown>;
  };
  const profile = { ...spec.profile, executionFencing: { version: 1 } };
  const publish = (p: unknown, version: string) =>
    accountingCall(`/v1/regions/${f.regionId}/catalogs`, {
      method: "POST",
      headers: installerHeaders,
      body: JSON.stringify({ version, profiles: [p] }),
    });
  const catalog = await publish(profile, "fenced-v1");
  expect(catalog.status).toBe(201);
  expect(await catalog.json()).toMatchObject({
    catalog: {
      profiles: [expect.objectContaining({ executionFencing: { version: 1 } })],
    },
  });
  expect(
    (
      await publish(
        { ...profile, executionFencing: { version: 1, epoch: "99" } },
        "caller-epoch",
      )
    ).status,
  ).toBe(400);
  const lane = `/v1/regions/${f.regionId}/operations`;
  const claim = async () =>
    (await (
      await accountingCall(`${lane}/claim`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify({ leaseSeconds: 90 }),
      })
    ).json()) as {
      claim: {
        operationId: string;
        leaseToken: string;
        leaseEpoch: number;
        runEpoch?: string;
      };
    };
  const ready = (
    c: Awaited<ReturnType<typeof claim>>["claim"],
    observation: unknown,
  ) =>
    accountingCall(`${lane}/${c.operationId}/result`, {
      method: "POST",
      headers: f.regionHeaders,
      body: JSON.stringify({
        leaseToken: c.leaseToken,
        leaseEpoch: c.leaseEpoch,
        status: "ready",
        resultCode: "cnpg_ready",
        observation,
      }),
    });
  const observation = {
    clusterUid: "44444444-4444-4444-8444-444444444444",
    clusterGeneration: 1,
    readyInstances: 1,
  };
  const legacy = await claim();
  expect(legacy.claim.runEpoch).toBeUndefined();
  expect((await ready(legacy.claim, observation)).status).toBe(200);
  expect(
    (
      await accountingCall(`/v1/regions/${f.regionId}/admission`, {
        method: "PUT",
        headers: installerHeaders,
        body: JSON.stringify({
          catalogVersion: "fenced-v1",
          acceptingNewEnvironments: true,
        }),
      })
    ).status,
  ).toBe(200);
  const collection = `/v1/organizations/${f.organizationId}/projects/${f.projectId}/environments`;
  const response = await accountingCall(collection, {
    method: "POST",
    headers: { ...f.orgHeaders, "idempotency-key": "fenced-environment" },
    body: JSON.stringify({
      name: "fenced",
      regionId: f.regionId,
      catalogVersion: "fenced-v1",
      profileId: "accounting-fixture",
      volumeGiB: 8,
    }),
  });
  expect(response.status).toBe(202);
  const created = (await response.json()) as {
    environment: { id: string; runEpoch: string };
  };
  expect(created.environment.runEpoch).toBe("1");
  const fenced = await claim();
  expect(fenced.claim.runEpoch).toBe("1");
  expect((await ready(fenced.claim, observation)).status).toBe(400);
  expect(
    (await ready(fenced.claim, { ...observation, runEpoch: "2" })).status,
  ).toBe(400);
  expect(
    (await ready(fenced.claim, { ...observation, runEpoch: "1" })).status,
  ).toBe(200);
  const path = `${collection}/${created.environment.id}`;
  const suspended = await accountingCall(`${path}/suspend`, {
    method: "POST",
    headers: { ...f.orgHeaders, "idempotency-key": "fenced-suspend" },
    body: JSON.stringify({ expectedRevision: 0 }),
  });
  expect(suspended.status).toBe(202);
  const stop = (await (
    await accountingCall(`/v1/regions/${f.regionId}/suspend-operations/claim`, {
      method: "POST",
      headers: f.regionHeaders,
      body: JSON.stringify({ leaseSeconds: 90 }),
    })
  ).json()) as { claim: { runEpoch: string } };
  expect(stop.claim.runEpoch).toBe("1");
  expect(
    await env.DB.prepare(
      "SELECT resolved_spec,spec_hash FROM environments WHERE id=?",
    )
      .bind(f.environmentId)
      .first(),
  ).toEqual(old);
});
