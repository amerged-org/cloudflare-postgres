import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index";

const origin = "https://control.example.test";
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

async function call(
  path: string,
  init: RequestInit<IncomingRequestCfProperties> = {},
): Promise<Response> {
  return worker.fetch(new IncomingRequest(`${origin}${path}`, init), env);
}

async function bootstrap(name: string): Promise<{
  organization: { id: string; name: string };
  apiToken: string;
}> {
  const response = await call("/v1/organizations", {
    method: "POST",
    headers: {
      authorization: "Bearer test-installation-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  return response.json();
}

it("requires installation authorization and reveals an organization token only at bootstrap", async () => {
  const denied = await call("/v1/organizations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "First organization" }),
  });
  expect(denied.status).toBe(401);

  const { organization, apiToken } = await bootstrap("First organization");
  expect(organization.name).toBe("First organization");
  expect(apiToken).toMatch(/^cporg_[A-Za-z0-9_-]+$/);
  const stored = await env.DB.prepare(
    "SELECT token_hash FROM api_tokens WHERE organization_id = ?",
  )
    .bind(organization.id)
    .first<{ token_hash: string }>();
  expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(stored?.token_hash).not.toBe(apiToken);
});

it("requires installation authorization for region registration and recovery", async () => {
  const deniedCreate = await call("/v1/regions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "North region" }),
  });
  expect(deniedCreate.status).toBe(401);

  const deniedList = await call("/v1/regions");
  expect(deniedList.status).toBe(401);

  const deniedRead = await call(
    "/v1/regions/00000000-0000-4000-8000-000000000001",
  );
  expect(deniedRead.status).toBe(401);

  const deniedReissue = await call(
    "/v1/regions/00000000-0000-4000-8000-000000000001/tokens/reissue",
    { method: "POST" },
  );
  expect(deniedReissue.status).toBe(401);
});

it("registers an opaque region and stores only its scoped token digest", async () => {
  const headers = {
    authorization: "Bearer test-installation-token",
  };
  const created = await call("/v1/regions", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "North region" }),
  });
  expect(created.status).toBe(201);
  const body = (await created.json()) as {
    region: { id: string; name: string; status: string };
    apiToken: string;
    scopes: string[];
  };
  expect(body.region.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(body.region.name).toBe("North region");
  expect(body.region.status).toBe("registered");
  expect(body.apiToken).toMatch(/^cprgn_[A-Za-z0-9_-]+$/);
  expect(body.scopes).toEqual(["operations:claim", "operations:report"]);

  const stored = await env.DB.prepare(
    "SELECT token_hash, scopes FROM region_tokens WHERE region_id = ? AND revoked_at IS NULL",
  )
    .bind(body.region.id)
    .first<{ token_hash: string; scopes: string }>();
  expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(stored?.token_hash).not.toBe(body.apiToken);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body.apiToken),
  );
  const expectedHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  expect(stored?.token_hash).toBe(expectedHash);
  expect(stored?.scopes).toBe(body.scopes.join(" "));

  const duplicate = await call("/v1/regions", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "North region" }),
  });
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toEqual({
    error: { code: "region_name_conflict" },
  });

  const listed = await call("/v1/regions", { headers });
  expect(listed.status).toBe(200);
  const listBody = (await listed.json()) as {
    regions: Array<{ id: string; name: string }>;
  };
  expect(
    listBody.regions
      .filter((region) => region.name === body.region.name)
      .map((region) => region.id),
  ).toEqual([body.region.id]);
  expect(JSON.stringify(listBody)).not.toContain(body.apiToken);

  const read = await call(`/v1/regions/${body.region.id}`, { headers });
  expect(read.status).toBe(200);
  expect(await read.json()).toEqual({ region: body.region });
});

