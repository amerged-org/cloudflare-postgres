// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index";
import { accountingCall, accountingFixture } from "./accounting-fixture";

const fixtureKeys = JSON.stringify({
  active: "test-role-v1",
  keys: { "test-role-v1": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
});
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
function call(
  path: string,
  init: RequestInit<IncomingRequestCfProperties> = {},
) {
  return worker.fetch(
    new IncomingRequest(`https://control.example.test${path}`, init),
    {
      ...env,
      ROLE_CREDENTIAL_KEYS: fixtureKeys,
    } as typeof env,
  );
}

it("encrypts durable role intent and reveals only the exact verified current credential through conditional rotation", async () => {
  const f = await accountingFixture("role lifecycle");
  const createClaim = await accountingCall(
    `/v1/regions/${f.regionId}/operations/claim`,
    {
      method: "POST",
      headers: f.regionHeaders,
      body: JSON.stringify({ leaseSeconds: 90 }),
    },
  );
  const creation = (await createClaim.json()) as {
    claim: { operationId: string; leaseToken: string; leaseEpoch: number };
  };
  const clusterUid = "44444444-4444-4444-8444-444444444444";
  const ready = await accountingCall(
    `/v1/regions/${f.regionId}/operations/${creation.claim.operationId}/result`,
    {
      method: "POST",
      headers: f.regionHeaders,
      body: JSON.stringify({
        leaseToken: creation.claim.leaseToken,
        leaseEpoch: creation.claim.leaseEpoch,
        status: "ready",
        resultCode: "cnpg_ready",
        observation: { clusterUid, clusterGeneration: 1, readyInstances: 1 },
      }),
    },
  );
  expect(ready.status).toBe(200);
  const base = `/v1/organizations/${f.organizationId}/projects/${f.projectId}/environments/${f.environmentId}/roles`;
  const input = { name: "reporter", connectionLimit: 20 };
  const create = () =>
    call(base, {
      method: "POST",
      headers: { ...f.orgHeaders, "idempotency-key": "role-create" },
      body: JSON.stringify(input),
    });
  const created = await create();
  expect(created.status).toBe(202);
  expect(created.headers.get("cache-control")).toBe("no-store");
  const first = (await created.json()) as {
    role: { id: string; desiredCredentialRevision: number };
    operation: { id: string };
  };
  expect(first.role.desiredCredentialRevision).toBe(1);
  expect(JSON.stringify(first)).not.toContain("password");
  expect(await (await create()).json()).toEqual(first);
  expect(
    (
      await call(base, {
        method: "POST",
        headers: { ...f.orgHeaders, "idempotency-key": "role-create" },
        body: JSON.stringify({ ...input, name: "another" }),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call(base, {
        method: "POST",
        headers: { ...f.orgHeaders, "idempotency-key": "reserved-role" },
        body: JSON.stringify({ ...input, name: "postgres" }),
      })
    ).status,
  ).toBe(400);
  const credentialPath = `${base}/${first.role.id}/credentials`;
  expect((await call(credentialPath, { headers: f.orgHeaders })).status).toBe(
    409,
  );
  expect(
    (await call(credentialPath, { headers: f.regionHeaders })).status,
  ).toBe(401);
  const lane = `/v1/regions/${f.regionId}/role-operations`;
  const claimed = await call(`${lane}/claim`, {
    method: "POST",
    headers: f.regionHeaders,
    body: JSON.stringify({ leaseSeconds: 90 }),
  });
  expect(claimed.status).toBe(200);
  const grant = (await claimed.json()) as {
    claim: {
      operationId: string;
      roleId: string;
      roleName: string;
      credentialRevision: number;
      password: string;
      previousPassword: string | null;
      clusterUid: string;
      leaseToken: string;
      leaseEpoch: number;
    };
  };
  expect(grant.claim.roleId).toBe(first.role.id);
  expect(grant.claim.clusterUid).toBe(clusterUid);
  expect(grant.claim.previousPassword).toBeNull();
  expect(grant.claim.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const ciphertext = await env.DB.prepare(
    "SELECT encrypted_json FROM role_credentials WHERE role_id = ?",
  )
    .bind(first.role.id)
    .all<{ encrypted_json: string }>();
  expect(ciphertext.results).toHaveLength(1);
  expect(ciphertext.results[0]!.encrypted_json).not.toContain(
    grant.claim.password,
  );
  expect(JSON.parse(ciphertext.results[0]!.encrypted_json).keyId).toBe(
    "test-role-v1",
  );
  const observation = {
    namespaceUid: "33333333-3333-4333-8333-333333333333",
    clusterUid,
    roleUid: "55555555-5555-4555-8555-555555555555",
    roleGeneration: 1,
    roleObservedGeneration: 1,
    secretUid: "66666666-6666-4666-8666-666666666666",
    secretResourceVersion: "101",
    roleSecretResourceVersion: "101",
    authenticatedUser: "reporter",
    authenticatedDatabase: "app",
    writablePrimary: true,
    previousCredentialRejected: null,
  };
  const report = {
    leaseToken: grant.claim.leaseToken,
    leaseEpoch: grant.claim.leaseEpoch,
    status: "applied",
    resultCode: "role_verified",
    observation,
  };
  expect(
    (
      await call(`${lane}/${grant.claim.operationId}/result`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify({
          ...report,
          observation: { ...observation, roleSecretResourceVersion: "old" },
        }),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call(`${lane}/${grant.claim.operationId}/result`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify(report),
      })
    ).status,
  ).toBe(200);
  const disclosed = await call(credentialPath, { headers: f.orgHeaders });
  expect(disclosed.status).toBe(200);
  const oldCredential = (await disclosed.json()) as {
    credential: { password: string; credentialRevision: number };
  };
  expect(oldCredential.credential.password).toBe(grant.claim.password);
  const rotate = () =>
    call(`${base}/${first.role.id}/rotate`, {
      method: "POST",
      headers: { ...f.orgHeaders, "idempotency-key": "role-rotate" },
      body: JSON.stringify({ expectedCredentialRevision: 1 }),
    });
  const rotated = await rotate();
  expect(rotated.status).toBe(202);
  const second = (await rotated.json()) as typeof first;
  expect(second.role.desiredCredentialRevision).toBe(2);
  expect(await (await rotate()).json()).toEqual(second);
  expect((await call(credentialPath, { headers: f.orgHeaders })).status).toBe(
    409,
  );
  expect(
    (
      await call(`${lane}/${grant.claim.operationId}/result`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify(report),
      })
    ).status,
  ).toBe(200);
  expect((await call(credentialPath, { headers: f.orgHeaders })).status).toBe(
    409,
  );
  const next = (await (
    await call(`${lane}/claim`, {
      method: "POST",
      headers: f.regionHeaders,
      body: JSON.stringify({ leaseSeconds: 90 }),
    })
  ).json()) as typeof grant;
  expect(next.claim.credentialRevision).toBe(2);
  expect(next.claim.password).not.toBe(grant.claim.password);
  expect(next.claim.previousPassword).toBe(grant.claim.password);
  expect(
    (
      await call(`${lane}/${next.claim.operationId}/result`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify({
          ...report,
          leaseToken: next.claim.leaseToken,
          leaseEpoch: next.claim.leaseEpoch,
          observation: {
            ...observation,
            roleGeneration: 2,
            roleObservedGeneration: 2,
            secretUid: "77777777-7777-4777-8777-777777777777",
            secretResourceVersion: "202",
            roleSecretResourceVersion: "202",
            previousCredentialRejected: true,
          },
        }),
      })
    ).status,
  ).toBe(200);
  const current = (await (
    await call(credentialPath, { headers: f.orgHeaders })
  ).json()) as typeof oldCredential;
  expect(current.credential.credentialRevision).toBe(2);
  expect(current.credential.password).toBe(next.claim.password);
});
