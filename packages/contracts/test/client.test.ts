// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from "vitest";
import { PgcfClient, PgcfClientError } from "../src/client.ts";
import { newApiKey } from "../src/auth.ts";
import {
  Database,
  DatabaseWithOperation,
  type DatabaseCreate,
} from "../src/api.ts";
import {
  newDatabaseId,
  newNodeId,
  newOperationId,
  newProjectId,
} from "../src/ids.ts";
import {
  NodeAddition,
  NodeLoss,
  nodeAdditionHostname,
  type NodeAdditionRequest,
} from "../src/nodes.ts";
import { nodeOperatorKubernetesHeaders } from "../src/node-operator.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const baseUrl = `https://${["api", "invalid"].join(".")}`;

it("prepares a private operator WebSocket request without native fetch or URL credentials", () => {
  const apiKey = newApiKey().key,
    nodeId = newNodeId(),
    nodeUid = crypto.randomUUID(),
    fetcher = vi.fn<typeof fetch>(),
    client = new PgcfClient({ baseUrl, apiKey, fetch: fetcher });
  const descriptor = client.operatorKubernetesRequest(nodeId, nodeUid);
  expect(descriptor).toEqual({
    url: `${baseUrl.replace("https:", "wss:")}/v1/nodes/${nodeId}/operator/kubernetes?node_uid=${nodeUid}`,
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  expect(descriptor.url).not.toContain(apiKey);
  expect(fetcher).not.toHaveBeenCalled();
  expect(() =>
    client.operatorKubernetesRequest(`${nodeId}/other`, nodeUid),
  ).toThrow(PgcfClientError);
  expect(() => client.operatorKubernetesRequest(nodeId, "invalid")).toThrow(
    PgcfClientError,
  );
});

it("validates operator response binding and rejects a different requested node UID", () => {
  const client = new PgcfClient({ baseUrl, apiKey: newApiKey().key }),
    binding = {
      node_uid: crypto.randomUUID(),
      cluster_uid: crypto.randomUUID(),
      node_name: "pgcf-node-fixture",
      material_revision: 2,
    },
    headers = new Headers(nodeOperatorKubernetesHeaders(binding));
  expect(
    client.parseOperatorKubernetesResponse(headers, binding.node_uid),
  ).toEqual(binding);
  expect(() =>
    client.parseOperatorKubernetesResponse(headers, crypto.randomUUID()),
  ).toThrow(PgcfClientError);
  expect(() =>
    client.parseOperatorKubernetesResponse(new Headers(), binding.node_uid),
  ).toThrow(PgcfClientError);
});

function fixtures() {
  const now = new Date().toISOString();
  const database = {
    id: newDatabaseId(),
    project_id: newProjectId(),
    region_id: "eu-test",
    name: "fixture",
    size_class_id: "small",
    desired_state: "running" as const,
    observed_state: "ready" as const,
    generation: 1,
    observed_generation: 1,
    status_message: null,
    health: { archiving: "ok" as const, since: null },
    created_at: now,
    updated_at: now,
  };
  const operation = {
    id: newOperationId(),
    kind: "database.create" as const,
    status: "succeeded" as const,
    project_id: database.project_id,
    database_id: database.id,
    generation: 1,
    error: null,
    created_at: now,
    updated_at: now,
    completed_at: now,
  };
  const request: DatabaseCreate = {
    project_id: database.project_id,
    region_id: database.region_id,
    name: database.name,
    size_class_id: database.size_class_id,
  };
  return {
    database,
    operation,
    request,
    apiKey: newApiKey().key,
    idempotencyKey: crypto.randomUUID(),
  };
}

function nodeFixtures() {
  const nodeId = newNodeId(),
    predecessorId = newNodeId(),
    uid = crypto.randomUUID(),
    now = new Date().toISOString();
  const request: NodeAdditionRequest = {
    region_id: "eu-test",
    mode: "recover",
    provider_instance_id: "123456",
    predecessor_node_id: predecessorId,
    expected_node_uid: uid,
  };
  const addition = NodeAddition.parse({
    intent: {
      node_id: nodeId,
      operation_id: newOperationId(),
      requested_hostname: nodeAdditionHostname(nodeId),
      request,
    },
    request_key: crypto.randomUUID(),
    request_hash: "a".repeat(64),
    intent_hash: "b".repeat(64),
    revision: 1,
    status: "reserved",
    slot_held: true,
    dispatch_request_id: null,
    provider_instance_id: null,
    approval: null,
    receipt: null,
    audit: null,
    checkpoint: null,
    network: null,
    capacity: null,
    failure_code: null,
    created_at: now,
    updated_at: now,
  });
  const loss = NodeLoss.parse({
    node_id: predecessorId,
    region_id: request.region_id,
    node_uid: uid,
    provider_instance_id: request.provider_instance_id,
    lost_at: now,
    reason: "confirmed loss",
  });
  return { request, addition, loss };
}

it("uses the admin loss and node-addition contracts with the exact recovery identity", async () => {
  const f = fixtures(),
    n = nodeFixtures();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(n.loss))
    .mockResolvedValueOnce(Response.json(n.addition, { status: 202 }))
    .mockResolvedValueOnce(Response.json(n.addition));
  const client = new PgcfClient({ baseUrl, apiKey: f.apiKey, fetch: fetcher });
  expect(
    await client.markNodeLost(n.loss.node_id, {
      expected_node_uid: n.loss.node_uid,
      reason: "  confirmed loss  ",
    }),
  ).toEqual(n.loss);
  expect(
    await client.requestNodeAddition(n.request, n.addition.request_key),
  ).toEqual(n.addition);
  expect(await client.getNodeAddition(n.addition.intent.operation_id)).toEqual(
    n.addition,
  );
  expect(
    fetcher.mock.calls.map(([url, init]) => [
      new URL(String(url)).pathname,
      init!.method,
      init!.redirect,
    ]),
  ).toEqual([
    [`/v1/nodes/${n.loss.node_id}/mark-lost`, "POST", "manual"],
    ["/v1/nodes/additions", "POST", "manual"],
    [`/v1/nodes/additions/${n.addition.intent.operation_id}`, "GET", "manual"],
  ]);
  const lossInit = fetcher.mock.calls[0]![1]!,
    additionInit = fetcher.mock.calls[1]![1]!,
    readInit = fetcher.mock.calls[2]![1]!;
  expect(JSON.parse(String(lossInit.body))).toEqual({
    expected_node_uid: n.loss.node_uid,
    reason: n.loss.reason,
  });
  expect(JSON.parse(String(additionInit.body))).toEqual(n.request);
  expect(new Headers(additionInit.headers).get("Idempotency-Key")).toBe(
    n.addition.request_key,
  );
  expect(new Headers(lossInit.headers).has("Idempotency-Key")).toBe(false);
  expect(readInit.body).toBeUndefined();
  expect(new Headers(readInit.headers).has("Idempotency-Key")).toBe(false);
  for (const [, init] of fetcher.mock.calls)
    expect(new Headers(init!.headers).get("Authorization")).toBe(
      `Bearer ${f.apiKey}`,
    );
});

it("refuses invalid recovery identity, node paths and mutation keys before sending", () => {
  const f = fixtures(),
    n = nodeFixtures(),
    fetcher = vi.fn<typeof fetch>();
  const client = new PgcfClient({ baseUrl, apiKey: f.apiKey, fetch: fetcher });
  expect(() =>
    client.requestNodeAddition(
      { ...n.request, expected_node_uid: "invalid" },
      n.addition.request_key,
    ),
  ).toThrow(PgcfClientError);
  expect(() =>
    client.requestNodeAddition(
      { ...n.request, provider_instance_id: "0" },
      n.addition.request_key,
    ),
  ).toThrow(PgcfClientError);
  expect(() =>
    client.requestNodeAddition(n.request, undefined as unknown as string),
  ).toThrow(PgcfClientError);
  expect(() =>
    client.getNodeAddition(`${n.addition.intent.operation_id}/bootstrap`),
  ).toThrow(PgcfClientError);
  expect(() =>
    client.markNodeLost("invalid", {
      expected_node_uid: n.loss.node_uid,
      reason: n.loss.reason,
    }),
  ).toThrow(PgcfClientError);
  expect(() =>
    client.markNodeLost(n.loss.node_id, {
      expected_node_uid: n.loss.node_uid,
      reason: " ",
    }),
  ).toThrow(PgcfClientError);
  expect(fetcher).not.toHaveBeenCalled();
});

it("never retries uncertain recovery or exposes a malformed addition acknowledgement", async () => {
  const f = fixtures(),
    n = nodeFixtures();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error(f.apiKey))
    .mockResolvedValueOnce(
      Response.json({ ...n.addition, secret: f.apiKey }, { status: 202 }),
    );
  const client = new PgcfClient({ baseUrl, apiKey: f.apiKey, fetch: fetcher });
  const transportError = await client
    .requestNodeAddition(n.request, n.addition.request_key)
    .catch((value: unknown) => value);
  expect(transportError).toMatchObject({ code: "transport_error" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(transportError)).not.toContain(f.apiKey);
  const acknowledgementError = await client
    .requestNodeAddition(n.request, n.addition.request_key)
    .catch((value: unknown) => value);
  expect(acknowledgementError).toMatchObject({
    code: "invalid_response",
    status: 202,
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(acknowledgementError)).not.toContain(f.apiKey);
});

it("validates a create before sending and parses the same asynchronous response contract", async () => {
  const f = fixtures();
  const acknowledgement = { database: f.database, operation: f.operation };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(acknowledgement, { status: 202 }));
  const client = new PgcfClient({ baseUrl, apiKey: f.apiKey, fetch: fetcher });
  expect(await client.createDatabase(f.request, f.idempotencyKey)).toEqual(
    DatabaseWithOperation.parse(acknowledgement),
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(String(url)).toBe(`${baseUrl}/v1/databases`);
  expect(init).toMatchObject({ method: "POST", redirect: "manual" });
  const headers = new Headers(init!.headers);
  expect(headers.get("Authorization")).toBe(`Bearer ${f.apiKey}`);
  expect(headers.get("Idempotency-Key")).toBe(f.idempotencyKey);
  expect(JSON.parse(String(init!.body))).toEqual(f.request);
});

it("uses the management operation and role paths with caller-owned mutation keys", async () => {
  const f = fixtures();
  const keys = {
    resize: crypto.randomUUID(),
    suspend: crypto.randomUUID(),
    resume: crypto.randomUUID(),
    restore: crypto.randomUUID(),
    roleCreate: crypto.randomUUID(),
    roleReset: crypto.randomUUID(),
    delete: crypto.randomUUID(),
  };
  const result = { database: f.database, operation: f.operation };
  const target = { ...f.database, id: newDatabaseId(), name: "restored" };
  const restored = {
    target_database: target,
    operation: {
      ...f.operation,
      kind: "database.restore",
      database_id: target.id,
    },
  };
  const role = {
    database_id: f.database.id,
    name: "app",
    owner: true,
    password_revision: 1,
    created_at: f.database.created_at,
    updated_at: f.database.updated_at,
  };
  const host = ["db", "invalid"].join(".");
  const uri = {
    database_id: f.database.id,
    role: "app",
    host,
    database: f.database.id,
    uri: `postgres://app@${host}/${f.database.id}`,
    includes_password: false,
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(f.database))
    .mockResolvedValueOnce(Response.json(result, { status: 202 }))
    .mockResolvedValueOnce(Response.json(result, { status: 202 }))
    .mockResolvedValueOnce(Response.json(result, { status: 202 }))
    .mockResolvedValueOnce(Response.json(restored, { status: 202 }))
    .mockResolvedValueOnce(Response.json(role, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ data: [role], next_cursor: null }))
    .mockResolvedValueOnce(Response.json(role))
    .mockResolvedValueOnce(Response.json(uri))
    .mockResolvedValueOnce(Response.json(f.operation))
    .mockResolvedValueOnce(Response.json(result, { status: 202 }));
  const client = new PgcfClient({ baseUrl, apiKey: f.apiKey, fetch: fetcher });
  expect(await client.getDatabase(f.database.id)).toEqual(
    Database.parse(f.database),
  );
  await client.resizeDatabase(
    f.database.id,
    { size_class_id: "small" },
    keys.resize,
  );
  await client.suspendDatabase(f.database.id, keys.suspend);
  await client.resumeDatabase(f.database.id, keys.resume);
  expect(
    await client.restoreDatabase(
      f.database.id,
      { mode: "pitr", name: "restored", target_time: f.database.created_at },
      keys.restore,
    ),
  ).toEqual(restored);
  expect(
    await client.createRole(f.database.id, { name: "app" }, keys.roleCreate),
  ).toEqual(role);
  expect(await client.listRoles(f.database.id)).toEqual({
    data: [role],
    next_cursor: null,
  });
  await client.resetRolePassword(f.database.id, "app", keys.roleReset);
  expect(await client.getConnectionUri(f.database.id, "app")).toEqual(uri);
  expect(await client.getOperation(f.operation.id)).toEqual(f.operation);
  await client.deleteDatabase(f.database.id, keys.delete);
  const path = `/v1/databases/${f.database.id}`;
  expect(
    fetcher.mock.calls.map(([url, init]) => [
      new URL(String(url)).pathname,
      init!.method,
    ]),
  ).toEqual([
    [path, "GET"],
    [path, "PATCH"],
    [`${path}/suspend`, "POST"],
    [`${path}/resume`, "POST"],
    [`${path}/restore`, "POST"],
    [`${path}/roles`, "POST"],
    [`${path}/roles`, "GET"],
    [`${path}/roles/app/reset-password`, "POST"],
    [`${path}/roles/app/connection-uri`, "GET"],
    [`/v1/operations/${f.operation.id}`, "GET"],
    [path, "DELETE"],
  ]);
  expect(
    new Set(
      fetcher.mock.calls
        .filter(([, init]) => init!.method !== "GET")
        .map(([, init]) => new Headers(init!.headers).get("Idempotency-Key")),
    ),
  ).toEqual(new Set(Object.values(keys)));
});

it("rejects invalid configuration, IDs, roles, input and missing idempotency keys before fetch", () => {
  const f = fixtures();
  const fetcher = vi.fn<typeof fetch>();
  expect(
    () =>
      new PgcfClient({
        baseUrl: baseUrl.replace("https:", "http:"),
        apiKey: f.apiKey,
        fetch: fetcher,
      }),
  ).toThrow(PgcfClientError);
  expect(
    () =>
      new PgcfClient({ baseUrl, apiKey: crypto.randomUUID(), fetch: fetcher }),
  ).toThrow(PgcfClientError);
  const client = new PgcfClient({ baseUrl, apiKey: f.apiKey, fetch: fetcher });
  expect(() => client.getDatabase("invalid")).toThrow(PgcfClientError);
  expect(() => client.getOperation("invalid")).toThrow(PgcfClientError);
  expect(() => client.getConnectionUri(f.database.id, "postgres")).toThrow(
    PgcfClientError,
  );
  expect(() =>
    client.createDatabase(
      { ...f.request, name: "invalid/name" },
      f.idempotencyKey,
    ),
  ).toThrow(PgcfClientError);
  expect(() =>
    client.createDatabase(f.request, undefined as unknown as string),
  ).toThrow(PgcfClientError);
  expect(fetcher).not.toHaveBeenCalled();
});

it("never retries an uncertain write or retains its transport exception text", async () => {
  const f = fixtures();
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(f.apiKey));
  const client = new PgcfClient({ baseUrl, apiKey: f.apiKey, fetch: fetcher });
  const error = await client
    .createDatabase(f.request, f.idempotencyKey)
    .catch((value: unknown) => value);
  expect(error).toMatchObject({
    code: "transport_error",
    status: null,
    requestId: null,
  });
  expect(String(error)).not.toContain(f.apiKey);
  expect(JSON.stringify(error)).not.toContain(f.apiKey);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("never retries a write whose acknowledgement is malformed", async () => {
  const f = fixtures();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ secret: f.apiKey }, { status: 202 }));
  const client = new PgcfClient({ baseUrl, apiKey: f.apiKey, fetch: fetcher });
  const error = await client
    .createDatabase(f.request, f.idempotencyKey)
    .catch((value: unknown) => value);
  expect(error).toMatchObject({
    code: "invalid_response",
    status: 202,
    requestId: null,
  });
  expect(JSON.stringify(error)).not.toContain(f.apiKey);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("rejects and cancels oversized streamed responses without returning their body", async () => {
  const f = fixtures();
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(f.apiKey));
    },
    cancel,
  });
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
  const client = new PgcfClient({
    baseUrl,
    apiKey: f.apiKey,
    maxResponseBytes: 16,
    fetch: fetcher,
  });
  const error = await client
    .getDatabase(f.database.id)
    .catch((value: unknown) => value);
  expect(error).toMatchObject({ code: "response_too_large", status: 200 });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(error)).not.toContain(f.apiKey);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("returns only API error code, status and a safe request ID", async () => {
  const f = fixtures(),
    requestId = crypto.randomUUID();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json(
        {
          error: {
            code: "conflict",
            message: f.apiKey,
            request_id: requestId,
            details: { credential: f.apiKey },
          },
        },
        { status: 409 },
      ),
    )
    .mockResolvedValueOnce(
      Response.json(
        {
          error: { code: "conflict", message: f.apiKey, request_id: f.apiKey },
        },
        { status: 409 },
      ),
    );
  const client = new PgcfClient({ baseUrl, apiKey: f.apiKey, fetch: fetcher });
  const error = await client
    .getDatabase(f.database.id)
    .catch((value: unknown) => value);
  expect(error).toMatchObject({ code: "conflict", status: 409, requestId });
  expect(JSON.stringify(error)).not.toContain(f.apiKey);
  const unsafeId = await client
    .getDatabase(f.database.id)
    .catch((value: unknown) => value);
  expect(unsafeId).toMatchObject({
    code: "conflict",
    status: 409,
    requestId: null,
  });
  expect(JSON.stringify(unsafeId)).not.toContain(f.apiKey);
});

it("refuses redirects without following them or exposing their locations", async () => {
  const f = fixtures();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(null, {
      status: 302,
      headers: { Location: `${baseUrl}/${f.apiKey}` },
    }),
  );
  const client = new PgcfClient({ baseUrl, apiKey: f.apiKey, fetch: fetcher });
  const error = await client
    .getDatabase(f.database.id)
    .catch((value: unknown) => value);
  expect(error).toMatchObject({ code: "redirect_refused", status: 302 });
  expect(fetcher.mock.calls[0]![1]!.redirect).toBe("manual");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(error)).not.toContain(f.apiKey);
});

it("bounds the whole request including a stalled body and cancels it without retry", async () => {
  vi.useFakeTimers();
  const f = fixtures();
  const cancel = vi.fn();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(new ReadableStream({ cancel })));
  const client = new PgcfClient({
    baseUrl,
    apiKey: f.apiKey,
    timeoutMs: 30,
    fetch: fetcher,
  });
  const pending = client
    .createDatabase(f.request, f.idempotencyKey)
    .catch((value: unknown) => value);
  await vi.advanceTimersByTimeAsync(31);
  expect(await pending).toMatchObject({
    code: "timeout",
    status: null,
    requestId: null,
  });
  expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
