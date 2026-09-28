// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index";
import { accountingCall, accountingFixture } from "./accounting-fixture";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const keys = JSON.stringify({
  active: "test-role-v1",
  keys: { "test-role-v1": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
});
function call(
  path: string,
  init: RequestInit<IncomingRequestCfProperties> = {},
) {
  return worker.fetch(
    new IncomingRequest(`https://control.example.test${path}`, init),
    { ...env, ROLE_CREDENTIAL_KEYS: keys } as typeof env,
  );
}

it("creates an owned database under a verified role, fences rotation until applied and discloses the latest owner credential", async () => {
  const f = await accountingFixture("owned database");
  const creation = (await (
    await accountingCall(`/v1/regions/${f.regionId}/operations/claim`, {
      method: "POST",
      headers: f.regionHeaders,
      body: JSON.stringify({ leaseSeconds: 90 }),
    })
  ).json()) as {
    claim: { operationId: string; leaseToken: string; leaseEpoch: number };
  };
  const namespaceUid = "33333333-3333-4333-8333-333333333333",
    clusterUid = "44444444-4444-4444-8444-444444444444",
    roleUid = "55555555-5555-4555-8555-555555555555",
    secretUid = "66666666-6666-4666-8666-666666666666";
  expect(
    (
      await accountingCall(
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
              clusterUid,
              clusterGeneration: 1,
              readyInstances: 1,
            },
          }),
        },
      )
    ).status,
  ).toBe(200);
  const environmentPath = `/v1/organizations/${f.organizationId}/projects/${f.projectId}/environments/${f.environmentId}`;
  const roleCreated = (await (
    await call(`${environmentPath}/roles`, {
      method: "POST",
      headers: { ...f.orgHeaders, "idempotency-key": "database-owner" },
      body: JSON.stringify({ name: "dbowner", connectionLimit: 20 }),
    })
  ).json()) as { role: { id: string } };
  const roleLane = `/v1/regions/${f.regionId}/role-operations`;
  const owner = (await (
    await call(`${roleLane}/claim`, {
      method: "POST",
      headers: f.regionHeaders,
      body: JSON.stringify({ leaseSeconds: 90 }),
    })
  ).json()) as {
    claim: {
      operationId: string;
      password: string;
      leaseToken: string;
      leaseEpoch: number;
    };
  };
  const roleObservation = {
    namespaceUid,
    clusterUid,
    roleUid,
    roleGeneration: 1,
    roleObservedGeneration: 1,
    secretUid,
    secretResourceVersion: "101",
    roleSecretResourceVersion: "101",
    authenticatedUser: "dbowner",
    authenticatedDatabase: "app",
    writablePrimary: true,
    previousCredentialRejected: null,
  };
  expect(
    (
      await call(`${roleLane}/${owner.claim.operationId}/result`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify({
          leaseToken: owner.claim.leaseToken,
          leaseEpoch: owner.claim.leaseEpoch,
          status: "applied",
          resultCode: "role_verified",
          observation: roleObservation,
        }),
      })
    ).status,
  ).toBe(200);
  const base = `${environmentPath}/databases`;
  const input = { name: "customerdb", ownerRoleId: roleCreated.role.id };
  const create = () =>
    call(base, {
      method: "POST",
      headers: { ...f.orgHeaders, "idempotency-key": "database-create" },
      body: JSON.stringify(input),
    });
  const created = await create();
  expect(created.status).toBe(202);
  const first = (await created.json()) as {
    database: { id: string; name: string; ownerRoleId: string; status: string };
    operation: { id: string };
  };
  expect(first.database).toMatchObject({
    name: "customerdb",
    ownerRoleId: roleCreated.role.id,
    status: "pending",
  });
  expect(JSON.stringify(first)).not.toContain(owner.claim.password);
  expect(await (await create()).json()).toEqual(first);
  expect(
    (
      await call(base, {
        method: "POST",
        headers: { ...f.orgHeaders, "idempotency-key": "database-create" },
        body: JSON.stringify({ ...input, name: "different" }),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call(base, {
        method: "POST",
        headers: { ...f.orgHeaders, "idempotency-key": "reserved-database" },
        body: JSON.stringify({ ...input, name: "app" }),
      })
    ).status,
  ).toBe(400);
  const credentialPath = `${base}/${first.database.id}/credentials`;
  expect((await call(credentialPath, { headers: f.orgHeaders })).status).toBe(
    409,
  );
  expect(
    (await call(credentialPath, { headers: f.regionHeaders })).status,
  ).toBe(401);
  const rotationPath = `${environmentPath}/roles/${roleCreated.role.id}/rotate`;
  const rotate = () =>
    call(rotationPath, {
      method: "POST",
      headers: { ...f.orgHeaders, "idempotency-key": "owner-rotate" },
      body: JSON.stringify({ expectedCredentialRevision: 1 }),
    });
  expect((await rotate()).status).toBe(409);
  const lane = `/v1/regions/${f.regionId}/database-operations`;
  const issued = (await (
    await call(`${lane}/claim`, {
      method: "POST",
      headers: f.regionHeaders,
      body: JSON.stringify({ leaseSeconds: 90 }),
    })
  ).json()) as {
    claim: {
      operationId: string;
      databaseId: string;
      databaseName: string;
      ownerRoleUid: string;
      ownerCredentialRevision: number;
      secretUid: string;
      secretResourceVersion: string;
      password: string;
      leaseToken: string;
      leaseEpoch: number;
    };
  };
  expect(issued.claim).toMatchObject({
    operationId: first.operation.id,
    databaseId: first.database.id,
    databaseName: "customerdb",
    ownerRoleUid: roleUid,
    ownerCredentialRevision: 1,
    secretUid,
    secretResourceVersion: "101",
    password: owner.claim.password,
  });
  const observation = {
    namespaceUid,
    clusterUid,
    ownerRoleUid: roleUid,
    ownerCredentialRevision: 1,
    secretUid,
    secretResourceVersion: "101",
    databaseUid: "77777777-7777-4777-8777-777777777777",
    databaseGeneration: 1,
    databaseObservedGeneration: 1,
    databaseOid: "16400",
    authenticatedUser: "dbowner",
    authenticatedDatabase: "customerdb",
    writablePrimary: true,
    databaseOwned: true,
    schemaCreateVerified: true,
    probeRolledBack: true,
  };
  const report = {
    leaseToken: issued.claim.leaseToken,
    leaseEpoch: issued.claim.leaseEpoch,
    status: "applied",
    resultCode: "database_verified",
    observation,
  };
  expect(
    (
      await call(`${lane}/${issued.claim.operationId}/result`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify({
          ...report,
          observation: { ...observation, databaseOwned: false },
        }),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call(`${lane}/${issued.claim.operationId}/result`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify(report),
      })
    ).status,
  ).toBe(200);
  const credential = (await (
    await call(credentialPath, { headers: f.orgHeaders })
  ).json()) as {
    credential: {
      password: string;
      credentialRevision: number;
      database: string;
    };
  };
  expect(credential.credential).toMatchObject({
    password: owner.claim.password,
    credentialRevision: 1,
    database: "customerdb",
  });
  expect((await rotate()).status).toBe(202);
  expect((await call(credentialPath, { headers: f.orgHeaders })).status).toBe(
    409,
  );
  const rotated = (await (
    await call(`${roleLane}/claim`, {
      method: "POST",
      headers: f.regionHeaders,
      body: JSON.stringify({ leaseSeconds: 90 }),
    })
  ).json()) as typeof owner;
  expect(
    (
      await call(`${roleLane}/${rotated.claim.operationId}/result`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify({
          leaseToken: rotated.claim.leaseToken,
          leaseEpoch: rotated.claim.leaseEpoch,
          status: "applied",
          resultCode: "role_verified",
          observation: {
            ...roleObservation,
            roleGeneration: 2,
            roleObservedGeneration: 2,
            secretUid: "88888888-8888-4888-8888-888888888888",
            secretResourceVersion: "202",
            roleSecretResourceVersion: "202",
            previousCredentialRejected: true,
          },
        }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call(`${lane}/${issued.claim.operationId}/result`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify(report),
      })
    ).status,
  ).toBe(200);
  const current = (await (
    await call(credentialPath, { headers: f.orgHeaders })
  ).json()) as typeof credential;
  expect(current.credential).toMatchObject({
    password: rotated.claim.password,
    credentialRevision: 2,
    database: "customerdb",
  });
  expect(current.credential.password).not.toBe(owner.claim.password);
});
