// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from "vitest";
import { PgcfClient, PgcfClientError } from "../src/client.ts";
import { newApiKey } from "../src/auth.ts";
import {
  Database,
  DatabaseWithOperation,
  type DatabaseCreate,
} from "../src/api.ts";
import { newDatabaseId, newOperationId, newProjectId } from "../src/ids.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const baseUrl = `https://${["api", "invalid"].join(".")}`;
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
