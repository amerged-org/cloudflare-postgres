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
  expect(created.status).toBe(202);
});

it("creates a pending project and queued operation, then restricts both reads to its organization", async () => {
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
  expect(created.status).toBe(202);
  const body = (await created.json()) as {
    project: { id: string; status: string };
    operation: { id: string; status: string };
  };
  expect(body.project.status).toBe("pending");
  expect(body.operation.status).toBe("queued");

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
  expect(first.status).toBe(202);
  const firstBody = await first.json();

  const replay = await call(path, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "First project" }),
  });
  expect(replay.status).toBe(202);
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
});
