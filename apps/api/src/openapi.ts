// SPDX-License-Identifier: Apache-2.0
import { NODE_OPERATOR_KUBERNETES_HEADERS } from "@pgcf/contracts/node-operator";
import { ApiError, type ApiApp } from "./app.ts";
import type { Env } from "./env.ts";
import { routeMetadata, type DocumentationAuth } from "./openapi-metadata.ts";
import {
  agentRouteErrors,
  registerCallbackDocumentation,
} from "./openapi-callbacks.ts";
import { registerFleetImageDocumentation } from "./openapi-fleet-images.ts";
import {
  publicRouteErrors,
  idempotentPublicRoutes,
  requiredIdempotentPublicRoutes,
  locationResponses,
} from "./openapi-public-errors.ts";

type Document = ReturnType<ApiApp["getOpenAPI31Document"]>;
type PathItem = NonNullable<Document["paths"]>[string];
type Operation = NonNullable<PathItem["get"]>;
type Scope = "public" | "agent" | "internal";
const methods = ["get", "head", "post", "put", "patch", "delete"] as const;
const scopes = [
  ["public", "/v1/openapi.json", "PGCF management API"],
  ["agent", "/agent/v1/openapi.json", "PGCF regional agent API"],
  ["internal", "/internal/v1/openapi.json", "PGCF operation callback API"],
] as const;
const errors: Record<number, string> = {
  400: "Invalid request",
  401: "Invalid or missing credentials",
  403: "Administrator scope required",
  404: "Resource not found or inaccessible",
  409: "Request conflicts with current authority or state",
  500: "Internal server error",
  503: "Capacity unavailable",
};
const authDescription: Record<DocumentationAuth, string> = {
  none: "",
  api: "Accepts an administrator or integrator API key.",
  project:
    "Accepts an administrator or integrator API key; a resource outside the integrator's project is reported as not found.",
  admin: "Requires an administrator API key.",
  agent:
    "Requires the current regional agent bearer, rather than a management API key.",
  callback:
    "Requires the current bearer scoped to this operation, session or execution lease, rather than a management or regional agent key.",
};
const responseHeaders = {
  "X-Request-Id": {
    description: "The accepted caller request identifier or a generated UUID",
    schema: { type: "string" as const },
  },
  "X-PGCF-Diagnostic-Id": {
    description: "Fresh diagnostic identifier for this request",
    schema: { type: "string" as const, format: "uuid" },
  },
  "Cache-Control": { schema: { type: "string" as const, const: "no-store" } },
  "X-Content-Type-Options": {
    schema: { type: "string" as const, const: "nosniff" },
  },
};

function inScope(scope: Scope, path: string): boolean {
  return scope === "public"
    ? path.startsWith("/v1/") ||
        path === "/healthz" ||
        path === "/fleet-images/v1/raw/{digest}"
    : scope === "agent"
      ? path.startsWith("/agent/")
      : path.startsWith("/internal/") || path === "/source-control";
}

function workerVersion(env: Env): WorkerVersionMetadata {
  const metadata = env.CF_VERSION_METADATA;
  if (
    !metadata ||
    typeof metadata.id !== "string" ||
    metadata.id.length === 0 ||
    typeof metadata.tag !== "string" ||
    typeof metadata.timestamp !== "string" ||
    !Number.isFinite(Date.parse(metadata.timestamp))
  )
    throw new ApiError("internal", "Worker version metadata is unavailable");
  return { id: metadata.id, tag: metadata.tag, timestamp: metadata.timestamp };
}

