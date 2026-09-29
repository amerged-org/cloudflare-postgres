// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index";
import {
  accountingCall,
  accountingFixture,
  installerHeaders,
} from "./accounting-fixture";

const pooling = {
  version: 1,
  image: `ghcr.io/cloudnative-pg/pgbouncer@sha256:${"b".repeat(64)}`,
  mode: "session",
  compute: {
    requests: { cpuMilli: 50, memoryMiB: 64 },
    limits: { cpuMilli: 200, memoryMiB: 256 },
  },
  connections: {
    maxClients: 50,
    poolSize: 5,
    maxDatabaseConnections: 10,
    maxUserConnections: 10,
  },
  timeouts: { queryWaitSeconds: 15, connectSeconds: 10, cancelWaitSeconds: 10 },
};

it("freezes an optional generic pooling policy in new catalogs and requires matching Pooler readiness without changing unpooled state", async () => {
  const f = await accountingFixture("managed pooling");
  const existing = await env.DB.prepare(
    "SELECT resolved_spec, spec_hash FROM environments WHERE id = ?",
  )
    .bind(f.environmentId)
    .first<{ resolved_spec: string; spec_hash: string }>();
  expect(existing).not.toBeNull();
  const spec = JSON.parse(existing!.resolved_spec) as {
    profile: Record<string, unknown>;
  };
  const profile = { ...spec.profile, pooling };
  const publish = (value: unknown, version: string) =>
    accountingCall(`/v1/regions/${f.regionId}/catalogs`, {
      method: "POST",
      headers: installerHeaders,
      body: JSON.stringify({ version, profiles: [value] }),
    });
  const catalog = await publish(profile, "pooling-v1");
  expect(catalog.status).toBe(201);
  const publicCatalog = await catalog.json();
  expect(publicCatalog).toMatchObject({
    catalog: { profiles: [expect.objectContaining({ pooling })] },
  });
  expect(JSON.stringify(publicCatalog)).not.toContain("fixture-backup");
  expect((await publish(profile, "pooling-v1")).status).toBe(409);
  expect(
    (
      await publish(
        { ...profile, pooling: { ...pooling, mode: "transaction" } },
        "unsupported-pooling",
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await publish(
        {
          ...profile,
          pooling: { ...pooling, backendURL: "postgres://example.test" },
        },
        "arbitrary-backend",
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
        spec: { profile: Record<string, unknown> };
      };
    };
  const old = await claim();
  const cluster = {
    clusterUid: "44444444-4444-4444-8444-444444444444",
    clusterGeneration: 1,
    readyInstances: 1,
  };
  const report = (grant: typeof old.claim, observation: unknown) =>
    accountingCall(`${lane}/${grant.operationId}/result`, {
      method: "POST",
      headers: f.regionHeaders,
      body: JSON.stringify({
        leaseToken: grant.leaseToken,
        leaseEpoch: grant.leaseEpoch,
        status: "ready",
        resultCode: "cnpg_ready",
        observation,
      }),
    });
  expect((await report(old.claim, cluster)).status).toBe(200);
  expect(
    (
      await accountingCall(`/v1/regions/${f.regionId}/admission`, {
        method: "PUT",
        headers: installerHeaders,
        body: JSON.stringify({
          catalogVersion: "pooling-v1",
          acceptingNewEnvironments: true,
        }),
      })
    ).status,
  ).toBe(200);
  const path = `/v1/organizations/${f.organizationId}/projects/${f.projectId}/environments`;
  const created = await accountingCall(path, {
    method: "POST",
    headers: { ...f.orgHeaders, "idempotency-key": "pooling-environment" },
    body: JSON.stringify({
      name: "pooled",
      regionId: f.regionId,
      catalogVersion: "pooling-v1",
      profileId: "accounting-fixture",
      volumeGiB: 8,
    }),
  });
  expect(created.status).toBe(202);
  const owned = (await created.json()) as {
    environment: {
      id: string;
      resolvedSpec: { profile: Record<string, unknown> };
    };
  };
  expect(owned.environment.resolvedSpec.profile.pooling).toEqual(pooling);
  const pooled = await claim();
  expect(pooled.claim.spec.profile.pooling).toEqual(pooling);
  expect((await report(pooled.claim, cluster)).status).toBe(400);
  const observation = {
    ...cluster,
    pooler: {
      uid: "55555555-5555-4555-8555-555555555555",
      generation: 1,
      deploymentUid: "66666666-6666-4666-8666-666666666666",
      readyInstances: 1,
    },
  };
  expect((await report(pooled.claim, observation)).status).toBe(200);
  const read = await accountingCall(`${path}/${owned.environment.id}`, {
    headers: f.orgHeaders,
  });
  expect(await read.json()).toMatchObject({ environment: { observation } });
  const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
  const role = await worker.fetch(
    new IncomingRequest(
      `https://control.example.test${path}/${owned.environment.id}/roles`,
      {
        method: "POST",
        headers: { ...f.orgHeaders, "idempotency-key": "pooled-owner" },
        body: JSON.stringify({ name: "pooledowner", connectionLimit: 20 }),
      },
    ),
    {
      ...env,
      ROLE_CREDENTIAL_KEYS: JSON.stringify({
        active: "test-pooling-v1",
        keys: {
          "test-pooling-v1": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      }),
    } as typeof env,
  );
  expect(role.status).toBe(202);
  const preserved = await env.DB.prepare(
    "SELECT resolved_spec, spec_hash FROM environments WHERE id = ?",
  )
    .bind(f.environmentId)
    .first();
  expect(preserved).toEqual(existing);
});
