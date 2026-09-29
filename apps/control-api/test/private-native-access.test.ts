// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import {
  accountingCall as call,
  accountingFixture,
  installerHeaders,
} from "./accounting-fixture";
import { testCA } from "./private-native-certificate";

interface Claim {
  operationId: string;
  environmentId: string;
  leaseToken: string;
  leaseEpoch: number;
  specHash: string;
  spec: {
    profile: { nativeAccess?: { version: number; clientProfileId: string } };
  };
}
async function claim(f: Awaited<ReturnType<typeof accountingFixture>>) {
  const response = await call(`/v1/regions/${f.regionId}/operations/claim`, {
    method: "POST",
    headers: f.regionHeaders,
    body: JSON.stringify({ leaseSeconds: 60 }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { claim: Claim }).claim;
}

it("publishes only a fenced opt-in private native endpoint and restricts discovery to current owned running authority", async () => {
  const f = await accountingFixture("Private native access");
  const base = `/v1/organizations/${f.organizationId}/projects/${f.projectId}/environments`;
  const legacy = await claim(f);
  const readyLegacy = await call(
    `/v1/regions/${f.regionId}/operations/${legacy.operationId}/result`,
    {
      method: "POST",
      headers: f.regionHeaders,
      body: JSON.stringify({
        leaseToken: legacy.leaseToken,
        leaseEpoch: legacy.leaseEpoch,
        status: "ready",
        resultCode: "cnpg_ready",
        observation: {
          clusterUid: "11111111-1111-4111-8111-111111111111",
          clusterGeneration: 1,
          readyInstances: 1,
        },
      }),
    },
  );
  expect(readyLegacy.status).toBe(200);
  expect(
    (
      await call(`${base}/${f.environmentId}/connections`, {
        headers: f.orgHeaders,
      })
    ).status,
  ).toBe(409);
  const stored = await env.DB.prepare(
    "SELECT resolved_spec FROM environments WHERE id = ?",
  )
    .bind(f.environmentId)
    .first<{ resolved_spec: string }>();
  const oldSpec = JSON.parse(stored!.resolved_spec) as {
    profile: Record<string, unknown> & { id: string };
  };
  const profile = {
    ...oldSpec.profile,
    nativeAccess: { version: 1, clientProfileId: "private-application" },
  };
  const published = await call(`/v1/regions/${f.regionId}/catalogs`, {
    method: "POST",
    headers: installerHeaders,
    body: JSON.stringify({ version: "private-native-v1", profiles: [profile] }),
  });
  expect(
    published.status,
    "an installation catalog must opt into native client access without customer selectors",
  ).toBe(201);
  const admitted = await call(`/v1/regions/${f.regionId}/admission`, {
    method: "PUT",
    headers: installerHeaders,
    body: JSON.stringify({
      catalogVersion: "private-native-v1",
      acceptingNewEnvironments: true,
    }),
  });
  expect(admitted.status).toBe(200);
  const created = await call(base, {
    method: "POST",
    headers: { ...f.orgHeaders, "idempotency-key": "private-native" },
    body: JSON.stringify({
      name: "Private native environment",
      regionId: f.regionId,
      catalogVersion: "private-native-v1",
      profileId: profile.id,
      volumeGiB: 8,
    }),
  });
  expect(created.status).toBe(202);
  const environment = (
    (await created.json()) as { environment: { id: string; specHash: string } }
  ).environment;
  const route = `${base}/${environment.id}/connections`;
  expect((await call(route, { headers: f.orgHeaders })).status).toBe(409);
  const task = await claim(f);
  expect(task.environmentId).toBe(environment.id);
  expect(task.spec.profile.nativeAccess).toEqual(profile.nativeAccess);
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(testCA),
  );
  const caHash = Array.from(new Uint8Array(bytes), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  const observation = {
    clusterUid: "11111111-1111-4111-8111-111111111111",
    clusterGeneration: 1,
    readyInstances: 1,
    nativeConnection: {
      version: 1,
      visibility: "private",
      mode: "direct",
      clientProfileId: "private-application",
      namespaceUid: "22222222-2222-4222-8222-222222222222",
      clusterUid: "11111111-1111-4111-8111-111111111111",
      clusterGeneration: 1,
      specHash: task.specHash,
      serviceUid: "33333333-3333-4333-8333-333333333333",
      serviceResourceVersion: "10",
      primaryPodUid: "44444444-4444-4444-8444-444444444444",
      endpointSliceUid: "55555555-5555-4555-8555-555555555555",
      policyUid: "66666666-6666-4666-8666-666666666666",
      host: `database-rw.pgcf-${environment.id.replaceAll("-", "")}.svc`,
      port: 5432,
      caCertificate: testCA,
      caCertificateSha256: caHash,
      serverCertificateSha256: "a".repeat(64),
      caValidFrom: "2026-09-29T13:28:08.000Z",
      caValidUntil: "2036-09-26T13:28:08.000Z",
      serverValidUntil: "2036-09-26T13:28:08.000Z",
      observedAt: new Date().toISOString(),
    },
  };
  const resultInput = {
    leaseToken: task.leaseToken,
    leaseEpoch: task.leaseEpoch,
    status: "ready",
    resultCode: "cnpg_ready",
    observation,
  };
  const resultPath = `/v1/regions/${f.regionId}/operations/${task.operationId}/result`;
  const wrong = await call(resultPath, {
    method: "POST",
    headers: f.regionHeaders,
    body: JSON.stringify({
      ...resultInput,
      observation: {
        ...observation,
        nativeConnection: {
          ...observation.nativeConnection,
          specHash: "b".repeat(64),
        },
      },
    }),
  });
  expect(wrong.status).toBe(400);
  const result = await call(resultPath, {
    method: "POST",
    headers: f.regionHeaders,
    body: JSON.stringify(resultInput),
  });
  expect(result.status).toBe(200);
  const replay = await call(resultPath, {
    method: "POST",
    headers: f.regionHeaders,
    body: JSON.stringify(resultInput),
  });
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(await result.json());
  const connected = await call(route, { headers: f.orgHeaders });
  expect(connected.status).toBe(200);
  expect(connected.headers.get("cache-control")).toBe("no-store");
  const content = await connected.json();
  expect(content).toMatchObject({
    connection: {
      environmentId: environment.id,
      host: observation.nativeConnection.host,
      port: 5432,
      visibility: "private",
      mode: "direct",
      sslmode: "verify-full",
      caCertificate: testCA,
      observedAt: observation.nativeConnection.observedAt,
      observationScope: "provisioning",
    },
  });
  expect(JSON.stringify(content)).not.toContain("password");
  expect(JSON.stringify(content)).not.toContain("PRIVATE KEY");
  const foreign = await accountingFixture("Foreign native access");
  expect((await call(route, { headers: foreign.orgHeaders })).status).toBe(404);
  expect((await call(route, { headers: f.regionHeaders })).status).toBe(401);
  const grantor = await call(
    `/v1/organizations/${f.organizationId}/budget-tokens/reissue`,
    { method: "POST", headers: installerHeaders },
  );
  expect(grantor.status).toBe(201);
  const budgetToken = ((await grantor.json()) as { apiToken: string }).apiToken;
  const budgetHeaders = {
    authorization: `Bearer ${budgetToken}`,
    "content-type": "application/json",
  };
  const budgetPath = `/v1/organizations/${f.organizationId}/projects/${f.projectId}/budget`;
  const now = Date.now();
  expect(
    (
      await call(budgetPath, {
        method: "PUT",
        headers: budgetHeaders,
        body: JSON.stringify({
          expectedRevision: "0",
          period: {
            start: new Date(now - 60_000).toISOString(),
            end: new Date(now + 3_600_000).toISOString(),
          },
          granted: { cpu_millicore_ms: "100000" },
        }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call(`${budgetPath}/pause`, {
        method: "POST",
        headers: budgetHeaders,
        body: JSON.stringify({ expectedRevision: "1" }),
      })
    ).status,
  ).toBe(200);
  expect((await call(route, { headers: f.orgHeaders })).status).toBe(409);
  expect(
    (
      await call(`${budgetPath}/resume`, {
        method: "POST",
        headers: budgetHeaders,
        body: JSON.stringify({ expectedRevision: "2" }),
      })
    ).status,
  ).toBe(200);
  expect((await call(route, { headers: f.orgHeaders })).status).toBe(200);
  const suspended = await call(`${base}/${environment.id}/suspend`, {
    method: "POST",
    headers: { ...f.orgHeaders, "idempotency-key": "private-native-suspend" },
    body: JSON.stringify({ expectedRevision: 0 }),
  });
  expect(suspended.status).toBe(202);
  expect((await call(route, { headers: f.orgHeaders })).status).toBe(409);
});
