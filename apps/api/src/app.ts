// SPDX-License-Identifier: Apache-2.0
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ERROR_HTTP_STATUS,
  errorBody,
  retryAfterSeconds,
  type ErrorCode,
  type ErrorDetails,
} from "@pgcf/contracts";
import { HTTPException } from "hono/http-exception";
import { routePath } from "hono/route";
import { ApiError, failureCause } from "./api-error.ts";
import { registerApiDocuments } from "./openapi.ts";
import type { ApiContext, ApiEnv } from "./env.ts";
import { registerDomain } from "./routes/domain.ts";
import { registerDatabaseResources } from "./routes/database-resources.ts";
import { registerPlatform } from "./routes/platform.ts";
import { registerUsage } from "./routes/usage.ts";
import { registerWebhooks } from "./routes/webhooks.ts";
import { registerCosts } from "./routes/costs.ts";
import { registerOperationalHealth } from "./routes/health.ts";
import { registerRegionConfiguration } from "./routes/region-configuration.ts";
import { registerFleetReleases } from "./routes/fleet-releases.ts";
import { registerResourceProfiles } from "./routes/resource-profiles.ts";
import { registerNodeLink } from "./routes/node-link.ts";
import { nodeLookup } from "./domain/node-auth.ts";
import { registerNodes } from "./routes/nodes.ts";
import { registerLifecycle } from "./routes/lifecycle.ts";
import { registerInfrastructureBackups } from "./routes/infrastructure-backups.ts";
import { registerAuditEvents } from "./routes/audit-events.ts";
import { recordAuditOutcome } from "./middleware/audit.ts";
import { NodeStateError } from "./domain/node-state.ts";

export type ApiApp = OpenAPIHono<ApiEnv>;
export const REQUEST_ID_HEADER = "X-Request-Id";
export const DIAGNOSTIC_ID_HEADER = "X-PGCF-Diagnostic-Id";
export const JSON_BODY_MAX_BYTES = 64 * 1024;
/** A node's volume report names up to 10,000 volumes. */
export const NODE_JSON_BODY_MAX_BYTES = 4 * 1024 * 1024;
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
export const DIAGNOSTIC_ROUTES = new Set([
  "/v1/costs",
  "/v1/operational-health",
  "/v1/nodes/:id/mark-lost",
  "/v1/nodes/:id/loss",
  "/v1/nodes/:id/reinstall-override",
  "/v1/nodes/:id/maintenance",
  "/v1/nodes/:id/maintenance/:operation",
  "/v1/nodes/:id/diagnostics",
  "/v1/nodes/:id/diagnostics/:diagnostic_id",
  "/v1/nodes/:id/database-placement",
  "/v1/nodes/:id",
  "/v1/regions/:id",
  "/v1/fleet/releases",
  "/v1/infrastructure-backups",
  "/v1/infrastructure-backups/config",
  "/v1/databases/:id/move",
  "/v1/databases/:id/moves",
  "/v1/databases/:id/restore-in-place",
  "/v1/databases/:id/restores/in-place",
  "/v1/costs/node-facts",
  "/healthz",
  "/v1/openapi.json",
  "/v1/api-keys",
  "/v1/api-keys/:id",
  "/v1/audit-events",
  "/v1/projects",
  "/v1/projects/:id",
  "/v1/size-classes",
  "/v1/size-classes/:id",
  "/v1/resource-profiles/:id",
  "/v1/resource-profiles/:id/rollout",
  "/v1/resource-profiles/:id/revisions/:revision",
  "/v1/databases/:id/resource-profile",
  "/v1/regions",
  "/v1/regions/:id/configuration",
  "/v1/fleet/releases/:id",
  "/v1/regions/:id/release",
  "/v1/nodes/:id/release",
  "/v1/nodes",
  "/v1/nodes/additions",
  "/v1/nodes/additions/:id",
  "/v1/nodes/additions/:id/approve",
  "/v1/nodes/additions/:id/cancel",
  "/v1/regions/:id/capacity-policy",
  "/v1/regions/:id/capacity-decision",
  "/v1/databases",
  "/v1/databases/:id",
  "/v1/databases/:id/idle-time",
  "/v1/databases/:id/resources",
  "/v1/databases/:id/suspend",
  "/v1/databases/:id/restore",
  "/v1/databases/:id/resume",
  "/v1/databases/:id/roles",
  "/v1/databases/:id/roles/:name",
  "/v1/databases/:id/roles/:name/reset-password",
  "/v1/databases/:id/roles/:name/connection-uri",
  "/v1/operations/:id",
  "/v1/databases/:id/operations",
  "/v1/usage",
  "/v1/webhooks",
  "/v1/webhooks/:id",
  "/v1/webhooks/:id/test",
  "/v1/databases/:id/webhook-deliveries",
  "/v1/databases/:id/webhook-deliveries/:delivery_id/replay",
  "/v1/databases/:id/archive",
  "/v1/databases/:id/backups",
  "/v1/regions/:id/node-policy",
  "/node/v1/enroll",
  "/node/v1/installer/progress",
  "/node/v1/releases/:version/pgcf-node.raw.zst",
  "/node/v1/releases/:version/host-files/:sha256",
  "/node/v1/releases/:version/:file",
  "/node/v1/link",
  "/node/v1/desired",
  "/node/v1/credentials",
  "/node/v1/observations",
  "/node/v1/volumes",
  "/node/v1/events",
  "/node/v1/usage",
  "/node/v1/diagnostics",
  "/node/v1/archive-credentials/:id",
  "/node/v1/openapi.json",
]);

