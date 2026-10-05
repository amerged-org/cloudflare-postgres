// SPDX-License-Identifier: Apache-2.0
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ERROR_HTTP_STATUS, errorBody, type ErrorCode } from "@pgcf/contracts";
import { HTTPException } from "hono/http-exception";
import { routePath } from "hono/route";
import { version } from "../package.json";
import type { ApiContext, ApiEnv } from "./env.ts";
import { registerDomain } from "./routes/domain.ts";
import { registerPlatform } from "./routes/platform.ts";
import { registerUsage } from "./routes/usage.ts";
import { registerAgentMetrics } from "./routes/agent-metrics.ts";
import { registerCosts } from "./routes/costs.ts";
import { registerNodes } from "./routes/nodes.ts";
import { authenticateBootstrapCallback } from "./domain/bootstrap-jobs.ts";
import { NodeStateError } from "./domain/node-state.ts";
import { requireScope } from "./middleware/auth.ts";

export type ApiApp = OpenAPIHono<ApiEnv>;
export const REQUEST_ID_HEADER = "X-Request-Id";
export const DIAGNOSTIC_ID_HEADER = "X-PGCF-Diagnostic-Id";
export const JSON_BODY_MAX_BYTES = 64 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
const DIAGNOSTIC_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
const DIAGNOSTIC_ROUTES = new Set([
  "/v1/costs",
  "/v1/costs/node-facts",
  "/healthz",
  "/v1/openapi.json",
  "/v1/api-keys",
  "/v1/api-keys/:id",
  "/v1/projects",
  "/v1/projects/:id",
  "/v1/size-classes",
  "/v1/size-classes/:id",
  "/v1/regions",
  "/v1/nodes",
  "/v1/nodes/additions",
  "/v1/nodes/additions/:id",
  "/v1/nodes/additions/:id/approve",
  "/v1/nodes/additions/:id/cancel",
  "/v1/nodes/additions/:id/bootstrap",
  "/v1/nodes/additions/:id/verify",
  "/v1/regions/:id/capacity-policy",
  "/v1/regions/:id/capacity-decision",
  "/internal/v1/node-bootstrap/:operation_id",
  "/internal/v1/node-bootstrap/:operation_id/relay",
  "/v1/databases",
  "/v1/databases/:id",
  "/v1/databases/:id/suspend",
  "/v1/databases/:id/restore",
  "/v1/databases/:id/resume",
  "/v1/databases/:id/roles",
  "/v1/databases/:id/roles/:name/reset-password",
  "/v1/databases/:id/roles/:name/connection-uri",
  "/v1/operations/:id",
  "/v1/usage",
  "/v1/databases/:id/archive",
  "/agent/v1/desired",
  "/agent/v1/observations",
  "/agent/v1/activity",
  "/agent/v1/usage",
  "/agent/v1/link",
]);

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }
}

export function apiError(
  c: ApiContext,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): Response {
  return c.json(
    errorBody(code, message, c.get("requestId"), details),
    ERROR_HTTP_STATUS[code],
  );
}

async function readJsonBody(
  request: Request,
  maximum = JSON_BODY_MAX_BYTES,
): Promise<{ text: string; byteLength: number }> {
  const reader = request.body!.getReader();
  const bytes = new Uint8Array(maximum);
  let length = 0;
  try {
    const declared = request.headers.get("Content-Length");
    if (
      declared !== null &&
      /^\d+$/.test(declared) &&
      Number(declared) > maximum
    ) {
      await reader.cancel();
      throw new ApiError(
        "invalid_request",
        `JSON body exceeds ${maximum / 1024} KiB`,
      );
    }
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > maximum - length) {
        await reader.cancel();
        throw new ApiError(
          "invalid_request",
          `JSON body exceeds ${maximum / 1024} KiB`,
        );
      }
      bytes.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
    return {
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        bytes.subarray(0, length),
      ),
      byteLength: length,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("invalid_request", "Could not read JSON body");
  } finally {
    reader.releaseLock();
  }
}

function httpError(error: HTTPException): { code: ErrorCode; message: string } {
  switch (error.status) {
    case 400:
    case 413:
    case 415:
    case 422:
      return { code: "invalid_request", message: "Invalid request" };
    case 401:
      return { code: "unauthorized", message: "Unauthorized" };
    case 403:
      return { code: "forbidden", message: "Forbidden" };
    case 404:
      return { code: "not_found", message: "Route not found" };
    case 409:
      return {
        code: "conflict",
        message: "Request conflicts with current state",
      };
    case 429:
      return { code: "rate_limited", message: "Too many requests" };
    case 503:
      return { code: "capacity_exhausted", message: "Capacity unavailable" };
    default:
      return { code: "internal", message: "Internal server error" };
  }
}

