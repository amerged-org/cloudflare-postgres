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
