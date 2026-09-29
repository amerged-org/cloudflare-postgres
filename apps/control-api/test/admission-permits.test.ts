// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index";
import { accountingCall as call, installerHeaders } from "./accounting-fixture";

async function hash(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
async function fixture(label: string) {
  const org = await call("/v1/organizations", {
    method: "POST",
    headers: installerHeaders,
    body: JSON.stringify({ name: `${label} org` }),
  });
  expect(org.status).toBe(201);
  const owner = (await org.json()) as {
    organization: { id: string };
    apiToken: string;
  };
  const headers = {
    authorization: `Bearer ${owner.apiToken}`,
    "content-type": "application/json",
  };
  const project = await call(
    `/v1/organizations/${owner.organization.id}/projects`,
    {
      method: "POST",
      headers: { ...headers, "idempotency-key": "project" },
      body: JSON.stringify({ name: `${label} project` }),
    },
  );
  expect(project.status).toBe(201);
  const p = (await project.json()) as { project: { id: string } };
  const region = await call("/v1/regions", {
    method: "POST",
    headers: installerHeaders,
    body: JSON.stringify({ name: `${label} region` }),
  });
  expect(region.status).toBe(201);
  const r = (await region.json()) as { region: { id: string } };
  const profile = {
    id: "commissioning",
    postgresImage: `ghcr.io/cloudnative-pg/postgresql@sha256:${"a".repeat(64)}`,
    compute: { cpuMilli: 500, memoryMiB: 512 },
    storage: {
      classId: "local-volume",
      storageClassName: "test-local",
      minGiB: 4,
      maxGiB: 64,
      stepGiB: 4,
    },
    instances: 1,
    backup: {
      region: "auto",
      endpointURL: "https://object-store.example.test",
      destinationPath: "s3://fixture-backups/commissioning",
      retentionPolicy: "30d",
      credentialSecret: {
        namespace: "platform-secrets",
        name: "fixture-backup",
        accessKeyIdKey: "ACCESS_KEY_ID",
        secretAccessKeyKey: "SECRET_ACCESS_KEY",
      },
    },
  };
  const published = await call(`/v1/regions/${r.region.id}/catalogs`, {
    method: "POST",
    headers: installerHeaders,
    body: JSON.stringify({ version: "commissioning-v1", profiles: [profile] }),
  });
  expect(published.status).toBe(201);
  const c = (await published.json()) as { catalog: { catalogHash: string } };
  const input = {
    name: `${label} environment`,
    regionId: r.region.id,
    catalogVersion: "commissioning-v1",
    profileId: profile.id,
    volumeGiB: 8,
  };
  const issuance = {
    organizationId: owner.organization.id,
    projectId: p.project.id,
    ...input,
    catalogHash: c.catalog.catalogHash,
    specHash: await hash(JSON.stringify({ ...input, profile })),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  };
  return {
    organizationId: owner.organization.id,
    projectId: p.project.id,
    regionId: r.region.id,
    input,
    issuance,
    headers,
    path: `/v1/organizations/${owner.organization.id}/projects/${p.project.id}/environments`,
  };
}
type PermitResponse = {
  permit: {
    id: string;
    status: string;
    specHash: string;
    consumedEnvironmentId: string | null;
    consumedOperationId: string | null;
  };
};
const permits = "/v1/environment-admission-permits";
async function issue(
  f: Awaited<ReturnType<typeof fixture>>,
  key: string,
  overrides: object = {},
) {
  return call(permits, {
    method: "POST",
    headers: { ...installerHeaders, "idempotency-key": key },
    body: JSON.stringify({ ...f.issuance, ...overrides }),
  });
}
function create(
  f: Awaited<ReturnType<typeof fixture>>,
  key: string,
  admissionPermitId?: string,
  overrides: object = {},
) {
  return call(f.path, {
    method: "POST",
    headers: { ...f.headers, "idempotency-key": key },
    body: JSON.stringify({
      ...f.input,
      ...(admissionPermitId ? { admissionPermitId } : {}),
      ...overrides,
    }),
  });
}

it("commissions an exactly bound environment once with ordinary authorization and retained replay while global admission stays closed", async () => {
  const f = await fixture("permit lifecycle");
  expect((await create(f, "ordinary")).status).toBe(409);
  expect(
    (
      await call(permits, {
        method: "POST",
        headers: { ...f.headers, "idempotency-key": "not-installer" },
        body: JSON.stringify(f.issuance),
      })
    ).status,
  ).toBe(401);
  expect(
    (await issue(f, "wrong-hash", { specHash: "0".repeat(64) })).status,
  ).toBe(409);
  expect(
    (await issue(f, "wrong-catalog", { catalogHash: "0".repeat(64) })).status,
  ).toBe(409);
  expect(
    (
      await issue(f, "unbounded", {
        expiresAt: new Date(Date.now() + 3_700_000).toISOString(),
      })
    ).status,
  ).toBe(400);
  const issued = await issue(f, "permit-one");
  expect(issued.status).toBe(201);
  const p = (await issued.json()) as PermitResponse;
  expect(p.permit).toMatchObject({
    status: "issued",
    specHash: f.issuance.specHash,
    consumedEnvironmentId: null,
  });
  expect((await (await issue(f, "permit-one")).json()) as object).toEqual(p);
  expect((await issue(f, "permit-one", { name: "changed" })).status).toBe(409);
  expect(
    (await create(f, "wrong-binding", p.permit.id, { volumeGiB: 12 })).status,
  ).toBe(409);
  expect(
    (await create(f, "invalid-id", "00000000-0000-4000-8000-000000000099"))
      .status,
  ).toBe(409);
  const [accepted, concurrentReplay] = await Promise.all([
    create(f, "commission", p.permit.id),
    create(f, "commission", p.permit.id),
  ]);
  expect(accepted.status).toBe(202);
  expect(concurrentReplay.status).toBe(202);
  const result = (await accepted.json()) as {
    environment: { id: string; specHash: string; resolvedSpec: object };
    operation: { id: string };
  };
  expect(result.environment.specHash).toBe(f.issuance.specHash);
  expect(await concurrentReplay.json()).toEqual(result);
  expect(JSON.stringify(result.environment.resolvedSpec)).not.toContain(
    "admissionPermitId",
  );
  expect(
    (await (await create(f, "commission", p.permit.id)).json()) as object,
  ).toEqual(result);
  expect(
    (await create(f, "commission", p.permit.id, { name: "changed" })).status,
  ).toBe(409);
  expect((await create(f, "second-use", p.permit.id)).status).toBe(409);
  const read = await call(`${permits}/${p.permit.id}`, {
    headers: installerHeaders,
  });
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({
    permit: {
      status: "consumed",
      consumedEnvironmentId: result.environment.id,
      consumedOperationId: result.operation.id,
    },
  });
  const admission = await call(`/v1/regions/${f.regionId}/admission`, {
    headers: installerHeaders,
  });
  expect(await admission.json()).toMatchObject({
    admission: { acceptingNewEnvironments: false },
  });
  await expect(
    env.DB.prepare(
      "UPDATE environment_admission_permits SET spec_hash=? WHERE id=?",
    )
      .bind("b".repeat(64), p.permit.id)
      .run(),
  ).rejects.toThrow();
});

it("atomically fences competing consumption, revocation and a revoked organization actor without falling back to open admission", async () => {
  const f = await fixture("permit race");
  const issued = await issue(f, "permit-race");
  expect(issued.status).toBe(201);
  const p = (await issued.json()) as PermitResponse;
  const responses = await Promise.all([
    create(f, "race-a", p.permit.id),
    create(f, "race-b", p.permit.id),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([202, 409]);
  const count = await env.DB.prepare(
    "SELECT count(*) AS n FROM environments WHERE project_id=?",
  )
    .bind(f.projectId)
    .first<{ n: number }>();
  expect(count?.n).toBe(1);
  const revoked = (await (
    await issue(f, "revokable")
  ).json()) as PermitResponse;
  const revoke = () =>
    call(`${permits}/${revoked.permit.id}/revoke`, {
      method: "POST",
      headers: { ...installerHeaders, "idempotency-key": "revoke" },
      body: "{}",
    });
  expect((await revoke()).status).toBe(200);
  expect((await revoke()).status).toBe(200);
  expect((await create(f, "revoked", revoked.permit.id)).status).toBe(409);
  await call(`/v1/regions/${f.regionId}/admission`, {
    method: "PUT",
    headers: installerHeaders,
    body: JSON.stringify({
      catalogVersion: f.input.catalogVersion,
      acceptingNewEnvironments: true,
    }),
  });
  expect((await create(f, "no-fallback", revoked.permit.id)).status).toBe(409);
  const pausedPermit = (await (
    await issue(f, "paused-project")
  ).json()) as PermitResponse;
  const grantorResponse = await call(
    `/v1/organizations/${f.organizationId}/budget-tokens/reissue`,
    { method: "POST", headers: installerHeaders },
  );
  expect(grantorResponse.status).toBe(201);
  const grantor = (await grantorResponse.json()) as { apiToken: string };
  const budgetHeaders = {
    authorization: `Bearer ${grantor.apiToken}`,
    "content-type": "application/json",
  };
  const budgetPath = `/v1/organizations/${f.organizationId}/projects/${f.projectId}/budget`;
  expect(
    (
      await call(budgetPath, {
        method: "PUT",
        headers: budgetHeaders,
        body: JSON.stringify({
          expectedRevision: "0",
          period: {
            start: new Date(Date.now() - 60_000).toISOString(),
            end: new Date(Date.now() + 3_600_000).toISOString(),
          },
          granted: { cpu_millicore_ms: "1000000" },
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
  expect((await create(f, "paused", pausedPermit.permit.id)).status).toBe(409);
  expect(
    (await (
      await call(`${permits}/${pausedPermit.permit.id}`, {
        headers: installerHeaders,
      })
    ).json()) as object,
  ).toMatchObject({ permit: { status: "issued" } });
  expect(
    (
      await call(`${budgetPath}/resume`, {
        method: "POST",
        headers: budgetHeaders,
        body: JSON.stringify({ expectedRevision: "2" }),
      })
    ).status,
  ).toBe(200);
  const expiredInput = { expiresAt: new Date(Date.now() + 350).toISOString() };
  const expiringResponse = await issue(f, "expiring", expiredInput);
  expect(expiringResponse.status).toBe(201);
  const expiring = (await expiringResponse.json()) as PermitResponse;
  const delayedSession = env.DB.withSession("first-primary");
  const delayedDb = new Proxy(env.DB, {
    get(target, property) {
      if (property === "withSession")
        return () =>
          new Proxy(delayedSession, {
            get(bound, field) {
              if (field === "batch")
                return async (statements: D1PreparedStatement[]) => {
                  await new Promise((resolve) => setTimeout(resolve, 450));
                  return bound.batch(statements);
                };
              const value = Reflect.get(bound, field);
              return typeof value === "function" ? value.bind(bound) : value;
            },
          });
      return Reflect.get(target, property);
    },
  });
  const expiredResponse = await worker.fetch(
    new Request(`https://control.example.test${f.path}`, {
      method: "POST",
      headers: { ...f.headers, "idempotency-key": "expires-before-commit" },
      body: JSON.stringify({
        ...f.input,
        admissionPermitId: expiring.permit.id,
      }),
    }),
    { ...env, DB: delayedDb },
  );
  expect(expiredResponse.status).toBe(409);
  expect(
    (await (await issue(f, "expiring", expiredInput)).json()) as object,
  ).toMatchObject({ permit: { id: expiring.permit.id, status: "expired" } });
  expect(
    (
      await env.DB.prepare(
        "SELECT count(*) AS n FROM environments WHERE project_id=?",
      )
        .bind(f.projectId)
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
  const fresh = (await (
    await issue(f, "actor-fence")
  ).json()) as PermitResponse;
  const session = env.DB.withSession("first-primary");
  const racedDb = new Proxy(env.DB, {
    get(target, property) {
      if (property === "withSession")
        return () =>
          new Proxy(session, {
            get(bound, field) {
              if (field === "batch")
                return async (statements: D1PreparedStatement[]) => {
                  await env.DB.prepare(
                    "UPDATE api_tokens SET revoked_at=? WHERE organization_id=?",
                  )
                    .bind(new Date().toISOString(), f.organizationId)
                    .run();
                  return bound.batch(statements);
                };
              const value = Reflect.get(bound, field);
              return typeof value === "function" ? value.bind(bound) : value;
            },
          });
      return Reflect.get(target, property);
    },
  });
  const response = await worker.fetch(
    new Request(`https://control.example.test${f.path}`, {
      method: "POST",
      headers: { ...f.headers, "idempotency-key": "revoked-in-batch" },
      body: JSON.stringify({ ...f.input, admissionPermitId: fresh.permit.id }),
    }),
    { ...env, DB: racedDb },
  );
  expect(response.status).toBe(401);
  expect(
    (
      await env.DB.prepare(
        "SELECT count(*) AS n FROM environments WHERE project_id=?",
      )
        .bind(f.projectId)
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
  expect(
    (await (
      await call(`${permits}/${fresh.permit.id}`, { headers: installerHeaders })
    ).json()) as object,
  ).toMatchObject({ permit: { status: "issued" } });
});
