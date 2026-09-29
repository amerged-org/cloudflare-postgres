// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import {
  accountingCall,
  accountingFixture,
  installerHeaders,
} from "./accounting-fixture";

it("pins an explicit node cohort from tracked provisioning into the immutable stop claim without adopting legacy or changed cohort identity", async () => {
  const f = await accountingFixture("node cohort");
  const original = await env.DB.prepare(
    "SELECT resolved_spec FROM environments WHERE id=?",
  )
    .bind(f.environmentId)
    .first<{ resolved_spec: string }>();
  const originalProfile = JSON.parse(original!.resolved_spec).profile;
  const publish = (profile: unknown, version: string) =>
    accountingCall(`/v1/regions/${f.regionId}/catalogs`, {
      method: "POST",
      headers: installerHeaders,
      body: JSON.stringify({ version, profiles: [profile] }),
    });
  const profile = {
    ...originalProfile,
    executionFencing: { version: 1 },
    nodeTracking: { version: 1 },
  };
  const catalog = await publish(profile, "tracked-v1");
  expect(catalog.status).toBe(201);
  expect(await catalog.json()).toMatchObject({
    catalog: {
      profiles: [expect.objectContaining({ nodeTracking: { version: 1 } })],
    },
  });
  expect(
    (
      await publish(
        { ...originalProfile, nodeTracking: { version: 1 } },
        "unfenced-tracking",
      )
    ).status,
  ).toBe(400);
  const lane = `/v1/regions/${f.regionId}/operations`;
  const claim = async () => {
    const r = await accountingCall(`${lane}/claim`, {
      method: "POST",
      headers: f.regionHeaders,
      body: JSON.stringify({ leaseSeconds: 90 }),
    });
    expect(r.status).toBe(200);
    return (
      (await r.json()) as {
        claim: {
          operationId: string;
          leaseToken: string;
          leaseEpoch: number;
          runEpoch?: string;
        };
      }
    ).claim;
  };
  const ready = (c: Awaited<ReturnType<typeof claim>>, observation: unknown) =>
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
  expect((await ready(legacy, observation)).status).toBe(200);
  const pointer = {
    uid: "66666666-6666-4666-8666-666666666666",
    hash: "a".repeat(64),
  };
  expect(
    (await ready(legacy, { ...observation, nodeCohort: pointer })).status,
  ).toBe(400);
  expect(
    (
      await accountingCall(`/v1/regions/${f.regionId}/admission`, {
        method: "PUT",
        headers: installerHeaders,
        body: JSON.stringify({
          catalogVersion: "tracked-v1",
          acceptingNewEnvironments: true,
        }),
      })
    ).status,
  ).toBe(200);
  const collection = `/v1/organizations/${f.organizationId}/projects/${f.projectId}/environments`;
  const created = await accountingCall(collection, {
    method: "POST",
    headers: { ...f.orgHeaders, "idempotency-key": "tracked-environment" },
    body: JSON.stringify({
      name: "tracked",
      regionId: f.regionId,
      catalogVersion: "tracked-v1",
      profileId: profile.id,
      volumeGiB: 8,
    }),
  });
  expect(created.status).toBe(202);
  const environmentId = (
    (await created.json()) as { environment: { id: string } }
  ).environment.id;
  const c = await claim();
  expect(c.runEpoch).toBe("1");
  expect((await ready(c, { ...observation, runEpoch: "1" })).status).toBe(400);
  expect(
    (await ready(c, { ...observation, runEpoch: "1", nodeCohort: pointer }))
      .status,
  ).toBe(200);
  expect(
    (
      await ready(c, {
        ...observation,
        runEpoch: "1",
        nodeCohort: { hash: pointer.hash, uid: pointer.uid },
      })
    ).status,
  ).toBe(200);
  const accepted = await env.DB.prepare(
    "SELECT observation_json FROM environments WHERE id=?",
  )
    .bind(environmentId)
    .first<{ observation_json: string }>();
  expect(JSON.parse(accepted!.observation_json).nodeCohort).toEqual(pointer);
  const stop = await accountingCall(`${collection}/${environmentId}/suspend`, {
    method: "POST",
    headers: { ...f.orgHeaders, "idempotency-key": "tracked-stop" },
    body: JSON.stringify({ expectedRevision: 0 }),
  });
  expect(stop.status).toBe(202);
  const stopLane = `/v1/regions/${f.regionId}/suspend-operations`;
  const leased = await accountingCall(`${stopLane}/claim`, {
    method: "POST",
    headers: f.regionHeaders,
    body: JSON.stringify({ leaseSeconds: 90 }),
  });
  expect(leased.status).toBe(200);
  const s = (
    (await leased.json()) as {
      claim: {
        operationId: string;
        leaseToken: string;
        leaseEpoch: number;
        nodeCohort: { uid: string; hash: string };
      };
    }
  ).claim;
  expect(s.nodeCohort).toEqual(pointer);
  const frozen = await env.DB.prepare(
    "SELECT node_cohort_json FROM environment_suspend_specs WHERE operation_id=?",
  )
    .bind(s.operationId)
    .first<{ node_cohort_json: string }>();
  expect(JSON.parse(frozen!.node_cohort_json)).toEqual(pointer);
  await expect(
    env.DB.prepare(
      "UPDATE environment_suspend_specs SET node_cohort_json=NULL WHERE operation_id=?",
    )
      .bind(s.operationId)
      .run(),
  ).rejects.toThrow();
  await env.DB.prepare("UPDATE environments SET observation_json=? WHERE id=?")
    .bind(
      JSON.stringify({
        ...observation,
        runEpoch: "1",
        nodeCohort: { ...pointer, uid: "77777777-7777-4777-8777-777777777777" },
      }),
      environmentId,
    )
    .run();
  const renewal = await accountingCall(`${stopLane}/${s.operationId}/renew`, {
    method: "POST",
    headers: f.regionHeaders,
    body: JSON.stringify({
      leaseToken: s.leaseToken,
      leaseEpoch: s.leaseEpoch,
      leaseSeconds: 90,
    }),
  });
  expect(renewal.status).toBe(409);
});