it("reissues a lost region token and revokes its predecessor", async () => {
  const headers = {
    authorization: "Bearer test-installation-token",
  };
  const created = await call("/v1/regions", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "Recovery region" }),
  });
  expect(created.status).toBe(201);
  const first = (await created.json()) as {
    region: { id: string };
    apiToken: string;
  };

  const reissued = await call(`/v1/regions/${first.region.id}/tokens/reissue`, {
    method: "POST",
    headers,
  });
  expect(reissued.status).toBe(201);
  const second = (await reissued.json()) as {
    region: { id: string };
    apiToken: string;
  };
  expect(second.region.id).toBe(first.region.id);
  expect(second.apiToken).toMatch(/^cprgn_[A-Za-z0-9_-]+$/);
  expect(second.apiToken).not.toBe(first.apiToken);

  const active = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM region_tokens WHERE region_id = ? AND revoked_at IS NULL",
  )
    .bind(first.region.id)
    .first<{ count: number }>();
  expect(active?.count).toBe(1);
  const revoked = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM region_tokens WHERE region_id = ? AND revoked_at IS NOT NULL",
  )
    .bind(first.region.id)
    .first<{ count: number }>();
  expect(revoked?.count).toBe(1);
});

it("stops reading an oversized JSON body when no Content-Length is supplied", async () => {
  let bytesProduced = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (bytesProduced === 16_384) {
          controller.close();
          return;
        }
        bytesProduced += 1024;
        controller.enqueue(new Uint8Array(1024).fill(65));
      },
    },
    { highWaterMark: 0 },
  );
  const response = await call("/v1/organizations", {
    method: "POST",
    headers: {
      authorization: "Bearer test-installation-token",
      "content-type": "application/json",
    },
    body,
  });

  expect(response.status).toBe(400);
  expect(bytesProduced).toBeLessThanOrEqual(5_120);
});

it("recovers organization access after a committed bootstrap response is lost", async () => {
  const initial = await bootstrap("Recovery owner");
  const installationAuth = {
    authorization: "Bearer test-installation-token",
  };
  const listed = await call("/v1/organizations", {
    headers: installationAuth,
  });
  expect(listed.status).toBe(200);
  const listBody = (await listed.json()) as {
    organizations: Array<{ id: string; name: string }>;
  };
  const recovered = listBody.organizations.find(
    (organization) => organization.id === initial.organization.id,
  );
  expect(recovered?.name).toBe("Recovery owner");

  const reissued = await call(
    `/v1/organizations/${recovered?.id}/tokens/reissue`,
    { method: "POST", headers: installationAuth },
  );
  expect(reissued.status).toBe(201);
  const newToken = (await reissued.json()) as { apiToken: string };
  expect(newToken.apiToken).toMatch(/^cporg_[A-Za-z0-9_-]+$/);
  const active = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM api_tokens WHERE organization_id = ? AND revoked_at IS NULL",
  )
    .bind(initial.organization.id)
    .first<{ count: number }>();
  expect(active?.count).toBe(1);

  const created = await call(
    `/v1/organizations/${initial.organization.id}/projects`,
    {
      method: "POST",
      headers: {
        ...installationAuth,
        authorization: `Bearer ${newToken.apiToken}`,
        "content-type": "application/json",
        "idempotency-key": "recovered-project",
      },
      body: JSON.stringify({ name: "Recovered project" }),
    },
  );
  expect(created.status).toBe(201);
});