export function createApp(): ApiApp {
  const app = new OpenAPIHono<ApiEnv>({
    defaultHook(result, c) {
      if (!result.success)
        return apiError(c, "invalid_request", "Request validation failed");
    },
  });

  app.use("*", async (c, next) => {
    const diagnosticId = crypto.randomUUID();
    const started = performance.now();
    const supplied = c.req.header(REQUEST_ID_HEADER);
    const requestId =
      supplied !== undefined && REQUEST_ID_PATTERN.test(supplied)
        ? supplied
        : crypto.randomUUID();
    c.set("requestId", requestId);
    c.header(REQUEST_ID_HEADER, requestId);
    c.header(DIAGNOSTIC_ID_HEADER, diagnosticId);
    await next();
    c.header(REQUEST_ID_HEADER, requestId);
    c.header(DIAGNOSTIC_ID_HEADER, diagnosticId);
    if (c.res.status >= 400) {
      const matched = routePath(c, -1);
      console.error(
        JSON.stringify({
          event: "api_request_failed",
          diagnostic_id: diagnosticId,
          method: DIAGNOSTIC_METHODS.has(c.req.method) ? c.req.method : "OTHER",
          route: DIAGNOSTIC_ROUTES.has(matched) ? matched : "unmatched",
          status: c.res.status,
          elapsed_ms: Math.round(performance.now() - started),
        }),
      );
    }
  });

  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof ApiError)
      return apiError(c, error.code, error.message, error.details);
    if (error instanceof NodeStateError)
      return apiError(
        c,
        error.code === "not_found"
          ? "not_found"
          : error.code === "capacity_unavailable"
            ? "capacity_exhausted"
            : "conflict",
        error.message,
      );
    if (error instanceof HTTPException) {
      const mapped = httpError(error);
      return apiError(c, mapped.code, mapped.message);
    }
    return apiError(c, "internal", "Internal server error");
  });

  app.use("*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const callback = /^\/internal\/v1\/node-bootstrap\/(op_[a-z0-9]{20})$/.exec(
      path,
    );
    const privateBootstrap =
      /^\/v1\/nodes\/additions\/op_[a-z0-9]{20}\/bootstrap$/.test(path) &&
      c.req.method === "POST";
    let maximum = JSON_BODY_MAX_BYTES;
    if (callback && c.req.method === "POST") {
      await authenticateBootstrapCallback(c, callback[1]!);
      maximum = 512 * 1024;
    } else if (privateBootstrap) {
      await requireScope(c, "admin");
      maximum = 512 * 1024;
    }
    if (c.req.raw.body !== null) {
      const { text, byteLength } = await readJsonBody(c.req.raw, maximum);
      // A bodyless HTTP request can arrive as a non-null zero-byte stream.
      if (byteLength !== 0) {
        const mediaType = c.req.header("Content-Type")?.split(";")[0]?.trim();
        if (
          mediaType === undefined ||
          !/^application\/(?:[a-z0-9.+-]+\+)?json$/i.test(mediaType)
        ) {
          throw new ApiError(
            "invalid_request",
            "Content-Type must be application/json",
          );
        }
        try {
          JSON.parse(text);
        } catch {
          throw new ApiError("invalid_request", "Malformed JSON body");
        }
      }
      // Preserve the bounded body for validators and idempotency request hashing.
      c.req.raw = new Request(c.req.raw, { body: text });
    }
    await next();
  });

  const health = z
    .strictObject({ status: z.literal("ok") })
    .meta({ id: "Health" });
  app.openapi(
    createRoute({
      method: "get",
      path: "/healthz",
      responses: {
        200: {
          description: "Worker is running",
          content: { "application/json": { schema: health } },
        },
      },
    }),
    (c) => c.json({ status: "ok" as const }, 200),
  );

  registerPlatform(app);
  registerDomain(app);
  registerUsage(app);
  registerAgentMetrics(app);
  registerCosts(app);
  registerNodes(app);
  app.doc31("/v1/openapi.json", {
    openapi: "3.1.0",
    info: { title: "PGCF API", version },
  });
  app.notFound((c) => apiError(c, "not_found", "Route not found"));
  return app;
}
