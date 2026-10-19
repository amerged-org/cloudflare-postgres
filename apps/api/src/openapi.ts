// SPDX-License-Identifier: Apache-2.0
import {
  API_CONTRACT_VERSION,
  RETRYABLE_ERROR_REASONS,
  TIMESTAMP_PATTERN,
} from "@pgcf/contracts";
import { ApiError } from "./api-error.ts";
import type { ApiApp } from "./app.ts";
import type { Env } from "./env.ts";
import { routeMetadata, type DocumentationAuth } from "./openapi-metadata.ts";
import {
  publicRouteErrors,
  idempotentPublicRoutes,
  requiredIdempotentPublicRoutes,
  locationResponses,
} from "./openapi-public-errors.ts";

type Document = ReturnType<ApiApp["getOpenAPI31Document"]>;
type PathItem = NonNullable<Document["paths"]>[string];
type Operation = NonNullable<PathItem["get"]>;
type Scope = "public" | "node";
const methods = ["get", "head", "post", "put", "patch", "delete"] as const;
const scopes = [
  [
    "public",
    "/v1/openapi.json",
    "PGCF management API",
    [
      "Request bodies are JSON of at most 64 KiB and carry `Content-Type: application/json` whenever there is a body; unknown fields are refused with `400`.",
      "Timestamps are UTC with exactly three fractional digits and a literal `Z`, as `Date#toISOString` renders them.",
      "Lists are ordered newest first and take `limit` (1 to 100) and the opaque `cursor` of the previous page's `next_cursor`.",
      "An error is `{error: {code, message, request_id, details?}}`. `details.reason` is the stable cause where a code stands for several, and a `Retry-After` header advises the delay of a transient refusal.",
      "A mutation that names `Idempotency-Key` is repeated safely under the same key for 24 hours, per API key.",
      "A resource of another project is reported as `404`, never `403`.",
    ].join("\n\n"),
  ],
  [
    "node",
    "/node/v1/openapi.json",
    "PGCF node API",
    [
      "A node calls these routes. Every one but the enrollment, the installer's report and the release files carries `Authorization: Bearer pgcf_nr1.<claims>.<signature>`: an Ed25519 signature of the request's method, its path with the query and the SHA-256 of its body, valid for 60 seconds.",
      "Request bodies are JSON of at most 4 MiB.",
      'A node declared lost reaches only the desired page and the observations; every other route answers `403 {"error":"node_fenced"}`.',
    ].join("\n\n"),
  ],
] as const;
/** A node's key is checked before the request is read; handler reads and state fences give the rest. */
const nodeRouteErrors: Readonly<Record<string, readonly number[]>> = {
  "POST /node/v1/enroll": [400, 401, 403, 409, 500],
  "POST /node/v1/installer/progress": [400, 401, 409, 500],
  "GET /node/v1/releases/{version}/pgcf-node.raw.zst": [401, 404, 416, 500],
  "GET /node/v1/releases/{version}/{file}": [404, 416, 500],
  "GET /node/v1/link": [401, 403, 500],
  "GET /node/v1/desired": [400, 401, 403, 404, 409, 500],
  "GET /node/v1/credentials": [401, 403, 500],
  "GET /node/v1/archive-credentials/{id}": [400, 401, 403, 404, 500],
  "POST /node/v1/observations": [400, 401, 403, 500],
  "POST /node/v1/volumes": [400, 401, 403, 500],
  "POST /node/v1/events": [400, 401, 403, 500],
  "POST /node/v1/usage": [400, 401, 403, 500],
  "POST /node/v1/diagnostics": [400, 401, 403, 404, 500, 503],
};
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
  node: "Requires a request signed with the node's key, rather than a management API key.",
  installer:
    "Requires the install's one-time progress token, rather than a management API key.",
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

/** Present on a 409 or 503 whose cause is transient; the same rule decides it in apiError. */
const retryAfterHeader = {
  description: `Seconds to wait before repeating the request. Sent when the refusal is transient: error.details.reason is one of ${Object.keys(RETRYABLE_ERROR_REASONS).join(", ")}, or the code is capacity_exhausted or idempotency_in_progress. A hint, not a promise.`,
  schema: { type: "integer" as const, minimum: 1 },
};