it("pages through every organization without skipping equal creation timestamps", async () => {
  const createdAt = "9999-01-01T00:00:00.000Z";
  const ids = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003",
  ];
  await env.DB.batch(
    ids.map((id) =>
      env.DB.prepare(
        "INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)",
      ).bind(id, id, createdAt),
    ),
  );
  const headers = { authorization: "Bearer test-installation-token" };

  const first = await call("/v1/organizations?limit=2", { headers });
  expect(first.status).toBe(200);
  const firstBody = (await first.json()) as {
    organizations: Array<{ id: string }>;
    nextCursor: string | null;
  };
  expect(firstBody.organizations.map(({ id }) => id)).toEqual([ids[2], ids[1]]);
  expect(firstBody.nextCursor).toEqual(expect.any(String));

  const second = await call(
    `/v1/organizations?cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
    { headers },
  );
  expect(second.status).toBe(200);
  const secondBody = (await second.json()) as typeof firstBody;
  expect(secondBody.organizations[0]?.id).toBe(ids[0]);
  expect(
    secondBody.organizations.some(({ id }) => id === ids[1] || id === ids[2]),
  ).toBe(false);
  expect(secondBody.nextCursor).toBeNull();
});

it("rejects an invalid organization page cursor", async () => {
  const response = await call("/v1/organizations?cursor=not-a-cursor", {
    headers: { authorization: "Bearer test-installation-token" },
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: { code: "invalid_request" } });
});

it("creates an active logical project and completed audit operation, then restricts both reads to its organization", async () => {
  const first = await bootstrap("Projects owner");
  const other = await bootstrap("Other owner");
  const created = await call(
    `/v1/organizations/${first.organization.id}/projects`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${first.apiToken}`,
        "content-type": "application/json",
        "idempotency-key": "project-a",
      },
      body: JSON.stringify({ name: "Project A" }),
    },
  );
  expect(created.status).toBe(201);
  const body = (await created.json()) as {
    project: { id: string; status: string; createdAt: string };
    operation: {
      id: string;
      status: string;
      observedAt: string;
      resultCode: string;
    };
  };
  expect(body.project.status).toBe("active");
  expect(body.operation.status).toBe("succeeded");
  expect(body.operation.observedAt).toBe(body.project.createdAt);
  expect(body.operation.resultCode).toBe("logical_container_created");

  const project = await call(
    `/v1/organizations/${first.organization.id}/projects/${body.project.id}`,
    { headers: { authorization: `Bearer ${first.apiToken}` } },
  );
  expect(project.status).toBe(200);
  const projectBody = (await project.json()) as { project: { id: string } };
  expect(projectBody.project.id).toBe(body.project.id);

  const operation = await call(
    `/v1/organizations/${first.organization.id}/operations/${body.operation.id}`,
    { headers: { authorization: `Bearer ${first.apiToken}` } },
  );
  expect(operation.status).toBe(200);
  const operationBody = (await operation.json()) as {
    operation: { id: string };
  };
  expect(operationBody.operation.id).toBe(body.operation.id);

  const crossOrg = await call(
    `/v1/organizations/${first.organization.id}/projects/${body.project.id}`,
    { headers: { authorization: `Bearer ${other.apiToken}` } },
  );
  expect(crossOrg.status).toBe(404);

  const crossOrgOperation = await call(
    `/v1/organizations/${first.organization.id}/operations/${body.operation.id}`,
    { headers: { authorization: `Bearer ${other.apiToken}` } },
  );
  expect(crossOrgOperation.status).toBe(404);

  const unauthorized = await call(
    `/v1/organizations/${first.organization.id}/projects/${body.project.id}`,
  );
  expect(unauthorized.status).toBe(401);

  const crossOrgCreate = await call(
    `/v1/organizations/${first.organization.id}/projects`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${other.apiToken}`,
        "content-type": "application/json",
        "idempotency-key": "cross-org-attempt",
      },
      body: JSON.stringify({ name: "Wrong owner" }),
    },
  );
  expect(crossOrgCreate.status).toBe(404);
});

it("replays an identical project request and rejects a changed request under the same key", async () => {
  const { organization, apiToken } = await bootstrap("Idempotency owner");
  const path = `/v1/organizations/${organization.id}/projects`;
  const headers = {
    authorization: `Bearer ${apiToken}`,
    "content-type": "application/json",
    "idempotency-key": "same-key",
  };
  const first = await call(path, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "First project" }),
  });
  expect(first.status).toBe(201);
  const firstBody = (await first.json()) as {
    project: { id: string };
    operation: { id: string };
  };

  const replay = await call(path, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "First project" }),
  });
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual(firstBody);

  const changed = await call(path, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Changed project" }),
  });
  expect(changed.status).toBe(409);
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM projects WHERE organization_id = ?",
  )
    .bind(organization.id)
    .first<{ count: number }>();
  expect(count?.count).toBe(1);

  // Migration 0004 leaves a legacy pending/queued pair with two operations
  // unchanged. Its idempotent replay must not report completed creation.
  await env.DB.batch([
    env.DB.prepare("UPDATE projects SET status = 'pending' WHERE id = ?").bind(
      firstBody.project.id,
    ),
    env.DB.prepare(
      "UPDATE operations SET status = 'queued', observed_at = NULL, result_code = NULL WHERE id = ?",
    ).bind(firstBody.operation.id),
    env.DB.prepare(
      "INSERT INTO operations (id, organization_id, project_id, kind, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(
      crypto.randomUUID(),
      organization.id,
      firstBody.project.id,
      "project.create",
      "queued",
      new Date().toISOString(),
    ),
  ]);
  const unmatchedReplay = await call(path, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "First project" }),
  });
  expect(unmatchedReplay.status).toBe(202);
  const unmatchedBody = (await unmatchedReplay.json()) as {
    project: { id: string; status: string };
    operation: { id: string; status: string };
  };
  expect(unmatchedBody.project).toMatchObject({
    id: firstBody.project.id,
    status: "pending",
  });
  expect(unmatchedBody.operation).toMatchObject({
    id: firstBody.operation.id,
    status: "queued",
  });
});

const installationHeaders = {
  authorization: "Bearer test-installation-token",
  "content-type": "application/json",
};

const environmentProfile = {
  id: "standard",
  postgresImage: `ghcr.io/cloudnative-pg/postgresql@sha256:${"a".repeat(64)}`,
  compute: { cpuMilli: 500, memoryMiB: 512 },
  storage: {
    classId: "local-volume",
    storageClassName: "private-storage-class",
    minGiB: 4,
    maxGiB: 64,
    stepGiB: 4,
  },
  instances: 1,
  backup: {
    region: "auto",
    endpointURL: "https://object-store.example.test",
    destinationPath: "s3://operator-backups/environments",
    retentionPolicy: "30d",
    credentialSecret: {
      namespace: "platform-secrets",
      name: "private-backup-credentials",
      accessKeyIdKey: "ACCESS_KEY_ID",
      secretAccessKeyKey: "SECRET_ACCESS_KEY",
    },
  },
};

interface TestEnvironment {
  id: string;
  status: string;
  specHash: string;
  resolvedSpec: { volumeGiB: number; profile: typeof environmentProfile };
}

interface TestClaim {
  operationId: string;
  environmentId: string;
  regionId: string;
  leaseToken: string;
  leaseEpoch: number;
  leaseExpiresAt: string;
  specHash: string;
  spec: { volumeGiB: number; profile: typeof environmentProfile };
}

async function environmentFixture(label: string) {
  const owner = await bootstrap(`${label} owner`);
  const regionResponse = await call("/v1/regions", {
    method: "POST",
    headers: installationHeaders,
    body: JSON.stringify({ name: `${label} region` }),
  });
  expect(regionResponse.status).toBe(201);
  const region = (await regionResponse.json()) as {
    region: { id: string };
    apiToken: string;
  };
  const projectResponse = await call(
    `/v1/organizations/${owner.organization.id}/projects`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${owner.apiToken}`,
        "content-type": "application/json",
        "idempotency-key": "logical-project",
      },
      body: JSON.stringify({ name: `${label} project` }),
    },
  );
  expect(projectResponse.status).toBe(201);
  const { project } = (await projectResponse.json()) as {
    project: { id: string };
  };
  return {
    owner,
    regionId: region.region.id,
    regionHeaders: {
      authorization: `Bearer ${region.apiToken}`,
      "content-type": "application/json",
    },
    path: `/v1/organizations/${owner.organization.id}/projects/${project.id}/environments`,
    organizationHeaders: {
      authorization: `Bearer ${owner.apiToken}`,
      "content-type": "application/json",
      "idempotency-key": "environment-request",
    },
    input: {
      name: "Database environment",
      regionId: region.region.id,
      catalogVersion: "version-1",
      profileId: environmentProfile.id,
      volumeGiB: 8,
    },
  };
}