export function apiError(
  c: ApiContext,
  code: ErrorCode,
  message: string,
  details?: ErrorDetails,
): Response {
  const retry = retryAfterSeconds(code, details?.reason);
  return c.json(
    errorBody(code, message, c.get("requestId"), details),
    ERROR_HTTP_STATUS[code],
    retry === undefined ? undefined : { "Retry-After": String(retry) },
  );
}

async function readJsonBody(
  request: Request,
  maximum: number,
): Promise<{ text: string; bytes: Uint8Array }> {
  const reader = request.body!.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const tooLarge = () =>
    new ApiError("invalid_request", `JSON body exceeds ${maximum / 1024} KiB`);
  try {
    const declared = request.headers.get("Content-Length");
    if (
      declared !== null &&
      /^\d+$/.test(declared) &&
      Number(declared) > maximum
    ) {
      await reader.cancel();
      throw tooLarge();
    }
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > maximum - length) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(chunk.value);
      length += chunk.value.byteLength;
    }
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    return {
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        bytes,
      ),
      bytes,
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
      const cause = c.get("failureCause");
      console.error(
        JSON.stringify({
          event: "api_request_failed",
          diagnostic_id: diagnosticId,
          method: DIAGNOSTIC_METHODS.has(c.req.method) ? c.req.method : "OTHER",
          route: DIAGNOSTIC_ROUTES.has(matched) ? matched : "unmatched",
          status: c.res.status,
          elapsed_ms: Math.round(performance.now() - started),
          ...(cause ? { cause } : {}),
        }),
      );
    }
  });

  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  });
  app.use("*", recordAuditOutcome);
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
    const cause = failureCause(error);
    if (cause) c.set("failureCause", cause);
    return apiError(c, "internal", "Internal server error");
  });

  // A node's key is looked up before its body is read; its signature covers the body.
  app.use("/node/v1/*", nodeLookup);
  app.use("*", async (c, next) => {
    if (c.req.raw.body !== null) {
      // Only a request that names an enrolled node's key may carry a node's larger body; the
      // installer's progress and the enrollment are read like any other request.
      const { text, bytes } = await readJsonBody(
        c.req.raw,
        c.get("nodeClaim") === undefined
          ? JSON_BODY_MAX_BYTES
          : NODE_JSON_BODY_MAX_BYTES,
      );
      // The bytes a node signed are the bytes it sent, not what parsing leaves of them.
      c.set("body", bytes);
      // A bodyless HTTP request can arrive as a non-null zero-byte stream.
      if (bytes.byteLength !== 0) {
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
  registerDatabaseResources(app);
  registerUsage(app);
  registerWebhooks(app);
  registerCosts(app);
  registerNodes(app);
  registerNodeLink(app);
  registerLifecycle(app);
  registerInfrastructureBackups(app);
  registerAuditEvents(app);
  registerOperationalHealth(app);
  registerRegionConfiguration(app);
  registerFleetReleases(app);
  registerResourceProfiles(app);
  registerApiDocuments(app);
  app.notFound((c) => apiError(c, "not_found", "Route not found"));
  return app;
}
