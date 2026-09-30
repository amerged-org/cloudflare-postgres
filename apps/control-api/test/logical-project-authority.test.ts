// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { accountingCall as call, installerHeaders } from "./accounting-fixture";

async function bootstrap(name: string) {
  const response = await call("/v1/organizations", {
    method: "POST",
    headers: installerHeaders,
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    organization: { id: string };
    apiToken: string;
  };
}
function headers(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "idempotency-key": "logical-project-request",
  };
}
async function state(organizationId: string) {
  const [projects, operations, requests, guards] = await Promise.all([
    env.DB.prepare("SELECT * FROM projects WHERE organization_id=? ORDER BY id")
      .bind(organizationId)
      .all(),
    env.DB.prepare(
      "SELECT * FROM operations WHERE organization_id=? ORDER BY id",
    )
      .bind(organizationId)
      .all(),
    env.DB.prepare(
      "SELECT * FROM idempotency_requests WHERE organization_id=? ORDER BY idempotency_key",
    )
      .bind(organizationId)
      .all(),
    env.DB.prepare("SELECT id,ok FROM accounting_assertions ORDER BY id").all(),
  ]);
  return {
    projects: projects.results,
    operations: operations.results,
    requests: requests.results,
    guards: guards.results,
  };
}
function atBodyRead(input: unknown, change: () => Promise<void>) {
  let reads = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        reads++;
        expect(reads).toBe(1);
        await change();
        controller.enqueue(new TextEncoder().encode(JSON.stringify(input)));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  return { body, reads: () => reads };
}

it("refuses a fresh logical project when its original token is reissued during streamed body delivery without storing business or guard rows", async () => {
  const owner = await bootstrap("Logical creation revocation");
  const organizationId = owner.organization.id;
  const path = `/v1/organizations/${organizationId}/projects`;
  const input = { name: "Ordinary logical project" };
  const before = await state(organizationId);
  let replacement = "";
  const stream = atBodyRead(input, async () => {
    const rotated = await call(
      `/v1/organizations/${organizationId}/tokens/reissue`,
      { method: "POST", headers: installerHeaders },
    );
    expect(rotated.status).toBe(201);
    replacement = ((await rotated.json()) as { apiToken: string }).apiToken;
  });
  const denied = await call(path, {
    method: "POST",
    headers: headers(owner.apiToken),
    body: stream.body,
  });
  expect(stream.reads()).toBe(1);
  expect(denied.status).toBe(401);
  expect(await denied.json()).toEqual({ error: { code: "unauthorized" } });
  expect(await state(organizationId)).toEqual(before);

  const created = await call(path, {
    method: "POST",
    headers: headers(replacement),
    body: JSON.stringify(input),
  });
  expect(created.status).toBe(201);
  const after = await state(organizationId);
  expect(after.projects).toHaveLength(1);
  expect(after.operations).toHaveLength(1);
  expect(after.requests).toHaveLength(1);
  expect(after.guards).toEqual(before.guards);
});

it("refuses historical replay after streamed write-scope loss and recovers the same project only under current reissued authority", async () => {
  const owner = await bootstrap("Logical replay authority");
  const organizationId = owner.organization.id;
  const path = `/v1/organizations/${organizationId}/projects`;
  const input = { name: "Recoverable logical project" };
  const created = await call(path, {
    method: "POST",
    headers: headers(owner.apiToken),
    body: JSON.stringify(input),
  });
  expect(created.status).toBe(201);
  const original = (await created.json()) as {
    project: { id: string };
    operation: { id: string };
  };
  const before = await state(organizationId);
  const token = await env.DB.prepare(
    "SELECT id FROM api_tokens WHERE organization_id=? AND revoked_at IS NULL",
  )
    .bind(organizationId)
    .first<{ id: string }>();
  expect(token).not.toBeNull();
  const stream = atBodyRead(input, async () => {
    await env.DB.prepare("UPDATE api_tokens SET scopes=? WHERE id=?")
      .bind("projects:read operations:read", token!.id)
      .run();
  });
  const denied = await call(path, {
    method: "POST",
    headers: headers(owner.apiToken),
    body: stream.body,
  });
  expect(stream.reads()).toBe(1);
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: { code: "forbidden" } });
  expect(await state(organizationId)).toEqual(before);

  const rotated = await call(
    `/v1/organizations/${organizationId}/tokens/reissue`,
    { method: "POST", headers: installerHeaders },
  );
  expect(rotated.status).toBe(201);
  const replacement = ((await rotated.json()) as { apiToken: string }).apiToken;
  const replay = await call(path, {
    method: "POST",
    headers: headers(replacement),
    body: JSON.stringify(input),
  });
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual(original);
  expect(await state(organizationId)).toEqual(before);
  const revoked = await call(path, {
    method: "POST",
    headers: headers(owner.apiToken),
    body: JSON.stringify(input),
  });
  expect(revoked.status).toBe(401);
  const conflict = await call(path, {
    method: "POST",
    headers: headers(replacement),
    body: JSON.stringify({ name: "Different logical intent" }),
  });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({
    error: { code: "idempotency_conflict" },
  });
  expect(await state(organizationId)).toEqual(before);

  // Older queued logical-container records retain their original 202 recovery.
  await env.DB.batch([
    env.DB.prepare("UPDATE projects SET status='pending' WHERE id=?").bind(
      original.project.id,
    ),
    env.DB.prepare("UPDATE operations SET status='queued' WHERE id=?").bind(
      original.operation.id,
    ),
  ]);
  const legacyBefore = await state(organizationId);
  const legacy = await call(path, {
    method: "POST",
    headers: headers(replacement),
    body: JSON.stringify(input),
  });
  expect(legacy.status).toBe(202);
  expect(
    (
      (await legacy.json()) as {
        project: { id: string };
        operation: { id: string };
      }
    ).project.id,
  ).toBe(original.project.id);
  expect(await state(organizationId)).toEqual(legacyBefore);
});