async function publishAndAdmit(regionId: string) {
  const published = await call(`/v1/regions/${regionId}/catalogs`, {
    method: "POST",
    headers: installationHeaders,
    body: JSON.stringify({
      version: "version-1",
      profiles: [environmentProfile],
    }),
  });
  expect(published.status).toBe(201);
  const admitted = await call(`/v1/regions/${regionId}/admission`, {
    method: "PUT",
    headers: installationHeaders,
    body: JSON.stringify({
      catalogVersion: "version-1",
      acceptingNewEnvironments: true,
    }),
  });
  expect(admitted.status).toBe(200);
}

it("creates a scoped immutable environment and observes its leased regional execution", async () => {
  const fixture = await environmentFixture("Environment lifecycle");
  const closed = await call(fixture.path, {
    method: "POST",
    headers: fixture.organizationHeaders,
    body: JSON.stringify(fixture.input),
  });
  expect(closed.status).toBe(409);
  const backupWithoutRegion: Omit<
    typeof environmentProfile.backup,
    "region"
  > & { region?: string } = { ...environmentProfile.backup };
  delete backupWithoutRegion.region;
  const missingBackupRegion = await call(
    `/v1/regions/${fixture.regionId}/catalogs`,
    {
      method: "POST",
      headers: installationHeaders,
      body: JSON.stringify({
        version: "missing-backup-region",
        profiles: [{ ...environmentProfile, backup: backupWithoutRegion }],
      }),
    },
  );
  expect(missingBackupRegion.status).toBe(400);
  const invalidEndpoint = await call(
    `/v1/regions/${fixture.regionId}/catalogs`,
    {
      method: "POST",
      headers: installationHeaders,
      body: JSON.stringify({
        version: "unsupported-endpoint",
        profiles: [
          {
            ...environmentProfile,
            backup: {
              ...environmentProfile.backup,
              endpointURL: "https://object-store.example.test/unsupported",
            },
          },
        ],
      }),
    },
  );
  expect(invalidEndpoint.status).toBe(400);
  await publishAndAdmit(fixture.regionId);

  const forbiddenCatalog = await call(
    `/v1/regions/${fixture.regionId}/catalogs`,
    {
      method: "POST",
      headers: fixture.organizationHeaders,
      body: JSON.stringify({
        version: "unauthorized",
        profiles: [environmentProfile],
      }),
    },
  );
  expect(forbiddenCatalog.status).toBe(401);
  const duplicateCatalog = await call(
    `/v1/regions/${fixture.regionId}/catalogs`,
    {
      method: "POST",
      headers: installationHeaders,
      body: JSON.stringify({
        version: "version-1",
        profiles: [{ ...environmentProfile, instances: 2 }],
      }),
    },
  );
  expect(duplicateCatalog.status).toBe(409);
  const catalog = await call(
    `/v1/organizations/${fixture.owner.organization.id}/regions/${fixture.regionId}/catalogs/version-1`,
    { headers: fixture.organizationHeaders },
  );
  expect(catalog.status).toBe(200);
  const publicCatalog = JSON.stringify(await catalog.json());
  expect(publicCatalog).not.toContain(
    environmentProfile.storage.storageClassName,
  );
  expect(publicCatalog).not.toContain(
    environmentProfile.backup.credentialSecret.name,
  );

  const created = await call(fixture.path, {
    method: "POST",
    headers: fixture.organizationHeaders,
    body: JSON.stringify(fixture.input),
  });
  expect(created.status).toBe(202);
  const body = (await created.json()) as {
    environment: TestEnvironment;
    operation: { id: string; kind: string; status: string };
  };
  expect(body.environment.status).toBe("pending");
  expect(body.operation).toMatchObject({
    kind: "environment.create",
    status: "queued",
  });
  expect(JSON.stringify(body)).not.toContain(
    environmentProfile.storage.storageClassName,
  );
  expect(JSON.stringify(body)).not.toContain(
    environmentProfile.backup.credentialSecret.name,
  );
  const stored = await env.DB.prepare(
    "SELECT resolved_spec FROM environments WHERE id = ?",
  )
    .bind(body.environment.id)
    .first<{ resolved_spec: string }>();
  expect(JSON.parse(stored!.resolved_spec).profile).toEqual(environmentProfile);
  await expect(
    env.DB.prepare("UPDATE environments SET resolved_spec = '{}' WHERE id = ?")
      .bind(body.environment.id)
      .run(),
  ).rejects.toThrow();

  const newer = await call(`/v1/regions/${fixture.regionId}/catalogs`, {
    method: "POST",
    headers: installationHeaders,
    body: JSON.stringify({
      version: "version-2",
      profiles: [
        { ...environmentProfile, compute: { cpuMilli: 1000, memoryMiB: 1024 } },
      ],
    }),
  });
  expect(newer.status).toBe(201);
  const closedAgain = await call(`/v1/regions/${fixture.regionId}/admission`, {
    method: "PUT",
    headers: installationHeaders,
    body: JSON.stringify({
      catalogVersion: "version-2",
      acceptingNewEnvironments: false,
    }),
  });
  expect(closedAgain.status).toBe(200);
  const replay = await call(fixture.path, {
    method: "POST",
    headers: fixture.organizationHeaders,
    body: JSON.stringify(fixture.input),
  });
  expect(replay.status).toBe(202);
  expect(await replay.json()).toEqual(body);
  const changed = await call(fixture.path, {
    method: "POST",
    headers: fixture.organizationHeaders,
    body: JSON.stringify({ ...fixture.input, volumeGiB: 12 }),
  });
  expect(changed.status).toBe(409);
  const foreign = await bootstrap("Foreign environment reader");
  const forbiddenRead = await call(`${fixture.path}/${body.environment.id}`, {
    headers: { authorization: `Bearer ${foreign.apiToken}` },
  });
  expect(forbiddenRead.status).toBe(404);

  const claimed = await call(
    `/v1/regions/${fixture.regionId}/operations/claim`,
    {
      method: "POST",
      headers: fixture.regionHeaders,
      body: JSON.stringify({ leaseSeconds: 60 }),
    },
  );
  expect(claimed.status).toBe(200);
  const { claim } = (await claimed.json()) as { claim: TestClaim };
  expect(claim).toMatchObject({
    operationId: body.operation.id,
    environmentId: body.environment.id,
    regionId: fixture.regionId,
    specHash: body.environment.specHash,
    spec: { volumeGiB: 8, profile: environmentProfile },
  });
  const renewed = await call(
    `/v1/regions/${fixture.regionId}/operations/${claim.operationId}/renew`,
    {
      method: "POST",
      headers: fixture.regionHeaders,
      body: JSON.stringify({
        leaseToken: claim.leaseToken,
        leaseEpoch: claim.leaseEpoch,
        leaseSeconds: 90,
      }),
    },
  );
  expect(renewed.status).toBe(200);
  const resultInput = {
    leaseToken: claim.leaseToken,
    leaseEpoch: claim.leaseEpoch,
    status: "ready",
    resultCode: "cnpg_ready",
    observation: {
      clusterUid: "kubernetes-uid",
      clusterGeneration: 1,
      readyInstances: 1,
    },
  };
  const resultPath = `/v1/regions/${fixture.regionId}/operations/${claim.operationId}/result`;
  const result = await call(resultPath, {
    method: "POST",
    headers: fixture.regionHeaders,
    body: JSON.stringify(resultInput),
  });
  expect(result.status).toBe(200);
  const duplicateResult = await call(resultPath, {
    method: "POST",
    headers: fixture.regionHeaders,
    body: JSON.stringify(resultInput),
  });
  expect(duplicateResult.status).toBe(200);
  expect(await duplicateResult.json()).toEqual(await result.json());
  const observed = await call(`${fixture.path}/${body.environment.id}`, {
    headers: fixture.organizationHeaders,
  });
  expect(observed.status).toBe(200);
  expect(
    ((await observed.json()) as { environment: TestEnvironment }).environment
      .status,
  ).toBe("ready");
  const operation = await call(
    `/v1/organizations/${fixture.owner.organization.id}/operations/${claim.operationId}`,
    {
      headers: fixture.organizationHeaders,
    },
  );
  expect(
    (
      (await operation.json()) as {
        operation: { status: string; resultCode: string };
      }
    ).operation,
  ).toMatchObject({ status: "succeeded", resultCode: "cnpg_ready" });
});