function describeOperation(key: string, operation: Operation): void {
  const metadata = routeMetadata[key];
  if (!metadata)
    throw new ApiError(
      "internal",
      "Registered API route documentation is incomplete",
    );
  operation.operationId ??= metadata.operationId;
  operation.summary ??= metadata.summary;
  const authentication =
    key === "POST /v1/api-keys"
      ? "Requires an administrator API key, except for the one-time bootstrap bearer that creates the first administrator key. Bootstrap creation ignores Idempotency-Key."
      : authDescription[metadata.auth];
  if (authentication)
    operation.description = [operation.description, authentication]
      .filter(Boolean)
      .join("\n\n");
  operation.security =
    metadata.auth === "none"
      ? []
      : [
          {
            [metadata.auth === "agent"
              ? "AgentBearer"
              : metadata.auth === "callback"
                ? "CallbackBearer"
                : "bearerAuth"]: [],
          },
        ];
  const statuses =
    metadata.errors ?? publicRouteErrors[key] ?? agentRouteErrors[key];
  if (statuses) {
    for (const status of Object.keys(operation.responses ?? {}))
      if (Number(status) >= 400 && !statuses.includes(Number(status)))
        delete operation.responses![status];
    for (const status of statuses)
      (operation.responses ??= {})[status] ??= {
        description:
          status === 403 && metadata.auth !== "admin"
            ? "Scoped execution authority is unavailable or changed"
            : (errors[status] ?? "Request refused"),
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Error" },
          },
        },
      };
  }
  operation.parameters = (operation.parameters ?? []).filter(
    (parameter) =>
      !(
        "name" in parameter &&
        parameter.in === "header" &&
        parameter.name === "Idempotency-Key"
      ),
  );
  if (idempotentPublicRoutes.has(key))
    operation.parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: requiredIdempotentPublicRoutes.has(key),
      description:
        key === "POST /v1/api-keys"
          ? "Optional for authenticated API-key creation. One-time credentials cannot be replayed: reuse of the same key returns 409. Bootstrap creation ignores this header."
          : key === "POST /v1/regions"
            ? "Optional for region creation. One-time regional agent credentials cannot be replayed: reuse of the same key returns 409."
            : "Reusing a key with the same request returns the retained result; a different request conflicts. Omit only where optional.",
      schema: { type: "string", pattern: "^[A-Za-z0-9._~-]{1,128}$" },
    });
  operation.parameters.push({
    name: "X-Request-Id",
    in: "header",
    required: false,
    description:
      "A 1–128 character identifier using letters, digits, dot, underscore, tilde or hyphen is echoed. Invalid values are replaced with a generated UUID.",
    schema: { type: "string" },
  });
  for (const [status, response] of Object.entries(operation.responses ?? {})) {
    if ("$ref" in response) continue;
    response.headers = { ...responseHeaders, ...response.headers };
    if (operation.responses?.default) {
      response.headers["Cache-Control"] = {
        description:
          "Local API responses use no-store; upstream handshake responses retain their own cache policy",
        schema: { type: "string" },
      };
      response.headers["X-Content-Type-Options"] = {
        description:
          "Local API responses use nosniff; upstream handshake headers are passed through",
        schema: { type: "string" },
      };
    }
    const location = locationResponses[key]?.[status];
    if (location)
      response.headers.Location = {
        description: location,
        schema: { type: "string" },
      };
  }
  if (operation.responses?.["101"]) {
    if (
      !operation.parameters.some(
        (parameter) =>
          "name" in parameter &&
          parameter.in === "header" &&
          parameter.name.toLowerCase() === "upgrade",
      )
    )
      operation.parameters.push({
        name: "Upgrade",
        in: "header",
        required: true,
        schema: { type: "string", const: "websocket" },
      });
    const response = operation.responses["101"];
    if (!("$ref" in response)) {
      delete response.content;
      if (key === "GET /v1/nodes/{id}/operator/kubernetes")
        for (const name of Object.values(NODE_OPERATOR_KUBERNETES_HEADERS))
          (response.headers ??= {})[name] = {
            description: "Fenced Kubernetes relay target identity",
            schema: { type: "string" },
          };
    }
  }
  if (key === "GET /agent/v1/link")
    operation.responses!["426"] = {
      description: "WebSocket upgrade required",
      headers: responseHeaders,
      content: {
        "text/plain": {
          schema: { type: "string", const: "WebSocket upgrade required" },
        },
      },
    };
}

/** Keep only components referenced by this interface, including transitive schema references. */
function scopedComponents(document: Document): void {
  const source = document.components ?? {};
  const retained: Record<string, Record<string, unknown>> = {};
  const pending: string[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (
      "$ref" in value &&
      typeof value.$ref === "string" &&
      value.$ref.startsWith("#/components/")
    )
      pending.push(value.$ref);
    for (const child of Object.values(value)) visit(child);
  };
  visit(document.paths);
  for (const item of Object.values(document.paths ?? {}))
    for (const method of methods)
      for (const security of item[method]?.security ?? [])
        for (const name of Object.keys(security))
          if (source.securitySchemes?.[name])
            (retained.securitySchemes ??= {})[name] =
              source.securitySchemes[name];
  while (pending.length) {
    const reference = pending.pop()!;
    if (seen.has(reference)) continue;
    seen.add(reference);
    const [, , section, name] = reference
      .split("/")
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    const value =
      section && name
        ? (source as Record<string, Record<string, unknown>>)[section]?.[name]
        : undefined;
    if (value === undefined)
      throw new ApiError(
        "internal",
        "API documentation component reference is unresolved",
      );
    (retained[section!] ??= {})[name!] = value;
    visit(value);
  }
  document.components = retained;
}

export function registerApiDocuments(app: ApiApp): void {
  app.openAPIRegistry.registerComponent("securitySchemes", "CallbackBearer", {
    type: "http",
    scheme: "bearer",
    description:
      "Ephemeral bearer scoped to the selected operation, callback session or current execution lease.",
  });
  registerCallbackDocumentation(app);
  registerFleetImageDocumentation(app);
  for (const [scope, path, title] of scopes) {
    app.openAPIRegistry.registerPath({
      method: "get",
      path,
      responses: {
        200: {
          description: "OpenAPI 3.1 reference for this interface",
          content: { "application/json": { schema: {} } },
        },
      },
    });
    app.get(path, (c) => {
      const metadata = workerVersion(c.env);
      const document = structuredClone(
        app.getOpenAPI31Document({
          openapi: "3.1.0",
          info: { title, version: metadata.id, "x-worker-version": metadata },
        }),
      );
      document.paths = Object.fromEntries(
        Object.entries(document.paths ?? {}).filter(([candidate]) =>
          inScope(scope, candidate),
        ),
      );
      for (const [candidate, item] of Object.entries(document.paths))
        for (const method of methods) {
          const operation = item[method];
          if (operation)
            describeOperation(
              method.toUpperCase() + " " + candidate,
              operation,
            );
        }
      scopedComponents(document);
      return c.json(document);
    });
  }
}
