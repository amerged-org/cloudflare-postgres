// SPDX-License-Identifier: Apache-2.0
import { env, exports } from "cloudflare:workers";
import { createRoute } from "@hono/zod-openapi";
import {
  decodeCursor,
  encodeCursor,
  ErrorBody,
  ProjectCreate,
} from "@pgcf/contracts";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import { ApiError, createApp, JSON_BODY_MAX_BYTES } from "../src/app.ts";

function request(path: string, init?: RequestInit): Request {
  return new Request(
    new URL(path, `https://${["api", "invalid"].join(".")}`),
    init,
  );
}

function projectApp() {
  const app = createApp();
  app.openapi(
    createRoute({
      method: "post",
      path: "/test/projects",
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: ProjectCreate } },
        },
      },
      responses: {
        200: {
          description: "Validated project body",
          content: { "application/json": { schema: ProjectCreate } },
        },
      },
    }),
    (c) => c.json(c.req.valid("json"), 200),
  );
  return app;
}

describe("API harness in the Workers runtime", () => {
  it("serves health through the Worker fetch entry", async () => {
    const response = await exports.default.fetch(request("/healthz"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("X-Request-Id")).toMatch(/^[a-f0-9-]{36}$/);
  });

  it("generates an OpenAPI document for registered routes", async () => {
    const response = await exports.default.fetch(request("/v1/openapi.json"));
    expect(response.status).toBe(200);
    const document = await response.json<{
      openapi: string;
      paths: Record<string, unknown>;
    }>();
    expect(document.openapi).toBe("3.1.0");
    expect(document.paths["/healthz"]).toBeDefined();
    expect(response.headers.get("X-Request-Id")).toBeTruthy();
  });

  it("returns the shared error envelope for an unknown route", async () => {
    const response = await exports.default.fetch(request("/missing"));
    expect(response.status).toBe(404);
    const body = ErrorBody.parse(await response.json());
    expect(body.error.code).toBe("not_found");
    expect(body.error.request_id).toBe(response.headers.get("X-Request-Id"));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("preserves a safe caller request id and replaces an invalid one", async () => {
    const app = createApp();
    const response = await app.fetch(
      request("/healthz", { headers: { "X-Request-Id": "request-42" } }),
      env,
    );
    expect(response.headers.get("X-Request-Id")).toBe("request-42");
    const invalid = await app.fetch(
      request("/missing", {
        headers: { "X-Request-Id": "unsafe ".repeat(30) },
      }),
      env,
    );
    expect(invalid.headers.get("X-Request-Id")).toMatch(/^[a-f0-9-]{36}$/);
    expect(ErrorBody.parse(await invalid.json()).error.request_id).toBe(
      invalid.headers.get("X-Request-Id"),
    );
  });

  it("rejects malformed JSON without echoing the input", async () => {
    const app = projectApp();
    const input = `{${crypto.randomUUID()}`;
    const response = await app.fetch(
      request("/test/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: input,
      }),
      env,
    );
    expect(response.status).toBe(400);
    const body = ErrorBody.parse(await response.json());
    expect(body.error.code).toBe("invalid_request");
    expect(JSON.stringify(body)).not.toContain(input);
    expect(body.error.request_id).toBe(response.headers.get("X-Request-Id"));
  });

  it("bounds streamed bodies even when Content-Length is absent", async () => {
    const app = projectApp();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(JSON_BODY_MAX_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await app.fetch(
      request("/test/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: stream,
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(ErrorBody.parse(await response.json()).error.code).toBe(
      "invalid_request",
    );
    expect(cancelled).toBe(true);
  });

  it("counts bytes and accepts a JSON body exactly at the limit", async () => {
    const app = projectApp();
    const valid = JSON.stringify({ name: "example" });
    const exact =
      valid +
      " ".repeat(
        JSON_BODY_MAX_BYTES - new TextEncoder().encode(valid).byteLength,
      );
    const accepted = await app.fetch(
      request("/test/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: exact,
      }),
      env,
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ name: "example" });

    const oversized = JSON.stringify({
      name: "é".repeat(JSON_BODY_MAX_BYTES / 2),
    });
    const rejected = await app.fetch(
      request("/test/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: oversized,
      }),
      env,
    );
    expect(rejected.status).toBe(400);
    expect(ErrorBody.parse(await rejected.json()).error.code).toBe(
      "invalid_request",
    );
  });

  it("validates plain contracts zod schemas and uses their meta ids in OpenAPI", async () => {
    const app = projectApp();
    const response = await app.fetch(
      request("/test/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "example", external_id: "external-42" }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(ProjectCreate.parse(await response.json())).toEqual({
      name: "example",
      external_id: "external-42",
    });
    const invalid = await app.fetch(
      request("/test/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"name":42}',
      }),
      env,
    );
    expect(invalid.status).toBe(400);
    expect(ErrorBody.parse(await invalid.json()).error.code).toBe(
      "invalid_request",
    );
    const documentResponse = await app.fetch(request("/v1/openapi.json"), env);
    const document = await documentResponse.json<{
      components: { schemas: Record<string, unknown> };
      paths: Record<string, unknown>;
    }>();
    expect(document.components.schemas.ProjectCreate).toBeDefined();
    expect(JSON.stringify(document.paths["/test/projects"])).toContain(
      "#/components/schemas/ProjectCreate",
    );
  });

  it("sanitizes unexpected errors", async () => {
    const app = createApp();
    const sensitive = crypto.randomUUID();
    app.get("/test/error", () => {
      throw new Error(sensitive);
    });
    const response = await app.fetch(request("/test/error"), env);
    expect(response.status).toBe(500);
    const body = ErrorBody.parse(await response.json());
    expect(body.error.code).toBe("internal");
    expect(JSON.stringify(body)).not.toContain(sensitive);
    expect(body.error.request_id).toBe(response.headers.get("X-Request-Id"));
  });

  it("returns intentional API errors and sanitizes framework errors", async () => {
    const app = createApp();
    app.get("/test/conflict", () => {
      throw new ApiError("conflict", "Resource already exists", {
        resource: "project",
      });
    });
    const sensitive = crypto.randomUUID();
    app.get("/test/framework-error", () => {
      throw new HTTPException(401, { message: sensitive });
    });
    const response = await app.fetch(request("/test/conflict"), env);
    expect(response.status).toBe(409);
    expect(ErrorBody.parse(await response.json()).error).toEqual({
      code: "conflict",
      message: "Resource already exists",
      request_id: response.headers.get("X-Request-Id"),
      details: { resource: "project" },
    });
    const framework = await app.fetch(request("/test/framework-error"), env);
    expect(framework.status).toBe(401);
    const body = ErrorBody.parse(await framework.json());
    expect(body.error.code).toBe("unauthorized");
    expect(JSON.stringify(body)).not.toContain(sensitive);
  });

  it("rejects non-JSON content and invalid UTF-8", async () => {
    const app = projectApp();
    const nonJson = await app.fetch(
      request("/test/projects", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ name: "example" }),
      }),
      env,
    );
    expect(nonJson.status).toBe(400);
    expect(ErrorBody.parse(await nonJson.json()).error.code).toBe(
      "invalid_request",
    );
    const invalidUtf8 = await app.fetch(
      request("/test/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: new Uint8Array([0xff]),
      }),
      env,
    );
    expect(invalidUtf8.status).toBe(400);
    expect(ErrorBody.parse(await invalidUtf8.json()).error.code).toBe(
      "invalid_request",
    );
  });

  it("applies the real migration to the Workers D1 binding", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toContain("databases");
    const migration = await env.DB.prepare(
      "SELECT name FROM d1_migrations",
    ).all<{ name: string }>();
    expect(migration.results.map((row) => row.name)).toContain("0001_init.sql");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM projects").first(
        "count",
      ),
    ).toBe(0);
  });

  it("decodes shared cursors inside the Workers runtime", () => {
    const cursor = {
      created_at: "2026-10-02T00:00:00.000Z",
      id: `prj_${"a".repeat(20)}`,
    };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(decodeCursor("malformed")).toBeNull();
  });
});
