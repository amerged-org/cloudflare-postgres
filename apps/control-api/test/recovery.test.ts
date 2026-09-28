// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index";
import { accountingCall, accountingFixture } from "./accounting-fixture";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const keys = JSON.stringify({
  active: "recovery-test-v1",
  keys: { "recovery-test-v1": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
});
function call(
  path: string,
  init: RequestInit<IncomingRequestCfProperties> = {},
) {
  return worker.fetch(
    new IncomingRequest(`https://control.example.test${path}`, init),
    {
      ...env,
      ROLE_CREDENTIAL_KEYS: keys,
    } as typeof env,
  );
}
type Fixture = Awaited<ReturnType<typeof accountingFixture>>;
function base(f: Fixture) {
  return `/v1/organizations/${f.organizationId}/projects/${f.projectId}/environments/${f.environmentId}`;
}
const clusterUid = "44444444-4444-4444-8444-444444444444";
const roleObservation = {
  namespaceUid: "33333333-3333-4333-8333-333333333333",
  clusterUid,
  roleUid: "55555555-5555-4555-8555-555555555555",
  roleGeneration: 1,
  roleObservedGeneration: 1,
  secretUid: "66666666-6666-4666-8666-666666666666",
  secretResourceVersion: "101",
  roleSecretResourceVersion: "101",
  authenticatedUser: "recoverowner",
  authenticatedDatabase: "app",
  writablePrimary: true,
  previousCredentialRejected: null,
};
async function ready(f: Fixture) {
  const { claim } = (await (
    await accountingCall(`/v1/regions/${f.regionId}/operations/claim`, {
      method: "POST",
      headers: f.regionHeaders,
      body: JSON.stringify({ leaseSeconds: 90 }),
    })
  ).json()) as {
    claim: { operationId: string; leaseToken: string; leaseEpoch: number };
  };
  expect(
    (
      await accountingCall(
        `/v1/regions/${f.regionId}/operations/${claim.operationId}/result`,
        {
          method: "POST",
          headers: f.regionHeaders,
          body: JSON.stringify({
            leaseToken: claim.leaseToken,
            leaseEpoch: claim.leaseEpoch,
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
}
async function owner(f: Fixture) {
  await ready(f);
  const response = await call(`${base(f)}/roles`, {
    method: "POST",
    headers: { ...f.orgHeaders, "idempotency-key": "recover-role" },
    body: JSON.stringify({ name: "recoverowner", connectionLimit: 20 }),
  });
  expect(response.status).toBe(202);
  return (await response.json()) as {
    role: { id: string };
    operation: { id: string };
  };
}
async function appliedOwner(f: Fixture) {
  const created = await owner(f);
  const { claim } = (await (
    await call(`/v1/regions/${f.regionId}/role-operations/claim`, {
      method: "POST",
      headers: f.regionHeaders,
      body: JSON.stringify({ leaseSeconds: 90 }),
    })
  ).json()) as {
    claim: {
      operationId: string;
      leaseToken: string;
      leaseEpoch: number;
      password: string;
    };
  };
  expect(
    (
      await call(
        `/v1/regions/${f.regionId}/role-operations/${claim.operationId}/result`,
        {
          method: "POST",
          headers: f.regionHeaders,
          body: JSON.stringify({
            leaseToken: claim.leaseToken,
            leaseEpoch: claim.leaseEpoch,
            status: "applied",
            resultCode: "role_verified",
            observation: roleObservation,
          }),
        },
      )
    ).status,
  ).toBe(200);
  return { ...created, claim };
}

it("recovers project and environment identities with bounded parent-bound pages and private catalog redaction", async () => {
  const f = await accountingFixture("recovery pages");
  const projects = await call(
    `/v1/organizations/${f.organizationId}/projects`,
    { headers: f.orgHeaders },
  );
  expect(projects.status).toBe(200);
  const projectPage = (await projects.json()) as {
    projects: Array<{ project: { id: string }; currentOperationId: string }>;
  };
  expect(projectPage.projects).toHaveLength(1);
  expect(projectPage.projects[0]!.project.id).toBe(f.projectId);
  expect(
    (
      await call(
        `/v1/organizations/${f.organizationId}/operations/${projectPage.projects[0]!.currentOperationId}`,
        { headers: f.orgHeaders },
      )
    ).status,
  ).toBe(200);
  const collection = `/v1/organizations/${f.organizationId}/projects/${f.projectId}/environments`;
  const second = await accountingCall(collection, {
    method: "POST",
    headers: {
      ...f.orgHeaders,
      "idempotency-key": "second-recovery-environment",
    },
    body: JSON.stringify({
      name: "second",
      regionId: f.regionId,
      catalogVersion: "accounting-v1",
      profileId: "accounting-fixture",
      volumeGiB: 8,
    }),
  });
  expect(second.status).toBe(202);
  const first = await call(`${collection}?limit=1`, { headers: f.orgHeaders });
  expect(first.status).toBe(200);
  expect(first.headers.get("cache-control")).toBe("no-store");
  type Page = {
    environments: Array<{
      environment: { id: string };
      currentOperationId: string;
    }>;
    nextCursor: string | null;
    consistency: string;
    observedAt: string;
  };
  const page = (await first.json()) as Page;
  expect(page.consistency).toBe("observed-page");
  expect(page.environments).toHaveLength(1);
  expect(page.nextCursor).toEqual(expect.any(String));
  expect(Number.isFinite(Date.parse(page.observedAt))).toBe(true);
  expect(JSON.stringify(page)).not.toContain("fixture-backup");
  expect(JSON.stringify(page)).not.toContain("object-store.example.test");
  const last = (await (
    await call(`${collection}?limit=1&cursor=${page.nextCursor}`, {
      headers: f.orgHeaders,
    })
  ).json()) as Page;
  expect(last.nextCursor).toBeNull();
  expect(last.environments).toHaveLength(1);
  expect(
    new Set(
      [...page.environments, ...last.environments].map((x) => x.environment.id),
    ).size,
  ).toBe(2);
  expect(
    (
      await call(`${base(f)}/roles?limit=1&cursor=${page.nextCursor}`, {
        headers: f.orgHeaders,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call(`${collection}?limit=2&cursor=${page.nextCursor}`, {
        headers: f.orgHeaders,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call(`${collection}?limit=1&cursor=${page.nextCursor}x`, {
        headers: f.orgHeaders,
      })
    ).status,
  ).toBe(400);
  expect(
    (await call(`${collection}?limit=1&limit=1`, { headers: f.orgHeaders }))
      .status,
  ).toBe(400);
});

it("recovers pending roles and historical rotation tasks without credential or lease disclosure", async () => {
  const f = await accountingFixture("role recovery");
  const created = await appliedOwner(f);
  const rotation = await call(`${base(f)}/roles/${created.role.id}/rotate`, {
    method: "POST",
    headers: { ...f.orgHeaders, "idempotency-key": "recover-rotation" },
    body: JSON.stringify({ expectedCredentialRevision: 1 }),
  });
  expect(rotation.status).toBe(202);
  const rotated = (await rotation.json()) as typeof created;
  const listed = await call(`${base(f)}/roles`, { headers: f.orgHeaders });
  expect(listed.status).toBe(200);
  const page = (await listed.json()) as {
    roles: Array<{
      role: { id: string; status: string; desiredCredentialRevision: number };
      currentOperationId: string;
    }>;
  };
  expect(page.roles).toEqual([
    expect.objectContaining({
      role: expect.objectContaining({
        id: created.role.id,
        status: "pending",
        desiredCredentialRevision: 2,
      }),
      currentOperationId: rotated.operation.id,
    }),
  ]);
  const path = `/v1/organizations/${f.organizationId}/operations/`;
  const current = await call(path + rotated.operation.id, {
    headers: f.orgHeaders,
  });
  expect(current.status).toBe(200);
  const currentBody = await current.json();
  expect(currentBody).toMatchObject({
    operation: {
      id: rotated.operation.id,
      organizationId: f.organizationId,
      projectId: f.projectId,
      environmentId: f.environmentId,
      roleId: created.role.id,
      credentialRevision: 2,
      status: "queued",
    },
  });
  const historical = await call(path + created.operation.id, {
    headers: f.orgHeaders,
  });
  expect(historical.status).toBe(200);
  expect(await historical.json()).toMatchObject({
    operation: {
      credentialRevision: 1,
      status: "applied",
      resultCode: "role_verified",
    },
  });
  const text = JSON.stringify([page, currentBody]);
  expect(text).not.toContain(created.claim.password);
  expect(text).not.toContain(created.claim.leaseToken);
  expect(text).not.toMatch(
    /encrypted_json|lease_token_hash|lease_epoch|version_token/,
  );
  await env.DB.prepare(
    "UPDATE api_tokens SET scopes = 'projects:read' WHERE organization_id = ?",
  )
    .bind(f.organizationId)
    .run();
  expect(
    (await call(`${base(f)}/roles`, { headers: f.orgHeaders })).status,
  ).toBe(200);
  expect(
    (await call(path + rotated.operation.id, { headers: f.orgHeaders })).status,
  ).toBe(403);
});

it("recovers database task state during regional unavailability and rejects foreign parents, ambiguous task IDs and revoked actors", async () => {
  const f = await accountingFixture("database recovery");
  const owned = await appliedOwner(f);
  const created = await call(`${base(f)}/databases`, {
    method: "POST",
    headers: { ...f.orgHeaders, "idempotency-key": "recover-database" },
    body: JSON.stringify({ name: "recoverydb", ownerRoleId: owned.role.id }),
  });
  expect(created.status).toBe(202);
  const database = (await created.json()) as {
    database: { id: string };
    operation: { id: string };
  };
  await env.DB.prepare("UPDATE regions SET status = 'disabled' WHERE id = ?")
    .bind(f.regionId)
    .run();
  const listed = await call(`${base(f)}/databases`, { headers: f.orgHeaders });
  expect(listed.status).toBe(200);
  const page = (await listed.json()) as {
    databases: Array<{ database: { id: string }; currentOperationId: string }>;
  };
  expect(page.databases).toEqual([
    expect.objectContaining({
      database: expect.objectContaining({ id: database.database.id }),
      currentOperationId: database.operation.id,
    }),
  ]);
  const operationPath = `/v1/organizations/${f.organizationId}/operations/${database.operation.id}`;
  const observed = await call(operationPath, { headers: f.orgHeaders });
  expect(observed.status).toBe(200);
  const body = await observed.json();
  expect(body).toMatchObject({
    operation: {
      databaseId: database.database.id,
      organizationId: f.organizationId,
      environmentId: f.environmentId,
      status: "queued",
    },
  });
  expect(JSON.stringify([body, page])).not.toContain(owned.claim.password);
  const foreign = await accountingFixture("foreign recovery");
  expect(
    (await call(`${base(foreign)}/databases`, { headers: f.orgHeaders }))
      .status,
  ).toBe(404);
  expect(
    (await call(operationPath, { headers: foreign.orgHeaders })).status,
  ).toBe(404);
  expect(
    (await call(`${base(foreign)}/databases`, { headers: foreign.orgHeaders }))
      .status,
  ).toBe(200);
  const unknown = "77777777-7777-4777-8777-777777777777";
  expect(
    (
      await call(`${base(f).replace(f.environmentId, unknown)}/databases`, {
        headers: f.orgHeaders,
      })
    ).status,
  ).toBe(404);
  expect(
    (await call(`${base(f)}/databases`, { headers: f.regionHeaders })).status,
  ).toBe(401);
  await env.DB.prepare(
    "INSERT INTO operations (id, organization_id, project_id, kind, status, created_at, observed_at, result_code) VALUES (?, ?, ?, 'project.create', 'succeeded', ?, ?, 'logical_container_created')",
  )
    .bind(
      database.operation.id,
      f.organizationId,
      f.projectId,
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
  expect((await call(operationPath, { headers: f.orgHeaders })).status).toBe(
    500,
  );
  await env.DB.prepare(
    "UPDATE api_tokens SET revoked_at = ? WHERE organization_id = ?",
  )
    .bind(new Date().toISOString(), f.organizationId)
    .run();
  expect(
    (await call(`${base(f)}/databases`, { headers: f.orgHeaders })).status,
  ).toBe(401);
});