/** The generator drops the calendar pattern of a datetime; the contract's own JSON Schema has it. */
const componentDocumentation: Readonly<
  Record<string, Record<string, unknown>>
> = {
  Timestamp: {
    pattern: TIMESTAMP_PATTERN,
    description:
      "UTC time with exactly three fractional digits and a literal Z, as Date#toISOString renders it; other precisions and offsets are refused with 400.",
    examples: ["2026-10-15T09:30:00.000Z"],
  },
  RoleName: {
    description:
      "A lower-case identifier of 1 to 63 characters. postgres, streaming_replica and names that start with pg_ or cnpg_ are reserved; creating a role also refuses pgcf_maintenance, and `app` is the owner.",
  },
};
const SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
/**
 * Brings the generator's output to what the contracts enforce: a nullable reference is the
 * reference or null (the generator emits allOf with a nullable type, which would refuse the null),
 * and an integer is a safe integer unless it says otherwise.
 */
function conformToContracts(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) conformToContracts(item);
    return;
  }
  const node = value as Record<string, unknown>;
  const parts = node.allOf;
  if (Array.isArray(parts) && parts.length === 2) {
    const reference = parts.find(
      (part) => part !== null && typeof part === "object" && "$ref" in part,
    ) as Record<string, unknown> | undefined;
    const rest = parts.find((part) => part !== reference) as
      Record<string, unknown> | undefined;
    if (
      reference !== undefined &&
      rest !== undefined &&
      Array.isArray(rest.type) &&
      rest.type.includes("null")
    ) {
      const { type: _type, ...annotations } = rest;
      void _type;
      delete node.allOf;
      node.anyOf = [reference, { type: "null" }];
      Object.assign(node, annotations);
    }
  }
  const type = node.type;
  if (type === "integer" || (Array.isArray(type) && type.includes("integer"))) {
    if (node.maximum === undefined && node.exclusiveMaximum === undefined)
      node.maximum = SAFE_INTEGER;
    if (node.minimum === undefined && node.exclusiveMinimum === undefined)
      node.minimum = -SAFE_INTEGER;
  }
  for (const child of Object.values(node)) conformToContracts(child);
}

function inScope(scope: Scope, path: string): boolean {
  return scope === "public"
    ? path.startsWith("/v1/") || path === "/healthz"
    : path.startsWith("/node/");
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
            [metadata.auth === "node"
              ? "NodeBearer"
              : metadata.auth === "installer"
                ? "EnrollmentBearer"
                : "bearerAuth"]: [],
          },
        ];
  const statuses =
    metadata.errors ?? publicRouteErrors[key] ?? nodeRouteErrors[key];
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
          ? "Optional for authenticated API-key creation. One-time credentials cannot be replayed: reuse of the same key returns 409. Bootstrap creation ignores this header. Keys are kept for 24 hours."
          : requiredIdempotentPublicRoutes.has(key)
            ? "Required; a request without it is refused with 400. Reusing a key with the same request returns the retained result; a different request conflicts. Keys are kept for 24 hours per API key; a request that failed is not retained."
            : "Reusing a key with the same request returns the retained result; a different request conflicts. Keys are kept for 24 hours per API key; a request that failed is not retained. Omit only where optional.",
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
    if (status === "409" || status === "503")
      response.headers["Retry-After"] = retryAfterHeader;
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
    }
  }
  if (key === "GET /node/v1/link")
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
  for (const [scope, path, title, description] of scopes) {
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
          info: {
            title,
            version: API_CONTRACT_VERSION,
            ...(description === undefined ? {} : { description }),
            "x-worker-version": metadata,
          },
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
      conformToContracts(document);
      for (const [name, documentation] of Object.entries(
        componentDocumentation,
      )) {
        const schemas = document.components?.schemas as
          Record<string, Record<string, unknown>> | undefined;
        if (schemas?.[name]) Object.assign(schemas[name], documentation);
      }
      return c.json(document);
    });
  }
}