it("fences competing, expired, and cross-region environment execution leases", async () => {
  const fixture = await environmentFixture("Execution fencing");
  const other = await environmentFixture("Other executor");
  await publishAndAdmit(fixture.regionId);
  const created = await call(fixture.path, {
    method: "POST",
    headers: fixture.organizationHeaders,
    body: JSON.stringify(fixture.input),
  });
  expect(created.status).toBe(202);
  const { environment, operation } = (await created.json()) as {
    environment: TestEnvironment;
    operation: { id: string };
  };
  const claimPath = `/v1/regions/${fixture.regionId}/operations/claim`;
  const crossedClaim = await call(claimPath, {
    method: "POST",
    headers: other.regionHeaders,
    body: JSON.stringify({ leaseSeconds: 60 }),
  });
  expect(crossedClaim.status).toBe(404);
  const claimed = await Promise.all([
    call(claimPath, {
      method: "POST",
      headers: fixture.regionHeaders,
      body: JSON.stringify({ leaseSeconds: 60 }),
    }),
    call(claimPath, {
      method: "POST",
      headers: fixture.regionHeaders,
      body: JSON.stringify({ leaseSeconds: 60 }),
    }),
  ]);
  expect(claimed.map((response) => response.status)).toEqual([200, 200]);
  const claimBodies = await Promise.all(
    claimed.map(
      (response) => response.json() as Promise<{ claim: TestClaim | null }>,
    ),
  );
  expect(claimBodies.filter((body) => body.claim)).toHaveLength(1);
  const first = claimBodies.find((body) => body.claim)!.claim!;
  expect(first.operationId).toBe(operation.id);
  await env.DB.prepare(
    "UPDATE operations SET lease_expires_at = ? WHERE id = ?",
  )
    .bind("2000-01-01T00:00:00.000Z", operation.id)
    .run();
  const reclaimed = await call(claimPath, {
    method: "POST",
    headers: fixture.regionHeaders,
    body: JSON.stringify({ leaseSeconds: 60 }),
  });
  expect(reclaimed.status).toBe(200);
  const second = ((await reclaimed.json()) as { claim: TestClaim }).claim;
  expect(second.leaseEpoch).toBe(first.leaseEpoch + 1);
  expect(second.leaseToken).not.toBe(first.leaseToken);
  const staleRenew = await call(
    `/v1/regions/${fixture.regionId}/operations/${operation.id}/renew`,
    {
      method: "POST",
      headers: fixture.regionHeaders,
      body: JSON.stringify({
        leaseToken: first.leaseToken,
        leaseEpoch: first.leaseEpoch,
        leaseSeconds: 60,
      }),
    },
  );
  expect(staleRenew.status).toBe(409);
  const readyResult = {
    leaseToken: first.leaseToken,
    leaseEpoch: first.leaseEpoch,
    status: "ready",
    resultCode: "cnpg_ready",
    observation: {
      clusterUid: "stale-cluster",
      clusterGeneration: 1,
      readyInstances: 1,
    },
  };
  const staleResult = await call(
    `/v1/regions/${fixture.regionId}/operations/${operation.id}/result`,
    {
      method: "POST",
      headers: fixture.regionHeaders,
      body: JSON.stringify(readyResult),
    },
  );
  expect(staleResult.status).toBe(409);
  const crossedResult = await call(
    `/v1/regions/${other.regionId}/operations/${operation.id}/result`,
    {
      method: "POST",
      headers: other.regionHeaders,
      body: JSON.stringify({
        ...readyResult,
        leaseToken: second.leaseToken,
        leaseEpoch: second.leaseEpoch,
      }),
    },
  );
  expect(crossedResult.status).toBe(409);
  const failed = await call(
    `/v1/regions/${fixture.regionId}/operations/${operation.id}/result`,
    {
      method: "POST",
      headers: fixture.regionHeaders,
      body: JSON.stringify({
        leaseToken: second.leaseToken,
        leaseEpoch: second.leaseEpoch,
        status: "failed",
        resultCode: "ownership_mismatch",
        observation: null,
      }),
    },
  );
  expect(failed.status).toBe(200);
  const final = await call(`${fixture.path}/${environment.id}`, {
    headers: fixture.organizationHeaders,
  });
  expect(
    ((await final.json()) as { environment: TestEnvironment }).environment
      .status,
  ).toBe("failed");
});
